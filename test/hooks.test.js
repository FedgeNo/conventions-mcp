import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function runHook(script, payload, environment) {
  const child = spawn(process.execPath, [script], {
    env: environment,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stdin.end(JSON.stringify(payload));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  return JSON.parse(output);
}

test("hook state is session-scoped, re-armed, and confined to a private directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-hook-test-"));
  const environment = {
    ...process.env,
    XDG_RUNTIME_DIR: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
  };
  const preTool = fileURLToPath(new URL("../bin/pre-tool-check.js", import.meta.url));
  const session = fileURLToPath(new URL("../bin/session-rules.js", import.meta.url));
  const sessionId = "../../untrusted/session";

  try {
    const denied = await runHook(preTool, { session_id: sessionId, tool_name: "Read" }, environment);
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");

    assert.deepEqual(
      await runHook(preTool, { session_id: sessionId, tool_name: "mcp__conventions__list_rules" }, environment),
      {}
    );
    assert.deepEqual(await runHook(preTool, { session_id: sessionId, tool_name: "Read" }, environment), {});

    await runHook(session, { session_id: sessionId, source: "compact" }, environment);
    const deniedAgain = await runHook(preTool, { session_id: sessionId, tool_name: "Read" }, environment);
    assert.equal(deniedAgain.hookSpecificOutput.permissionDecision, "deny");

    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(directory, { recursive: true }));
    assert.equal(entries.some((entry) => entry.includes("..") || entry.includes("untrusted")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hook state never falls back to the shared system temp directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "conventions-hook-home-test-"));
  const sharedTemp = await mkdtemp(path.join(os.tmpdir(), "conventions-hook-shared-test-"));
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: sharedTemp,
    TMP: sharedTemp,
    TEMP: sharedTemp,
  };
  delete environment.XDG_RUNTIME_DIR;
  const preTool = fileURLToPath(new URL("../bin/pre-tool-check.js", import.meta.url));

  try {
    await runHook(
      preTool,
      { session_id: "home-fallback", tool_name: "mcp__conventions__list_rules" },
      environment
    );
    const homeEntries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(path.join(home, ".conventions-mcp", "hook-state"))
    );
    const tempEntries = await import("node:fs/promises").then(({ readdir }) => readdir(sharedTemp));
    assert.equal(homeEntries.length, 1);
    assert.deepEqual(tempEntries, []);
  } finally {
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(sharedTemp, { recursive: true, force: true }),
    ]);
  }
});
