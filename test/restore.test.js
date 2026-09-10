import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-restore-test-"));
process.env.MEMORY_DB_PATH = path.join(directory, "memory.db");
const dbModule = await import("../src/db.js");

test.after(async () => {
  dbModule.closeDb();
  await rm(directory, { recursive: true, force: true });
});

test("restore verifies a snapshot and preserves the previous database as rollback", async () => {
  const id = dbModule.insertThought({
    content: "Snapshot content.",
    metadata: { type: "instruction", topics: ["restore"], project: null },
    embedding: Array(384).fill(0),
  });
  const source = path.join(directory, "source.db");
  await dbModule.backupDatabase(source);
  dbModule.updateThought(id, {
    content: "Live content before restore.",
    metadata: { type: "instruction", topics: ["restore"], project: null },
    embedding: Array(384).fill(1),
  });
  dbModule.closeDb();

  const rollback = path.join(directory, "rollback.db");
  await dbModule.restoreDatabase(source, rollback);
  assert.equal(dbModule.getDb().prepare("SELECT content FROM thoughts WHERE id = ?").pluck().get(id), "Snapshot content.");

  const previous = new Database(rollback, { readonly: true, fileMustExist: true });
  try {
    assert.equal(previous.prepare("SELECT content FROM thoughts WHERE id = ?").pluck().get(id), "Live content before restore.");
    assert.equal(previous.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    previous.close();
  }
});

test("restore refuses a database with live SQLite sidecars", async () => {
  dbModule.closeDb();
  const sidecar = `${dbModule.DB_PATH}-shm`;
  fs.writeFileSync(sidecar, "active");
  try {
    await assert.rejects(
      dbModule.restoreDatabase(path.join(directory, "source.db"), path.join(directory, "second-rollback.db")),
      /appears to be open/
    );
  } finally {
    fs.unlinkSync(sidecar);
  }
});
