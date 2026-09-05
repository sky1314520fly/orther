import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

/**
 * Checks (and, when requested, creates) every directory component without
 * following symlinks. Host-owned destinations are user-controlled paths; a
 * recursive mkdir alone would allow a replaced parent symlink to redirect an
 * install outside the selected home.
 *
 * @param directoryValue - Absolute directory whose components are checked.
 * @param create - Create missing components when true.
 * @param trustedRootValue - Absolute user root whose ancestors are already trusted.
 */
export const ensureRegularDirectoryChain = async (
  directoryValue: string,
  create: boolean,
  trustedRootValue: string,
): Promise<void> => {
  if (!isAbsolute(directoryValue) || !isAbsolute(trustedRootValue)) {
    throw new TypeError("Directory paths must be absolute.");
  }
  const trustedRoot = resolve(trustedRootValue);
  const directory = resolve(directoryValue);
  if (!inside(trustedRoot, directory)) throw new Error("Directory is outside the trusted root.");
  let rootMetadata;
  try {
    rootMetadata = await lstat(trustedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
    await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
    rootMetadata = await lstat(trustedRoot);
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Refusing to use a symlink or non-directory trusted root: ${trustedRoot}`);
  }
  let current = trustedRoot;
  const components = relative(trustedRoot, directory)
    .split(sep)
    .filter((part) => part.length > 0);
  for (const component of components) {
    current = join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      await mkdir(current, { mode: 0o700 }).catch((mkdirError: unknown) => {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      });
      metadata = await lstat(current);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to use a symlink or non-directory path: ${current}`);
    }
  }
};
