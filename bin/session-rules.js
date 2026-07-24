#!/usr/bin/env node
// SessionStart hook. Prompts the model to load the standing rule set at the
// start of every session by calling list_rules. The rules themselves are far
// too large to inline in this hook's text slot, so this only issues the
// directive — the model is expected to act on it before doing any work. The
// PreToolUse hook (pre-tool-check.js) is the enforcement backstop: if the
// model ignores this directive and reaches for a tool without having loaded
// the rules, that hook blocks the call until it does.
//
// SessionStart also fires after compaction (source "compact") and after
// /clear (source "clear") — both of which discard the already-loaded rule
// text from context. In those two cases this hook also clears the per-session
// "rules already loaded" marker that pre-tool-check.js reads, so the model is
// forced to reload the list before any further tool use. On a fresh startup
// there is no marker yet, and on resume/fork the rules are still present in
// the restored transcript, so no clearing is needed there.
//
// The marker is keyed by session_id, matching pre-tool-check.js.
//
// session-rules.cmd (same directory) wraps this for Windows settings.json
// entries — a bare "node <path>" command string works there too, but the
// .cmd avoids the user having to hand-quote an install path containing
// spaces (common under C:\Users\<name>\...) inside the JSON command string.
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
    // Malformed input — still emit the directive, just can't scope the marker.
  }

  // After compaction or /clear the loaded rules are gone from context, so
  // re-arm the gate to force a reload. Other sources don't need it: startup
  // has no marker, and resume/fork keep the rules in the restored transcript.
  if (payload.source === "compact" || payload.source === "clear") {
    const marker = path.join(os.tmpdir(), `conventions-mcp-list-rules-called-${payload.session_id || "default"}`);
    try {
      fs.unlinkSync(marker);
    } catch {
      // Marker already absent — nothing to clear.
    }
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "Before using any tool, call mcp__conventions__list_rules to load this project's standing conventions.",
      },
    })
  );
});
