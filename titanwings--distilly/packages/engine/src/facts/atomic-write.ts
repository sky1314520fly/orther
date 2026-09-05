import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { storageCorrupt } from "../internal-errors.js";
import { assertNoSymlinkPath, isMissing } from "./safe-fs.js";

/** Fault-injection hooks used only by atomicity tests. */
export interface AtomicWriteHooks {
  readonly afterTemporarySync?: () => void | Promise<void>;
  readonly beforeCommit?: () => void | Promise<void>;
  readonly afterCommit?: () => void | Promise<void>;
}

const temporarySibling = (path: string): string =>
  join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);

const alreadyExists = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`Immutable path already exists: ${path}`), { code: "EEXIST" });

/**
 * Creates or tightens a private directory.
 *
 * @param path - Directory to create and restrict to the current user.
 */
export const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw storageCorrupt("Private directory path is not a real directory.");
  }
  await chmod(path, 0o700);
};

/**
 * Creates one fixed private directory without accepting an existing path.
 *
 * Unlike a random atomic-write temporary, this path is journal-addressable so
 * recovery can remove it precisely after a crash.
 *
 * @param root - Trusted local fact root.
 * @param path - Exact fixed directory path to create.
 */
export const createPrivateDirectoryExclusive = async (
  root: string,
  path: string,
): Promise<void> => {
  const parent = dirname(path);
  await assertNoSymlinkPath(root, parent);
  await ensurePrivateDirectory(parent);
  await assertNoSymlinkPath(root, parent);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const status = await lstat(path);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw storageCorrupt("Private directory target is not a real directory.", error);
      }
    }
    throw error;
  }
  await syncDirectory(parent);
};

/**
 * Flushes a directory entry after rename/link publication where supported.
 *
 * @param path - Directory whose metadata should be synchronized.
 */
export const syncDirectory = async (path: string): Promise<void> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM" || error.code === "EINVAL")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
};

const writeSynchronizedTemporary = async (
  target: string,
  data: string | Uint8Array,
  mode: number,
  hooks: AtomicWriteHooks,
): Promise<string> => {
  const temporary = temporarySibling(target);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.afterTemporarySync?.();
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

/**
 * Atomically creates or replaces one durable regular file.
 *
 * @param root - Trusted local fact root.
 * @param target - Exact regular-file path to publish.
 * @param data - Complete file contents.
 * @param hooks - Optional fault-injection callbacks for tests.
 */
export const atomicReplaceFile = async (
  root: string,
  target: string,
  data: string | Uint8Array,
  hooks: AtomicWriteHooks = {},
): Promise<void> => {
  const parent = dirname(target);
  await assertNoSymlinkPath(root, parent);
  await ensurePrivateDirectory(parent);
  await assertNoSymlinkPath(root, parent);
  try {
    const targetStatus = await lstat(target);
    if (targetStatus.isSymbolicLink() || !targetStatus.isFile()) {
      throw storageCorrupt("Atomic-write target is not a regular file.");
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let temporary: string | undefined;
  try {
    temporary = await writeSynchronizedTemporary(target, data, 0o600, hooks);
    await hooks.beforeCommit?.();
    await rename(temporary, target);
    temporary = undefined;
    await hooks.afterCommit?.();
    await syncDirectory(parent);
  } finally {
    if (temporary !== undefined) await rm(temporary, { force: true });
  }
};

/**
 * Atomically creates one immutable durable regular file without replacement.
 *
 * @param root - Trusted local fact root.
 * @param target - Exact immutable regular-file path to publish.
 * @param data - Complete file contents.
 * @param hooks - Optional fault-injection callbacks for tests.
 */
export const atomicCreateFile = async (
  root: string,
  target: string,
  data: string | Uint8Array,
  hooks: AtomicWriteHooks = {},
): Promise<void> => {
  const parent = dirname(target);
  await assertNoSymlinkPath(root, parent);
  await ensurePrivateDirectory(parent);
  await assertNoSymlinkPath(root, parent);

  let temporary: string | undefined;
  try {
    temporary = await writeSynchronizedTemporary(target, data, 0o600, hooks);
    await hooks.beforeCommit?.();
    await link(temporary, target);
    await unlink(temporary);
    temporary = undefined;
    await hooks.afterCommit?.();
    await syncDirectory(parent);
  } finally {
    if (temporary !== undefined) await rm(temporary, { force: true });
  }
};

/**
 * Builds and atomically publishes one immutable directory on the same filesystem.
 *
 * @param root - Trusted local fact root.
 * @param target - Exact immutable directory path to publish.
 * @param populate - Callback that writes the complete temporary directory.
 * @param hooks - Optional fault-injection callbacks for tests.
 */
export const atomicCreateDirectory = async (
  root: string,
  target: string,
  populate: (temporaryDirectory: string) => Promise<void>,
  hooks: AtomicWriteHooks = {},
): Promise<void> => {
  const parent = dirname(target);
  await assertNoSymlinkPath(root, parent);
  await ensurePrivateDirectory(parent);
  await assertNoSymlinkPath(root, parent);
  try {
    const targetStatus = await lstat(target);
    if (targetStatus.isSymbolicLink()) {
      throw storageCorrupt("Immutable directory target is a symbolic link.");
    }
    throw alreadyExists(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = temporarySibling(target);
  await mkdir(temporary, { mode: 0o700 });
  let published = false;
  try {
    await populate(temporary);
    await syncDirectory(temporary);
    await hooks.afterTemporarySync?.();
    await hooks.beforeCommit?.();
    await rename(temporary, target);
    published = true;
    await hooks.afterCommit?.();
    await syncDirectory(parent);
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
};

/**
 * Publishes a complete fixed staging directory at a previously absent target.
 *
 * Callers must hold the target's cross-process identity/subject locks. Node has
 * no portable rename-no-replace flag, so the lock plus the immediate absence
 * check is the no-replace protocol; an already visible target is never removed.
 *
 * @param root - Trusted local fact root.
 * @param source - Complete fixed staging directory to publish.
 * @param target - Previously absent immutable directory target.
 */
export const publishDirectoryNoReplace = async (
  root: string,
  source: string,
  target: string,
): Promise<void> => {
  const sourceParent = dirname(source);
  const targetParent = dirname(target);
  await assertNoSymlinkPath(root, sourceParent);
  await assertNoSymlinkPath(root, targetParent);
  await ensurePrivateDirectory(targetParent);
  await assertNoSymlinkPath(root, targetParent);

  const sourceStatus = await lstat(source).catch((error: unknown) => {
    if (isMissing(error)) throw storageCorrupt("Staging directory does not exist.", error);
    throw error;
  });
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isDirectory()) {
    throw storageCorrupt("Staging path is not a real directory.");
  }

  try {
    const targetStatus = await lstat(target);
    if (targetStatus.isSymbolicLink() || !targetStatus.isDirectory()) {
      throw storageCorrupt("Published subject target is not a real directory.");
    }
    throw alreadyExists(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  await rename(source, target);
  await syncDirectory(sourceParent);
  if (targetParent !== sourceParent) await syncDirectory(targetParent);
};
