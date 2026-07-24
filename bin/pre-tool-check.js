#!/usr/bin/env node
// PreToolUse hook (matcher "*"): the enforcement backstop for the "load the
// rules" directive that session-rules.js issues at session start. If the
// model reaches for any tool other than list_rules before it has loaded the
// rules, this denies the call outright — a real block, not another ignorable
// reminder, since a text-only directive can go unfollowed.
//
// "Already loaded" is tracked via a per-session marker file (hooks are
// stateless, with no memory of their own): this script writes the marker the
// moment it sees a list_rules call go by, and session-rules.js removes it at
// the boundaries where the loaded rules leave context — after compaction and
// after /clear — so the model is forced to reload before its next tool use.
// Between those boundaries the marker persists, so list_rules is forced once,
// not once per turn.
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
