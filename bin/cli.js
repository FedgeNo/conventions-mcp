#!/usr/bin/env node
// The npm "bin" entry (package.json's "bin": { "conventions-mcp": "bin/cli.js" }).
// Dispatches by subcommand; each target module does its work as a top-level
// side effect on import (same as running it directly with `node <file>`),
// so a dynamic import() is enough — no need to refactor them into exported
// functions just for this.
import "../src/load-env.js";

const SUBCOMMANDS = new Set(["init-db"]);

const [, , subcommand] = process.argv;

if (subcommand && !SUBCOMMANDS.has(subcommand)) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: conventions-mcp [init-db]  (no subcommand starts the configured MCP transport)");
  process.exit(1);
}

if (subcommand === "init-db") {
  await import("../src/init-db.js");
} else {
  const { runHTTPServer, runStdioServer } = await import("../src/server.js");
  if (process.env.MCP_TRANSPORT === "http") {
    await runHTTPServer();
  } else {
    await runStdioServer();
  }
}
