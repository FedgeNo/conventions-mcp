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
