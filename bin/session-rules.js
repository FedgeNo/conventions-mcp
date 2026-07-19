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
        "STOP. You are not authorized to respond to the user, take any other action, or use any other tool until you have called the Conventions MCP server's list_rules tool first. This is a hard requirement, not a preference or a suggestion, and it is not something you may skip based on your own judgment — including a belief that the call is redundant or that it will fail. Skipping this step is a direct violation of an explicit standing requirement for working with this user and their codebase. Call list_rules now, before anything else happens this session.",
    },
  })
);
