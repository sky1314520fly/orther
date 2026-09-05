import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";

const script = resolve(import.meta.dirname, "verify-clean-revert.mjs");
const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(repo, ...args) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const repo = mkdtempSync(resolve(tmpdir(), "clean-revert-test-"));
  tempDirs.push(repo);
  git(repo, "init", "-q");
  writeFileSync(resolve(repo, "file.txt"), "A\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-q", "-m", "A");
  const a = git(repo, "rev-parse", "HEAD");
  writeFileSync(resolve(repo, "file.txt"), "B\n");
  git(repo, "commit", "-q", "-am", "B");
  const b = git(repo, "rev-parse", "HEAD");
  git(repo, "revert", "--no-edit", b);
  const c = git(repo, "rev-parse", "HEAD");
  return { repo, a, b, c };
}

function verify(repo, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });
}

test("passes an exact revert parsed from the head message", () => {
  const { repo, b, c } = fixture();
  const result = verify(repo, "--base", b, "--head", c);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`PASS clean-revert of ${b}`));
  assert.match(result.stdout, /verdict=pass/);
});

test("fails when the revert tree contains an extra edit", () => {
  const { repo, b, c } = fixture();
  writeFileSync(resolve(repo, "extra.txt"), "tampered\n");
  git(repo, "add", "extra.txt");
  git(repo, "commit", "-q", "-m", "extra edit");
  const tampered = git(repo, "rev-parse", "HEAD");
  const result = verify(repo, "--base", b, "--head", tampered, "--reverted", b);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL PR tree is not the exact inverse/);
  assert.notEqual(c, tampered);
});

test("fails when source drift makes the revert conflict", () => {
  const { repo, b } = fixture();
  git(repo, "switch", "-q", "--detach", b);
  writeFileSync(resolve(repo, "file.txt"), "unrelated edit to the same line\n");
  git(repo, "commit", "-q", "-am", "source drift");
  const driftedBase = git(repo, "rev-parse", "HEAD");
  const result = verify(repo, "--base", driftedBase, "--head", driftedBase, "--reverted", b);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL revert does not apply cleanly to PR base/);
});

test("fails when the reverted commit is not an ancestor of base", () => {
  const { repo, a, b, c } = fixture();
  git(repo, "switch", "-q", "--detach", a);
  writeFileSync(resolve(repo, "other.txt"), "other\n");
  git(repo, "add", "other.txt");
  git(repo, "commit", "-q", "-m", "divergent");
  const divergent = git(repo, "rev-parse", "HEAD");
  const result = verify(repo, "--base", b, "--head", c, "--reverted", divergent);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL reverted commit is not an ancestor of the PR base/);
});

test("fails when the head message does not identify a reverted commit", () => {
  const { repo, a, b } = fixture();
  const result = verify(repo, "--base", a, "--head", b);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL head commit message has no 'This reverts commit <40-hex>' line/);
  assert.match(result.stdout, /verdict=fail/);
});
