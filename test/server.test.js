import assert from "node:assert/strict";
import test from "node:test";

import { runHTTPServer } from "../src/server.js";

test("HTTP transport rejects non-loopback binding", async () => {
  const previous = process.env.MCP_HTTP_HOST;
  process.env.MCP_HTTP_HOST = "0.0.0.0";
  try {
    await assert.rejects(runHTTPServer(), /loopback host/);
  } finally {
    if (previous === undefined) delete process.env.MCP_HTTP_HOST;
    else process.env.MCP_HTTP_HOST = previous;
  }
});

test("HTTP transport rejects malformed ports", async () => {
  const previous = process.env.MCP_HTTP_PORT;
  process.env.MCP_HTTP_PORT = "47123junk";
  try {
    await assert.rejects(runHTTPServer(), /integer from 1 through 65535/);
  } finally {
    if (previous === undefined) delete process.env.MCP_HTTP_PORT;
    else process.env.MCP_HTTP_PORT = previous;
  }
});

test("HTTP transport rejects malformed session limits", async () => {
  const previousMax = process.env.MCP_HTTP_MAX_SESSIONS;
  const previousIdle = process.env.MCP_HTTP_SESSION_IDLE_MS;
  try {
    process.env.MCP_HTTP_MAX_SESSIONS = "0";
    await assert.rejects(runHTTPServer(), /positive integer/);
    process.env.MCP_HTTP_MAX_SESSIONS = "10";
    process.env.MCP_HTTP_SESSION_IDLE_MS = "999";
    await assert.rejects(runHTTPServer(), /at least 1000/);
  } finally {
    if (previousMax === undefined) delete process.env.MCP_HTTP_MAX_SESSIONS;
    else process.env.MCP_HTTP_MAX_SESSIONS = previousMax;
    if (previousIdle === undefined) delete process.env.MCP_HTTP_SESSION_IDLE_MS;
    else process.env.MCP_HTTP_SESSION_IDLE_MS = previousIdle;
  }
});
