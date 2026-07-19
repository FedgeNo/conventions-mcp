#!/usr/bin/env node
// SessionStart hook: instructs the model to call list_rules before taking
// its first action, rather than embedding the rule content directly here.
// A large enough stored rule set gets silently truncated to a small preview
// before it ever reaches the model — a short, fixed-size instruction has no
// such ceiling, since the actual content comes back through a normal
// tool-call result the model explicitly requests instead.
//
// session-rules.cmd (same directory) wraps this for Windows settings.json
// entries — a bare "node <path>" command string works there too, but the
// .cmd avoids the user having to hand-quote an install path containing
// spaces (common under C:\Users\<name>\...) inside the JSON command string.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        "Before taking any action this session, call the Conventions MCP server's list_rules tool to load every current standing rule (global + this project). These apply for the rest of the session.",
    },
  })
);
