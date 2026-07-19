#!/usr/bin/env node
// UserPromptSubmit hook: fires every turn. Re-invokes list_rules on every
// turn rather than relying on rule text loaded once at session start —
// embedded text can scroll out of context over a long session, and (see
// session-rules.js) a large enough rule set gets silently truncated before
// it ever reaches the model in the first place. A tool call has neither
// problem: it always returns the current full set, fresh, on demand.
//
// This also re-anchors the other standing obligation every turn: no hook
// event fires on "the user just stated a rule" — that's a semantic
// judgment only the model can make.
//
// prompt-reminder.cmd (same directory) wraps this for Windows — see the
// note in session-rules.js for why.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        "Call the Conventions MCP server's list_rules tool now to refresh every current standing rule (global + this project) before responding. If this message states a new coding convention, standing instruction, correction, or preference, call capture_thought too.",
    },
  })
);
