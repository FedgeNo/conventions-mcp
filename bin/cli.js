#!/usr/bin/env node
// The npm "bin" entry (package.json's "bin": { "conventions-mcp": "bin/cli.js" }).
// Dispatches by subcommand; each target module does its work as a top-level
// side effect on import (same as running it directly with `node <file>`),
// so a dynamic import() is enough — no need to refactor them into exported
// functions just for this.
import "../src/load-env.js";

const SUBCOMMANDS = {
  "init-db": "../src/init-db.js",
};

const [, , subcommand] = process.argv;

if (subcommand && !(subcommand in SUBCOMMANDS)) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: conventions-mcp [init-db]  (no subcommand starts the MCP server over stdio)");
  process.exit(1);
}

await import(subcommand ? SUBCOMMANDS[subcommand] : "../src/server.js");
