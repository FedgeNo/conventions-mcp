import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-db-test-"));
process.env.MEMORY_DB_PATH = path.join(directory, "memory.db");
const { DB_PATH, backupDatabase, closeDb, getDb, insertThought } = await import("../src/db.js");

test.after(async () => {
  closeDb();
  await rm(directory, { recursive: true, force: true });
});

test("database uses durable settings and private POSIX permissions", async () => {
  const database = getDb();
  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(database.pragma("synchronous", { simple: true }), 2);
  assert.equal(database.pragma("busy_timeout", { simple: true }), 5000);
  assert.equal(database.pragma("secure_delete", { simple: true }), 1);

  if (process.platform !== "win32") {
    assert.equal((await stat(path.dirname(DB_PATH))).mode & 0o777, 0o700);
    assert.equal((await stat(DB_PATH)).mode & 0o777, 0o600);
  }
});

test("online backup is verified, private, and never overwrites", async () => {
  insertThought({
    content: "Backups preserve committed rules.",
    metadata: { type: "convention", topics: ["backup"], project: null },
    embedding: Array(384).fill(0),
  });

  const destination = path.join(directory, "backups", "memory.db");
  await backupDatabase(destination);
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    assert.equal(backup.prepare("SELECT content FROM thoughts").pluck().get(), "Backups preserve committed rules.");
    assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    backup.close();
  }
  if (process.platform !== "win32") assert.equal((await stat(destination)).mode & 0o777, 0o600);
  await assert.rejects(backupDatabase(destination), /already exists/);
});

test("a committed WAL write survives process termination", { timeout: 20_000 }, async () => {
  const crashPath = path.join(directory, "crash.db");
  const moduleUrl = new URL("../src/db.js", import.meta.url).href;
  const code = `
    process.env.MEMORY_DB_PATH = ${JSON.stringify(crashPath)};
    const { insertThought } = await import(${JSON.stringify(moduleUrl)});
    insertThought({
      content: "Committed before termination.",
      metadata: { type: "convention", topics: ["durability"], project: null },
      embedding: Array(384).fill(0),
    });
    process.stdout.write("committed\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");

  const recovered = new Database(crashPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(recovered.prepare("SELECT content FROM thoughts").pluck().get(), "Committed before termination.");
    assert.equal(recovered.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    recovered.close();
  }
});
