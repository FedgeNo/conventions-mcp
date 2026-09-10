# Shared service setup

One Streamable HTTP process can serve multiple agents concurrently. Each MCP
client gets its own protocol session while all sessions use the same
WAL-backed SQLite database. Keep the listener on `127.0.0.1` unless an
authenticated reverse proxy provides the network trust boundary.

## Before installing the service

1. Install Node.js 20.9 or newer and install the package:

   ```bash
   npm install -g conventions-mcp --onnxruntime-node-install-cuda=skip
   conventions-mcp init-db
   conventions-mcp warmup
   ```

2. Resolve the executable rather than copying an example path:

   - Linux/macOS: `command -v conventions-mcp`
   - Windows PowerShell: `(Get-Command conventions-mcp).Source`

3. Choose a persistent database path. The installed default is
   `~/.conventions-mcp/memory.db`; set `MEMORY_DB_PATH` only when a different
   location is required. Never place credentials or machine-specific paths in
   the repository.

The service environment is:

```text
MCP_TRANSPORT=http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=47123
MCP_HTTP_MAX_SESSIONS=100
MCP_HTTP_SESSION_IDLE_MS=1800000
MCP_SHUTDOWN_TIMEOUT_MS=10000
```

`MCP_HTTP_MAX_SESSIONS` bounds simultaneously retained protocol sessions.
`MCP_HTTP_SESSION_IDLE_MS` closes sessions with no MCP request activity after
the configured interval (30 minutes by default; minimum 1000 milliseconds).
`MCP_SHUTDOWN_TIMEOUT_MS` bounds graceful transport shutdown (10 seconds by
default; minimum 1000 milliseconds). Exceeding it forces HTTP connections
closed, logs the failure, closes the database, and produces a failing exit
status for the service manager.

## Linux (systemd user service)

Create `~/.config/systemd/user/conventions-mcp.service`. Replace
`<absolute-executable-path>` with the result of `command -v conventions-mcp`.

```ini
[Unit]
Description=Shared Conventions MCP service
After=default.target

[Service]
Type=simple
ExecStart=<absolute-executable-path>
Environment=MCP_TRANSPORT=http
Environment=MCP_HTTP_HOST=127.0.0.1
Environment=MCP_HTTP_PORT=47123
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

Then enable and verify it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now conventions-mcp.service
systemctl --user status conventions-mcp.service
```

Use `loginctl enable-linger "$USER"` only when the service must run before login
or remain running after logout and local policy permits lingering.

## macOS (launchd user agent)

Create `~/Library/LaunchAgents/io.github.fedgeno.conventions-mcp.plist`, replacing
`<absolute-executable-path>` with the resolved executable path:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.fedgeno.conventions-mcp</string>
  <key>ProgramArguments</key>
  <array><string>&lt;absolute-executable-path&gt;</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MCP_TRANSPORT</key><string>http</string>
    <key>MCP_HTTP_HOST</key><string>127.0.0.1</string>
    <key>MCP_HTTP_PORT</key><string>47123</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

Load and inspect it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.fedgeno.conventions-mcp.plist
launchctl print gui/$(id -u)/io.github.fedgeno.conventions-mcp
```

## Windows (Task Scheduler)

Create a user-only PowerShell launcher outside the repository, for example in
`$env:LOCALAPPDATA\conventions-mcp\service.ps1`:

```powershell
$env:MCP_TRANSPORT = 'http'
$env:MCP_HTTP_HOST = '127.0.0.1'
$env:MCP_HTTP_PORT = '47123'
& '<absolute-executable-path>'
```

Create a Task Scheduler task that runs at user logon, runs only for that user,
and executes:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <absolute-launcher-path>
```

Configure the task to restart after failure. Start it once from Task Scheduler
and confirm its last-run result is successful. A service wrapper such as WinSW
is also suitable when operation before login is required; give it the same
command and environment variables.

## Connect agents

Point every local MCP client at:

```text
http://127.0.0.1:47123/mcp
```

Clients that advertise MCP roots are scoped automatically. Otherwise add an
`X-Conventions-Project` header containing that client's absolute project path.
Do this in project-local client configuration so different agents cannot
inherit the wrong project. Sessions without a root or header receive global
rules only and cannot create project-scoped rules.

Restart or open a new agent session after changing MCP configuration. Existing
HTTP sessions do not survive a service restart.

## Back up the database

The service holds the only copy of every rule. Schedule a daily snapshot with
the built-in online backup command. It is consistent against a live WAL
database, integrity-checks the temporary snapshot, refuses to overwrite an
existing backup, and atomically publishes the verified file:

```bash
conventions-mcp backup "<destination>/memory-$(date +%F).db"
```

Run it from the platform's scheduler — a systemd user timer with
`Persistent=true` so a machine that was asleep at the scheduled time still
runs it, a launchd agent, or a Task Scheduler task. Keep the destination
outside the database's own directory, and prune old snapshots so it doesn't
grow without bound.

## Restore a snapshot

Stop every conventions-mcp process cleanly, then provide both the snapshot and
a new rollback destination:

```bash
conventions-mcp restore "/absolute/path/to/snapshot.db" "/absolute/path/to/pre-restore-rollback.db"
```

Restore refuses relative or overlapping paths, existing rollback files,
incompatible/corrupt snapshots, and live SQLite WAL/SHM sidecars. It creates an
integrity-checked online backup of the current database first, stages and
verifies the snapshot, publishes it with same-filesystem renames, validates the
new live database, and restores the displaced database if publication fails.
Keep the rollback until the restored service passes its acceptance test.

## Verify

1. Confirm the service is listening only on `127.0.0.1:47123` and that
   `curl --fail http://127.0.0.1:47123/healthz` returns an `ok` status and the
   installed package version.
2. Connect two MCP clients with different project roots.
3. Confirm `tools/list` returns seven tools and the server version matches the
   installed package version.
4. Call `list_rules` from each client and confirm each receives global rules
   plus only its own project's rules.
5. Run `npm test` from a checkout. The suite exercises simultaneous clients,
   shared storage, input validation, and project isolation against a temporary
   database; it never modifies the real rule store.
