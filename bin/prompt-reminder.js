#!/usr/bin/env node
// UserPromptSubmit hook: fires every turn. Two reminders, both re-anchored
// each turn: (1) actually follow the standing conventions already loaded via
// list_rules, and (2) capture only durable rules that should govern future
// sessions or repeated work. Task-specific directions stay in conversation.
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
        "Follow the standing conventions already loaded via list_rules. Capture a new rule with mcp__conventions__capture_thought only if it is a durable convention, standing instruction, correction, or preference meant to govern future sessions or repeated work. Never capture directions for this task, temporary choices, current status, incident history, one-job commands, or how this individual job was completed; keep those only in conversation context. Store any qualifying rule as one short imperative with no examples, quotes, or backstory.",
    },
  })
);
