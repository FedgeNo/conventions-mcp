import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("legacy scope migration is explicit, backed up, and preserves rule IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-scope-"));
  process.env.MEMORY_DB_PATH = path.join(directory, "memory.db");
  const db = await import("../src/db.js");
  try {
    const id = db.insertThought({ content: "Legacy scoped rule", metadata: { project: "-work-a-b" }, embedding: Array(384).fill(0) });
    assert.throws(() => db.listRules({ project: "path:/work/a-b" }), /explicit scope migration/);
    assert.throws(() => db.listRules({ project: "path:/work/a/b" }), /explicit scope migration/);
    await assert.rejects(db.migrateProjectScope("relative", path.join(directory, "invalid.db")), /absolute/);
    const backup = path.join(directory, "before.db");
    assert.equal(await db.migrateProjectScope("/work/a-b", backup), 1);
    assert.equal(db.listRules({ project: "path:/work/a-b" })[0].id, id);
    assert.deepEqual(db.listRules({ project: "path:/work/a/b" }), []);
    const snapshot = new Database(backup, { readonly: true });
    try { assert.equal(JSON.parse(snapshot.prepare("SELECT metadata FROM thoughts").get().metadata).project, "-work-a-b"); }
    finally { snapshot.close(); }
    assert.equal(await db.migrateProjectScope("/work/a-b", backup), 0);
  } finally {
    db.closeDb();
    await rm(directory, { recursive: true, force: true });
  }
});
