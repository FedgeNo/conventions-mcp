import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// XDG_RUNTIME_DIR is preferred over a private directory under the user's home:
// on multi-user Linux /tmp is shared, so another local user could pre-create
// a predictable state directory, making every chmod here fail — and a crashed
// PreToolUse hook is treated as non-blocking, silently disabling the gate.
// The home fallback stays private on platforms without XDG_RUNTIME_DIR.
function stateDirectory() {
  const directory = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "conventions-mcp")
    : path.join(os.homedir(), ".conventions-mcp", "hook-state");
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
