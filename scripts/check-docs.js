import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const documents = ["README.md", "AGENTS.md", "SECURITY.md"];

function collectMarkdown(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectMarkdown(absolute);
    else if (entry.name.endsWith(".md")) documents.push(path.relative(repository, absolute));
  }
}

collectMarkdown(path.join(repository, "docs"));
const errors = [];

for (const relative of [...new Set(documents)].sort()) {
  const absolute = path.join(repository, relative);
  const lines = fs.readFileSync(absolute, "utf8").split("\n");
  let inFence = false;
  let previousHeading = 0;
  let firstHeading;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/[ \t]+$/.test(line)) errors.push(`${relative}:${lineNumber}: trailing whitespace`);
    if (/^(?:```|~~~)/.test(line.trimStart())) inFence = !inFence;
    if (inFence) return;

    const heading = line.match(/^(#{1,6})\s+\S/);
    if (heading) {
      const level = heading[1].length;
      firstHeading ??= level;
      if (previousHeading && level > previousHeading + 1) {
        errors.push(`${relative}:${lineNumber}: heading level jumps from H${previousHeading} to H${level}`);
      }
      previousHeading = level;
    }

    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(absolute), decodeURIComponent(target));
      if (!fs.existsSync(resolved)) errors.push(`${relative}:${lineNumber}: missing link target ${target}`);
    }
  });

  if (inFence) errors.push(`${relative}: unclosed fenced code block`);
  if (firstHeading !== 1) errors.push(`${relative}: first heading must be H1`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Validated ${new Set(documents).size} Markdown files.`);
