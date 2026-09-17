# Upgrade, migration, restore, and rollback

Treat the database, its WAL state, and its embedding format as one durable
asset. Never copy a live `memory.db` directly while a server is running.

## Before upgrading

Version 4.0.0 requires explicit migration of legacy project scopes before scoped
operations resume; global rules are unaffected. See Project scope migration
below. Database parents must already be private on POSIX systems: choose a
dedicated directory with mode 0700 instead of relying on automatic chmod.

1. Resolve the active database path with `conventions-mcp doctor`.
2. Create a new absolute-path snapshot:

   ```bash
   conventions-mcp backup "/absolute/backup/directory/memory-before-upgrade.db"
   ```

3. Stop every conventions-mcp process cleanly. For a shared service, confirm
   the service manager reports it stopped and that `memory.db-wal` and
   `memory.db-shm` are absent.
4. Upgrade the package using the installation runbook, then run
   `conventions-mcp doctor` before restarting clients.

## Storage compatibility

The database records its schema version, embedding model, and embedding
dimension. A declared mismatch is rejected: never edit `app_metadata` to make
an incompatible store appear current. Different embedding models are not
comparable even when they produce vectors with the same dimension.

A non-empty legacy database without metadata is also rejected because its
vector origin cannot be inferred safely. Migrate it explicitly:

```bash
conventions-mcp migrate-storage "/absolute/backup/directory/legacy-before-migration.db"
```

The destination must not exist. Migration creates and verifies the backup
before embedding any rows, computes every replacement vector before changing
the vector table, and writes the vectors and format metadata in one
transaction. The current embedding model must already be available or
downloadable; run `conventions-mcp warmup` first when installing offline.

## Project scope migration

New project IDs preserve the normalized absolute path with a `path:` prefix.
Older IDs replaced separators with hyphens, so distinct paths can collide.
The server refuses to silently adopt those rules for a new path identity.

Use `list_thoughts` to review the old records and establish which project owns
them, then run:

```bash
conventions-mcp migrate-project "/absolute/project/path" "/absolute/backups/project-before-migration.db"
```

For a checkout, invoke `node /absolute/checkout/bin/cli.js` instead of the
installed command. Keep MEMORY_DB_PATH set to the same database as the service.
The command makes a verified backup, retains record IDs/content/vectors, and
changes only the matching legacy scope. Run it once for each known project.
If an old ID contains rules from multiple colliding paths, separate those
records by verified ownership before using this whole-scope operation.
Global rules and the all-record management view remain available beforehand.
Older server versions do not understand the new scope IDs; migrate all clients
to the current server before resuming scoped operations.

## Restore

Keep all services stopped and run:

```bash
conventions-mcp restore "/absolute/backup/directory/snapshot.db" \
  "/absolute/backup/directory/live-before-restore.db"
```

The second path is mandatory rollback storage and must not exist. Restore
rejects live WAL/SHM sidecars, validates the source's integrity and format,
creates an online verified backup of the current database, stages the source
beside the live file, and validates the published database. If publication or
final validation fails, it puts the displaced live database back.

After restore, run `conventions-mcp doctor`, start the service, call
`list_rules`, and perform the disposable capture/list/delete acceptance test
from [`install.md`](install.md). Retain the rollback database until those checks
pass.

Restore stages the source using SQLite's backup API, including committed source
WAL records. Keep the destination service stopped during restore. Backup and
restore staging is private from file creation, including in an existing shared
backup directory.

## Downgrade and rollback

In-place downgrade of a database written by a newer storage format is not
supported. Do not install an older package over a migrated store and do not
decrease metadata version values manually.

To roll back an application upgrade:

1. Stop the new service cleanly.
2. Reinstall the previous application version.
3. Restore the snapshot created before the upgrade, providing a separate new
   rollback destination for the current database.
4. Run the previous version's diagnostics and end-to-end acceptance test.

If no compatible pre-upgrade snapshot exists, preserve the database unchanged
and upgrade the application instead of attempting a destructive downgrade.

## Publishing a release

Update the version together in `package.json`, `package-lock.json` (including
its root package entry), and both version fields in `server.json`. A push to
`main` that changes `package.json` triggers `.github/workflows/publish.yml`.
The workflow checks npm first and skips an already-published version. Registry
errors fail the job rather than being mistaken for an unpublished version.
Manual dispatch on main remains available for retries.

The workflow runs tests, documentation/package checks, and the dependency
audit, then installs and validates the exact tarball it publishes. Publishing
uses the existing npm trusted publisher for this repository and workflow; no
local npm installation or publishing token is needed. Keep that workflow
filename stable because it is part of the trusted publisher identity.

A root-only package override is not sufficient to control transitive
dependencies when someone else installs the package. Review the dependency
ranges of the published package as well as the checkout's lockfile.
