# Installation and client integration

This is the canonical runbook for a person or coding agent installing
Conventions MCP. Do not guess machine-specific paths or overwrite existing
client configuration. Commands below assume a shell unless marked PowerShell.

## 1. Choose an operating mode

Use **stdio** for the simplest single-client installation. The MCP client
starts one server process per session. Use the **shared HTTP service** only
when several clients need one long-running process; complete
[`shared-service.md`](shared-service.md) before registering clients.

Choose one source:

- **Published package (recommended for users):** `npm install -g conventions-mcp --onnxruntime-node-install-cuda=skip`
- **Git checkout (development):** clone the repository and run `npm install`
  in its root. Use the checkout's absolute paths in client configuration.

Requirements are Node.js 20.9 or newer and enough disk space for the local
embedding model (approximately 130 MB, plus npm dependencies). The first
embedding call downloads the model from Hugging Face; `warmup` makes that
network-dependent step explicit during installation. The repository's tracked
`.npmrc` disables ONNX Runtime's unused CUDA artifact download; this server
runs CPU inference.

## 2. Install and validate the server

### Published package

```bash
node --version
npm install -g conventions-mcp --onnxruntime-node-install-cuda=skip
conventions-mcp --version
conventions-mcp init-db
conventions-mcp warmup
conventions-mcp doctor
command -v conventions-mcp       # Linux/macOS
```

On PowerShell, replace the last command with:

```powershell
(Get-Command conventions-mcp).Source
```

### Git checkout

```bash
node --version
npm install
npm run init-db
npm run warmup
npm test
```

The default database is `data/memory.db` in a checkout and
`~/.conventions-mcp/memory.db` for an installed package. To override it, set
`MEMORY_DB_PATH` in the process environment or in
`~/.conventions-mcp/.env`. Create that file with user-only permissions and do
not put it in a repository. The model cache defaults to the persistent
`~/.conventions-mcp/models` directory and can be overridden with
`MEMORY_MODEL_CACHE_PATH`. No API key is used.

`conventions-mcp doctor` validates the Node.js version, SQLite integrity,
vector table, data path, POSIX privacy modes, and embedding cache without
downloading the model. A missing model is a warning so the command is useful
before `warmup`; database or runtime failures produce a nonzero exit status.
If an older non-empty database has no format metadata, the server refuses to
guess which model produced its vectors. Run
`conventions-mcp migrate-storage <absolute-backup-path>`: it first creates and
verifies that backup, then re-embeds every stored rule with the current model
and records the schema, model, and dimension.

## 3. Register an MCP client

For a stdio client, register a server named **`conventions`** with one of these
command/argument pairs:

| Installation | Command | Arguments |
|---|---|---|
| npm package | `conventions-mcp` | none |
| Git checkout | `node` | `/absolute/path/to/conventions-mcp/src/server.js` |

Use the client's user/global scope when the memory should be available in every
project. Preserve unrelated configuration when editing JSON, TOML, or another
client config format. If the client's syntax is unknown, consult that client's
current official documentation rather than inventing a key or file location.
After registration, restart the client and verify that it reports all seven
tools listed in the README.

For a shared service, register the URL `http://127.0.0.1:47123/mcp` instead.
Project-scoped rules require either MCP roots or an
`X-Conventions-Project` header containing the absolute workspace path. Never
expose this unauthenticated HTTP listener beyond loopback.

### Claude Code

```bash
# npm package
claude mcp add --scope user conventions -- conventions-mcp

# Git checkout
claude mcp add --scope user conventions -- node /absolute/path/to/conventions-mcp/src/server.js

claude mcp list
```

Then install the three hooks exactly as described in `AGENTS.md` under
“Claude Code only.” Merge them into `~/.claude/settings.json`; do not replace
existing hooks. Start a new session afterward.

### Codex

Register the stdio command above using Codex's MCP configuration. For a shared
HTTP service, use:

```toml
[mcp_servers.conventions]
url = "http://127.0.0.1:47123/mcp"
http_headers_helper = "conventions-mcp codex-project-header"
```

Merge `hooks/hooks.json` into `~/.codex/hooks.json`, preserving existing hooks,
and review it with `/hooks`. Start a new session afterward.

### Other MCP clients

Other clients can use the stdio command pair or HTTP URL above. The bundled
standing-rule enforcement hooks are client-specific: if the client cannot run
them, add a durable client instruction to call `list_rules` at session start
and after context resets. This is advisory, not equivalent to the enforced
Codex/Claude Code gate.

## 4. End-to-end acceptance test

Do not consider installation complete merely because the process starts.
In a fresh client session:

1. Confirm the server named `conventions` is connected and exposes seven tools.
2. Call `list_rules`; an empty database should return `No rules found.`
3. Capture a clearly disposable test rule with all classification fields, for
   example content `Use a disposable installation verification rule.`, type
   `instruction`, topics `["installation"]`, and `projectScoped: false`.
4. Confirm the response echoes the exact text and says it is global.
5. Call `list_rules` and confirm the new row is present.
6. Call `delete_thought` with the returned numeric id and confirm deletion.
7. For Codex or Claude Code, start another fresh test session and attempt a
   non-`list_rules` tool first; the pre-tool hook should deny it until
   `list_rules` is attempted.

Never leave the disposable rule in the user's real database.

## Troubleshooting

- **Command not found:** resolve the global npm bin location, or use the
  checkout's absolute `node` script path. Do not rely on the current directory.
- **Model download fails:** check access to Hugging Face, proxy/CA settings,
  and available disk space, then rerun `conventions-mcp warmup`.
- **Native module install fails:** use a supported Node.js release and CPU
  architecture. `better-sqlite3` and `sqlite-vec` normally use prebuilt
  binaries; a source-build fallback requires a compiler toolchain.
- **Server is registered but absent:** restart the client. For Claude Code,
  verify with `claude mcp list`; if hooks remain absent, open `/hooks` once.
- **Project-scoped capture fails over HTTP:** configure an MCP root or the
  absolute `X-Conventions-Project` header. An unscoped HTTP session is global
  only by design.
- **Database is busy:** verify only supported server versions use the file and
  that the database resides on a local filesystem. Do not place a live SQLite
  database on a network share.
- **Before upgrades:** create a verified backup with
  `conventions-mcp backup <absolute-destination>`, follow
  [`upgrading.md`](upgrading.md), then rerun the acceptance test.
