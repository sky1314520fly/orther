import type { Profile, RequestId } from "@distilly/protocol";
import { lstat, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { storageCorrupt } from "../internal-errors.js";
import type { Layout } from "../layout.js";
import { compareUtf8 } from "../profile/claim-id.js";
import {
  atomicCreateFile,
  createPrivateDirectoryExclusive,
  ensurePrivateDirectory,
  syncDirectory,
} from "./atomic-write.js";
import { listFactDirectory } from "./directory-scan.js";
import { assertNoSymlinkPath, decodeUtf8, isMissing, readRegularFile } from "./safe-fs.js";
import type { FileVersionStore, VersionArtifactSet } from "./version-store.js";
import { CORE_PROFILE_FACETS, validateVersionArtifactSet } from "./version-store.js";

const writeProjection = async (
  root: string,
  directory: string,
  profile: Profile,
  prompt: string,
): Promise<void> => {
  const domainsDirectory = join(directory, "domains");
  await ensurePrivateDirectory(domainsDirectory);
  await atomicCreateFile(root, join(directory, "profile.md"), profile.rendered);
  for (const facet of CORE_PROFILE_FACETS) {
    await atomicCreateFile(root, join(directory, `${facet}.md`), profile.core[facet]);
  }
  for (const domainRoot of Object.keys(profile.domains).sort(compareUtf8)) {
    const content = profile.domains[domainRoot];
    if (content === undefined) throw storageCorrupt("Current profile domain is missing content.");
    await atomicCreateFile(root, join(domainsDirectory, `${domainRoot}.md`), content);
  }
  await atomicCreateFile(root, join(directory, "prompt.md"), prompt);
  await syncDirectory(domainsDirectory);
  await syncDirectory(directory);
};

const expectEntries = async (
  root: string,
  directory: string,
  expected: ReadonlyMap<string, "file" | "directory">,
): Promise<void> => {
  const entries = await listFactDirectory(root, directory);
  if (entries.length !== expected.size) {
    throw storageCorrupt("Current profile projection has an incomplete or unknown entry set.");
  }
  for (const entry of entries) {
    if (expected.get(entry.name) !== entry.kind) {
      throw storageCorrupt("Current profile projection has an incomplete or unknown entry set.");
    }
  }
};

const readText = async (root: string, path: string): Promise<string> => {
  try {
    return decodeUtf8(await readRegularFile(root, path), "Current profile artifact");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "not_found") {
      throw storageCorrupt("Current profile projection is missing a required artifact.", error);
    }
    throw error;
  }
};

const directoryStatus = async (path: string): Promise<"missing" | "directory"> => {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw storageCorrupt("Current profile transaction path is not a real directory.");
    }
    return "directory";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
};

/** Atomic, disposable current-profile projection rebuilt from immutable version artifacts. */
export class FileCurrentProfileProjection {
  readonly #layout: Layout;
  readonly #versions: FileVersionStore;

  /**
   * Creates the rebuildable projection seam.
   *
   * @param layout - Confined local fact layout.
   * @param versions - Complete immutable-version verifier and source reader.
   */
  constructor(layout: Layout, versions: FileVersionStore) {
    this.#layout = layout;
    this.#versions = versions;
  }

  /**
   * Rebuilds current profile artifacts from one exact immutable version.
   *
   * The caller holds the subject lock. A fixed sibling stage and backup make every interrupted
   * replacement recoverable without treating this disposable mirror as authority.
   *
   * @param requestId - Journal request that owns the projection rebuild paths.
   * @param input - Exact immutable version artifacts that must become current.
   */
  async apply(requestId: RequestId, input: VersionArtifactSet): Promise<void> {
    const prepared = validateVersionArtifactSet(input);
    const { subjectId, id: versionId } = prepared.version;
    await this.#versions.readFromDirectory(
      subjectId,
      versionId,
      this.#layout.versionDirectory(subjectId, versionId),
      prepared,
    );

    const current = this.#layout.currentProfileDirectory(subjectId);
    const staging = this.#layout.currentProfileStagingDirectory(requestId, subjectId, versionId);
    const backup = this.#layout.currentProfileBackupDirectory(requestId, subjectId, versionId);
    const parent = dirname(current);
    await assertNoSymlinkPath(this.#layout.root, parent);

    if ((await directoryStatus(current)) === "directory") {
      try {
        await this.readExact(prepared);
        await this.removeDirectory(staging);
        await this.removeDirectory(backup);
        return;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "storage_corrupt")) {
          throw error;
        }
      }
    }

    if ((await directoryStatus(backup)) === "directory") {
      if ((await directoryStatus(current)) === "missing") {
        await rename(backup, current);
        await syncDirectory(parent);
      } else {
        await this.removeDirectory(backup);
      }
    }

    if ((await directoryStatus(staging)) === "directory") {
      try {
        await this.readProjectionDirectory(staging, prepared);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "storage_corrupt")) {
          throw error;
        }
        await this.removeDirectory(staging);
      }
    }
    if ((await directoryStatus(staging)) === "missing") {
      await createPrivateDirectoryExclusive(this.#layout.root, staging);
      await writeProjection(this.#layout.root, staging, prepared.profile, prepared.prompt);
      await this.readProjectionDirectory(staging, prepared);
    }

    if ((await directoryStatus(backup)) === "directory") {
      await this.removeDirectory(backup);
    }
    let movedCurrent = false;
    try {
      if ((await directoryStatus(current)) === "directory") {
        await rename(current, backup);
        movedCurrent = true;
        await syncDirectory(parent);
      }
      await rename(staging, current);
      await syncDirectory(parent);
    } catch (error) {
      if (
        movedCurrent &&
        (await directoryStatus(current)) === "missing" &&
        (await directoryStatus(backup)) === "directory"
      ) {
        await rename(backup, current);
        await syncDirectory(parent);
      }
      throw error;
    }
    await this.readExact(prepared);
    await this.removeDirectory(backup);
  }

  /**
   * Idempotently completes or repairs an interrupted current projection rebuild.
   *
   * @param requestId - Journal request that owns the sibling paths.
   * @param input - Exact immutable version artifacts that must become current.
   */
  async recover(requestId: RequestId, input: VersionArtifactSet): Promise<void> {
    await this.apply(requestId, input);
  }

  /**
   * Verifies the visible current projection against one exact immutable version payload.
   *
   * @param input - Exact immutable version artifacts expected to be current.
   */
  async readExact(input: VersionArtifactSet): Promise<void> {
    const prepared = validateVersionArtifactSet(input);
    await this.readProjectionDirectory(
      this.#layout.currentProfileDirectory(prepared.version.subjectId),
      prepared,
    );
  }

  private async readProjectionDirectory(
    directory: string,
    input: VersionArtifactSet,
  ): Promise<void> {
    await expectEntries(
      this.#layout.root,
      directory,
      new Map([
        ["boundaries.md", "file"],
        ["domains", "directory"],
        ["identity.md", "file"],
        ["profile.md", "file"],
        ["prompt.md", "file"],
        ["psyche.md", "file"],
        ["relations.md", "file"],
        ["texture.md", "file"],
        ["timeline.md", "file"],
        ["voice.md", "file"],
      ]),
    );
    const expectedDomains = new Map(
      Object.keys(input.profile.domains).map((root) => [`${root}.md`, "file"] as const),
    );
    await expectEntries(this.#layout.root, join(directory, "domains"), expectedDomains);
    for (const facet of CORE_PROFILE_FACETS) {
      if (
        (await readText(this.#layout.root, join(directory, `${facet}.md`))) !==
        input.profile.core[facet]
      ) {
        throw storageCorrupt("Current core profile artifact does not match its immutable version.");
      }
    }
    for (const [root, content] of Object.entries(input.profile.domains)) {
      if (
        (await readText(this.#layout.root, join(directory, "domains", `${root}.md`))) !== content
      ) {
        throw storageCorrupt(
          "Current domain profile artifact does not match its immutable version.",
        );
      }
    }
    if (
      (await readText(this.#layout.root, join(directory, "profile.md"))) !== input.profile.rendered
    ) {
      throw storageCorrupt("Current combined profile does not match its immutable version.");
    }
    if ((await readText(this.#layout.root, join(directory, "prompt.md"))) !== input.prompt) {
      throw storageCorrupt("Current prompt does not match its immutable version.");
    }
  }

  private async removeDirectory(path: string): Promise<void> {
    const parent = dirname(path);
    await assertNoSymlinkPath(this.#layout.root, parent);
    if ((await directoryStatus(path)) === "missing") return;
    await rm(path, { recursive: true, force: false });
    await syncDirectory(parent);
  }
}
