import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

test("doctor validates storage without downloading the model", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conventions-doctor-test-"));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "doctor"], {
      env: {
        ...process.env,
        MEMORY_DB_PATH: path.join(directory, "memory.db"),
        MEMORY_MODEL_CACHE_PATH: path.join(directory, "models"),
      },
    });
    assert.match(stdout, /PASS Node\.js:/);
    assert.match(stdout, /PASS Database integrity: ok/);
    assert.match(stdout, /PASS Vector extension:/);
    assert.match(stdout, /WARN Embedding model: not fully cached/);
    assert.equal(stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
