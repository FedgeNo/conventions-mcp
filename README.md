# playbook-mcp

Personal memory for coding conventions and standing instructions — one store, any MCP-compatible AI client, available in every project. Occasional other notes are fine too, but this is primarily meant to hold things like "always use 2-space indent in this language," "never force-push to main," corrections after getting something wrong, and workflow preferences — the kind of thing that should carry across sessions and projects rather than get re-explained every time.

## What it's tuned to store

Every capture is classified into one of five types (see the `SYSTEM_PROMPT` in `src/metadata.js`):

| Type | What it means |
|---|---|
| `convention` | A specific coding style/pattern rule (e.g. "always use 2-space indent") |
| `instruction` | A standing directive on how to work/behave (e.g. "never force-push to main") |
| `correction` | A past mistake and the corrected approach |
| `preference` | A softer preference, not a hard rule |
| `other` | Catch-all for anything that doesn't fit but still got captured |

Each thought also gets a **scope** (a language/framework/project name, or `"global"` for a universal rule) and 1–3 **topic tags** for filtering. This is deliberately narrow — it's not a general note-taking store — but the taxonomy isn't hardcoded logic, it's just the wording of that system prompt. Retuning what counts as a `convention` vs. an `instruction`, adding a new type, or changing what "scope" means is a matter of editing that prompt text, not restructuring the code. The one wrinkle: the five type names themselves are also referenced for validation in `safeParseMetadata` (`src/metadata.js`) and in the `type` filter's enum in `list_thoughts` (`src/server.js`) — if you rename or add a type, update those two spots to match or the new type will get silently coerced to `other`/rejected as a filter value. Everything's stored as a JSON blob column, so none of this needs a schema migration.

- **Storage:** SQLite (`better-sqlite3`) + `sqlite-vec` for native vector search, FTS5 for keyword search, combined via reciprocal rank fusion. One file, no server, no daemon.
- **Embeddings:** local, via `Xenova/bge-small-en-v1.5` (384-dim, quantized, ~130MB). Loads lazily on first use, no network call, no GPU needed.
- **Metadata extraction:** OpenRouter (free tier), rotated across a pool of 5 models on every call to stay under free-tier rate limits (per OpenRouter's own recommendation for handling `:free` throttling) — with automatic fallback to the next pool member on any failure. The only step that calls out to a network service. Extracts a type (`convention`/`instruction`/`correction`/`preference`/`other`), a scope (which language/project/framework it applies to, or "global"), and topic tags from each captured thought.
- **Transport:** MCP over stdio. No port, no listener, no CORS, no shared secret — the trust boundary is simply "who can launch this process," same as any other local tool.
- **Proactive retrieval:** `~/.claude/CLAUDE.md` carries a standing instruction to check this store before unfamiliar coding work, not just when explicitly asked — a tool description alone tends to make Claude wait to be asked.

## Setup

```bash
npm install
cp .env.example .env   # then fill in OPENROUTER_API_KEY
npm run init-db        # creates data/memory.db
```

## Register with Claude Code / Claude Desktop

Registered globally in `~/.claude/settings.json` under `mcpServers` (so it's available in every project, not just one repo). Uses `--env-file` to load `.env` directly rather than duplicating the API key into the config file — the secret lives in exactly one place:

```json
{
  "mcpServers": {
    "playbook": {
      "command": "node",
      "args": [
        "--env-file=/home/fedge/playbook-mcp/.env",
        "/home/fedge/playbook-mcp/src/server.js"
      ]
    }
  }
}
```

(Use absolute paths for both — Claude Code may spawn this from an arbitrary working directory, so a relative `.env` path would silently fail to resolve.)

## Tools

| Tool | Description |
|---|---|
| `capture_thought` | Save a convention, instruction, correction, or preference. Embeds locally, extracts metadata via OpenRouter. |
| `update_thought` | Correct/refine an existing thought in place — same id, re-embedded and re-tagged from the new content. |
| `search_thoughts` | Hybrid semantic + keyword search. |
| `list_thoughts` | List recent captures, optionally filtered by type or time range. |
| `thought_stats` | Totals, type breakdown, top topics, and scopes. |
| `delete_thought` | Permanently delete a thought by id. |

## Notes

- Metadata extraction rotates through a pool of free OpenRouter models (`src/metadata.js` → `DEFAULT_MODEL_POOL`) and falls back to the next one on any failure — if all 5 fail (rare — would mean the whole pool is simultaneously throttled or one has gone away), `capture_thought` still saves the thought and its embedding with default/empty metadata rather than failing the capture outright.
- OpenRouter's free-model catalog rotates — if the pool starts failing entirely, check current free models at `https://openrouter.ai/api/v1/models` (filter for `pricing.prompt == "0"`) and set `OPENROUTER_MODEL_POOL` in `.env` to a replacement list.
- `data/memory.db` holds everything you capture. It's gitignored — back it up yourself if you care about it (it's just a SQLite file; `cp data/memory.db data/memory.db.bak` is a complete backup).
- To upgrade embedding quality later without re-architecting, swap `MODEL_NAME` in `src/embeddings.js` — but re-embed existing thoughts if the new model's vector space isn't compatible with the old one (different models' embeddings aren't comparable, even at the same dimension).
