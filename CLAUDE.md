# conventions-mcp

A personal memory MCP server: local SQLite storage, local embeddings, hybrid
(vector + keyword) search, MCP over stdio. See `README.md` for the pitch and
setup steps — this file is guidance for Claude Code (or any agent) working on
the server's own code, plus how to wire the finished server into a client.

## Architecture

- `src/db.js` — SQLite (`better-sqlite3`) + `sqlite-vec` (vector search) +
  FTS5 (keyword search). One `thoughts` table; FTS5 stays in sync via
  triggers; `sqlite-vec` does not, so `deleteThought` deletes both rows
  explicitly in one transaction. `hybridSearch` merges vector + FTS results
  with reciprocal rank fusion (`1 / (k + rank)`), not a raw score blend.
  `DB_PATH` (exported) resolves via `MEMORY_DB_PATH`, else `defaultDbPath()`:
  `./data/memory.db` in a git checkout (detected by a sibling `.git`
  directory — npm never publishes one), or `~/.conventions-mcp/memory.db`
  otherwise, since an npm/npx install's own directory usually isn't
  user-writable and gets wiped on upgrade. `getDb()` creates that directory
  if missing, so nothing upstream needs to `mkdir` first.
- `src/load-env.js` — side-effect module loading `~/.conventions-mcp/.env` into
  `process.env` (without overriding anything already set), for entry points
  invoked without Node's own `--env-file` flag — the installed `conventions-mcp`
  bin and the hook scripts run standalone. Import it FIRST in any file that
  reads `process.env` at module-load time, before importing `db.js`/
  `metadata.js`; ES module static imports evaluate in file order, so a
  leading import guarantees this runs before those reads.
- `src/embeddings.js` — local embedding model (`Xenova/bge-small-en-v1.5`,
  quantized), loaded lazily on first call and held resident for the server
  process's lifetime. No network call, no GPU.
- `src/metadata.js` — the network call in the actual capture pipeline (`bin/check-api-key.js`,
  covered below, makes a separate one, but only during install verification):
  OpenRouter free-tier chat completion, rotated across `DEFAULT_MODEL_POOL` per call to
  stay under free-tier rate limits, with retries per model and fallback to
  the next pool member on failure. If every pool member fails,
  `capture_thought` still saves the thought, with default metadata.
  The LLM only judges *whether* a thought is project-specific (`projectSpecific`,
  defaulting to `false`/global unless the content obviously names or is about
  one particular codebase) — it never has to name the project itself; see
  `withProjectStamp` in `server.js`.
- `bin/check-api-key.js` (`npm run check-key`) — validates `OPENROUTER_API_KEY`
  against OpenRouter's `GET /api/v1/key` before any install step touches local
  Claude Code config (see "Wiring this server into Claude Code" below). A free
  lookup, not a chat completion — cheap enough to run as a pure preflight
  check, catching a present-but-wrong key before it can silently degrade
  every future capture to fallback metadata.
- `db.js`'s `listRules({ project })` — a plain deterministic SQL filter
  (`project IS NULL OR project = ?`), no embeddings, no LLM call. Backs the
  `list_rules` MCP tool and both hook scripts in `bin/` — cheap enough to run
  on every session start / every turn.
- `bin/session-rules.js` (`SessionStart` hook) and `bin/prompt-reminder.js`
  (`UserPromptSubmit` hook) — see "Standing-rule hooks" below. These call
  `listRules`/`getCurrentProject` directly via relative import, bypassing the
  MCP transport entirely, because hooks are shell commands the harness
  invokes directly, not tool calls the model makes. Each has a `.cmd`
  sibling (`session-rules.cmd`, `prompt-reminder.cmd`) that Windows
  `settings.json` entries point at — see "Platform support" below. Every path
  in `src/` goes through `node:path`, which is cross-platform by design, and
  the one process-spawn (`execFileSync("git", ...)` in `project.js`) resolves
  via Node's own PATH/PATHEXT search on every OS.
- `src/server.js` — registers the seven MCP tools (`capture_thought`,
  `update_thought`, `delete_thought`, `search_thoughts`, `list_thoughts`,
  `list_rules`, `thought_stats`) and connects over stdio. `update_thought` is
  a real SQL `UPDATE` (preserves id and `created_at`), not delete-then-
  reinsert — it re-embeds and re-runs metadata extraction against the new
  content, then replaces the row's `thoughts_vec` entry in the same
  transaction (vec0 has no in-place UPDATE, so that part is delete+insert
  internally, unlike the `thoughts`/FTS side which is a real UPDATE synced by
  the existing trigger). `withProjectStamp` converts the LLM's `projectSpecific`
  boolean into a deterministic `project` field before storage — see
  `src/project.js` below for why that split exists.
- `src/project.js` — `getCurrentProject()` derives a stable project identifier
  from the git repo's toplevel directory name (falls back to plain `cwd`
  basename outside a git repo). Used to stamp captures and to filter
  `list_rules`/the hook scripts, so "which project" is a deterministic lookup
  rather than free-text matching against whatever string an LLM happened to
  write.
- `bin/cli.js` — the npm `"bin"` entry (`package.json`'s
  `"bin": { "conventions-mcp": "bin/cli.js" }`), so an installed copy resolves
  on PATH with no path management needed. Dispatches by subcommand
  (`init-db`, `check-key`, or nothing → starts the MCP server) via dynamic
  `import()` of the same modules the `npm run` scripts already use — each
  does its work as a top-level side effect on import, so no refactor into
  exported functions was needed just for this. First run with no
  `~/.conventions-mcp/.env` yet copies `.env.example` there and exits, rather
  than leaving a first-time installed user to guess where config goes.

## Conventions for this codebase

- ES modules throughout (`"type": "module"` in `package.json`); use `import`/
  `export`, never `require`.
- camelCase for functions/variables, matching the rest of the JS ecosystem.
- Comments explain *why*, not what — reserved for non-obvious constraints
  (e.g. the `CAST(? AS INTEGER)` note in `db.js`, the undici version-pinning
  note in `metadata.js`). Don't add a comment a reader wouldn't need.
- Every tool handler in `server.js` follows the same shape: `try` the work,
  return `{ content: [{ type: "text", text }] }` on success, catch and return
  `{ content: [...], isError: true }` on failure — never let a tool call throw
  past the handler.
- `capture_thought`/`update_thought` always echo the verbatim content and
  scope back in the confirmation text (`formatConfirmation` in `server.js`),
  and their tool descriptions instruct the calling agent to relay that to the
  user — so a misclassified or misheard rule is visible and correctable
  immediately, not just discoverable later via `search_thoughts`.
- When metadata extraction falls back (`metadata.fallback === true` — see
  `FALLBACK_METADATA` in `metadata.js`), `formatConfirmation` appends a ⚠️
  warning that the classification is a placeholder, and both tool
  descriptions instruct the calling agent to relay it plainly rather than
  presenting fallback metadata as if it were real.
- `capture_thought`'s description instructs the calling agent to call it once
  per distinct rule when a single message states several — not merge them
  into one capture — and to relay each one individually, the same treatment
  as a single capture.
- SQL: prepared statements for every query with a variable (`better-sqlite3`'s
  `.prepare()`/`.run()`/`.get()`/`.all()`), never string-interpolated SQL.
  Multi-statement writes (e.g. `insertThought`, `deleteThought`) go through
  `database.transaction()` so partial failure can't leave `thoughts` and
  `thoughts_vec` out of sync.
- Keep the embedding dimension (`EMBEDDING_DIM` in `db.js`) and the model in
  `embeddings.js` in lockstep — if the model changes and its output
  dimension differs, existing rows in `thoughts_vec` need re-embedding, not
  just a schema tweak (different models' vector spaces aren't comparable
  even at the same dimension).
- `MODEL_POOL` in `metadata.js` should stay a plausible free-tier lineup —
  OpenRouter's free catalog rotates, so if `capture_thought` starts falling
  back to default metadata often, check `https://openrouter.ai/api/v1/models`
  (filter `pricing.prompt == "0"`) before assuming the code is broken.

## Standing-rule hooks

Two hooks, configured in `~/.claude/settings.json` (not this repo — see
"Wiring this server into Claude Code" below), guarantee baseline rule
retrieval every session — hook events fire deterministically regardless of
whether a given model happens to notice relevance in the moment:

- **`SessionStart`** → `bin/session-rules.js` — loads every applicable rule
  (global + current-project) into context *before* the model's first action,
  via `listRules`. No embeddings, no network call, so it's fast enough to run
  on every session start unconditionally.
- **`UserPromptSubmit`** → `bin/prompt-reminder.js` — fires on every turn. No
  hook event exists for "the user just stated a rule" — that's a semantic
  judgment only the model can make, and hook `prompt`/`agent` types (which
  *can* run an LLM check) are restricted to tool events, not this one. So this
  hook re-anchors two things every turn instead: keep following what
  `SessionStart` loaded (which could otherwise scroll out of context in a long
  session) and check whether the message just stated a new rule worth a
  `capture_thought` call.

Both scripts resolve "current project" via `process.cwd()` at the moment the
hook fires, not from where the script file lives — this only works because
hook commands inherit the active session's working directory.

## Platform support

Linux, macOS, and Windows:

- `bin/session-rules.cmd` / `bin/prompt-reminder.cmd` wrap the corresponding
  `.js` file via `node "%~dp0<script>.js"` — `%~dp0` resolves to the batch
  file's own directory, so it works regardless of where the repo is cloned.
  Point Windows `settings.json` hook entries at the `.cmd` path directly
  (no `node` prefix — batch files are directly executable), which also
  avoids needing to hand-quote a path containing spaces (common under
  `C:\Users\<name>\...`) inside the JSON `command` string.
- `better-sqlite3` and `sqlite-vec` (native modules) both ship prebuilt
  Windows binaries — `npm install` shouldn't need a compiler toolchain. If it
  falls back to building from source, that's a sign the specific Node
  version/arch combination doesn't have a matching prebuild, not a code
  issue here.
- `jq`, used in this doc's validation commands, isn't installed by default on
  Windows. Skip that check there and rely on pipe-testing the `.cmd`/`.js`
  directly instead — it exercises the same code path.
- The installed-mode default DB path and config path (`defaultDbPath()` in
  `db.js`, `CONFIG_ENV_PATH` in `load-env.js`/`cli.js`) are both built on
  `os.homedir()` + `path.join`, which resolve correctly on every OS Node
  supports — no OS-specific branch needed there either.

## Testing

Verify changes by driving the server directly over stdio (it speaks
line-delimited JSON-RPC on stdin/stdout):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | node --env-file=.env src/server.js
```

Chain `notifications/initialized` and a `tools/call` the same way. Note the
**first** `capture_thought` call in a freshly spawned process can take ~15-20s
(cold local-model load + the OpenRouter network round trip) — don't mistake
that for a hang; give it real time before concluding something's broken. Any
thought captured purely for testing should be cleaned up afterward with
`delete_thought` so it doesn't pollute real search results.

## Wiring this server into Claude Code

When asked to set this server up for use (not just develop on it), do the
following. Two install paths exist — a git checkout (development) or the
published npm package (a plain install) — differing only in the exact
commands and paths used at each step; the shape of every step is the same
either way, and hooks are registered identically regardless of path:

1. Get the code and set the key.
   - **Git checkout:** from the project root, `npm install`, then
     `cp .env.example .env` and have the user fill in `OPENROUTER_API_KEY`
     (get one at https://openrouter.ai/settings/keys — free tier works with
     the default model pool). Confirm non-empty after they say it's done:
     `grep -c '^OPENROUTER_API_KEY=.\+' .env` should print `1`.
   - **npm install:** `npm install -g conventions-mcp`, then run `conventions-mcp`
     once. First run has no config yet, so it creates
     `~/.conventions-mcp/.env` from the package's own template and exits,
     telling the user to fill in `OPENROUTER_API_KEY` there. Confirm the same
     way, at that path: `grep -c '^OPENROUTER_API_KEY=.\+' ~/.conventions-mcp/.env`.
   Never fill in or guess an API key yourself either way.
2. **Validate the key before touching anything else — no local Claude Code
   config gets edited until this passes.**
   - **Git checkout:** `npm run check-key`
   - **npm install:** `conventions-mcp check-key`
   Both call OpenRouter's own `GET https://openrouter.ai/api/v1/key` — a
   free, unrated lookup, not a chat completion — confirming the key is
   genuinely valid. A wrong key makes `capture_thought` fall back to generic
   `other`/`global`/`uncategorized` tagging on every future capture, so this
   check runs before `init-db` or any registration step. If it fails: stop,
   show the user the actual error (the command prints the HTTP status), have
   them fix the key at https://openrouter.ai/settings/keys, and re-run —
   don't proceed to step 3 until it passes.
3. Create the database.
   - **Git checkout:** `npm run init-db` → `data/memory.db`.
   - **npm install:** `conventions-mcp init-db` → resolves automatically to
     `~/.conventions-mcp/memory.db` (see `defaultDbPath` in `db.js`) — no path
     to manage.
4. Register the server at user scope with the `claude mcp add` CLI command:
   - **Git checkout:** use **absolute paths** for both the `--env-file` and
     the server script — Claude Code can spawn this from an arbitrary working
     directory, so a relative `.env` path silently fails to resolve:
     ```bash
     claude mcp add --scope user conventions -- node --env-file=/absolute/path/to/conventions-mcp/.env /absolute/path/to/conventions-mcp/src/server.js
     ```
   - **npm install:** the installed `conventions-mcp` command is already on
     PATH, and it loads `~/.conventions-mcp/.env` itself (`load-env.js`) — no
     paths needed at all:
     ```bash
     claude mcp add --scope user conventions -- conventions-mcp
     ```
   Either way, this writes the registration to `~/.claude.json`'s top-level
   `mcpServers` key, which is the file the CLI actually reads.
   `~/.claude/settings.json` has a `mcpServers` key too, but Claude Code's
   CLI does not read it — entries placed there are silently inert (confirmed
   via `claude mcp list` not showing them). Verify the registration took with
   `claude mcp list`, not by inspecting a config file.
5. Register the two standing-rule hooks (see "Standing-rule hooks" above) in
   `~/.claude/settings.json` — **not** this repo's own config, since these
   need to fire in every project, not just this one. Read the file first and
   merge under the existing `hooks` key if present. Both the OS (see
   "Platform support" above) and the install path change the exact
   `command` path:
   - **Git checkout, Linux/macOS:** the clone's absolute paths, e.g.
     `node /absolute/path/to/conventions-mcp/bin/session-rules.js`.
   - **Git checkout, Windows:** the clone's `.cmd` wrappers, e.g.
     `C:\\absolute\\path\\to\\conventions-mcp\\bin\\session-rules.cmd` (no `node`
     prefix — the batch file invokes it).
   - **npm install, Linux/macOS:** resolve the install location first —
     `$(npm root -g)/conventions-mcp/bin/session-rules.js` — then use that
     absolute path the same way as the git-checkout case.
   - **npm install, Windows:** same idea, resolved via `npm root -g`, then
     point at the `.cmd` wrapper there.

   Example (git checkout, Linux/macOS):
   ```json
   {
     "hooks": {
       "SessionStart": [
         { "hooks": [{ "type": "command", "command": "node /absolute/path/to/conventions-mcp/bin/session-rules.js", "timeout": 15 }] }
       ],
       "UserPromptSubmit": [
         { "hooks": [{ "type": "command", "command": "node /absolute/path/to/conventions-mcp/bin/prompt-reminder.js", "timeout": 5 }] }
       ]
     }
   }
   ```

   Validate with `jq -e '.hooks.SessionStart[0].hooks[0].command' ~/.claude/settings.json`
   (and the `UserPromptSubmit` equivalent) after writing — Linux/macOS only,
   `jq` isn't a Windows default; visually inspect the JSON there instead.
   Pipe-test each resolved script/wrapper directly first (Linux/macOS:
   `echo '{}' | node <resolved-path>/bin/session-rules.js`; Windows:
   `echo {} | <resolved-path>\bin\session-rules.cmd` from a Windows shell) so
   a broken path surfaces as a clear error, not a silently inert hook.
6. Tell the user a **new Claude Code session** is required to pick up a
   newly-registered MCP server or new hooks — config changes made mid-session
   aren't visible to the session that just edited them. If the settings
   watcher wasn't already watching `~/.claude/` when this session started,
   even a new session may need the user to open `/hooks` once to force a
   reload — mention this as a fallback, don't assume it's needed.
7. Verify the wiring end-to-end: confirm the full pipeline (embedding +
   metadata extraction + storage) with a real `capture_thought` call, then
   `delete_thought` the test capture afterward — it's not a real memory.
   Separately, verify the hooks by starting a fresh session in a test project
   and confirming the `SessionStart` rules text appears in context.
