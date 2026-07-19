#!/usr/bin/env node
// UserPromptSubmit hook: fires every turn. No hook event fires on "a rule
// was just stated" — that's a semantic judgment only the model can make —
// so this re-anchors two standing obligations on every turn instead: keep
// following what session-rules.js loaded at session start (which could
// otherwise scroll out of context on a long session), and check whether
// this message itself just stated a new rule worth capturing.
//
// prompt-reminder.cmd (same directory) wraps this for Windows — see the
// note in session-rules.js for why.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        "Reminder: keep following the standing rules loaded from conventions-mcp memory at session start. If this message states a new coding convention, standing instruction, correction, or preference, call capture_thought now.",
    },
  })
);
