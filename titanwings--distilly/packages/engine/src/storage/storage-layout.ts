import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ensurePrivateDirectory } from "../facts/atomic-write.js";
import { assertNoSymlinkPath, isMissing } from "../facts/safe-fs.js";
import { invalidInput, storageCorrupt } from "../internal-errors.js";

/** Fixed filesystem paths owned by one SQLite-backed Engine instance. */
export class StorageLayout {
  readonly root: string;
  readonly databaseFile: string;
  readonly blobsDirectory: string;
  readonly sha256Directory: string;

  /**
   * Resolves the one supported private storage layout.
   *
   * @param root - Configured DISTILLY_ROOT.
   */
  constructor(root: string) {
    if (root.trim().length === 0) throw invalidInput("DISTILLY_ROOT cannot be empty.", "root");
    this.root = resolve(root);
    this.databaseFile = join(this.root, "store.sqlite3");
    this.blobsDirectory = join(this.root, "blobs");
    this.sha256Directory = join(this.blobsDirectory, "sha256");
  }

  /** Creates or tightens DISTILLY_ROOT after rejecting an exact symlink root. */
  async prepareRoot(): Promise<void> {
    await assertNoSymlinkPath(this.root, this.root);
    await ensurePrivateDirectory(this.root);
    await assertNoSymlinkPath(this.root, this.root);
  }

  /** Creates the fixed private SHA-256 blob hierarchy without following symlinks. */
  async prepareBlobRoot(): Promise<void> {
    await this.prepareRoot();
    await assertNoSymlinkPath(this.root, this.sha256Directory);
    await ensurePrivateDirectory(this.sha256Directory);
    await assertNoSymlinkPath(this.root, this.sha256Directory);
  }

  /** Rejects an existing database path unless it is a regular file. */
  async verifyDatabaseTarget(): Promise<void> {
    await this.prepareRoot();
    try {
      const status = await lstat(this.databaseFile);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw storageCorrupt("SQLite storage path is not a regular file.");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
