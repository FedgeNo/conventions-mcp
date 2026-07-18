// Local embeddings — no daemon, no network call. Loaded once, lazily, on
// first use, and held resident only for the life of this MCP server process.
//
// Model: Xenova/bge-small-en-v1.5, quantized. ~130MB on disk, ~250-300MB
// resident with runtime overhead. 384-dim output (matches the schema in
// db.js — same dimension as all-MiniLM-L6-v2, so the schema needed no change).
// Stronger retrieval quality than MiniLM at a still-small footprint.

import { pipeline } from "@huggingface/transformers";

const MODEL_NAME = "Xenova/bge-small-en-v1.5";

let embedderPromise;

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", MODEL_NAME, {
      dtype: "q8", // quantized — smallest footprint
    });
  }
  return embedderPromise;
}

export async function embed(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}
