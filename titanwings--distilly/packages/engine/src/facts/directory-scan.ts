import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { storageCorrupt } from "../internal-errors.js";
import { assertNoSymlinkPath, decodeUtf8, isMissing } from "./safe-fs.js";

/** Verified child of one fact directory. */
export interface FactDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
}

const compareCanonicalBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/**
 * Lists real regular-file/directory children without following symbolic links.
 *
 * A missing fact directory is an empty collection. Callers own the set of
 * accepted names and must reject unknown entries rather than silently adopt
 * them as facts.
 *
 * @param root - Trusted local fact root.
 * @param directory - Exact fact collection to inspect.
 * @returns Verified children sorted by canonical UTF-8 bytes.
 */
export const listFactDirectory = async (
  root: string,
  directory: string,
): Promise<readonly FactDirectoryEntry[]> => {
  await assertNoSymlinkPath(root, directory);
  let directoryStatus;
  try {
    directoryStatus = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw storageCorrupt("Fact collection path is not a real directory.");
  }

  const names = await readdir(directory, { encoding: "buffer" });
  const entries: FactDirectoryEntry[] = [];
  for (const nameBytes of names) {
    const name = decodeUtf8(nameBytes, "Fact collection entry name");
    const path = join(directory, name);
    let status;
    try {
      status = await lstat(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw storageCorrupt("Fact collection contains a symbolic link.");
    }
    if (status.isFile()) entries.push({ name, kind: "file" });
    else if (status.isDirectory()) entries.push({ name, kind: "directory" });
    else throw storageCorrupt("Fact collection contains an unsupported entry type.");
  }
  return entries.sort((left, right) => compareCanonicalBytes(left.name, right.name));
};
