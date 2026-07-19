#!/usr/bin/env node
// The npm "bin" entry (package.json's "bin": { "conventions-mcp": "bin/cli.js" }).
// Dispatches by subcommand; each target module does its work as a top-level
// side effect on import (same as running it directly with `node <file>`),
// so a dynamic import() is enough — no need to refactor them into exported
// functions just for this.
import "../src/load-env.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_DIR = path.join(os.homedir(), ".conventions-mcp");
const CONFIG_ENV_PATH = path.join(CONFIG_DIR, ".env");

// A missing OPENROUTER_API_KEY already fails loud downstream (extractMetadata
// throws), but a first-time installed user has no `.env` to even discover —
// bootstrap the config directory from the package's own .env.example rather
// than let them hunt for where a config file is even supposed to go. Never
// fills in a real key — just gets the template in place and stops.
function bootstrapConfigIfMissing() {
  if (fs.existsSync(CONFIG_ENV_PATH)) return false;

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const template = path.join(__dirname, "..", ".env.example");
  fs.copyFileSync(template, CONFIG_ENV_PATH);
  console.error(`No config found — created ${CONFIG_ENV_PATH} from the template.`);
  console.error("Fill in OPENROUTER_API_KEY there, then run this again.");
  return true;
}

const SUBCOMMANDS = {
  "init-db": "../src/init-db.js",
  "check-key": "../bin/check-api-key.js",
};

const [, , subcommand] = process.argv;

if (subcommand && !(subcommand in SUBCOMMANDS)) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: conventions-mcp [init-db|check-key]  (no subcommand starts the MCP server over stdio)");
  process.exit(1);
}

if (bootstrapConfigIfMissing()) {
  process.exit(1);
}

await import(subcommand ? SUBCOMMANDS[subcommand] : "../src/server.js");
