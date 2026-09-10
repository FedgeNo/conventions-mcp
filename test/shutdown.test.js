import assert from "node:assert/strict";
import test from "node:test";

import { parseShutdownTimeout, runBoundedShutdown } from "../src/shutdown.js";

test("shutdown timeout validation accepts defaults and safe configured values", () => {
  assert.equal(parseShutdownTimeout(undefined), 10_000);
  assert.equal(parseShutdownTimeout("2500"), 2_500);
  assert.throws(() => parseShutdownTimeout("999"), /at least 1000/);
  assert.throws(() => parseShutdownTimeout("1second"), /safe integer/);
});

test("bounded shutdown completes tasks before closing the database", async () => {
  const events = [];
  const clean = await runBoundedShutdown({
    tasks: [async () => events.push("transport")],
    timeoutMs: 100,
    force: () => events.push("force"),
    closeDatabase: () => events.push("database"),
    logError: (message) => events.push(message),
  });
  assert.equal(clean, true);
  assert.deepEqual(events, ["transport", "database"]);
});

test("bounded shutdown forces hung connections and reports failure", async () => {
  const events = [];
  const clean = await runBoundedShutdown({
    tasks: [() => new Promise(() => {})],
    timeoutMs: 10,
    force: () => events.push("force"),
    closeDatabase: () => events.push("database"),
    logError: (message) => events.push(message),
  });
  assert.equal(clean, false);
  assert.match(events[0], /exceeded 10ms/);
  assert.deepEqual(events.slice(1), ["force", "database"]);
});

test("bounded shutdown contains task and database errors", async () => {
  const errors = [];
  const clean = await runBoundedShutdown({
    tasks: [async () => { throw new Error("transport broke"); }],
    timeoutMs: 100,
    closeDatabase: () => { throw new Error("checkpoint broke"); },
    logError: (message) => errors.push(message),
  });
  assert.equal(clean, false);
  assert.deepEqual(errors, [
    "Graceful shutdown task failed: transport broke",
    "Database shutdown failed: checkpoint broke",
  ]);
});
