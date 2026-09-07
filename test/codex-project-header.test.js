import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("codex-project-header reports the active workspace", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "conventions-workspace-"));

  try {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, "bin/cli.js"), "codex-project-header"],
      { cwd: workspace, encoding: "utf8" }
    );

    assert.deepEqual(JSON.parse(output), {
      "X-Conventions-Project": realpathSync(workspace),
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
