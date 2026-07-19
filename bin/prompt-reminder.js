#!/usr/bin/env node
// UserPromptSubmit hook: fires every turn. Re-invokes list_rules on every
// turn rather than relying on rule text loaded once at session start —
// embedded text can scroll out of context over a long session, and (see
// session-rules.js) a large enough rule set gets silently truncated before
// it ever reaches the model in the first place. A tool call has neither
// problem: it always returns the current full set, fresh, on demand.
//
// Also clears the per-session "list_rules already called this turn" marker
// that pre-tool-check.js (PreToolUse) reads — a fresh turn means the model
// hasn't called it yet regardless of what happened last turn.
//
// This also re-anchors the other standing obligation every turn: no hook
// event fires on "the user just stated a rule" — that's a semantic
// judgment only the model can make.
//
// prompt-reminder.cmd (same directory) wraps this for Windows — see the
// note in session-rules.js for why.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    // Malformed input — still emit the reminder, just can't scope the marker.
  }

  const marker = path.join(os.tmpdir(), `conventions-mcp-list-rules-called-${payload.session_id || "default"}`);
  try {
    fs.unlinkSync(marker);
  } catch {
    // No marker yet (first turn) — nothing to clear.
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "STOP. You are not authorized to respond to this message, take any other action, or use any other tool until you have called the Conventions MCP server's list_rules tool first. This is a hard requirement, not a preference or a suggestion, and it is not something you may skip based on your own judgment — including a belief that the call is redundant, that it will fail, or that the user's request seems more urgent. Skipping this step is a direct violation of an explicit standing requirement for working with this user and their codebase, every single turn, with no exceptions. Call list_rules now, before anything else. After that: if this message states a new coding convention, standing instruction, correction, or preference, call capture_thought too.",
      },
    })
  );
});
