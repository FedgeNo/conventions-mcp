import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("embedding cache defaults to persistent per-user storage", async () => {
  const { env } = await import("@huggingface/transformers");
  const { MODEL_CACHE_PATH } = await import("../src/embeddings.js");
  assert.equal(MODEL_CACHE_PATH, path.join(os.homedir(), ".conventions-mcp", "models"));
  assert.equal(env.cacheDir, MODEL_CACHE_PATH);
});
