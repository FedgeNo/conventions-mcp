import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// npm never includes .git in a published package, so its presence reliably
// distinguishes "running from a git checkout" (this repo, under active
// development) from "installed via npm/npx" (no writable/stable location
// inside the package tree — installs can be read-only and get wiped on
// upgrade). Checkout mode keeps the local ./data folder for dev convenience
// (easy to find, inspect, delete); installed mode defaults to a per-user
// home directory instead. MEMORY_DB_PATH always overrides both.
function defaultDbPath() {
  const isGitCheckout = fs.existsSync(path.join(__dirname, "..", ".git"));
  if (isGitCheckout) return path.join(__dirname, "..", "data", "memory.db");
  return path.join(os.homedir(), ".conventions-mcp", "memory.db");
}

export const DB_PATH = process.env.MEMORY_DB_PATH || defaultDbPath();
const EMBEDDING_DIM = 384; // matches src/embeddings.js (Xenova/bge-small-en-v1.5)

let db;

export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
      content,
      content='thoughts',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS thoughts_ai AFTER INSERT ON thoughts BEGIN
      INSERT INTO thoughts_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS thoughts_ad AFTER DELETE ON thoughts BEGIN
      INSERT INTO thoughts_fts(thoughts_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS thoughts_au AFTER UPDATE ON thoughts BEGIN
      INSERT INTO thoughts_fts(thoughts_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO thoughts_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_vec USING vec0(
      thought_id INTEGER PRIMARY KEY,
      embedding FLOAT[${EMBEDDING_DIM}]
    );
  `);

  return db;
}

// vec0's primary-key column requires an unambiguous SQLITE_INTEGER bind —
// a plain bound JS number can land as INTEGER or REAL depending on
// better-sqlite3's internal heuristics, and vec0 rejects the latter with a
// misleading "Only integers are allowed" error. CAST(? AS INTEGER) forces it.
// The embedding parameter must be a Node Buffer wrapping the raw float32
// bytes — a bare Float32Array/ArrayBuffer is rejected by better-sqlite3's
// own bind-type check before it even reaches vec0.
function toVecBuffer(embedding) {
  return Buffer.from(new Float32Array(embedding).buffer);
}

// Fold the WAL back into memory.db immediately after a write. Without this,
// rows sit in memory.db-wal indefinitely — the ~1000-page autocheckpoint
// threshold is never reached at this write volume, and nothing checkpoints on
// shutdown — so a crash or hard reboot that discards the WAL loses every
// uncheckpointed rule. TRUNCATE also resets the WAL file to zero bytes so it
// can't grow unbounded between checkpoints.
function checkpoint(database) {
  database.pragma("wal_checkpoint(TRUNCATE)");
}

export function insertThought({ content, metadata, embedding }) {
  const database = getDb();
  const insertThoughtStmt = database.prepare(
    "INSERT INTO thoughts (content, metadata) VALUES (?, ?)"
  );
  const insertVecStmt = database.prepare(
    "INSERT INTO thoughts_vec (thought_id, embedding) VALUES (CAST(? AS INTEGER), ?)"
  );

  const tx = database.transaction(() => {
    const result = insertThoughtStmt.run(content, JSON.stringify(metadata ?? {}));
    const thoughtId = result.lastInsertRowid;
    insertVecStmt.run(thoughtId, toVecBuffer(embedding));
    return thoughtId;
  });

  const thoughtId = tx();
  checkpoint(database);
  return thoughtId;
}

// Returns true if a row with that id existed and was updated, false otherwise.
// Preserves the row's id (this is an edit, not a new capture).
// Updates the thoughts row (FTS5 re-syncs via its own AFTER UPDATE trigger)
// and replaces its thoughts_vec row in the same transaction — vec0 has no
// FTS-style auto-sync trigger, and has no UPDATE support of its own, so the
// embedding row is deleted and reinserted rather than updated in place.
export function updateThought(id, { content, metadata, embedding }) {
  const database = getDb();
  const updateThoughtStmt = database.prepare(
    "UPDATE thoughts SET content = ?, metadata = ? WHERE id = CAST(? AS INTEGER)"
  );
  const deleteVecStmt = database.prepare("DELETE FROM thoughts_vec WHERE thought_id = CAST(? AS INTEGER)");
  const insertVecStmt = database.prepare(
    "INSERT INTO thoughts_vec (thought_id, embedding) VALUES (CAST(? AS INTEGER), ?)"
  );

  const tx = database.transaction(() => {
    const result = updateThoughtStmt.run(content, JSON.stringify(metadata ?? {}), id);
    if (result.changes === 0) return false;
    deleteVecStmt.run(id);
    insertVecStmt.run(id, toVecBuffer(embedding));
    return true;
  });

  const updated = tx();
  if (updated) checkpoint(database);
  return updated;
}

// Returns the deleted row's content (for a confirmation echo) or null if no
// thought with that id existed. Deletes both the thoughts row (FTS5 syncs
// via its own AFTER DELETE trigger) and its vec0 row in one transaction —
// vec0 has no FTS-style auto-sync trigger, so it needs an explicit delete.
export function deleteThought(id) {
  const database = getDb();
  const selectStmt = database.prepare("SELECT content FROM thoughts WHERE id = CAST(? AS INTEGER)");
  const deleteThoughtStmt = database.prepare("DELETE FROM thoughts WHERE id = CAST(? AS INTEGER)");
  const deleteVecStmt = database.prepare("DELETE FROM thoughts_vec WHERE thought_id = CAST(? AS INTEGER)");

  const tx = database.transaction(() => {
    const row = selectStmt.get(id);
    if (!row) return null;
    deleteThoughtStmt.run(id);
    deleteVecStmt.run(id);
    return row.content;
  });

  const deletedContent = tx();
  if (deletedContent !== null) checkpoint(database);
  return deletedContent;
}

// Hybrid search: vector similarity (semantic) + FTS5 (exact/keyword) combined
// via reciprocal rank fusion. Catches both "similar meaning" and "exact term"
// matches, which pure vector search alone misses.
export function hybridSearch({ queryEmbedding, queryText, limit = 10, k = 60 }) {
  const database = getDb();

  const vecResults = database
    .prepare(
      `SELECT thought_id, distance
       FROM thoughts_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`
    )
    .all(toVecBuffer(queryEmbedding), Math.max(limit * 4, 40));

  const ftsResults = queryText?.trim()
    ? database
        .prepare(
          `SELECT rowid AS thought_id, rank
           FROM thoughts_fts
           WHERE thoughts_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsMatchQuery(queryText), Math.max(limit * 4, 40))
    : [];

  const scores = new Map(); // thought_id -> reciprocal rank fusion score
  vecResults.forEach((row, i) => {
    scores.set(row.thought_id, (scores.get(row.thought_id) || 0) + 1 / (k + i + 1));
  });
  ftsResults.forEach((row, i) => {
    scores.set(row.thought_id, (scores.get(row.thought_id) || 0) + 1 / (k + i + 1));
  });

  const rankedIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (rankedIds.length === 0) return [];

  const placeholders = rankedIds.map(() => "?").join(",");
  const rows = database
    .prepare(`SELECT id, content, metadata FROM thoughts WHERE id IN (${placeholders})`)
    .all(...rankedIds);

  const byId = new Map(rows.map((r) => [r.id, r]));
  return rankedIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
}

// FTS5 MATCH needs simple space-separated terms, not arbitrary punctuation —
// strip characters that would otherwise throw a syntax error mid-query.
function ftsMatchQuery(text) {
  return text
    .replace(/["^*:().-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" OR ");
}

export function listThoughts({ type } = {}) {
  const database = getDb();
  const rows = database
    .prepare("SELECT id, content, metadata FROM thoughts ORDER BY id DESC")
    .all()
    .map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));

  return type ? rows.filter((r) => r.metadata?.type === type) : rows;
}

// Every thought that applies right now: global (no project stamped) plus
// anything stamped with the current project. Deterministic filter on the
// `project` metadata field — no embeddings, no LLM call — so it's cheap
// enough to call on every session start / turn without the search_thoughts
// latency or ranking uncertainty.
export function listRules({ project } = {}) {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT id, content, metadata FROM thoughts
       WHERE json_extract(metadata, '$.project') IS NULL
          OR json_extract(metadata, '$.project') = ?
       ORDER BY id`
    )
    .all(project ?? null);

  return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
}

export function thoughtStats() {
  const database = getDb();
  const { count } = database.prepare("SELECT COUNT(*) AS count FROM thoughts").get();
  const rows = database.prepare("SELECT metadata FROM thoughts").all();

  const types = {};
  const topics = {};
  const projects = {};

  for (const row of rows) {
    const m = JSON.parse(row.metadata);
    if (m.type) types[m.type] = (types[m.type] || 0) + 1;
    for (const t of m.topics || []) topics[t] = (topics[t] || 0) + 1;
    if (m.project) projects[m.project] = (projects[m.project] || 0) + 1;
  }

  return { total: count, types, topics, projects };
}
