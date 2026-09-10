// Local embeddings — no daemon, no network call. Loaded once, lazily, on
// first use, and held resident only for the life of this MCP server process.
//
// Model: Xenova/bge-small-en-v1.5, quantized. ~130MB on disk, ~250-300MB
// resident with runtime overhead. 384-dim output (matches the schema in
// db.js — same dimension as all-MiniLM-L6-v2, so the schema needed no change).
// Stronger retrieval quality than MiniLM at a still-small footprint.

import { env, pipeline } from "@huggingface/transformers";
import os from "node:os";
import path from "node:path";
import { EMBEDDING_MODEL } from "./storage-format.js";

export const MODEL_NAME = EMBEDDING_MODEL;
export const MODEL_CACHE_PATH = process.env.MEMORY_MODEL_CACHE_PATH || path.join(os.homedir(), ".conventions-mcp", "models");
env.cacheDir = MODEL_CACHE_PATH;

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
