// Side-effect module: loads ~/.conventions-mcp/.env into process.env, without
// overriding anything already set — a real shell env var or Node's own
// --env-file flag always wins. Only meaningful for installed use (the
// `conventions-mcp` bin command, or a hook script run standalone): a git
// checkout's `npm run` scripts already get their env from --env-file=.env
// before any script code runs, so this is a no-op there unless the file
// happens to exist too.
//
// Import this FIRST in any entry point that reads process.env at module
// load time (db.js's DB_PATH) — ES module static imports evaluate in order,
// so a leading `import "./load-env.js"` (or "../src/load-env.js" from bin/)
// guarantees this runs before those reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_ENV_PATH = path.join(os.homedir(), ".conventions-mcp", ".env");

if (fs.existsSync(CONFIG_ENV_PATH)) {
  const lines = fs.readFileSync(CONFIG_ENV_PATH, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const isQuoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) value = value.slice(1, -1);

    if (key && !(key in process.env)) process.env[key] = value;
  }
}
