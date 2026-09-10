import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-format-test-"));
process.env.MEMORY_DB_PATH = path.join(directory, "memory.db");
const { closeDb, getDb, insertThought, migrateLegacyStorage } = await import("../src/db.js");

test.after(async () => {
  closeDb();
  await rm(directory, { recursive: true, force: true });
});

test("storage metadata rejects unknown legacy vectors and migration reindexes after backup", async () => {
  insertThought({
    content: "Legacy rule.",
    metadata: { type: "instruction", topics: ["migration"], project: null },
    embedding: Array(384).fill(0),
  });
  getDb().prepare("DELETE FROM app_metadata").run();
  closeDb();

  assert.throws(() => getDb(), /migrate-storage/);
  const backup = path.join(directory, "legacy-backup.db");
  const migrated = await migrateLegacyStorage(backup, async () => Array(384).fill(1));
  assert.equal(migrated, true);
  assert.equal(getDb().prepare("SELECT COUNT(*) FROM app_metadata").pluck().get(), 3);
});

test("storage rejects incompatible declared formats", () => {
  getDb().prepare("UPDATE app_metadata SET value = '999' WHERE key = 'schema_version'").run();
  closeDb();
  assert.throws(() => getDb(), /Incompatible storage schema_version/);
});
