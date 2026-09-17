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

test("failed initialization retries and concurrent calls share successful initialization", async () => {
  const { createEmbedder } = await import("../src/embeddings.js");
  let attempts = 0;
  const embed = createEmbedder(async () => {
    if (++attempts === 1) throw new Error("Temporary loading failure");
    return async () => ({ data: new Float32Array(384).fill(1) });
  });
  const failed = await Promise.allSettled([embed("one"), embed("two")]);
  assert(failed.every(result => result.status === "rejected"));
  assert.equal(attempts, 1);
  const recovered = await Promise.all([embed("one"), embed("two")]);
  assert.equal(attempts, 2);
  assert.deepEqual(recovered, [Array(384).fill(1), Array(384).fill(1)]);
  await embed("three");
  assert.equal(attempts, 2);
});
