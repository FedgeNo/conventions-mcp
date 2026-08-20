# conventions-mcp

Personal memory for durable coding conventions and standing instructions — one store, any MCP-compatible AI client, available in every project. It holds rules like "always use 2-space indent in this language," "never force-push to main," lasting corrections, and long-lived workflow preferences that should carry across future sessions rather than get re-explained every time. It is deliberately not a history of individual jobs or a place for task-specific directions, temporary decisions, current status, or one-off commands.

## Why this one

There's no shortage of memory MCP servers — several well-established ones (mem0/OpenMemory, Zep/Graphiti, the official reference memory server, plus a long tail of smaller projects) already do "remember things across sessions." What's different here:

- **Narrow taxonomy, not a general note-taking store.** Every capture must be a durable rule for future work and gets classified into one of five purpose-built types — convention, instruction, correction, preference, other — plus a project field and topic tags. Task-specific procedures and work history are excluded so retrieval stays precise instead of noisy.
- **Deterministic retrieval, not best-effort.** Most memory MCPs rely entirely on the calling model noticing a tool description is relevant and deciding to call it — which fails silently and inconsistently. Three Claude Code hooks here (`SessionStart`, `UserPromptSubmit`, `PreToolUse`) make a `list_rules` call unavoidable — the first two are advisory reminders, and the third actually enforces it by denying every other tool call until `list_rules` has run. It's forced once per session (and re-armed after a compaction or `/clear`, when the loaded rules fall out of context), not once per turn. If you're not on Claude Code, you still get the tool descriptions, just not the hook guarantee.
- **Transparent by default, not silent.** Every capture and update echoes the verbatim stored content and whether it's global or project-scoped back immediately, so a misheard or misclassified rule is visible and correctable on the spot — not something you discover three sessions later via search.
- **Fully local at runtime.** SQLite + local embeddings, no hosted service, no per-token costs, no API key. The embedding model is downloaded once on first use (or explicitly with `conventions-mcp warmup`) and then runs locally. Classification (type/topics/projectScoped) is done by the calling agent at capture time, guided by the tool description — it already has the full conversation the thought came from, richer context than an isolated content string would give a separate extractor model.
- **Project-scoped without fuzzy matching.** A rule can be global (the default) or tied to one specific codebase. Stdio clients derive the project from their working directory; HTTP clients provide an MCP root or an `X-Conventions-Project` header. The project identifier is never guessed by an LLM from free text.

If what you want is a general-purpose "remember everything" store, or you're not on Claude Code and don't need the hook-driven determinism, one of the more general options above may fit better. This one is for someone who specifically wants a tight, coding-convention-focused memory that stays accurate and doesn't require trusting the model to remember to check it.

## What it's tuned to store

Every capture is classified into one of five types by the calling agent, guided by `capture_thought`'s tool description (`src/server.js`):

| Type | What it means |
|---|---|
| `convention` | A specific coding style/pattern rule (e.g. "always use 2-space indent") |
| `instruction` | A standing directive on how to work/behave (e.g. "never force-push to main") |
| `correction` | A lasting correction to future behavior |
| `preference` | A long-lived softer preference, not a hard rule |
| `other` | Another durable, future-facing rule that does not fit the four specific types |

Each thought also gets 1–3 **topic tags** for filtering. This is deliberately narrow — it's not a general note-taking store — but the taxonomy isn't hardcoded logic, it's just the wording of the tool description and its zod schema in `src/server.js`. Retuning what counts as a `convention` vs. an `instruction`, or adding a new type, is a matter of editing that description text, not restructuring the code. The one wrinkle: the five type names are also referenced in the `type` filter's enum in `list_thoughts` (`src/server.js`) — if you rename or add a type, update that enum too or the new type will get rejected as a filter value. Everything's stored as a JSON blob column, so none of this needs a schema migration.

Separately, every thought gets a **project** field — `null` by default (applies everywhere), or a specific project id if it's scoped to the current codebase. The calling agent only judges *whether* it's project-scoped (`projectScoped`); the actual project id is derived deterministically from the working directory — the absolute path with separators turned into dashes, e.g. `/var/www/html` → `-var-www-html`, matching the per-project directory name Claude Code itself uses under `~/.claude/projects/`. The model never names the project, so retrieval can do an exact match instead of fuzzy text comparison.

- **Storage:** SQLite (`better-sqlite3`) + `sqlite-vec` for native vector search, FTS5 for keyword search, combined via reciprocal rank fusion. One file, no server, no daemon.
- **Embeddings:** local, via `Xenova/bge-small-en-v1.5` (384-dim, quantized, ~130MB). Downloads once, loads lazily, and needs no GPU.
- **Classification:** done by the calling agent (Claude Code, or any MCP client) at capture time, guided by the tool description — no network call, no external model, no API key.
- **Transport:** MCP over stdio by default, with an optional localhost-only Streamable HTTP mode for running it as a persistent service.
- **Proactive retrieval:** Claude Code hooks (see below) enforce standing rules before tool use — no CLAUDE.md instruction to keep in sync, no dependence on the model happening to notice a tool description is relevant.
- **Scoped retrieval:** `list_rules` and semantic search return global rules plus the current project's rules; project-specific rules from other codebases stay out of normal retrieval. `list_thoughts` remains the explicit all-records management view.

## Setup

Two ways to get this: a git checkout (if you want to read/modify the source) or the npm package (if you just want it running).

**Git checkout:**
```bash
npm install
npm run init-db        # creates data/memory.db
```

**npm package:**
```bash
npm install -g conventions-mcp
conventions-mcp init-db    # creates ~/.conventions-mcp/memory.db
conventions-mcp warmup     # downloads and verifies the embedding model
```

Nothing to configure — there's no API key and no external service. `MEMORY_DB_PATH` is the only environment variable this reads, and it's optional (see `.env.example`).

### Persistent local service

Use Streamable HTTP when the MCP client should connect to one boot-managed
server instead of launching a stdio child for every session:

```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=47123 conventions-mcp
```

Run that command under the operating system's service manager and configure
the MCP client with `http://127.0.0.1:47123/mcp`. See
[`docs/shared-service.md`](docs/shared-service.md) for complete systemd,
launchd, and Windows setup and verification instructions. The server rejects
non-local host headers when bound to localhost. `MCP_HTTP_HOST` defaults to
`127.0.0.1` and `MCP_HTTP_PORT` defaults to `47123`.

HTTP clients that support MCP roots need no additional project configuration.
For clients that do not, set `X-Conventions-Project` to the absolute project
path in project-local MCP configuration. An HTTP session without either value
receives global rules only and cannot create a project-scoped capture, which
prevents one project's rules from leaking into another project.

## Register with Claude Code

Register at **user scope** so it's available in every project, not just one repo — use the `claude mcp add` CLI, not a hand-edited config file:

```bash
# Git checkout — an absolute path, since Claude Code may spawn this from an
# arbitrary working directory:
claude mcp add --scope user conventions -- node /absolute/path/to/conventions-mcp/src/server.js

# npm package — already on PATH:
claude mcp add --scope user conventions -- conventions-mcp
```

Either way, this writes to `~/.claude.json`'s `mcpServers` key, which is what the CLI actually reads; a `mcpServers` entry placed directly in `~/.claude/settings.json` is silently inert. Verify with `claude mcp list`. A new Claude Code session is required to pick up a newly-registered server.

## Standing-rule hooks

Three hooks in `~/.claude/settings.json` enforce `list_rules` before tool use — the first two provide reminders, the third actually enforces it:

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

- `bin/session-rules.js` fires at session start and emits a short reminder to call `list_rules` first — rather than embedding rule content in the hook output directly, which doesn't scale (a large enough stored rule set gets silently truncated to a small preview before it ever reaches the model). It also re-arms the enforcement gate after a compaction or `/clear` (the two events that drop the already-loaded rules from context), so a reload is forced then too.
- `bin/prompt-reminder.js` fires on every turn with a static reminder to follow the loaded conventions and to capture only genuinely durable rules intended for future sessions or repeated work. It explicitly excludes task-specific directions, temporary choices, current status, incident history, one-job commands, and records of how an individual job was completed.
- `bin/pre-tool-check.js` fires before every tool call and denies it outright until `list_rules` has run this session — the first two hooks are advisory (reminders only), so this is the layer that actually enforces the requirement. It's forced once per session, not once per turn.

None of the three touch the database directly. `list_rules` resolves the current project from the stdio working directory, an MCP root, or the HTTP project's `X-Conventions-Project` header.

**npm package:** the scripts live inside the global install rather than a known clone path — resolve it first with `npm root -g`, then point the hook at `$(npm root -g)/conventions-mcp/bin/session-rules.js` the same way.

**Windows:** point the `command` at the `.cmd` wrapper instead of the `.js` file directly (no `node` prefix — the batch file invokes it) — `bin\session-rules.cmd` / `bin\prompt-reminder.cmd` / `bin\pre-tool-check.cmd` for a git checkout, or the equivalent path under `npm root -g` for the npm package.

## Tools

| Tool | Description |
|---|---|
| `capture_thought` | Save a convention, instruction, correction, or preference. Embeds locally; classification is provided by the calling agent. |
| `update_thought` | Correct/refine an existing thought in place — same id, re-embedded and re-tagged from the new content. |
| `search_thoughts` | Hybrid semantic + keyword search. |
| `list_thoughts` | List all captures, optionally filtered by type. |
| `list_rules` | Every global + current-project rule in one deterministic call — no embeddings, no ranking, ordered by id. What the hooks use under the hood. |
| `thought_stats` | Totals, type breakdown, top topics, and per-project counts. |
| `delete_thought` | Permanently delete a thought by id. |

## Notes

- If a single message states several distinct rules, `capture_thought` gets called once per rule, each relayed individually — not merged into one capture or summarized together.
- The database lives at `data/memory.db` in a git checkout, or `~/.conventions-mcp/memory.db` for the npm package (override either with `MEMORY_DB_PATH`). It's gitignored and created with private permissions. Use `conventions-mcp backup <absolute-destination>` for a live-safe, integrity-checked backup. [`docs/shared-service.md`](docs/shared-service.md) shows a scheduled setup.
- To upgrade embedding quality later without re-architecting, swap `MODEL_NAME` in `src/embeddings.js` — but re-embed existing thoughts if the new model's vector space isn't compatible with the old one (different models' embeddings aren't comparable, even at the same dimension).
