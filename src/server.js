#!/usr/bin/env node
// Personal memory MCP server. Runs over stdio — no port, no listener, no
// network exposure of any kind. The trust boundary is simply "who can launch
// this process," same as any other local tool.
//
// Pipeline: embeddings and search are fully local (SQLite + sqlite-vec +
// FTS5, hybrid-ranked). The only network call is metadata extraction on
// capture, via OpenRouter (free tier).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { embed } from "./embeddings.js";
import { extractMetadata } from "./metadata.js";
import { insertThought, updateThought, deleteThought, hybridSearch, listThoughts, thoughtStats } from "./db.js";

const server = new McpServer({ name: "playbook-mcp", version: "1.0.0" });

server.registerTool(
  "capture_thought",
  {
    title: "Capture Convention or Instruction",
    description:
      "Save a coding convention, standing instruction, correction, or workflow preference for future reference — e.g. style rules ('always use 2-space indent'), standing directives ('never force-push to main'), a correction after getting something wrong, or a stated preference for how work should be done. Call this whenever the user states a rule or preference for how you should work, corrects your approach, or explicitly asks you to remember something — don't wait to be asked to 'save' it. Occasional non-coding notes are fine too, but this store is primarily for conventions and instructions that should carry across future sessions and projects.",
    inputSchema: {
      content: z
        .string()
        .describe("The convention, instruction, or thought to capture — a clear, standalone statement that will make sense when retrieved later, in a different session, with no other context"),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([embed(content), extractMetadata(content)]);
      const id = insertThought({ content, metadata, embedding });

      let confirmation = `Captured (#${id}) as ${metadata.type}, scope: ${metadata.scope}`;
      if (metadata.topics?.length) confirmation += ` — ${metadata.topics.join(", ")}`;

      return { content: [{ type: "text", text: confirmation }] };
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
      "Correct or refine an existing thought's content in place — same id, same capture date, re-embedded and re-tagged from the new content. Use this instead of delete_thought + capture_thought whenever the user is correcting, refining, or replacing what a specific existing thought says (a stale convention, a preference that's since changed) rather than adding an unrelated new one. If the id isn't already known from context, use search_thoughts or list_thoughts first and confirm with the user which one before updating.",
    inputSchema: {
      id: z.number().describe("The numeric ID of the thought to update, as shown in search_thoughts/list_thoughts output (e.g. the '#4' in a result)"),
      content: z
        .string()
        .describe("The corrected/replacement content — a clear, standalone statement, same as capture_thought"),
    },
  },
  async ({ id, content }) => {
    try {
      const [embedding, metadata] = await Promise.all([embed(content), extractMetadata(content)]);
      const updated = updateThought(id, { content, metadata, embedding });
      if (!updated) {
        return { content: [{ type: "text", text: `No thought found with id #${id} — nothing updated.` }] };
      }

      let confirmation = `Updated (#${id}) as ${metadata.type}, scope: ${metadata.scope}`;
      if (metadata.topics?.length) confirmation += ` — ${metadata.topics.join(", ")}`;

      return { content: [{ type: "text", text: confirmation }] };
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
