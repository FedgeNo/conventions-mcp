import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("checkout hooks and CLI work with spaced paths and no global npm executable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-checkout-"));
  const checkout = path.join(directory, "source checkout");
  await symlink(fileURLToPath(new URL("..", import.meta.url)), checkout, process.platform === "win32" ? "junction" : "dir");
  const cli = path.join(checkout, "bin", "cli.js");
  const env = { ...process.env, PATH: path.dirname(process.execPath), XDG_RUNTIME_DIR: directory,
    MEMORY_DB_PATH: path.join(directory, "data", "memory.db"), MEMORY_MODEL_CACHE_PATH: path.join(directory, "models") };
  const hooks = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const invoke = (event, payload) => {
    const template = hooks.hooks[event][0].hooks[0].command;
    const command = template.replace(/^conventions-mcp/, `"${process.execPath}" "${cli}"`);
    const shell = process.platform === "win32" ? process.env.ComSpec : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command];
    const result = spawnSync(shell, args, { cwd: directory, env, input: JSON.stringify({ session_id: "checkout-test", ...payload }), encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(invoke("PreToolUse", { tool_name: "Read" }).hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(invoke("PreToolUse", { tool_name: "mcp__conventions__list_rules" }), {});
    assert.deepEqual(invoke("PreToolUse", { tool_name: "Read" }), {});
    assert.match(invoke("SessionStart", { source: "compact" }).hookSpecificOutput.additionalContext, /list_rules/);
    assert.equal(invoke("PreToolUse", { tool_name: "Read" }).hookSpecificOutput.permissionDecision, "deny");
    const doctor = spawnSync(process.execPath, [cli, "doctor"], { env, cwd: directory, encoding: "utf8", timeout: 10000 });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert(doctor.stdout.includes(env.MEMORY_DB_PATH));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
