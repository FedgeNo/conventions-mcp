#!/usr/bin/env node
// UserPromptSubmit hook: fires every turn. Two reminders, both re-anchored
// each turn: (1) actually follow the standing conventions already loaded via
// list_rules, and (2) if the user states a new convention/instruction/
// preference this turn, capture it — in extremely terse form — since no hook
// event fires on "the user stated a rule"; only the model can catch that.
//
// Loading the rule list is not this hook's job — that's prompted once at
// session start (and after compaction/clear) by session-rules.js and enforced
// by pre-tool-check.js.
//
// prompt-reminder.cmd (same directory) wraps this for Windows — see the
// note in session-rules.js for why.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        "Follow the standing conventions already loaded via list_rules. If this message states a new convention, instruction, or preference, capture it with mcp__conventions__capture_thought in extremely terse form — a single short imperative, no examples, quotes, or backstory.",
    },
  })
);
