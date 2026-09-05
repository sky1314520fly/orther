import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const assembler = join(packageRoot, "scripts", "assemble-preview-package.mjs");
const root = await mkdtemp(join(tmpdir(), "distilly-package-safety-built-"));
const unowned = join(root, "unowned-directory");
const marker = join(unowned, "keep.txt");

try {
  await mkdir(unowned);
  await writeFile(marker, "keep me\n");
  const result = spawnSync(process.execPath, [assembler, "--output", unowned, "--force"], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Refusing to replace an unverified Preview package output/u);
  assert.equal(await readFile(marker, "utf8"), "keep me\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
