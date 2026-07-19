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
// So: a pool of established, capable free models, sent (3 at a time — the
// most OpenRouter allows) as OpenRouter's native `models` fallback array
// (https://openrouter.ai/docs/guides/routing/model-fallbacks) so a single
// throttled/down model doesn't fail the whole capture — OpenRouter tries the
// list in order server-side and falls through on rate-limiting, moderation
// flags, context-length errors, or downtime, billing (here, $0) whichever
// model actually answered. The 3-model window is a slice of the pool that
// slides by one per call (below), so across calls every pool member gets
// used, and no single model always lands in the (most-hit) first slot.
// Checked current free-tier availability against
// https://openrouter.ai/api/v1/models before picking these — that catalog
// rotates, so re-check if the pool starts erroring out entirely.
const DEFAULT_MODEL_POOL = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-31b-it:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-nano-9b-v2:free",
];

// Paid variants of the same model families, for users who'd rather pay
// per-token than deal with free-tier congestion (the free pool above is
// prone to going down all at once when every :free variant is upstream-
// rate-limited — same models, no :free suffix, avoids that entirely).
// nemotron-nano-9b-v2 has no paid variant on OpenRouter, so it's dropped
// here rather than included and left to fail every call.
const DEFAULT_PAID_MODEL_POOL = [
  "meta-llama/llama-3.3-70b-instruct",
  "google/gemma-4-31b-it",
  "qwen/qwen3-next-80b-a3b-instruct",
  "openai/gpt-oss-20b",
];

const parseBool = (value, defaultValue) => /^(1|true)$/i.test(value ?? (defaultValue ? "1" : ""));

// Config flag (default off): set OPENROUTER_USE_PAID_MODELS=1 or "true" to
// extract metadata against paid models instead of the free pool.
const USE_PAID_MODELS = parseBool(process.env.OPENROUTER_USE_PAID_MODELS, false);

// Only meaningful when USE_PAID_MODELS is on — default on, so paid mode
// still tries the free pool first (free-tier congestion is often transient)
// and only spends money once the free pool is exhausted. Set
// OPENROUTER_TRY_FREE_FIRST=0/false to skip straight to paid every call.
const TRY_FREE_FIRST = USE_PAID_MODELS && parseBool(process.env.OPENROUTER_TRY_FREE_FIRST, true);

const FREE_POOL = process.env.OPENROUTER_MODEL_POOL
  ? process.env.OPENROUTER_MODEL_POOL.split(",").map((m) => m.trim()).filter(Boolean)
  : DEFAULT_MODEL_POOL;

const PAID_POOL = process.env.OPENROUTER_PAID_MODEL_POOL
  ? process.env.OPENROUTER_PAID_MODEL_POOL.split(",").map((m) => m.trim()).filter(Boolean)
  : DEFAULT_PAID_MODEL_POOL;

// Each pool tried in order per call, each with its own rotating window (see
// callPoolWithRetries) so the two pools' rotations don't interfere.
const POOLS_TO_TRY = !USE_PAID_MODELS
  ? [{ name: "free", models: FREE_POOL, rotationIndex: 0 }]
  : TRY_FREE_FIRST
    ? [{ name: "free", models: FREE_POOL, rotationIndex: 0 }, { name: "paid", models: PAID_POOL, rotationIndex: 0 }]
    : [{ name: "paid", models: PAID_POOL, rotationIndex: 0 }];

// If paid-only mode (TRY_FREE_FIRST off) runs the account out of credit
// (402), fall back to the free pool rather than failing the capture — a
// dead account shouldn't be worse than not having paid mode on at all. Not
// wired in when TRY_FREE_FIRST is on: in that mode free was already tried
// first and failed for its own reasons, so looping back to it after paid
// also fails would just repeat a failure already seen this call.
const CREDIT_FALLBACK_POOL = USE_PAID_MODELS && !TRY_FREE_FIRST
  ? { name: "free", models: FREE_POOL, rotationIndex: 0 }
  : null;

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

// OpenRouter's own fallback only covers HTTP-level failures (429, downtime,
// etc.) — it doesn't retry on a 200 response whose content is unparseable
// JSON, and it doesn't help with a flaky connection dropping the whole
// request. So the request as a whole (already spanning the full model pool)
// still gets a couple of attempts before giving up.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;
// OpenRouter rejects a `models` array with more than 3 entries (400 "'models'
// array must have 3 items or fewer") — a hard API limit, not a preference.
const OPENROUTER_MODELS_MAX = 3;
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
  "scope": string,          // the language, framework, or general topic this applies to (e.g. "PHP", "SQL", "git") — or "global" if it isn't tied to a particular language/framework
  "topics": string[],       // 1-3 short topic tags (e.g. "git", "testing", "naming"), always at least one
  "type": "convention" | "instruction" | "correction" | "preference" | "other",
  "projectSpecific": boolean // true ONLY if the content explicitly names one project/codebase or is obviously about its specific files/architecture — false (the default) for anything that could apply across projects
}`;

// `fallback: true` marks metadata that's a placeholder, not a real
// classification — every pool attempt failed and this content was never
// actually seen by a model. Distinct from a model genuinely classifying
// something as type "other" (which is a real answer, just an unspecific
// one) — callers need to tell the two apart to warn the user correctly.
const FALLBACK_METADATA = {
  scope: "global",
  topics: ["uncategorized"],
  type: "other",
  projectSpecific: false,
  fallback: true,
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
      projectSpecific: parsed.projectSpecific === true,
      fallback: false,
    };
  } catch {
    return null; // signals "retry the request", distinct from a legitimately empty result
  }
}

async function callModelsOnce(models, content, apiKey) {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      models,
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
    const err = new Error(`all models failed: ${response.status} ${errText}`.slice(0, 300));
    err.status = response.status; // lets callers distinguish out-of-credit (402) from other failures
    throw err;
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`${data?.model ?? "response"} returned no content`);

  const parsed = safeParseMetadata(raw);
  if (!parsed) throw new Error(`${data?.model ?? "response"} returned unparseable JSON`);
  return parsed;
}

// Tries one pool (its 3-model rotating window, each attempted up to
// MAX_ATTEMPTS times). Never throws — returns { metadata: null, outOfCredit }
// on failure so the caller can move on to the next pool (e.g. paid, after
// free is exhausted) and, specifically, tell an out-of-credit failure apart
// from any other kind.
async function callPoolWithRetries(pool, content, apiKey, errors) {
  const windowSize = Math.min(OPENROUTER_MODELS_MAX, pool.models.length);
  const models = Array.from({ length: windowSize }, (_, i) => pool.models[(pool.rotationIndex + i) % pool.models.length]);
  pool.rotationIndex = (pool.rotationIndex + 1) % pool.models.length;

  let outOfCredit = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return { metadata: await callModelsOnce(models, content, apiKey) };
    } catch (err) {
      outOfCredit = outOfCredit || err.status === 402;
      errors.push(`${pool.name} pool attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  return { metadata: null, outOfCredit };
}

export async function extractMetadata(content) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const errors = [];
  for (const pool of POOLS_TO_TRY) {
    const outcome = await callPoolWithRetries(pool, content, apiKey, errors);
    if (outcome.metadata) return outcome.metadata;

    if (outcome.outOfCredit && CREDIT_FALLBACK_POOL) {
      const fallbackOutcome = await callPoolWithRetries(CREDIT_FALLBACK_POOL, content, apiKey, errors);
      if (fallbackOutcome.metadata) return fallbackOutcome.metadata;
    }
  }

  // Every pool failed (all throttled, a genuinely bad connection run, or
  // persistently unparseable output) — don't let metadata tagging block the
  // actual save.
  console.error(`All pools failed; using fallback metadata. Errors: ${errors.join(" | ")}`);
  return FALLBACK_METADATA;
}
