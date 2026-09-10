# Upgrade, migration, restore, and rollback

Treat the database, its WAL state, and its embedding format as one durable
asset. Never copy a live `memory.db` directly while a server is running.

## Before upgrading

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
