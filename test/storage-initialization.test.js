import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("failed initialization is not cached and malformed schemas are not adopted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-init-"));
  process.env.MEMORY_DB_PATH = path.join(directory, "memory.db");
  const module = await import("../src/db.js");
  try {
    if (process.platform !== "win32") {
      await chmod(directory, 0o755);
      assert.throws(() => module.getDb(), /directory must be private/);
      assert.equal((await stat(directory)).mode & 0o777, 0o755);
      await chmod(directory, 0o700);
    }
    for (const table of ["app_metadata", "thoughts"]) {
      const malformed = new Database(module.DB_PATH);
      malformed.exec(`CREATE TABLE ${table} (wrong TEXT)`);
      malformed.close();
      assert.throws(() => module.getDb(), /Incompatible .* schema/);
      assert.throws(() => module.getDb(), /Incompatible .* schema/);
      const repair = new Database(module.DB_PATH);
      assert.equal(repair.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n, 1);
      repair.exec(`DROP TABLE ${table}`);
      repair.close();
    }
    const database = module.getDb();
    assert.equal(database.prepare("SELECT count(*) n FROM app_metadata").get().n, 3);
  } finally {
    module.closeDb();
    await rm(directory, { recursive: true, force: true });
  }
});
