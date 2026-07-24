// Deterministic project identifier matching how Claude Code names this
// project: the working directory's absolute path with path separators turned
// into dashes (e.g. /var/www/html -> -var-www-html) — the same string Claude
// Code uses for the per-project transcript directory under ~/.claude/projects/.
// The LLM only decides *whether* a thought is scoped to the current project;
// this derives *which* project, so retrieval can do an exact match rather than
// a fuzzy comparison against an LLM-guessed name.
export function getCurrentProject(cwd = process.cwd()) {
  return cwd.replace(/\//g, "-");
}
