# playbook-mcp

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
- `src/embeddings.js` — local embedding model (`Xenova/bge-small-en-v1.5`,
  quantized), loaded lazily on first call and held resident for the server
  process's lifetime. No network call, no GPU.
- `src/metadata.js` — the one network call in the whole pipeline: OpenRouter
  free-tier chat completion, rotated across `DEFAULT_MODEL_POOL` per call to
  stay under free-tier rate limits, with retries per model and fallback to
  the next pool member on failure. If every pool member fails, `capture_thought`
  still saves the thought with default metadata rather than losing the capture.
- `src/server.js` — registers the six MCP tools (`capture_thought`,
  `update_thought`, `delete_thought`, `search_thoughts`, `list_thoughts`,
  `thought_stats`) and connects over stdio. `update_thought` is a real SQL
  `UPDATE` (preserves id and `created_at`), not delete-then-reinsert — it
  re-embeds and re-runs metadata extraction against the new content, then
  replaces the row's `thoughts_vec` entry in the same transaction (vec0 has
  no in-place UPDATE, so that part is delete+insert internally, unlike the
  `thoughts`/FTS side which is a real UPDATE synced by the existing trigger).

## Conventions for this codebase

- ES modules throughout (`"type": "module"` in `package.json`); use `import`/
  `export`, never `require`.
- camelCase for functions/variables, matching the rest of the JS ecosystem
  here — this project doesn't follow the snake_case-locals convention from
  other (PHP-flavored) projects.
- Comments explain *why*, not what — reserved for non-obvious constraints
  (e.g. the `CAST(? AS INTEGER)` note in `db.js`, the undici version-pinning
  note in `metadata.js`). Don't add a comment a reader wouldn't need.
- Every tool handler in `server.js` follows the same shape: `try` the work,
  return `{ content: [{ type: "text", text }] }` on success, catch and return
  `{ content: [...], isError: true }` on failure — never let a tool call throw
  past the handler.
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

## Testing

There's no automated test suite yet — verify changes by driving the server
directly over stdio (it speaks line-delimited JSON-RPC on stdin/stdout):

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
following — this is the same procedure the project's own `README.md`
documents for a human, written here as direct steps for an agent to execute:

1. From this project's root: `npm install`, then `cp .env.example .env` and
   have the user fill in `OPENROUTER_API_KEY` (get one at
   https://openrouter.ai/settings/keys — free tier works with the default
   model pool). Never fill in or guess an API key yourself.
2. Run `npm run init-db` to create `data/memory.db`.
3. Register the server at user scope with the `claude mcp add` CLI command,
   using **absolute paths** for both the `--env-file` and the server script
   — Claude Code can spawn this from an arbitrary working directory, so a
   relative `.env` path silently fails to resolve:
   ```bash
   claude mcp add --scope user playbook -- node --env-file=/absolute/path/to/playbook-mcp/.env /absolute/path/to/playbook-mcp/src/server.js
   ```
   This writes the registration to `~/.claude.json`'s top-level `mcpServers`
   key, which is the file the CLI actually reads. `~/.claude/settings.json`
   has a `mcpServers` key too, but Claude Code's CLI does not read it —
   entries placed there are silently inert (confirmed via `claude mcp list`
   not showing them). Verify the registration took with `claude mcp list`,
   not by inspecting a config file.
4. Tell the user a **new Claude Code session** is required to pick up a
   newly-registered MCP server — tools registered mid-session aren't visible
   to the running session that just edited the config.
5. Once tools are available, add a standing instruction to the user's global
   `~/.claude/CLAUDE.md` describing when to call `search_thoughts` (proactively,
   before unfamiliar work) and `capture_thought` (whenever the user states a
   convention, correction, or preference) — this is what makes the retrieval
   proactive instead of only-when-asked. Check whether such a section already
   exists before adding a duplicate.
6. Verify the wiring worked by actually calling a tool (e.g. `thought_stats`)
   rather than just confirming the config file looks right — a typo'd path or
   a missing dependency only surfaces when the process is actually spawned.
