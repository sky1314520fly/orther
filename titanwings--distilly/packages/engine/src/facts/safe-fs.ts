import { lstat, open } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { factNotFound, storageCorrupt } from "../internal-errors.js";

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

class RegularFileReplacedDuringOpen extends Error {}

/** Internal fault-injection hooks for deterministic filesystem-race tests. */
export interface ReadRegularFileHooks {
  /** Runs after the target lstat and immediately before opening the file. */
  readonly afterTargetStat?: () => void | Promise<void>;
}

/**
 * Identifies a verified regular-file replacement race without string matching.
 *
 * @param error - Candidate error raised by readRegularFile.
 * @returns Whether the file inode changed between lstat and open.
 */
export const isRegularFileReplacement = (error: unknown): boolean =>
  error instanceof Error && error.cause instanceof RegularFileReplacedDuringOpen;

/**
 * Rejects symlinks in every existing path component below a fact root.
 *
 * @param root - Trusted local fact root.
 * @param target - Candidate path whose existing components are inspected.
 */
export const assertNoSymlinkPath = async (root: string, target: string): Promise<void> => {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const fromRoot = relative(absoluteRoot, absoluteTarget);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw storageCorrupt("Fact path escapes DISTILLY_ROOT.");
  }

  try {
    const rootStatus = await lstat(absoluteRoot);
    if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
      throw storageCorrupt("DISTILLY_ROOT is not a real directory.");
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  const segments = fromRoot === "" ? [] : fromRoot.split(sep);
  let cursor = absoluteRoot;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      const status = await lstat(cursor);
      if (status.isSymbolicLink()) throw storageCorrupt("Fact path contains a symbolic link.");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
};

/**
 * Reads a bounded regular file while detecting target replacement races.
 *
 * @param root - Trusted local fact root.
 * @param path - Exact regular file to read.
 * @param maximumBytes - Optional inclusive file-size bound.
 * @param hooks - Optional deterministic race hooks used by tests.
 * @returns The verified file bytes.
 */
export const readRegularFile = async (
  root: string,
  path: string,
  maximumBytes?: number,
  hooks: ReadRegularFileHooks = {},
): Promise<Buffer> => {
  await assertNoSymlinkPath(root, dirname(path));

  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw factNotFound("Fact file does not exist.");
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw storageCorrupt("Fact path is not a regular file.");
  }
  if (maximumBytes !== undefined && before.size > maximumBytes) {
    throw storageCorrupt("Fact file exceeds its size limit.");
  }
  await hooks.afterTargetStat?.();

  const handle = await open(path, "r").catch((error: unknown) => {
    if (isMissing(error)) throw factNotFound("Fact file does not exist.");
    throw error;
  });
  try {
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) {
      throw storageCorrupt(
        "Fact file changed while it was opened.",
        new RegularFileReplacedDuringOpen(),
      );
    }
    if (maximumBytes !== undefined && after.size > maximumBytes) {
      throw storageCorrupt("Fact file exceeds its size limit.");
    }
    const data = await handle.readFile();
    if (maximumBytes !== undefined && data.byteLength > maximumBytes) {
      throw storageCorrupt("Fact file exceeds its size limit.");
    }
    return data;
  } finally {
    await handle.close();
  }
};

/**
 * Decodes fact text without replacing malformed UTF-8 bytes.
 *
 * @param data - Exact bytes to decode.
 * @param label - Safe label used in corruption errors.
 * @returns The strictly decoded UTF-8 text.
 */
export const decodeUtf8 = (data: Uint8Array, label: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch (error) {
    throw storageCorrupt(`${label} is not valid UTF-8.`, error);
  }
};

export { isMissing };
