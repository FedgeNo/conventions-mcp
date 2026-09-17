#!/usr/bin/env node
// The npm "bin" entry (package.json's "bin": { "conventions-mcp": "bin/cli.js" }).
// Dispatches by subcommand; each target module does its work as a top-level
// side effect on import (same as running it directly with `node <file>`),
// so a dynamic import() is enough — no need to refactor them into exported
// functions just for this.
import "../src/load-env.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const usage = `Usage: conventions-mcp [command]

Run without a command to start the MCP server.

Commands:
  init-db                         Initialize the database
  backup <absolute-path>          Create and verify an online backup
  warmup                          Download and verify the embedding model
  doctor                          Validate runtime, storage, and model readiness
  migrate-storage <backup-path>   Back up and reindex legacy storage
  migrate-project <path> <backup> Back up and assign a legacy project scope
  restore <source> <rollback>     Restore a verified snapshot with rollback
  codex-project-header            Print the active project HTTP header as JSON
  hook-session-rules              Run the SessionStart hook
  hook-pre-tool-check             Run the PreToolUse hook
  --help, -h                      Show this help
  --version, -v                   Show the installed version`;

const SUBCOMMANDS = new Set([
  "init-db",
  "backup",
  "warmup",
  "doctor",
  "migrate-storage",
  "migrate-project",
  "restore",
  "codex-project-header",
  "hook-session-rules",
  "hook-pre-tool-check",
]);

const [, , subcommand, ...args] = process.argv;

if (["--help", "-h"].includes(subcommand)) {
  console.log(usage);
  process.exit(0);
} else if (["--version", "-v"].includes(subcommand)) {
  console.log(version);
  process.exit(0);
} else if (subcommand && !SUBCOMMANDS.has(subcommand)) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(usage);
  process.exit(1);
}

if (subcommand === "init-db") {
  await import("../src/init-db.js");
} else if (subcommand === "backup") {
  if (args.length !== 1) {
    console.error("Usage: conventions-mcp backup <absolute-path>");
    process.exit(1);
  }
  const { backupDatabase, closeDb } = await import("../src/db.js");
  try {
    await backupDatabase(args[0]);
    console.log(`Verified backup created: ${args[0]}`);
  } catch (error) {
    // Scheduled runs land in a service log — one clear line, not a stack.
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
} else if (subcommand === "warmup") {
  const { embed } = await import("../src/embeddings.js");
  await embed("Initialize the local conventions search model.");
  console.log("Embedding model is ready.");
} else if (subcommand === "doctor") {
  const { runDoctor } = await import("../src/doctor.js");
  if (!runDoctor()) process.exitCode = 1;
} else if (subcommand === "migrate-storage") {
  if (args.length !== 1) {
    console.error("Usage: conventions-mcp migrate-storage <absolute-backup-path>");
    process.exit(1);
  }
  const { embed } = await import("../src/embeddings.js");
  const { closeDb, migrateLegacyStorage } = await import("../src/db.js");
  try {
    const migrated = await migrateLegacyStorage(args[0], embed);
    console.log(migrated ? `Legacy storage backed up to ${args[0]} and reindexed.` : "Storage format is already current.");
  } finally {
    closeDb();
  }
} else if (subcommand === "migrate-project") {
  if (args.length !== 2) {
    console.error("Usage: conventions-mcp migrate-project <absolute-project-path> <absolute-backup-path>");
    process.exit(1);
  }
  const { migrateProjectScope, closeDb } = await import("../src/db.js");
  try {
    console.log(`Migrated ${await migrateProjectScope(args[0], args[1])} project rules.`);
  } catch (error) {
    console.error(`Project migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally { closeDb(); }
} else if (subcommand === "restore") {
  if (args.length !== 2) {
    console.error("Usage: conventions-mcp restore <absolute-source> <absolute-rollback-destination>");
    process.exit(1);
  }
  const { restoreDatabase } = await import("../src/db.js");
  await restoreDatabase(args[0], args[1]);
  console.log(`Restored ${args[0]}; previous database preserved at ${args[1]}.`);
} else if (subcommand === "codex-project-header") {
  console.log(JSON.stringify({ "X-Conventions-Project": process.cwd() }));
} else if (subcommand === "hook-session-rules") {
  await import("./session-rules.js");
} else if (subcommand === "hook-pre-tool-check") {
  await import("./pre-tool-check.js");
} else {
  const { runHTTPServer, runStdioServer } = await import("../src/server.js");
  if (process.env.MCP_TRANSPORT === "http") {
    await runHTTPServer();
  } else {
    await runStdioServer();
  }
}
