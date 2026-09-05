/**
 * Test-only snapshot of the retired file-backed immutable-version staging seam.
 *
 * SQLite commit publishes version authority in one transaction and never imports this fixture.
 */
import { requestIdSchema, versionIdSchema } from "@distilly/protocol";
import type { Profile, RequestId, SubjectId, VersionId } from "@distilly/protocol";
import { lstat, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  atomicCreateFile,
  createPrivateDirectoryExclusive,
  ensurePrivateDirectory,
  publishDirectoryNoReplace,
  syncDirectory,
} from "../facts/atomic-write.js";
import { createFactFile } from "../facts/fact-file.js";
import { assertNoSymlinkPath, isMissing } from "../facts/safe-fs.js";
import type {
  FileVersionStore,
  StoredCompleteVersion,
  VersionArtifactSet,
} from "../facts/version-store.js";
import { CORE_PROFILE_FACETS, validateVersionArtifactSet } from "../facts/version-store.js";
import { storageCorrupt } from "../internal-errors.js";
import type { Layout } from "../layout.js";
import { compareUtf8 } from "../profile/claim-id.js";
import {
  versionClaimsSnapshotSchema,
  versionMaterialManifestSchema,
  versionRecordSchema,
} from "@distilly/protocol";
import type {
  RuntimeSchema,
  VersionClaimsSnapshot,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";

const storedVersionSchema: RuntimeSchema<VersionRecord> = {
  parse(value) {
    return versionRecordSchema.parse(value) as VersionRecord;
  },
};

const storedManifestSchema: RuntimeSchema<VersionMaterialManifest> = {
  parse(value) {
    return versionMaterialManifestSchema.parse(value);
  },
};

const storedClaimsSchema: RuntimeSchema<VersionClaimsSnapshot> = {
  parse(value) {
    return versionClaimsSnapshotSchema.parse(value) as VersionClaimsSnapshot;
  },
};

const isAlreadyExists = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

/**
 * Returns the retired test-only staging root formerly exposed by production Layout.
 *
 * @param layout - Legacy file layout used by the regression fixture.
 * @param subjectId - Subject that owns the staged version.
 * @returns Absolute path to the subject's retired staging root.
 */
export const legacyVersionStagingRootDirectory = (layout: Layout, subjectId: SubjectId): string =>
  resolve(layout.versionsDirectory(subjectId), ".staging");

/**
 * Returns one retired test-only staging path owned by a commit journal.
 *
 * @param layout - Legacy file layout used by the regression fixture.
 * @param requestId - Mutation request that owns the staged version.
 * @param subjectId - Subject that owns the staged version.
 * @param versionId - Immutable version being staged.
 * @returns Absolute path to the retired staging directory.
 */
export const legacyVersionStagingDirectory = (
  layout: Layout,
  requestId: RequestId,
  subjectId: SubjectId,
  versionId: VersionId,
): string =>
  resolve(
    legacyVersionStagingRootDirectory(layout, subjectId),
    `${requestIdSchema.parse(requestId)}.${versionIdSchema.parse(versionId)}`,
  );

/**
 * Returns one retired test-only deleting path used by commit recovery.
 *
 * @param layout - Legacy file layout used by the regression fixture.
 * @param requestId - Mutation request that owns the staged version.
 * @param subjectId - Subject that owns the staged version.
 * @param versionId - Immutable version being deleted.
 * @returns Absolute path to the retired deleting directory.
 */
export const legacyVersionDeletingDirectory = (
  layout: Layout,
  requestId: RequestId,
  subjectId: SubjectId,
  versionId: VersionId,
): string =>
  resolve(
    legacyVersionStagingRootDirectory(layout, subjectId),
    `${requestIdSchema.parse(requestId)}.${versionIdSchema.parse(versionId)}.deleting`,
  );

const writeProfileArtifacts = async (
  root: string,
  profileDirectory: string,
  promptFile: string,
  profile: Profile,
  prompt: string,
  afterArtifact: (label: VersionStagingArtifactLabel) => Promise<void>,
): Promise<void> => {
  const domainsDirectory = join(profileDirectory, "domains");
  await assertNoSymlinkPath(root, profileDirectory);
  await ensurePrivateDirectory(profileDirectory);
  await ensurePrivateDirectory(domainsDirectory);
  await atomicCreateFile(root, join(profileDirectory, "profile.md"), profile.rendered);
  await afterArtifact("profile/profile.md");
  for (const facet of CORE_PROFILE_FACETS) {
    await atomicCreateFile(root, join(profileDirectory, `${facet}.md`), profile.core[facet]);
    await afterArtifact(`profile/${facet}.md`);
  }
  const domainRoots = Object.keys(profile.domains).sort(compareUtf8);
  for (const domainRoot of domainRoots) {
    const content = profile.domains[domainRoot];
    if (content === undefined) throw storageCorrupt("Version profile domain is missing content.");
    await atomicCreateFile(root, join(domainsDirectory, `${domainRoot}.md`), content);
    await afterArtifact(`profile/domains/${domainRoot}.md`);
  }
  await atomicCreateFile(root, promptFile, prompt);
  await afterArtifact("prompt.md");
  await syncDirectory(domainsDirectory);
  await syncDirectory(profileDirectory);
};

/** Callback that proves a published version has no authoritative or lineage references. */
export type VerifyVersionUnreferenced = (
  subjectId: SubjectId,
  versionId: VersionId,
) => Promise<void>;

/** Stable relative-path labels for durable files created in one version staging directory. */
export type VersionStagingArtifactLabel =
  | "version.json"
  | "materials.json"
  | "claims.json"
  | "profile/profile.md"
  | `profile/${(typeof CORE_PROFILE_FACETS)[number]}.md`
  | `profile/domains/${string}.md`
  | "prompt.md";

/** Fault-injection hooks for fixed version staging and abort-cleanup tests. */
export interface VersionStagingHooks {
  /** Runs after one staged artifact file and its direct parent entry are durable. */
  readonly afterArtifact?: (label: VersionStagingArtifactLabel) => void | Promise<void>;
  /** Runs after exact/reference verification and immediately before the deletion rename. */
  readonly beforePublishedCleanupRename?: () => void | Promise<void>;
  /** Runs after the deletion rename and before either parent directory is synchronized. */
  readonly afterPublishedCleanupRename?: () => void | Promise<void>;
  /** Runs immediately before recursive cleanup of the fixed journal-owned deleting path. */
  readonly beforePublishedCleanupRemoval?: () => void | Promise<void>;
}

/** Fixed-path, journal-addressable immutable-version staging and publication seam. */
export class FileVersionStaging {
  readonly #layout: Layout;
  readonly #versions: FileVersionStore;
  readonly #hooks: VersionStagingHooks;

  /**
   * Creates a staging seam backed by the complete immutable-version verifier.
   *
   * @param layout - Confined local fact layout.
   * @param versions - Complete version verifier used before publish and cleanup.
   * @param hooks - Optional deterministic fault-injection callbacks used by tests.
   */
  constructor(layout: Layout, versions: FileVersionStore, hooks: VersionStagingHooks = {}) {
    this.#layout = layout;
    this.#versions = versions;
    this.#hooks = hooks;
  }

  /**
   * Writes the complete artifact set to its fixed journal-owned staging directory.
   *
   * An exact pre-existing staging directory is accepted as an idempotent retry.
   *
   * @param requestId - Commit journal that owns the staging directory.
   * @param input - Complete version facts, Profile, and prompt from that journal.
   */
  async prepare(requestId: RequestId, input: VersionArtifactSet): Promise<void> {
    const prepared = validateVersionArtifactSet(input);
    const { subjectId, id: versionId } = prepared.version;
    const staging = legacyVersionStagingDirectory(this.#layout, requestId, subjectId, versionId);
    try {
      await createPrivateDirectoryExclusive(this.#layout.root, staging);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await this.readExact(requestId, prepared);
      return;
    }

    await createFactFile(
      this.#layout.root,
      join(staging, "version.json"),
      prepared.version,
      storedVersionSchema,
    );
    await this.#hooks.afterArtifact?.("version.json");
    await createFactFile(
      this.#layout.root,
      join(staging, "materials.json"),
      prepared.manifest,
      storedManifestSchema,
    );
    await this.#hooks.afterArtifact?.("materials.json");
    await createFactFile(
      this.#layout.root,
      join(staging, "claims.json"),
      prepared.claims,
      storedClaimsSchema,
    );
    await this.#hooks.afterArtifact?.("claims.json");
    await writeProfileArtifacts(
      this.#layout.root,
      join(staging, "profile"),
      join(staging, "prompt.md"),
      prepared.profile,
      prepared.prompt,
      async (label) => {
        await this.#hooks.afterArtifact?.(label);
      },
    );
    await syncDirectory(staging);
    await this.readExact(requestId, prepared);
  }

  /**
   * Re-reads the fixed staging directory and matches every artifact to one journal payload.
   *
   * @param requestId - Commit journal that owns the staging directory.
   * @param input - Complete exact journal-owned payload.
   * @returns The complete verified staged version.
   */
  async readExact(requestId: RequestId, input: VersionArtifactSet): Promise<StoredCompleteVersion> {
    const prepared = validateVersionArtifactSet(input);
    return this.#versions.readFromDirectory(
      prepared.version.subjectId,
      prepared.version.id,
      legacyVersionStagingDirectory(
        this.#layout,
        requestId,
        prepared.version.subjectId,
        prepared.version.id,
      ),
      prepared,
    );
  }

  /**
   * Publishes one complete fixed staging directory without replacing an immutable version.
   *
   * An exact already-published target is accepted and its redundant fixed staging is removed.
   *
   * @param requestId - Commit journal that owns the staging directory.
   * @param input - Complete exact journal-owned payload.
   */
  async publish(requestId: RequestId, input: VersionArtifactSet): Promise<void> {
    const prepared = validateVersionArtifactSet(input);
    const { subjectId, id: versionId } = prepared.version;
    const target = this.#layout.versionDirectory(subjectId, versionId);
    try {
      const status = await lstat(target);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw storageCorrupt("Published version target is not a real directory.");
      }
      await this.#versions.readFromDirectory(subjectId, versionId, target, prepared);
      await this.cleanup(requestId, prepared);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.readExact(requestId, prepared);
    await publishDirectoryNoReplace(
      this.#layout.root,
      legacyVersionStagingDirectory(this.#layout, requestId, subjectId, versionId),
      target,
    );
    await this.#versions.readFromDirectory(subjectId, versionId, target, prepared);
  }

  /**
   * Removes only the fixed staging directory owned by one journal payload.
   *
   * A missing staging directory is an idempotent success. Partial contents are allowed because a
   * crash may interrupt prepare before the full artifact set exists; the fixed request/version path
   * is the ownership proof.
   *
   * @param requestId - Commit journal that owns the staging directory.
   * @param input - Journal payload that fixes the subject and version path.
   */
  async cleanup(requestId: RequestId, input: VersionArtifactSet): Promise<void> {
    const prepared = validateVersionArtifactSet(input);
    const staging = legacyVersionStagingDirectory(
      this.#layout,
      requestId,
      prepared.version.subjectId,
      prepared.version.id,
    );
    await this.removeRealDirectory(staging, "Journal version staging path");
  }

  /**
   * Removes an exact published version only after recovery proves it has no references.
   *
   * Callers must hold the subject lock while the proof and removal run.
   *
   * @param requestId - Commit journal that exclusively owns the fixed deleting path.
   * @param input - Exact journal-owned artifact set eligible for abort cleanup.
   * @param verifyUnreferenced - Recovery callback that rejects every remaining reference.
   */
  async removePublishedExact(
    requestId: RequestId,
    input: VersionArtifactSet,
    verifyUnreferenced: VerifyVersionUnreferenced,
  ): Promise<void> {
    const prepared = validateVersionArtifactSet(input);
    const { subjectId, id: versionId } = prepared.version;
    const target = this.#layout.versionDirectory(subjectId, versionId);
    const deleting = legacyVersionDeletingDirectory(this.#layout, requestId, subjectId, versionId);

    if (await this.realDirectoryExists(deleting, "Published version deleting path")) {
      await this.#hooks.beforePublishedCleanupRemoval?.();
      await this.removeRealDirectory(deleting, "Published version deleting path");
      return;
    }

    let status;
    try {
      status = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw storageCorrupt("Published version cleanup target is not a real directory.");
    }
    await this.#versions.readFromDirectory(subjectId, versionId, target, prepared);
    await verifyUnreferenced(subjectId, versionId);
    await this.#versions.readFromDirectory(subjectId, versionId, target, prepared);

    const deletingParent = dirname(deleting);
    await assertNoSymlinkPath(this.#layout.root, deletingParent);
    await ensurePrivateDirectory(deletingParent);
    await assertNoSymlinkPath(this.#layout.root, deletingParent);
    if (await this.realDirectoryExists(deleting, "Published version deleting path")) {
      throw storageCorrupt("Published version deleting path appeared during cleanup.");
    }

    await this.#hooks.beforePublishedCleanupRename?.();
    await rename(target, deleting);
    await this.#hooks.afterPublishedCleanupRename?.();
    await syncDirectory(dirname(target));
    if (deletingParent !== dirname(target)) await syncDirectory(deletingParent);
    await this.#hooks.beforePublishedCleanupRemoval?.();
    await this.removeRealDirectory(deleting, "Published version deleting path");
  }

  private async realDirectoryExists(path: string, label: string): Promise<boolean> {
    let status;
    try {
      status = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw storageCorrupt(`${label} is not a real directory.`);
    }
    return true;
  }

  private async removeRealDirectory(path: string, label: string): Promise<void> {
    const parent = dirname(path);
    await assertNoSymlinkPath(this.#layout.root, parent);
    let status;
    try {
      status = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw storageCorrupt(`${label} is not a real directory.`);
    }
    await rm(path, { recursive: true, force: false });
    await syncDirectory(parent);
  }
}
