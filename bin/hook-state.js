import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function stateDirectory() {
  const directory = path.join(os.tmpdir(), `conventions-mcp-${process.getuid?.() ?? "user"}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  return directory;
}

export function markerPath(sessionId) {
  const key = createHash("sha256").update(String(sessionId || "default")).digest("hex");
  return path.join(stateDirectory(), key);
}

export function markRulesLoaded(sessionId) {
  const marker = markerPath(sessionId);
  try {
    fs.writeFileSync(marker, "1", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

export function clearRulesLoaded(sessionId) {
  try {
    fs.unlinkSync(markerPath(sessionId));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function rulesAreLoaded(sessionId) {
  return fs.existsSync(markerPath(sessionId));
}
