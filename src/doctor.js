import fs from "node:fs";
import path from "node:path";

import { closeDb, DB_PATH, getDb } from "./db.js";
import { MODEL_CACHE_PATH, MODEL_NAME } from "./embeddings.js";

function nodeVersionSupported(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > 20 || (major === 20 && minor >= 9);
}

function containsOnnxModel(directory) {
  if (!fs.existsSync(directory)) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && containsOnnxModel(target)) return true;
    if (entry.isFile() && entry.name.endsWith(".onnx")) return true;
  }
  return false;
}

export function collectDiagnostics() {
  const checks = [];
  const add = (status, name, detail) => checks.push({ status, name, detail });

  add(
    nodeVersionSupported(process.versions.node) ? "PASS" : "FAIL",
    "Node.js",
    `${process.versions.node} (requires 20.9.0 or newer)`
  );

  try {
    const database = getDb();
    const integrity = database.pragma("quick_check", { simple: true });
    add(integrity === "ok" ? "PASS" : "FAIL", "Database integrity", String(integrity));
    const vectorTable = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thoughts_vec'")
      .get();
    add(vectorTable ? "PASS" : "FAIL", "Vector extension", vectorTable ? "thoughts_vec is available" : "thoughts_vec is missing");
    fs.accessSync(path.dirname(DB_PATH), fs.constants.R_OK | fs.constants.W_OK);
    add("PASS", "Database path", DB_PATH);

    if (process.platform !== "win32") {
      const directoryMode = fs.statSync(path.dirname(DB_PATH)).mode & 0o777;
      const databaseMode = fs.statSync(DB_PATH).mode & 0o777;
      const privateModes = directoryMode === 0o700 && databaseMode === 0o600;
      add(
        privateModes ? "PASS" : "FAIL",
        "Database permissions",
        `directory ${directoryMode.toString(8)}, database ${databaseMode.toString(8)} (expected 700/600)`
      );
    }
  } catch (error) {
    add("FAIL", "Database", error.message);
  }

  try {
    const modelDirectory = path.join(MODEL_CACHE_PATH, MODEL_NAME);
    const modelReady = fs.existsSync(path.join(modelDirectory, "config.json")) && containsOnnxModel(modelDirectory);
    add(
      modelReady ? "PASS" : "WARN",
      "Embedding model",
      modelReady ? `cached at ${modelDirectory}` : `not fully cached; run conventions-mcp warmup (cache: ${MODEL_CACHE_PATH})`
    );
  } catch (error) {
    add("FAIL", "Embedding model cache", error.message);
  }

  return checks;
}

export function runDoctor() {
  const checks = collectDiagnostics();
  try {
    closeDb();
  } catch (error) {
    checks.push({ status: "FAIL", name: "Database shutdown", detail: error.message });
  }
  for (const check of checks) console.log(`${check.status} ${check.name}: ${check.detail}`);
  return !checks.some(({ status }) => status === "FAIL");
}
