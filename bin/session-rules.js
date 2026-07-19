#!/usr/bin/env node
// SessionStart hook: loads every standing rule (global + current-project)
// before the model takes its first action, via a direct SQL lookup — no
// embeddings, no OpenRouter call, so this stays fast enough to run on every
// session start without the usual capture_thought latency.
//
// session-rules.cmd (same directory) wraps this for Windows settings.json
// entries — a bare "node <path>" command string works there too, but the
// .cmd avoids the user having to hand-quote an install path containing
// spaces (common under C:\Users\<name>\...) inside the JSON command string.
import "../src/load-env.js";
import { listRules } from "../src/db.js";
import { getCurrentProject } from "../src/project.js";

const project = getCurrentProject();
const rows = listRules({ project });

const output = {};
if (rows.length) {
  const rules = rows
    .map((t) => {
      const m = t.metadata || {};
      return `- (${m.type || "??"}${m.project ? `, ${m.project}` : ""}) ${t.content}`;
    })
    .join("\n");

  output.hookSpecificOutput = {
    hookEventName: "SessionStart",
    additionalContext: `Standing rules loaded from conventions-mcp memory (${rows.length}, project: "${project}"):\n${rules}\n\nThese apply for the rest of this session — follow them without being asked again.`,
  };
}

process.stdout.write(JSON.stringify(output));
