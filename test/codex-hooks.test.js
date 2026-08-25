import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hooks = JSON.parse(
  await readFile(new URL("../hooks/hooks.json", import.meta.url), "utf8")
);

test("Codex forces the agent to load standing rules at every context boundary", () => {
  const sessionStart = hooks.hooks.SessionStart;
  const preToolUse = hooks.hooks.PreToolUse;

  assert.equal(sessionStart.length, 1);
  assert.equal(sessionStart[0].matcher, "^(startup|resume|clear|compact)$");
  assert.deepEqual(sessionStart[0].hooks, [
    {
      type: "command",
      command: "conventions-mcp hook-session-rules",
      timeout: 5,
      statusMessage: "Checking standing conventions",
    },
  ]);

  assert.equal(preToolUse.length, 1);
  assert.equal(preToolUse[0].matcher, "*");
  assert.deepEqual(preToolUse[0].hooks, [
    {
      type: "command",
      command: "conventions-mcp hook-pre-tool-check",
      timeout: 5,
      statusMessage: "Checking standing conventions",
    },
  ]);
});
