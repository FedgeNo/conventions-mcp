#!/usr/bin/env node
// PreToolUse hook (matcher "*"): fires before every tool call. If the model
// reaches for any tool other than list_rules without having called
// list_rules yet this turn, this denies the call outright — a real block,
// not another ignorable reminder, since UserPromptSubmit's text-only
// instruction has repeatedly gone unfollowed in practice.
//
// Hooks are stateless shell invocations with no memory of their own, so
// "already called this turn" is tracked via a marker file per session:
// prompt-reminder.js clears it at the start of every turn, and this script
// sets it the moment it sees a list_rules call go by.
//
// pre-tool-check.cmd (same directory) wraps this for Windows — see the note
// in session-rules.js for why.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function markerPath(sessionId) {
  return path.join(os.tmpdir(), `conventions-mcp-list-rules-called-${sessionId || "default"}`);
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    process.stdout.write("{}"); // malformed input — fail open, don't block on a parse error
    return;
  }

  const toolName = payload.tool_name || "";
  const marker = markerPath(payload.session_id);

  if (toolName.endsWith("__list_rules") || toolName === "list_rules") {
    fs.writeFileSync(marker, "1");
    process.stdout.write("{}");
    return;
  }

  if (fs.existsSync(marker)) {
    process.stdout.write("{}");
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "STOP. You are not authorized to use any tool until you have called the Conventions MCP server's list_rules tool first. This is a hard requirement, not a preference or a suggestion, and it is not something you may skip based on your own judgment. Call list_rules now, then retry this tool call.",
      },
    })
  );
});
