import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { x as extractTarball } from "tar";

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const npmCli = process.env.npm_execpath;
const temporary = await mkdtemp(path.join(os.tmpdir(), "conventions-package-smoke-"));

try {
  assert.ok(npmCli, "Run the package smoke check through npm run test:package");
  const { stdout: packOutput } = await execFileAsync(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", temporary],
    { cwd: repository }
  );
  const [{ filename }] = JSON.parse(packOutput);
  const tarball = path.join(temporary, filename);
  await extractTarball({ file: tarball, cwd: temporary });
  const packageRoot = path.join(temporary, "package");
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const locked = JSON.parse(await readFile(path.join(repository, "package-lock.json"), "utf8"));
  const registry = JSON.parse(await readFile(path.join(repository, "server.json"), "utf8"));
  assert.equal(locked.version, packageJson.version);
  assert.equal(locked.packages[""].version, packageJson.version);
  assert.equal(registry.version, packageJson.version);
  assert.equal(registry.packages[0].version, packageJson.version);
  const cli = path.join(packageRoot, "bin", "cli.js");
  const { stdout: versionOutput } = await execFileAsync(process.execPath, [cli, "--version"]);
  const { stdout: helpOutput } = await execFileAsync(process.execPath, [cli, "--help"]);

  assert.equal(versionOutput.trim(), packageJson.version);
  assert.match(helpOutput, /^Usage: conventions-mcp \[command\]/);
  console.log(`Packed and extracted ${packageJson.name}@${packageJson.version}; CLI smoke checks passed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
