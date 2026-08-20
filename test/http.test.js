import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json");

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connectClient(port, project) {
  const client = new Client({ name: "conventions-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { "X-Conventions-Project": project } },
  });
  await client.connect(transport);
  return client;
}

test("shared HTTP service isolates project scope while sharing durable storage", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-mcp-test-"));
  const port = await availablePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_HTTP_PORT: String(port),
      MEMORY_DB_PATH: path.join(directory, "memory.db"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      once(child, "exit").then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!exited) child.kill("SIGKILL");
    assert.equal(exited, true, "HTTP service did not shut down within five seconds");
    await rm(directory, { recursive: true, force: true });
  });

  await once(child.stderr, "data");
  const first = await connectClient(port, "/projects/first");
  const second = await connectClient(port, "/projects/second");
  t.after(async () => Promise.allSettled([first.close(), second.close()]));

  const tools = await first.listTools();
  assert.equal(first.getServerVersion().version, packageVersion);
  assert.equal(tools.tools.length, 7);
  assert.equal(tools.tools.find(({ name }) => name === "search_thoughts").inputSchema.properties.limit.minimum, 1);

  const invalidSearch = await first.callTool({ name: "search_thoughts", arguments: { query: "", limit: 0 } });
  assert.equal(invalidSearch.isError, true);

  const captured = await first.callTool({
    name: "capture_thought",
    arguments: {
      content: "Use deterministic integration tests.",
      type: "convention",
      topics: ["testing"],
      projectScoped: true,
    },
  });
  assert.match(captured.content[0].text, /project: -projects-first/);

  const firstRules = await first.callTool({ name: "list_rules", arguments: {} });
  const secondRules = await second.callTool({ name: "list_rules", arguments: {} });
  assert.match(firstRules.content[0].text, /Use deterministic integration tests/);
  assert.doesNotMatch(secondRules.content[0].text, /Use deterministic integration tests/);

  const secondSearch = await second.callTool({
    name: "search_thoughts",
    arguments: { query: "deterministic integration tests", limit: 10 },
  });
  assert.doesNotMatch(secondSearch.content[0].text, /Use deterministic integration tests/);

  const allThoughts = await second.callTool({ name: "list_thoughts", arguments: {} });
  assert.match(allThoughts.content[0].text, /Use deterministic integration tests/);

  const [firstGlobal, secondGlobal] = await Promise.all([
    first.callTool({
      name: "capture_thought",
      arguments: {
        content: "First concurrent global rule.",
        type: "instruction",
        topics: ["concurrency"],
        projectScoped: false,
      },
    }),
    second.callTool({
      name: "capture_thought",
      arguments: {
        content: "Second concurrent global rule.",
        type: "instruction",
        topics: ["concurrency"],
        projectScoped: false,
      },
    }),
  ]);
  const firstGlobalId = Number(firstGlobal.content[0].text.match(/#(\d+)/)[1]);
  const secondGlobalId = Number(secondGlobal.content[0].text.match(/#(\d+)/)[1]);

  const updated = await first.callTool({
    name: "update_thought",
    arguments: {
      id: firstGlobalId,
      content: "Updated concurrent global rule.",
      type: "instruction",
      topics: ["concurrency"],
      projectScoped: false,
    },
  });
  assert.match(updated.content[0].text, /Updated concurrent global rule/);

  const deleted = await second.callTool({ name: "delete_thought", arguments: { id: secondGlobalId } });
  assert.match(deleted.content[0].text, new RegExp(`Deleted #${secondGlobalId}`));

  const finalThoughts = await second.callTool({ name: "list_thoughts", arguments: {} });
  assert.match(finalThoughts.content[0].text, /Updated concurrent global rule/);
  assert.doesNotMatch(finalThoughts.content[0].text, /Second concurrent global rule/);
});
