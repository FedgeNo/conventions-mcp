import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-fault-test-"));
process.env.MEMORY_DB_PATH = path.join(directory, "memory.db");
const dbModule = await import("../src/db.js");

test.after(async () => {
  dbModule.closeDb();
  await rm(directory, { recursive: true, force: true });
});

test("failed online backup removes its temporary snapshot", async () => {
  const database = dbModule.getDb();
  const originalBackup = database.backup.bind(database);
  database.backup = async (temporary) => {
    fs.writeFileSync(temporary, "partial");
    throw new Error("injected backup failure");
  };
  const destination = path.join(directory, "failed-backup.db");
  try {
    await assert.rejects(dbModule.backupDatabase(destination), /injected backup failure/);
  } finally {
    database.backup = originalBackup;
  }
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("failed-backup.db.tmp-")), []);
});

test("failed legacy embedding leaves vectors and format state untouched", async () => {
  dbModule.insertThought({
    content: "Migration must be atomic.",
    metadata: { type: "instruction", topics: ["migration"], project: null },
    embedding: Array(384).fill(0),
  });
  const database = dbModule.getDb();
  database.prepare("DELETE FROM app_metadata").run();
  const vectorCount = database.prepare("SELECT COUNT(*) FROM thoughts_vec").pluck().get();
  const backup = path.join(directory, "pre-migration.db");

  await assert.rejects(
    dbModule.migrateLegacyStorage(backup, async () => { throw new Error("injected embedding failure"); }),
    /injected embedding failure/
  );
  assert.equal(fs.existsSync(backup), true);
  assert.equal(database.prepare("SELECT COUNT(*) FROM app_metadata").pluck().get(), 0);
  assert.equal(database.prepare("SELECT COUNT(*) FROM thoughts_vec").pluck().get(), vectorCount);
});

test("corrupt thought metadata fails visibly instead of being silently ignored", () => {
  const database = dbModule.getDb({ allowLegacy: true });
  database.prepare("INSERT INTO thoughts (content, metadata) VALUES (?, ?)").run("Corrupt row", "not-json");
  assert.throws(() => dbModule.listThoughts(), /JSON/);
});
