#!/usr/bin/env node
// Validates OPENROUTER_API_KEY against OpenRouter's own key-info endpoint —
// a cheap GET, not a paid/rate-limited chat completion — so this is safe to
// run as a pure preflight check before anything else touches local Claude
// Code config. A missing key fails loud already (extractMetadata throws),
// but a *wrong* key doesn't: every capture still "succeeds," just silently
// falling back to generic metadata forever. This catches that case early.
import "../src/load-env.js";

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set — fill it in .env before continuing.");
  process.exit(1);
}

let response;
try {
  response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
} catch (err) {
  console.error(`Could not reach OpenRouter to validate the key: ${err.message}`);
  process.exit(1);
}

if (!response.ok) {
  console.error(`Key check failed: ${response.status} ${response.statusText} — the key is present but not valid.`);
  process.exit(1);
}

const { data } = await response.json();
console.log(`OPENROUTER_API_KEY is valid — label: ${data?.label ?? "(none)"}, free tier: ${data?.is_free_tier ?? "unknown"}`);
process.exit(0);
