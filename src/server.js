#!/usr/bin/env node
// Personal memory MCP server. Runs over stdio — no port, no listener, no
// network exposure of any kind. The trust boundary is simply "who can launch
// this process," same as any other local tool.
//
// Pipeline is fully local: SQLite + sqlite-vec + FTS5 for storage/search,
// a local embedding model for vectors. Classification (type/scope/topics/
// projectSpecific) is done by the calling agent, not a separate model call —
// it already has the full conversation the thought came from, which is
// richer context than an isolated content string would give an extractor.

import "./load-env.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { embed } from "./embeddings.js";
import { insertThought, updateThought, deleteThought, hybridSearch, listThoughts, listRules, thoughtStats } from "./db.js";
import { getCurrentProject } from "./project.js";

// The caller only judges *whether* a thought is project-specific (projectSpecific);
// this stamps *which* project deterministically from cwd, replacing the boolean in
// stored metadata so retrieval can do an exact `project` match instead of re-deriving it.
function withProjectStamp({ projectSpecific, ...rest }) {
  return { ...rest, project: projectSpecific ? getCurrentProject() : null };
}

// Echoes the verbatim content back alongside the classification — the
// caller is expected to relay this to the user (see the tool descriptions
// below), so a misclassification or a misheard rule is always visible and
// correctable on the spot, not just discoverable later via search_thoughts.
function formatConfirmation(verb, id, content, metadata) {
  let confirmation = `${verb} (#${id}) as ${metadata.type}, scope: ${metadata.scope}`;
  confirmation += metadata.project ? `, project: ${metadata.project}` : " (cross-project)";
  if (metadata.topics?.length) confirmation += ` — ${metadata.topics.join(", ")}`;
  confirmation += `\n\n"${content}"`;
  return confirmation;
}

const CLASSIFICATION_FIELDS = {
  type: z
    .enum(["convention", "instruction", "correction", "preference", "other"])
    .describe(
      "Classify using the conversation this thought came from: 'convention' — a specific coding style/pattern rule; 'instruction' — a standing directive on how to work/behave; 'correction' — a past mistake and the corrected approach; 'preference' — a softer preference, not a hard rule; 'other' — anything else that still belongs in this store."
    ),
  scope: z
    .string()
    .describe("The language, framework, or general topic this applies to (e.g. 'PHP', 'SQL', 'git') — or 'global' if it isn't tied to a particular language/framework."),
  topics: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("1-3 short topic tags (e.g. 'git', 'testing', 'naming')."),
  projectSpecific: z
    .boolean()
    .describe("True ONLY if this explicitly names one project/codebase or is obviously about its specific files/architecture — false (the default assumption) for anything that could apply across projects."),
};

const server = new McpServer({ name: "conventions-mcp", version: "1.0.0" });

server.registerTool(
  "capture_thought",
  {
    title: "Capture Convention or Instruction",
    description:
      "Save a coding convention, standing instruction, correction, or workflow preference for future reference — e.g. style rules ('always use 2-space indent'), standing directives ('never force-push to main'), a correction after getting something wrong, or a stated preference for how work should be done. Call this whenever the user states a rule or preference for how you should work, corrects your approach, or explicitly asks you to remember something — don't wait to be asked to 'save' it. Occasional non-coding notes are fine too, but this store is primarily for conventions and instructions that should carry across future sessions and projects. Classify it yourself using the type/scope/topics/projectSpecific fields below, based on the conversation the thought came from. If a single message states multiple distinct rules, call this once per rule — don't merge them into one capture — and relay each one individually the same as a single capture, not summarized together. After every successful call, state the captured content verbatim and its scope back to the user (the response text already contains both) — this is how they catch a misinterpreted rule and correct or delete it immediately, rather than discovering it wrong much later.",
    inputSchema: {
      content: z
        .string()
        .describe("The convention, instruction, or thought to capture — a clear, standalone statement that will make sense when retrieved later, in a different session, with no other context"),
      ...CLASSIFICATION_FIELDS,
    },
  },
  async ({ content, type, scope, topics, projectSpecific }) => {
    try {
      const embedding = await embed(content);
      const metadata = withProjectStamp({ type, scope, topics, projectSpecific });
      const id = insertThought({ content, metadata, embedding });
      return { content: [{ type: "text", text: formatConfirmation("Captured", id, content, metadata) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "update_thought",
  {
    title: "Update a Captured Thought",
    description:
      "Correct or refine an existing thought's content in place — same id, same capture date, re-embedded and re-tagged from the new content. Use this instead of delete_thought + capture_thought whenever the user is correcting, refining, or replacing what a specific existing thought says (a stale convention, a preference that's since changed) rather than adding an unrelated new one. If the id isn't already known from context, use search_thoughts or list_thoughts first and confirm with the user which one before updating. Re-classify using the type/scope/topics/projectSpecific fields below, based on the corrected content and the conversation it came from. After a successful call, state the updated content verbatim and its scope back to the user (the response text already contains both) — this is how they catch a misinterpreted rule and correct or delete it immediately.",
    inputSchema: {
      id: z.number().describe("The numeric ID of the thought to update, as shown in search_thoughts/list_thoughts output (e.g. the '#4' in a result)"),
      content: z
        .string()
        .describe("The corrected/replacement content — a clear, standalone statement, same as capture_thought"),
      ...CLASSIFICATION_FIELDS,
    },
  },
  async ({ id, content, type, scope, topics, projectSpecific }) => {
    try {
      const embedding = await embed(content);
      const metadata = withProjectStamp({ type, scope, topics, projectSpecific });
      const updated = updateThought(id, { content, metadata, embedding });
      if (!updated) {
        return { content: [{ type: "text", text: `No thought found with id #${id} — nothing updated.` }] };
      }
      return { content: [{ type: "text", text: formatConfirmation("Updated", id, content, metadata) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "delete_thought",
  {
    title: "Delete a Captured Thought",
    description:
      "Permanently delete a specific captured thought by its ID. This is destructive and irreversible — no undo, no trash. Only call this when the user explicitly asks to delete, remove, or forget a specific thought. Never call it proactively, as a side effect of another action, or on a guess at which ID they mean — if the ID isn't already known from context, use search_thoughts or list_thoughts first and confirm with the user which one before deleting.",
    inputSchema: {
      id: z.number().describe("The numeric ID of the thought to delete, as shown in search_thoughts/list_thoughts output (e.g. the '#4' in a result)"),
    },
  },
  async ({ id }) => {
    try {
      const deletedContent = deleteThought(id);
      if (deletedContent === null) {
        return { content: [{ type: "text", text: `No thought found with id #${id} — nothing deleted.` }] };
      }
      return { content: [{ type: "text", text: `Deleted #${id}: ${deletedContent.slice(0, 100)}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "search_thoughts",
  {
    title: "Search Conventions and Instructions",
    description:
      "Look up previously stored coding conventions, standing instructions, and preferences, by meaning and by exact keyword match (hybrid search). Call this proactively before starting unfamiliar coding work, or when uncertain about a style/convention choice in a project — don't wait for the user to ask. Also call it when the user references a past preference or rule ('like we discussed', 'the usual way', 'you know how I like it').",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
    },
  },
  async ({ query, limit }) => {
    try {
      const queryEmbedding = await embed(query);
      const results = hybridSearch({ queryEmbedding, queryText: query, limit });

      if (!results.length) {
        return { content: [{ type: "text", text: `No thoughts found matching "${query}".` }] };
      }

      const text = results
        .map((t, i) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (#${t.id}) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}${m.scope ? `, scope: ${m.scope}` : ""}`,
          ];
          if (m.topics?.length) parts.push(`Topics: ${m.topics.join(", ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        })
        .join("\n\n");

      return { content: [{ type: "text", text: `Found ${results.length} thought(s):\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Conventions and Instructions",
    description: "List recently captured conventions/instructions, optionally filtered by type or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z
        .enum(["convention", "instruction", "correction", "preference", "other"])
        .optional(),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, days }) => {
    try {
      const rows = listThoughts({ limit, type, days });
      if (!rows.length) return { content: [{ type: "text", text: "No thoughts found." }] };

      const text = rows
        .map((t, i) => {
          const m = t.metadata || {};
          const tags = m.topics?.length ? " - " + m.topics.join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags})\n   ${t.content}`;
        })
        .join("\n\n");

      return { content: [{ type: "text", text: `${rows.length} recent thought(s):\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_rules",
  {
    title: "List All Standing Rules",
    description:
      "Retrieve every convention, instruction, correction, and preference that applies right now — everything global plus anything scoped to the current project — in one call. A deterministic direct lookup (no embeddings, no ranking), so it won't miss anything a semantic search_thoughts query might rank low. Prefer this over several search_thoughts calls when you want the full standing rule set at once, e.g. at the start of unfamiliar work.",
    inputSchema: {},
  },
  async () => {
    try {
      const project = getCurrentProject();
      const rows = listRules({ project });
      if (!rows.length) return { content: [{ type: "text", text: "No rules found." }] };

      const text = rows
        .map((t, i) => {
          const m = t.metadata || {};
          const tags = m.topics?.length ? " - " + m.topics.join(", ") : "";
          const scope = m.project ? `, project: ${m.project}` : ", global";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${scope}${tags})\n   ${t.content}`;
        })
        .join("\n\n");

      return { content: [{ type: "text", text: `${rows.length} rule(s) for project "${project}":\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of everything captured: totals, types, top topics, and scopes (which languages/projects/contexts have the most stored conventions).",
    inputSchema: {},
  },
  async () => {
    try {
      const stats = thoughtStats();
      const sortTop = (obj) =>
        Object.entries(obj)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines = [
        `Total thoughts: ${stats.total}`,
        stats.dateRange
          ? `Date range: ${new Date(stats.dateRange.from).toLocaleDateString()} → ${new Date(stats.dateRange.to).toLocaleDateString()}`
          : null,
        "",
        "Types:",
        ...sortTop(stats.types).map(([k, v]) => `  ${k}: ${v}`),
      ].filter(Boolean);

      if (Object.keys(stats.topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sortTop(stats.topics)) lines.push(`  ${k}: ${v}`);
      }
      if (Object.keys(stats.scopes).length) {
        lines.push("", "By scope:");
        for (const [k, v] of sortTop(stats.scopes)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
