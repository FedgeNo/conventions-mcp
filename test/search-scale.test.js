import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("search exceeds 4096 records without losing project-eligible results", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-search-scale-"));
  process.env.MEMORY_DB_PATH = path.join(directory, "memory.db");
  const db = await import("../src/db.js");
  try {
    db.getDb().transaction(() => {
      for (let i = 0; i < 4097; i++) db.insertThought({
        content: `Foreign rule ${i}`, metadata: { project: "foreign" }, embedding: Array(384).fill(0),
      });
      db.insertThought({ content: "Eligible project rule", metadata: { project: "current" }, embedding: Array(384).fill(1) });
      db.insertThought({ content: "Global rule", metadata: { project: null }, embedding: Array(384).fill(2) });
    })();
    const results = db.hybridSearch({ queryEmbedding: Array(384).fill(0), queryText: "Eligible", project: "current", limit: 10 });
    assert.deepEqual(results.map(row => row.content), ["Eligible project rule", "Global rule"]);
    assert.equal(db.hybridSearch({ queryEmbedding: Array(384).fill(0), queryText: "Foreign", project: "foreign", limit: 10 }).length, 10);
  } finally {
    db.closeDb();
    await rm(directory, { recursive: true, force: true });
  }
});
