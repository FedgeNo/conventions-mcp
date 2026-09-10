import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

test("CLI exposes help without starting the server", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "--help"]);
  assert.match(stdout, /^Usage: conventions-mcp \[command\]/);
  assert.match(stdout, /backup <absolute-path>/);
  assert.equal(stderr, "");
});

test("CLI reports the installed package version", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "--version"]);
  assert.equal(stdout, `${version}\n`);
  assert.equal(stderr, "");
});
