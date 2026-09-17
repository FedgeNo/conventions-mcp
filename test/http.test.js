import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";

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

async function startIsolatedServer(t, port, extraEnv = {}, embeddingDelay = 0) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-http-test-"));
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { runHTTPServer } from './src/server.js';
    await runHTTPServer({ embedFunction: async () => {
      await new Promise(resolve => setTimeout(resolve, ${embeddingDelay}));
      return Array(384).fill(0);
    } });
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_SHUTDOWN_TIMEOUT_MS: "1000",
      MEMORY_DB_PATH: path.join(directory, "memory.db"),
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
  });
  return { child, exited, directory, errors: () => errors };
}

test("HTTP port conflicts fail without announcing a listening service", { timeout: 15_000 }, async (t) => {
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const server = await startIsolatedServer(t, occupied.address().port);
  const [code] = await server.exited;
  assert.notEqual(code, 0);
  assert.match(server.errors(), /EADDRINUSE/);
  assert.doesNotMatch(server.errors(), /Conventions MCP listening/);
});

test("expired HTTP sessions return 404 and allow a fresh connection", { timeout: 15_000 }, async (t) => {
  const port = await availablePort();
  const server = await startIsolatedServer(t, port, { MCP_HTTP_SESSION_IDLE_MS: "1000" });
  await once(server.child.stderr, "data");
  const url = `http://127.0.0.1:${port}/mcp`;
  const client = new Client({ name: "expiry-test", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  t.after(() => client.close());
  await client.connect(transport);
  const sessionId = transport.sessionId;
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  for (const method of ["POST", "GET", "DELETE"]) {
    for (const expired of [true, false]) {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(expired ? { "mcp-session-id": sessionId } : {}),
        },
        ...(method === "POST" ? {
          body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list" }),
        } : {}),
      });
      assert.equal(response.status, expired ? 404 : 400, `${method}, expired=${expired}`);
      await response.text();
    }
  }
  const fresh = await connectClient(port, "/projects/reconnected");
  t.after(() => fresh.close());
  assert.equal((await fresh.listTools()).tools.length, 7);
});

test("active captures survive idle expiry and shutdown drains their result", { timeout: 15_000 }, async (t) => {
  const port = await availablePort();
  const server = await startIsolatedServer(t, port, { MCP_HTTP_SESSION_IDLE_MS: "1000", MCP_SHUTDOWN_TIMEOUT_MS: "5000" }, 1800);
  await once(server.child.stderr, "data");
  const client = await connectClient(port, "/projects/slow");
  t.after(() => client.close());
  const call = () => client.callTool({ name: "capture_thought", arguments: {
    content: "Slow capture completes once.", type: "instruction", topics: ["testing"], projectScoped: false,
  } }, undefined, { timeout: 5000 });
  const first = await call();
  assert.match(first.content[0].text, /Captured/);
  const pending = call();
  await new Promise(resolve => setTimeout(resolve, 500));
  server.child.kill("SIGTERM");
  const second = await pending;
  assert.match(second.content[0].text, /Captured/);
  assert.equal((await server.exited)[0], 0, server.errors());
});

test("unresponsive roots use a bounded cached fallback and roots changes refresh scope", { timeout: 15_000 }, async (t) => {
  const port = await availablePort();
  const server = await startIsolatedServer(t, port);
  await once(server.child.stderr, "data");
  const client = new Client({ name: "roots-test", version: "1" }, { capabilities: { roots: { listChanged: true } } });
  let calls = 0;
  let responsive = false;
  client.setRequestHandler(ListRootsRequestSchema, () => {
    calls++;
    return responsive ? { roots: [{ uri: "file:///projects/changed" }] } : new Promise(() => {});
  });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { "X-Conventions-Project": "/projects/fallback" } },
  }));
  const capture = () => client.callTool({ name: "capture_thought", arguments: {
    content: "Use the resolved project.", type: "instruction", topics: ["testing"], projectScoped: true,
  } }, undefined, { timeout: 3000 });
  assert.match((await capture()).content[0].text, /project: path:\/projects\/fallback/);
  assert.match((await capture()).content[0].text, /project: path:\/projects\/fallback/);
  assert.equal(calls, 1);
  responsive = true;
  await client.notification({ method: "notifications/roots/list_changed" });
  assert.match((await capture()).content[0].text, /project: path:\/projects\/changed/);
  assert.equal(calls, 2);
});

test("cancelled embedding work cannot commit a capture later", { timeout: 15_000 }, async (t) => {
  const port = await availablePort();
  const server = await startIsolatedServer(t, port, {}, 1200);
  await once(server.child.stderr, "data");
  const client = await connectClient(port, "/projects/cancelled");
  t.after(() => client.close());
  await assert.rejects(client.callTool({ name: "capture_thought", arguments: {
    content: "Must not be stored", type: "instruction", topics: ["testing"], projectScoped: false,
  } }, undefined, { timeout: 300 }), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 1300));
  const rules = await client.callTool({ name: "list_thoughts", arguments: {} });
  assert.equal(rules.content[0].text, "No thoughts found.");
});

test("forced shutdown cancels pending writes before closing storage", { timeout: 15_000 }, async (t) => {
  const port = await availablePort();
  const server = await startIsolatedServer(t, port, {}, 2200);
  await once(server.child.stderr, "data");
  const client = await connectClient(port, "/projects/shutdown");
  t.after(() => client.close());
  await client.callTool({ name: "list_thoughts", arguments: {} });
  const pending = client.callTool({ name: "capture_thought", arguments: {
    content: "Must not commit after shutdown", type: "instruction", topics: ["testing"], projectScoped: false,
  } }, undefined, { timeout: 4000 }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 400));
  server.child.kill("SIGTERM");
  assert.equal((await server.exited)[0], 1, server.errors());
  assert.match(server.errors(), /forcing connections closed/);
  await pending;
  const database = new Database(path.join(server.directory, "memory.db"), { readonly: true });
  try { assert.equal(database.prepare("SELECT count(*) n FROM thoughts").get().n, 0); }
  finally { database.close(); }
});

test("shared HTTP service isolates project scope while sharing durable storage", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-mcp-test-"));
  const port = await availablePort();
  const serverUrl = new URL("../src/server.js", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      const { runHTTPServer } = await import(${JSON.stringify(serverUrl)});
      const embedFunction = async () => Array(384).fill(0);
      await runHTTPServer({ embedFunction });
    `,
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_MAX_SESSIONS: "2",
      MCP_SHUTDOWN_TIMEOUT_MS: "1000",
      MEMORY_DB_PATH: path.join(directory, "memory.db"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverErrors = "";
  child.stderr.on("data", (chunk) => (serverErrors += chunk));
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
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", version: packageVersion });
  const first = await connectClient(port, "/projects/first");
  const second = await connectClient(port, "/projects/second");
  t.after(async () => Promise.allSettled([first.close(), second.close()]));

  await assert.rejects(
    connectClient(port, "/projects/third"),
    /503|Maximum MCP session count reached/
  );

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
  assert.match(captured.content[0].text, /project: path:\/projects\/first/, serverErrors);

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
