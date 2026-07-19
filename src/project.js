import { execFileSync } from "node:child_process";
import path from "node:path";

// Deterministic project identifier, independent of the LLM — the metadata
// extractor only decides *whether* a thought is project-specific; this
// derives *which* project from the git root (falls back to plain cwd for a
// non-git directory) so retrieval can do an exact match instead of fuzzy
// text comparison against LLM-guessed project names.
export function getCurrentProject(cwd = process.cwd()) {
  try {
    const toplevel = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.basename(toplevel);
  } catch {
    return path.basename(cwd);
  }
}
