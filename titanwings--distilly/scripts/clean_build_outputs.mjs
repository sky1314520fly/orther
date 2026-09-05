#!/usr/bin/env node

/** Remove only package lib directories named by the root TypeScript references. */

import { lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function repositoryPath(root, path) {
  const result = relative(root, path);
  return result === "" ? "." : result.replaceAll("\\", "/");
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function requiredDirectory(path, root, label) {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label}: [missing-directory] expected a real directory`);
    }
    throw error;
  }
  if (status.isSymbolicLink()) {
    throw new Error(`${label}: [symlink-directory] symlinks are forbidden`);
  }
  if (!status.isDirectory()) {
    throw new Error(`${label}: [not-a-directory] expected a real directory`);
  }
  if (!isInside(root, path)) {
    throw new Error(`${label}: [path-escape] directory escapes the workspace root`);
  }
}

async function readRootReferences(root) {
  const configPath = resolve(root, "tsconfig.json");
  let status;
  try {
    status = await lstat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("tsconfig.json: [missing-root-config] expected root TypeScript config");
    }
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error("tsconfig.json: [unsafe-root-config] expected a regular non-symlink file");
  }

  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`tsconfig.json: [invalid-root-config] ${error.message}`);
  }
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !Array.isArray(config.references) ||
    config.references.length === 0
  ) {
    throw new Error(
      "tsconfig.json: [invalid-root-references] expected a non-empty direct references array",
    );
  }
  return config.references;
}

function referencedPackageName(reference, index) {
  const label = `tsconfig.json:references[${index}]`;
  if (
    reference === null ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    typeof reference.path !== "string" ||
    reference.path.length === 0
  ) {
    throw new Error(`${label}: [invalid-reference] expected a non-empty string path`);
  }
  const path = reference.path;
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path)
  ) {
    throw new Error(`${label}: [unsafe-reference] expected packages/<name>`);
  }
  const segments = path.split("/");
  if (
    segments.length !== 2 ||
    segments[0] !== "packages" ||
    !PACKAGE_NAME.test(segments[1]) ||
    segments[1] === "." ||
    segments[1] === ".."
  ) {
    throw new Error(`${label}: [unsafe-reference] expected packages/<name>`);
  }
  return segments[1];
}

/**
 * Removes every referenced package's real lib directory after validating the complete target set.
 *
 * @param {string} workspaceRoot - Repository root containing tsconfig.json and packages/.
 * @returns {Promise<number>} Number of lib directories removed.
 */
export async function cleanBuildOutputs(workspaceRoot) {
  const root = resolve(workspaceRoot);
  await requiredDirectory(root, root, ".");
  const packagesDirectory = resolve(root, "packages");
  await requiredDirectory(packagesDirectory, root, "packages");
  const references = await readRootReferences(root);

  const packageNames = references.map(referencedPackageName);
  if (new Set(packageNames).size !== packageNames.length) {
    throw new Error("tsconfig.json: [duplicate-reference] package references must be unique");
  }

  const targets = [];
  for (const name of packageNames.sort()) {
    const packageDirectory = resolve(packagesDirectory, name);
    const packageLabel = repositoryPath(root, packageDirectory);
    await requiredDirectory(packageDirectory, root, packageLabel);
    const lib = resolve(packageDirectory, "lib");
    if (!isInside(packageDirectory, lib) || repositoryPath(root, lib) !== `packages/${name}/lib`) {
      throw new Error(`${packageLabel}: [path-escape] refusing non-canonical build output`);
    }
    try {
      const status = await lstat(lib);
      if (status.isSymbolicLink()) {
        throw new Error(
          `${repositoryPath(root, lib)}: [symlink-build-output] refusing to remove a symlink`,
        );
      }
      if (!status.isDirectory()) {
        throw new Error(
          `${repositoryPath(root, lib)}: [unsafe-build-output] expected a real directory`,
        );
      }
      targets.push(lib);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  for (const target of targets) {
    await rm(target, { recursive: true, force: false });
  }
  return targets.length;
}

async function main() {
  if (process.argv.length > 3) {
    console.error("usage: node scripts/clean_build_outputs.mjs [workspace-root]");
    process.exitCode = 2;
    return;
  }
  const removed = await cleanBuildOutputs(process.argv[2] ?? process.cwd());
  console.log(`build outputs cleaned: ${removed}`);
}

const invokedPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`build output cleanup: ${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  });
}
