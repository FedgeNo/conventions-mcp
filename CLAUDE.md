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
  if missing, so nothing upstream needs to `mkdir` first. The DB runs in WAL
  mode, and every write (`insertThought`/`updateThought`/`deleteThought`) runs
  `wal_checkpoint(TRUNCATE)` right after its transaction — at this write volume
  the ~1000-page autocheckpoint never trips and `better-sqlite3` doesn't
  checkpoint on exit, so without it a crash or hard reboot that discarded the
  WAL would lose every rule not yet folded into `memory.db`.
- `src/load-env.js` — side-effect module loading `~/.conventions-mcp/.env` into
  `process.env` (without overriding anything already set), for entry points
  invoked without Node's own `--env-file` flag — the installed `conventions-mcp`
  bin and the hook scripts run standalone. Import it FIRST in any file that
  reads `process.env` at module-load time, before importing `db.js`; ES
  module static imports evaluate in file order, so a leading import
  guarantees this runs before those reads. Nothing in this codebase requires
  an env var — `MEMORY_DB_PATH` is the only one read, and it's optional.
- `src/embeddings.js` — local embedding model (`Xenova/bge-small-en-v1.5`,
  quantized), loaded lazily on first call and held resident for the server
  process's lifetime. No network call, no GPU.
- Classification (type/topics/projectScoped) happens in the calling
  agent, not the server — `capture_thought`/`update_thought`'s zod
  `inputSchema` in `server.js` (`CLASSIFICATION_FIELDS`) carries the taxonomy
  via field descriptions, and the tool description instructs the caller to
  fill them in from the conversation the thought came from. The caller only
  judges *whether* a thought is scoped to the current project (`projectScoped`,
  defaulting to `false`/global unless the rule is specific to the current
  working directory) — it never has to name the project itself; see
  `withProjectStamp` in `server.js`. There is no server-side classification
  step and no network call anywhere in the capture pipeline.
- `db.js`'s `listRules({ project })` — a plain deterministic SQL filter
  (`project IS NULL OR project = ?`), no embeddings, no LLM call. Backs the
  `list_rules` MCP tool — cheap enough to call on every turn.
- `bin/session-rules.js` (`SessionStart` hook), `bin/prompt-reminder.js`
  (`UserPromptSubmit` hook), and `bin/pre-tool-check.js` (`PreToolUse` hook,
  matcher `*`) — see "Standing-rule hooks" below. None touch the database
  directly. `session-rules.js` emits a short, fixed-size instruction telling
  the model to call the `list_rules` MCP tool itself; embedding the rule
  content directly in hook output doesn't scale — a large enough stored rule
  set gets silently truncated to a small preview before it ever reaches the
  model. `pre-tool-check.js` is the enforcement layer: advisory instructions
  turned out to be ignorable in practice, so it denies any other tool call
  until `list_rules` has run this session, tracked by a marker file. The gate
  fires once per session, not once per turn — `session-rules.js` re-arms it
  (clears the marker) only after a compaction or `/clear`, the two events that
  drop the loaded rules from context. `prompt-reminder.js` no longer touches
  the gate at all; it just re-anchors, every turn, "follow the loaded
  conventions, and capture only durable rules intended to govern future
  sessions or repeated work." Task-specific directions, temporary choices,
  status/history, one-job commands, and descriptions of how an individual job
  was completed remain in conversation context. Each script
  has a `.cmd` sibling (`session-rules.cmd`, `prompt-reminder.cmd`,
  `pre-tool-check.cmd`) that Windows `settings.json` entries point at — see
  "Platform support" below.
- `src/server.js` — registers the seven MCP tools (`capture_thought`,
  `update_thought`, `delete_thought`, `search_thoughts`, `list_thoughts`,
  `list_rules`, `thought_stats`) and connects over stdio by default or
  localhost-only Streamable HTTP when `MCP_TRANSPORT=http`. `update_thought` is
  a real SQL `UPDATE` (preserves the row's id), not delete-then-
  reinsert — it re-embeds against the new content and takes fresh
  classification fields from the caller, then replaces the row's
  `thoughts_vec` entry in the same transaction (vec0 has no in-place UPDATE,
  so that part is delete+insert internally, unlike the `thoughts`/FTS side
  which is a real UPDATE synced by the existing trigger). `withProjectStamp`
  converts the caller's `projectScoped` boolean into a deterministic
  `project` field before storage — see `src/project.js` below for why that
  split exists. `list_rules` and `list_thoughts` render each row by its `#id`
  (`list_rules` ordered by id ascending), so the ids the user sees are exactly
  the ones they pass back to `update_thought`/`delete_thought`.
- `src/project.js` — `getCurrentProject(cwd)` derives a stable project id from
  the working directory: the absolute path with `/` turned into `-` (e.g.
  `/var/www/html` → `-var-www-html`), the same string Claude Code uses for the
  per-project transcript directory under `~/.claude/projects/`. Used to stamp
  captures and to filter `list_rules`, so "which project" is a deterministic
  lookup rather than free-text matching against whatever string an LLM happened
  to write.
- `bin/cli.js` — the npm `"bin"` entry (`package.json`'s
  `"bin": { "conventions-mcp": "bin/cli.js" }`), so an installed copy resolves
  on PATH with no path management needed. Dispatches by subcommand
  (`init-db`, or nothing → starts the MCP server) via dynamic `import()` of
  the same modules the `npm run` scripts already use — each does its work as
  a top-level side effect on import, so no refactor into exported functions
  was needed just for this. No config bootstrap step — nothing here requires
  a `.env` to exist.

## Conventions for this codebase

- ES modules throughout (`"type": "module"` in `package.json`); use `import`/
  `export`, never `require`.
- camelCase for functions/variables, matching the rest of the JS ecosystem.
- Comments explain *why*, not what — reserved for non-obvious constraints
  (e.g. the `CAST(? AS INTEGER)` note in `db.js`). Don't add a comment a
  reader wouldn't need.
- Every tool handler in `server.js` follows the same shape: `try` the work,
  return `{ content: [{ type: "text", text }] }` on success, catch and return
  `{ content: [...], isError: true }` on failure — never let a tool call throw
  past the handler.
- `capture_thought`/`update_thought` always echo the verbatim content and
  whether it's global or project-scoped back in the confirmation text
  (`formatConfirmation` in `server.js`), and their tool descriptions instruct
  the calling agent to relay that to the user — so a misclassified or misheard
  rule is visible and correctable immediately, not just discoverable later via
  `search_thoughts`.
- `capture_thought`'s description and the server-level MCP instructions limit
  storage to durable rules that should govern future sessions or repeated
  work. They explicitly reject task-specific directions, temporary choices,
  status/history, one-job commands, and descriptions of how an individual job
  was completed. The description instructs the calling agent to call it once
  per distinct qualifying rule when a single message states several — not
  merge them into one capture — and to relay each one individually.
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

## Standing-rule hooks

Three hooks, configured in `~/.claude/settings.json` (not this repo — see
"Wiring this server into Claude Code" below), enforce baseline rule
retrieval before tool use — hook events fire deterministically at the moment
a tool call is attempted. The first two are advisory (they inject a reminder,
but nothing stops a model from ignoring it); the third actually enforces the
requirement by denying tool use outright:

- **`SessionStart`** → `bin/session-rules.js` — emits a short reminder to call
  `list_rules` before any other tool use this session. It also reads the
  event's `source`: on `compact` or `clear` (the two events that discard the
  already-loaded rules from context) it clears the enforcement marker below,
  forcing a reload; on a plain startup/resume there's no marker to clear.
- **`UserPromptSubmit`** → `bin/prompt-reminder.js` — fires on every turn with
  a static reminder to (1) follow the conventions already loaded via
  `list_rules`, and (2) capture only a durable rule clearly meant to govern
  future sessions or repeated work. It explicitly excludes current-task
  directions and work history; deciding whether a statement is genuinely
  durable is the semantic judgment only the model can make. It does **not**
  touch the enforcement marker.
- **`PreToolUse`** (matcher `*`) → `bin/pre-tool-check.js` — fires before
  *every* tool call and actually denies it (`permissionDecision: "deny"`,
  not just advisory `additionalContext`) unless `list_rules` has already run
  this session. Since hooks are stateless shell invocations with no memory
  between calls, that state is a marker file at
  `os.tmpdir()/conventions-mcp-list-rules-called-<session_id>` — written the
  moment a call whose `tool_name` ends in `__list_rules` is seen (allowed
  through unconditionally, so this can't deadlock against itself), and removed
  only by `session-rules.js` on `compact`/`clear`. So `list_rules` is forced
  once per session and again after each context reset, not once per turn. The
  gate keys on *attempt*, not success — even a `list_rules` call that errors
  at runtime still sets the marker, since `PreToolUse` fires before the
  underlying tool executes.

None of the three touch the database or call `getCurrentProject`. `list_rules`
resolves the current project from an MCP root when supported, the process
working directory for stdio, or `X-Conventions-Project` for HTTP. An unscoped
HTTP client receives global rules only rather than inheriting the service's
working directory.
`prompt-reminder.js` is fully static (fixed reminder text). `session-rules.js`
and `pre-tool-check.js` read stdin JSON (`source`/`session_id` and
`tool_name`/`session_id` respectively) and manage the marker file described
above, but neither queries the database.

## Platform support

Linux, macOS, and Windows:

- `bin/session-rules.cmd` / `bin/prompt-reminder.cmd` / `bin/pre-tool-check.cmd`
  wrap the corresponding `.js` file via `node "%~dp0<script>.js"` —
  `%~dp0` resolves to the batch
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
  | node src/server.js
```

Chain `notifications/initialized` and a `tools/call` the same way. Note the
**first** `capture_thought` call in a freshly spawned process can take a few
seconds for the local embedding model's cold load — don't mistake that for a
hang. `capture_thought`/`update_thought` calls require the classification
fields (`type`, `topics`, `projectScoped`) in the `tools/call`
params — a manual stdio test has to supply them itself, since there's no
calling agent to fill them in. Any thought captured purely for testing should
be cleaned up afterward with `delete_thought` so it doesn't pollute real
search results.

## Wiring this server into Claude Code

For a shared persistent service used by multiple agents, follow
`docs/shared-service.md` first, then register its localhost HTTP URL in each
client. Resolve executable and data paths on the target machine; never copy
machine-specific paths from another installation into the repository.

When asked to set this server up for use (not just develop on it), do the
following. Two install paths exist — a git checkout (development) or the
published npm package (a plain install) — differing only in the exact
commands and paths used at each step; the shape of every step is the same
either way, and hooks are registered identically regardless of path:

1. Get the code.
   - **Git checkout:** from the project root, `npm install`.
   - **npm install:** `npm install -g conventions-mcp`.
   No config to set — there's no API key and no external service.
   `MEMORY_DB_PATH` is the only environment variable this reads, and it's
   optional (see `.env.example`).
2. Create the database.
   - **Git checkout:** `npm run init-db` → `data/memory.db`.
   - **npm install:** `conventions-mcp init-db` → resolves automatically to
     `~/.conventions-mcp/memory.db` (see `defaultDbPath` in `db.js`) — no path
     to manage.
3. Register the server at user scope with the `claude mcp add` CLI command:
   - **Git checkout:** use an **absolute path** to the server script —
     Claude Code can spawn this from an arbitrary working directory:
     ```bash
     claude mcp add --scope user conventions -- node /absolute/path/to/conventions-mcp/src/server.js
     ```
   - **npm install:** the installed `conventions-mcp` command is already on
     PATH — no paths needed at all:
     ```bash
     claude mcp add --scope user conventions -- conventions-mcp
     ```
   Either way, this writes the registration to `~/.claude.json`'s top-level
   `mcpServers` key, which is the file the CLI actually reads.
   `~/.claude/settings.json` has a `mcpServers` key too, but Claude Code's
   CLI does not read it — entries placed there are silently inert (confirmed
   via `claude mcp list` not showing them). Verify the registration took with
   `claude mcp list`, not by inspecting a config file.
4. Register the three standing-rule hooks (see "Standing-rule hooks" above)
   in `~/.claude/settings.json` — **not** this repo's own config, since these
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
       ],
       "PreToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/conventions-mcp/bin/pre-tool-check.js", "timeout": 5 }] }
       ]
     }
   }
   ```

   Validate with `jq -e '.hooks.SessionStart[0].hooks[0].command' ~/.claude/settings.json`
   (and the `UserPromptSubmit`/`PreToolUse` equivalents) after writing —
   Linux/macOS only, `jq` isn't a Windows default; visually inspect the JSON
   there instead. Pipe-test each resolved script/wrapper directly first
   (Linux/macOS: `echo '{}' | node <resolved-path>/bin/session-rules.js`;
   Windows: `echo {} | <resolved-path>\bin\session-rules.cmd` from a Windows
   shell) so a broken path surfaces as a clear error, not a silently inert
   hook.
5. (Optional) Document the hook behavior in `~/.claude/CLAUDE.md` under the
   "Personal memory" section if you want to remind yourself what the hooks do,
   but it's not required — the enforcement is in the `PreToolUse` hook itself,
   which will deny any tool call until `list_rules` has been attempted that
   turn.
6. Tell the user a **new Claude Code session** is required to pick up a
   newly-registered MCP server or new hooks — config changes made mid-session
   aren't visible to the session that just edited them. If the settings
   watcher wasn't already watching `~/.claude/` when this session started,
   even a new session may need the user to open `/hooks` once to force a
   reload — mention this as a fallback, don't assume it's needed.
7. Verify the wiring end-to-end: confirm the full pipeline (embedding +
   classification + storage) with a real `capture_thought` call, then
   `delete_thought` the test capture afterward — it's not a real memory.
   Separately, verify the hooks by starting a fresh session in a test
   project: confirm the `SessionStart` instruction appears in context, and
   attempt a non-`list_rules` tool call before calling `list_rules` to
   confirm `pre-tool-check.js` actually denies it.
