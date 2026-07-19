# conventions-mcp

Personal memory for coding conventions and standing instructions — one store, any MCP-compatible AI client, available in every project. Occasional other notes are fine too, but this is primarily meant to hold things like "always use 2-space indent in this language," "never force-push to main," corrections after getting something wrong, and workflow preferences — the kind of thing that should carry across sessions and projects rather than get re-explained every time.

## Why this one

There's no shortage of memory MCP servers — several well-established ones (mem0/OpenMemory, Zep/Graphiti, the official reference memory server, plus a long tail of smaller projects) already do "remember things across sessions." What's different here:

- **Narrow taxonomy, not a general note-taking store.** Every capture gets forced into one of five purpose-built types — convention, instruction, correction, preference, other — plus a scope and a project field. A general "remember anything" store gives you a pile of loosely-related notes to search through; this one is opinionated about what belongs in it at all, which keeps retrieval precise instead of noisy.
- **Deterministic retrieval, not best-effort.** Most memory MCPs rely entirely on the calling model noticing a tool description is relevant and deciding to call it — which fails silently and inconsistently. Two Claude Code hooks here (`SessionStart`, `UserPromptSubmit`) load and re-remind about standing rules on a fixed schedule, independent of whether any given model happens to notice. If you're not on Claude Code, you still get the tool descriptions, just not the hook guarantee.
- **Transparent by default, not silent.** Every capture and update echoes the verbatim stored content and its scope back immediately, so a misheard or misclassified rule is visible and correctable on the spot — not something you discover three sessions later via search. If OpenRouter's classification step fails outright, that's flagged explicitly too (a placeholder tag, not a silently wrong one).
- **Fully local storage and embeddings, free-tier-friendly.** SQLite + local embeddings, no hosted service, no per-token embedding costs. The one network call (metadata classification) runs against OpenRouter's free tier by design, with a real per-user API key rather than a shared quota.
- **Project-scoped without fuzzy matching.** A rule can be global (the default) or tied to one specific codebase, and which project it belongs to is derived from the actual git repo, not guessed by an LLM from free text — so retrieval doesn't depend on an LLM having phrased a project name consistently across captures.

If what you want is a general-purpose "remember everything" store, or you're not on Claude Code and don't need the hook-driven determinism, one of the more general options above may fit better. This one is for someone who specifically wants a tight, coding-convention-focused memory that stays accurate and doesn't require trusting the model to remember to check it.

## What it's tuned to store

Every capture is classified into one of five types (see the `SYSTEM_PROMPT` in `src/metadata.js`):

| Type | What it means |
|---|---|
| `convention` | A specific coding style/pattern rule (e.g. "always use 2-space indent") |
| `instruction` | A standing directive on how to work/behave (e.g. "never force-push to main") |
| `correction` | A past mistake and the corrected approach |
| `preference` | A softer preference, not a hard rule |
| `other` | Catch-all for anything that doesn't fit but still got captured |

Each thought also gets a **scope** (a language/framework/topic, or `"global"`) and 1–3 **topic tags** for filtering. This is deliberately narrow — it's not a general note-taking store — but the taxonomy isn't hardcoded logic, it's just the wording of that system prompt. Retuning what counts as a `convention` vs. an `instruction`, adding a new type, or changing what "scope" means is a matter of editing that prompt text, not restructuring the code. The one wrinkle: the five type names themselves are also referenced for validation in `safeParseMetadata` (`src/metadata.js`) and in the `type` filter's enum in `list_thoughts` (`src/server.js`) — if you rename or add a type, update those two spots to match or the new type will get silently coerced to `other`/rejected as a filter value. Everything's stored as a JSON blob column, so none of this needs a schema migration.

Separately, every thought gets a **project** field — `null` by default (applies everywhere), or a specific project name if it's obviously scoped to one codebase. The LLM only judges *whether* it's project-specific; the actual project name is derived deterministically from the current git repo's directory name, not guessed by the model — so retrieval can do an exact match instead of fuzzy text comparison.

- **Storage:** SQLite (`better-sqlite3`) + `sqlite-vec` for native vector search, FTS5 for keyword search, combined via reciprocal rank fusion. One file, no server, no daemon.
- **Embeddings:** local, via `Xenova/bge-small-en-v1.5` (384-dim, quantized, ~130MB). Loads lazily on first use, no network call, no GPU needed.
- **Metadata extraction:** OpenRouter (free tier), rotated across a pool of 5 models on every call to stay under free-tier rate limits (per OpenRouter's own recommendation for handling `:free` throttling) — with automatic fallback to the next pool member on any failure. The only step that calls out to a network service. Extracts a type (`convention`/`instruction`/`correction`/`preference`/`other`), a scope (which language/project/framework it applies to, or "global"), and topic tags from each captured thought.
- **Transport:** MCP over stdio. No port, no listener, no CORS, no shared secret — the trust boundary is simply "who can launch this process," same as any other local tool.
- **Proactive retrieval:** two Claude Code hooks (see below) load and re-remind about standing rules deterministically every session and every turn — no CLAUDE.md instruction to keep in sync, no dependence on the model happening to notice a tool description is relevant.

## Setup

Two ways to get this: a git checkout (if you want to read/modify the source) or the npm package (if you just want it running).

**Git checkout:**
```bash
npm install
cp .env.example .env   # then fill in OPENROUTER_API_KEY
npm run check-key      # validates the key before you go any further
npm run init-db        # creates data/memory.db
```

**npm package:**
```bash
npm install -g conventions-mcp
conventions-mcp            # first run creates ~/.conventions-mcp/.env from the template and exits
# fill in OPENROUTER_API_KEY in ~/.conventions-mcp/.env, then:
conventions-mcp check-key  # validates the key before you go any further
conventions-mcp init-db    # creates ~/.conventions-mcp/memory.db
```

**Always validate the key (`check-key`) before registering the server anywhere.** A
wrong key makes every capture silently fall back to generic
`other`/`global`/`uncategorized` tagging. It calls OpenRouter's own
`GET /api/v1/key` (a free lookup, not a chat completion) to confirm the key
is genuinely valid before you wire anything else up around it.

## Register with Claude Code

Register at **user scope** so it's available in every project, not just one repo — use the `claude mcp add` CLI, not a hand-edited config file:

```bash
# Git checkout — absolute paths, since Claude Code may spawn this from an
# arbitrary working directory and a relative .env path would silently fail:
claude mcp add --scope user conventions -- node --env-file=/absolute/path/to/conventions-mcp/.env /absolute/path/to/conventions-mcp/src/server.js

# npm package — already on PATH, and it loads ~/.conventions-mcp/.env itself:
claude mcp add --scope user conventions -- conventions-mcp
```

Either way, this writes to `~/.claude.json`'s `mcpServers` key, which is what the CLI actually reads; a `mcpServers` entry placed directly in `~/.claude/settings.json` is silently inert. Verify with `claude mcp list`. A new Claude Code session is required to pick up a newly-registered server.

## Standing-rule hooks

Two hooks in `~/.claude/settings.json` make retrieval deterministic every session and every turn:

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

- `bin/session-rules.js` loads every global + current-project rule into context before the model's first action each session.
- `bin/prompt-reminder.js` fires on every turn, re-anchoring "keep following the loaded rules" and "capture this if it's a new one" — there's no hook event for "the user just stated a rule," since that's a semantic judgment only the model can make.

Both read the current project from the session's working directory, so they work correctly regardless of where the `conventions-mcp` install itself lives on disk.

**npm package:** the scripts live inside the global install rather than a known clone path — resolve it first with `npm root -g`, then point the hook at `$(npm root -g)/conventions-mcp/bin/session-rules.js` the same way.

**Windows:** point the `command` at the `.cmd` wrapper instead of the `.js` file directly (no `node` prefix — the batch file invokes it) — `bin\session-rules.cmd` / `bin\prompt-reminder.cmd` for a git checkout, or the equivalent path under `npm root -g` for the npm package.

## Tools

| Tool | Description |
|---|---|
| `capture_thought` | Save a convention, instruction, correction, or preference. Embeds locally, extracts metadata via OpenRouter. |
| `update_thought` | Correct/refine an existing thought in place — same id, re-embedded and re-tagged from the new content. |
| `search_thoughts` | Hybrid semantic + keyword search. |
| `list_thoughts` | List recent captures, optionally filtered by type or time range. |
| `list_rules` | Every global + current-project rule in one deterministic call — no embeddings, no ranking. What the hooks use under the hood. |
| `thought_stats` | Totals, type breakdown, top topics, and scopes. |
| `delete_thought` | Permanently delete a thought by id. |

## Notes

- Metadata extraction rotates through a pool of free OpenRouter models (`src/metadata.js` → `DEFAULT_MODEL_POOL`) and falls back to the next one on any failure — if all 5 fail (rare — would mean the whole pool is simultaneously throttled or one has gone away), `capture_thought` still saves the thought and its embedding, with placeholder metadata and a ⚠️ warning in the response saying so explicitly. Re-run `update_thought` on that id once the pool's working again to get a real classification.
- OpenRouter's free-model catalog rotates — if the pool starts failing entirely, check current free models at `https://openrouter.ai/api/v1/models` (filter for `pricing.prompt == "0"`) and set `OPENROUTER_MODEL_POOL` in `.env` to a replacement list.
- If a single message states several distinct rules, `capture_thought` gets called once per rule, each relayed individually — not merged into one capture or summarized together.
- The database lives at `data/memory.db` in a git checkout, or `~/.conventions-mcp/memory.db` for the npm package (override either with `MEMORY_DB_PATH`). It's gitignored — back it up yourself if you care about it (it's just a SQLite file; `cp` is a complete backup).
- To upgrade embedding quality later without re-architecting, swap `MODEL_NAME` in `src/embeddings.js` — but re-embed existing thoughts if the new model's vector space isn't compatible with the old one (different models' embeddings aren't comparable, even at the same dimension).
