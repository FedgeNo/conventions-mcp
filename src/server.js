#!/usr/bin/env node
// Personal memory MCP server. Runs over stdio by default, or as a
// localhost-only Streamable HTTP service when MCP_TRANSPORT=http.
//
// Pipeline is fully local: SQLite + sqlite-vec + FTS5 for storage/search,
// a local embedding model for vectors. Classification (type/topics/
// projectScoped) is done by the calling agent, not a separate model call —
// it already has the full conversation the thought came from, which is
// richer context than an isolated content string would give an extractor.

import "./load-env.js";

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { embed } from "./embeddings.js";
import { insertThought, updateThought, deleteThought, hybridSearch, listThoughts, listRules, thoughtStats } from "./db.js";
import { getCurrentProject } from "./project.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");

// The caller only judges *whether* a thought is scoped to the current project
// (projectScoped); this stamps *which* project deterministically from cwd,
// replacing the boolean in stored metadata so retrieval can do an exact
// `project` match instead of re-deriving it.
async function getSessionProject(server, fallback_project_path) {
  try {
    if (server.server.getClientCapabilities()?.roots) {
      const { roots } = await server.server.listRoots();
      const root = roots.find(({ uri }) => uri.startsWith("file:"));
      if (root) return getCurrentProject(fileURLToPath(root.uri));
    }
  } catch {
    // Clients are not required to implement roots; preserve the cwd behavior.
  }

  return fallback_project_path ? getCurrentProject(fallback_project_path) : null;
}

async function withProjectStamp(server, fallback_project_path, { projectScoped, ...rest }) {
  const project = projectScoped ? await getSessionProject(server, fallback_project_path) : null;
  if (projectScoped && !project) {
    throw new Error("The MCP client did not provide a project root");
  }
  return { ...rest, project };
}

// Echoes the verbatim content back alongside the classification — the
// caller is expected to relay this to the user (see the tool descriptions
// below), so a misclassification or a misheard rule is always visible and
// correctable on the spot, not just discoverable later via search_thoughts.
function formatConfirmation(verb, id, content, metadata) {
  let confirmation = `${verb} (#${id}) as ${metadata.type}`;
  confirmation += metadata.project ? `, project: ${metadata.project}` : " (global)";
  if (metadata.topics?.length) confirmation += ` — ${metadata.topics.join(", ")}`;
  confirmation += `\n\n"${content}"`;
  return confirmation;
}

const CLASSIFICATION_FIELDS = {
  type: z
    .enum(["convention", "instruction", "correction", "preference", "other"])
    .describe(
      "Classify using the conversation this durable rule came from: 'convention' — a specific coding style/pattern rule; 'instruction' — a standing directive on how to work/behave; 'correction' — a lasting correction to future behavior; 'preference' — a long-lived softer preference, not a hard rule; 'other' — another durable future-facing rule that genuinely belongs in this store, never task history or temporary context."
    ),
  topics: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("1-3 short topic tags (e.g. 'git', 'testing', 'naming')."),
  projectScoped: z
    .boolean()
    .describe("True ONLY if this rule is specific to the current project/working directory — false (the default) for anything that applies across projects. When true the server stamps the current project id automatically; global rules leave it empty."),
};

const SERVER_INSTRUCTIONS =
  "Store only durable conventions, standing instructions, corrections, and preferences that should affect future work. Never capture task-specific directions, temporary choices, current status, incident history, commands used for one job, or how an individual job happened to be completed. A direction that applies only to the current request belongs in conversation context, not this store. Capture it only when the user clearly states or confirms that it should govern future sessions or repeated work.";

export function createConventionsServer(fallback_project_path = process.cwd()) {
  const server = new McpServer(
    { name: "conventions-mcp", version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "capture_thought",
    {
      title: "Capture Convention or Instruction",
      description:
        "Save only a durable coding convention, standing instruction, correction, or workflow preference that should govern future sessions or repeated work — e.g. style rules ('always use 2-space indent') or standing directives ('never force-push to main'). Never capture directions specific to the current task, temporary decisions, current status, incident history, commands used for one job, or descriptions of how an individual job was completed; those belong only in the conversation. A preference mentioned while directing one task is not durable unless the user clearly states or confirms that it should apply in the future. Condense each durable rule to one sentence, two if absolutely necessary — no incident stories, user quotes, or example code. Call this when the user establishes or corrects a durable rule, or explicitly asks to retain a genuinely long-lived convention. Classify it yourself using the type/topics/projectScoped fields below, based on the conversation the thought came from. If a single message states multiple distinct durable rules, call this once per rule — don't merge them into one capture — and relay each one individually the same as a single capture, not summarized together. After every successful call, state the captured content verbatim and its project back to the user (the response text already contains both) — this is how they catch a misinterpreted rule and correct or delete it immediately, rather than discovering it wrong much later.",
      inputSchema: {
        content: z
          .string()
          .describe(
            "A durable rule for future sessions or repeated work, condensed to one sentence — two only if absolutely necessary. Do not submit task-specific directions, temporary choices, current status, incident history, one-job commands, or a record of how a job was completed. Do not include the incident it came from, the user's words, before/after stories, or example files/identifiers. Example: 'Never assign innerHTML; build with DOM methods.'"
          ),
        ...CLASSIFICATION_FIELDS,
      },
    },
    async ({ content, type, topics, projectScoped }) => {
      try {
        const embedding = await embed(content);
        const metadata = await withProjectStamp(server, fallback_project_path, { type, topics, projectScoped });
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
        "Correct or refine an existing thought's content in place — same id, re-embedded and re-tagged from the new content. Condense the rule to one sentence, two if absolutely necessary — no incident stories, user quotes, or example code. Use this instead of delete_thought + capture_thought whenever the user is correcting, refining, or replacing what a specific existing thought says (a stale convention, a preference that's since changed) rather than adding an unrelated new one. If the id isn't already known from context, use search_thoughts or list_thoughts first and confirm with the user which one before updating. Re-classify using the type/topics/projectScoped fields below, based on the corrected content and the conversation it came from. After a successful call, state the updated content verbatim and its project back to the user (the response text already contains both) — this is how they catch a misinterpreted rule and correct or delete it immediately.",
      inputSchema: {
        id: z.number().describe("The numeric ID of the thought to update, as shown in search_thoughts/list_thoughts output (e.g. the '#4' in a result)"),
        content: z
          .string()
          .describe("The corrected/replacement content — condensed to one sentence, two if absolutely necessary, with no padding from the incident/user's words/example files — same as capture_thought"),
        ...CLASSIFICATION_FIELDS,
      },
    },
    async ({ id, content, type, topics, projectScoped }) => {
      try {
        const embedding = await embed(content);
        const metadata = await withProjectStamp(server, fallback_project_path, { type, topics, projectScoped });
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
        query: z.string().trim().min(1).describe("What to search for"),
        limit: z.number().int().min(1).max(100).optional().default(10),
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
              `Type: ${m.type || "unknown"}${m.project ? `, project: ${m.project}` : ""}`,
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
      title: "List Conventions and Instructions",
      description: "List all captured conventions/instructions, optionally filtered by type.",
      inputSchema: {
        type: z
          .enum(["convention", "instruction", "correction", "preference", "other"])
          .optional(),
      },
    },
    async ({ type }) => {
      try {
        const rows = listThoughts({ type });
        if (!rows.length) return { content: [{ type: "text", text: "No thoughts found." }] };

        const text = rows
          .map((t) => {
            const m = t.metadata || {};
            const tags = m.topics?.length ? " - " + m.topics.join(", ") : "";
            return `#${t.id} (${m.type || "??"}${tags})\n   ${t.content}`;
          })
          .join("\n\n");

        return { content: [{ type: "text", text: `${rows.length} thought(s):\n\n${text}` }] };
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
        const project = await getSessionProject(server, fallback_project_path);
        const rows = listRules({ project });
        if (!rows.length) return { content: [{ type: "text", text: "No rules found." }] };

        const text = rows
          .map((t) => {
            const m = t.metadata || {};
            const tags = m.topics?.length ? " - " + m.topics.join(", ") : "";
            const projectLabel = m.project ? `, project: ${m.project}` : ", global";
            return `#${t.id} (${m.type || "??"}${projectLabel}${tags})\n   ${t.content}`;
          })
          .join("\n\n");

        const scope = project ? `project "${project}"` : "global scope";
        return { content: [{ type: "text", text: `${rows.length} rule(s) for ${scope}:\n\n${text}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
    description: "Get a summary of all captured durable rules: totals, types, top topics, and per-project counts.",
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
          "",
          "Types:",
          ...sortTop(stats.types).map(([k, v]) => `  ${k}: ${v}`),
        ].filter(Boolean);

        if (Object.keys(stats.topics).length) {
          lines.push("", "Top topics:");
          for (const [k, v] of sortTop(stats.topics)) lines.push(`  ${k}: ${v}`);
        }
        if (Object.keys(stats.projects).length) {
          lines.push("", "By project:");
          for (const [k, v] of sortTop(stats.projects)) lines.push(`  ${k}: ${v}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

export async function runStdioServer() {
  const server = createConventionsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function runHTTPServer() {
  const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.MCP_HTTP_PORT || "47123", 10);
  const sessions = new Map();
  const app = createMcpExpressApp({ host });

  app.post("/mcp", async (request, response) => {
    const session_id = request.headers["mcp-session-id"];
    let session = typeof session_id === "string" ? sessions.get(session_id) : null;

    if (!session && !session_id && isInitializeRequest(request.body)) {
      const project_header = request.headers["x-conventions-project"];
      const project_path =
        typeof project_header === "string" &&
        (path.isAbsolute(project_header) || path.win32.isAbsolute(project_header))
          ? project_header
          : null;
      const server = createConventionsServer(project_path);
      let transport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (new_session_id) => {
          sessions.set(new_session_id, { server, transport });
        },
      });
      transport.onclose = () => {
        for (const [stored_session_id, stored_session] of sessions) {
          if (stored_session.transport === transport) sessions.delete(stored_session_id);
        }
      };
      await server.connect(transport);
      session = { server, transport };
    }

    if (!session) {
      response.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session ID" },
        id: null,
      });
      return;
    }

    await session.transport.handleRequest(request, response, request.body);
  });

  app.get("/mcp", async (request, response) => {
    const session_id = request.headers["mcp-session-id"];
    const session = typeof session_id === "string" ? sessions.get(session_id) : null;
    if (!session) {
      response.status(400).send("Invalid or missing MCP session ID");
      return;
    }
    await session.transport.handleRequest(request, response);
  });

  app.delete("/mcp", async (request, response) => {
    const session_id = request.headers["mcp-session-id"];
    const session = typeof session_id === "string" ? sessions.get(session_id) : null;
    if (!session) {
      response.status(400).send("Invalid or missing MCP session ID");
      return;
    }
    await session.transport.handleRequest(request, response);
  });

  const http_server = app.listen(port, host, () => {
    console.error(`Conventions MCP listening at http://${host}:${port}/mcp`);
  });

  const shutdown = async () => {
    await new Promise((resolve) => http_server.close(resolve));
    await Promise.all([...sessions.values()].map(({ server }) => server.close()));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invoked_path = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked_path === fileURLToPath(import.meta.url)) {
  if (process.env.MCP_TRANSPORT === "http") {
    await runHTTPServer();
  } else {
    await runStdioServer();
  }
}
