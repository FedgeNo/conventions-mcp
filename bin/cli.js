#!/usr/bin/env node
// The npm "bin" entry (package.json's "bin": { "conventions-mcp": "bin/cli.js" }).
// Dispatches by subcommand; each target module does its work as a top-level
// side effect on import (same as running it directly with `node <file>`),
// so a dynamic import() is enough — no need to refactor them into exported
// functions just for this.
import "../src/load-env.js";

const SUBCOMMANDS = new Set(["init-db", "backup", "warmup"]);

const [, , subcommand, ...args] = process.argv;

if (subcommand && !SUBCOMMANDS.has(subcommand)) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: conventions-mcp [init-db | backup <absolute-path> | warmup]");
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
  } finally {
    closeDb();
  }
} else if (subcommand === "warmup") {
  const { embed } = await import("../src/embeddings.js");
  await embed("Initialize the local conventions search model.");
  console.log("Embedding model is ready.");
} else {
  const { runHTTPServer, runStdioServer } = await import("../src/server.js");
  if (process.env.MCP_TRANSPORT === "http") {
    await runHTTPServer();
  } else {
    await runStdioServer();
  }
}
