import path from "node:path";

export function getCurrentProject(cwd = process.cwd()) {
  const windows = /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\");
  let normalized = windows ? path.win32.normalize(cwd).replace(/\\/g, "/")
    : path.posix.normalize(path.posix.isAbsolute(cwd) ? cwd : path.resolve(cwd));
  if (windows) normalized = normalized.replace(/^[a-z]:/, drive => drive.toUpperCase());
  if (normalized.length > 1 && !/^[A-Z]:\/$/.test(normalized)) normalized = normalized.replace(/\/$/, "");
  return `path:${normalized}`;
}

export function legacyProject(project) {
  return project.startsWith("path:") ? project.slice(5).replace(/[\\/:]/g, "-") : null;
}
