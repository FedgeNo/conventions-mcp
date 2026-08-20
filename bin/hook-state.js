import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// XDG_RUNTIME_DIR is preferred over the system temp directory: on multi-user
// Linux /tmp is shared, so another local user could pre-create the state
// directory, making every chmod here fail — and a crashed PreToolUse hook is
// treated as non-blocking, which would silently disable the enforcement gate.
// The runtime dir is per-user, kernel-enforced 0700, and cleared at logout.
// macOS and Windows temp directories are already per-user, so the fallback
// is safe where XDG_RUNTIME_DIR doesn't exist.
function stateDirectory() {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const directory = path.join(base, `conventions-mcp-${process.getuid?.() ?? "user"}`);
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
