#!/usr/bin/env node
// SessionStart hook. Prompts the model to load the standing rule set at the
// start of every session by calling list_rules. The rules themselves are far
// too large to inline in this hook's text slot, so this only issues the
// directive — the model is expected to act on it before doing any work. The
// PreToolUse hook (pre-tool-check.js) is the enforcement backstop: if the
// model ignores this directive and reaches for a tool without having loaded
// the rules, that hook blocks the call until it does.
//
// A resumed session can retain its marker across client and server restarts.
// Re-arm on every SessionStart so that retained state cannot bypass a reload.
//
// The marker is keyed by session_id, matching pre-tool-check.js.
//
// session-rules.cmd (same directory) wraps this for Windows settings.json
// entries — a bare "node <path>" command string works there too, but the
// .cmd avoids the user having to hand-quote an install path containing
// spaces (common under C:\Users\<name>\...) inside the JSON command string.
import { clearRulesLoaded } from "./hook-state.js";

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    // Malformed input — still emit the directive, just can't scope the marker.
  }

  clearRulesLoaded(payload.session_id);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "This session has just started, resumed, or reset. Before your next tool call, call mcp__conventions__list_rules to reload this project's standing conventions, even if an earlier call appears in the restored conversation. Do not call it again until another SessionStart instruction or context reset.",
      },
    })
  );
});
