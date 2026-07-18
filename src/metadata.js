// Metadata extraction via OpenRouter (free tier). This is the one step in
// the pipeline that calls out to an API — embeddings and search are fully
// local. OpenRouter's API is OpenAI-Chat-Completions-compatible.
//
// Free-tier rate limit is 20 req/min and 50-1000 req/day (depending on
// lifetime credit purchased), and OpenRouter's own docs recommend spreading
// load across multiple :free models rather than hammering one:
// "We do however have different rate limits for different models, so you
// can share the load that way if you do run into issues."
// (https://openrouter.ai/docs/api_reference/limits)
//
// So: a pool of established, capable free models, round-robined on every
// call to spread load proactively, with fallback to the next pool member on
// any failure (429 or otherwise) so a single throttled/down model doesn't
// fail the whole capture. Checked current free-tier availability against
// https://openrouter.ai/api/v1/models before picking these — that catalog
// rotates, so re-check if the pool starts erroring out entirely.
const DEFAULT_MODEL_POOL = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-31b-it:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-nano-9b-v2:free",
];

const MODEL_POOL = process.env.OPENROUTER_MODEL_POOL
  ? process.env.OPENROUTER_MODEL_POOL.split(",").map((m) => m.trim()).filter(Boolean)
  : DEFAULT_MODEL_POOL;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// This runs on a connection that's genuinely unreliable — intermittent
// connection failures and stalls, not a code bug. Two things address that:
// undici's default connect timeout (10s) is too impatient for a slow-but-
// working connection here, and a single failed attempt is often just a bad
// moment, not a dead endpoint — worth retrying before writing the model off.
//
// IMPORTANT: pin this to the same major version Node bundles internally
// (check via `node -e "console.log(process.versions.undici)"`) — Node's
// built-in fetch() uses its own internal undici, and passing a dispatcher
// from a mismatched major version fails with a cryptic UND_ERR_INVALID_ARG
// ("invalid onRequestStart method"), not a clear version-mismatch error.
// Node 22.22.3 bundles 6.24.1; package.json is pinned to ^6.x accordingly —
// don't let this drift to 7.x/8.x on a routine `npm update`.
import { Agent } from "undici";
const dispatcher = new Agent({ connectTimeout: 25_000 });

const RETRIES_PER_MODEL = 2;
const RETRY_DELAY_MS = 2000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Taxonomy is purpose-built for coding conventions and standing instructions,
// not general note-taking — this store's primary job.
//   convention  — a specific coding style/pattern rule
//   instruction — a standing directive on how to work/behave
//   correction  — a past mistake and the corrected approach
//   preference  — a softer preference, not a hard rule
//   other       — anything else that still got captured
const SYSTEM_PROMPT = `Extract metadata from a captured coding convention, standing instruction, or preference. Only extract what's explicitly there — don't infer scope or topics that aren't implied by the text. Respond with ONLY a JSON object, no other text, matching exactly this shape:
{
  "scope": string,     // what this applies to — a language, framework, project name, or "global" if it's a universal rule with no stated context
  "topics": string[],  // 1-3 short topic tags (e.g. "git", "testing", "naming"), always at least one
  "type": "convention" | "instruction" | "correction" | "preference" | "other"
}`;

const FALLBACK_METADATA = {
  scope: "global",
  topics: ["uncategorized"],
  type: "other",
};

// Free-tier / smaller models are less reliable about strict JSON emission
// than a dedicated structured-output feature — this needs a defensive parse
// with a sane fallback rather than an assumed-valid guarantee.
function safeParseMetadata(raw) {
  try {
    // Strip markdown code fences some models wrap JSON in despite instructions.
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const parsed = JSON.parse(cleaned);
    return {
      scope: typeof parsed.scope === "string" && parsed.scope.trim() ? parsed.scope.trim() : "global",
      topics: Array.isArray(parsed.topics) && parsed.topics.length ? parsed.topics : ["uncategorized"],
      type: ["convention", "instruction", "correction", "preference", "other"].includes(parsed.type)
        ? parsed.type
        : "other",
    };
  } catch {
    return null; // signals "retry with next model", distinct from a legitimately empty result
  }
}

let rotationIndex = 0;

async function callModelOnce(model, content, apiKey) {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    }),
    dispatcher,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`${model} failed: ${response.status} ${errText}`.slice(0, 300));
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`${model} returned no content`);

  const parsed = safeParseMetadata(raw);
  if (!parsed) throw new Error(`${model} returned unparseable JSON`);
  return parsed;
}

// A single failed attempt against a flaky connection doesn't mean the model
// is actually unavailable — retry the same model a couple of times with a
// short delay before giving up on it and moving to the next pool member.
async function callModelWithRetries(model, content, apiKey, errors) {
  for (let attempt = 1; attempt <= RETRIES_PER_MODEL; attempt++) {
    try {
      return await callModelOnce(model, content, apiKey);
    } catch (err) {
      errors.push(`${model} (attempt ${attempt}/${RETRIES_PER_MODEL}): ${err.message}`);
      if (attempt < RETRIES_PER_MODEL) await sleep(RETRY_DELAY_MS);
    }
  }
  return null;
}

export async function extractMetadata(content) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const errors = [];
  // Try every pool member (each with its own retries), starting from the
  // rotating offset so load spreads evenly across calls rather than always
  // hammering index 0 first.
  for (let i = 0; i < MODEL_POOL.length; i++) {
    const model = MODEL_POOL[(rotationIndex + i) % MODEL_POOL.length];
    const result = await callModelWithRetries(model, content, apiKey, errors);
    if (result) {
      rotationIndex = (rotationIndex + i + 1) % MODEL_POOL.length; // advance past the model that worked
      return result;
    }
  }

  // Every model in the pool failed even after retries (all throttled, the
  // connection had a genuinely bad run, or all returned garbage) — don't let
  // metadata tagging block the actual save.
  console.error(`All ${MODEL_POOL.length} pool models failed after retries; using fallback metadata. Errors: ${errors.join(" | ")}`);
  return FALLBACK_METADATA;
}
