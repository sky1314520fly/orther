import {
  DistillyError,
  versionMaterialManifestSchema,
  versionRecordSchema,
} from "@distilly/protocol";
import type {
  RuntimeSchema,
  SubjectId,
  VersionId,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { hashMaterialSet } from "./digests.js";
import { readFactFile } from "./fact-file.js";
import type { FileMaterialStore } from "./material-store.js";

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

/** Verified immutable version metadata and its historical material membership. */
export interface StoredVersionManifest {
  readonly version: VersionRecord;
  readonly manifest: VersionMaterialManifest;
}

/** Minimal read-only store used to compute the current-version ingest baseline. */
export class FileVersionManifestStore {
  readonly #layout: Layout;
  readonly #materials: FileMaterialStore;

  /**
   * Creates a read-only version-manifest store for one fact layout.
   *
   * @param layout - Confined local fact layout.
   * @param materials - Store used to validate every immutable manifest member.
   */
  constructor(layout: Layout, materials: FileMaterialStore) {
    this.#layout = layout;
    this.#materials = materials;
  }

  /**
   * Reads and cross-validates one immutable VersionRecord and materials manifest.
   *
   * @param subjectId - Subject that owns the immutable version.
   * @param versionId - Profile version to load.
   * @returns Verified version metadata and its material manifest.
   */
  async read(subjectId: SubjectId, versionId: VersionId): Promise<StoredVersionManifest> {
    const version = await readFactFile(
      this.#layout.root,
      this.#layout.versionFile(subjectId, versionId),
      storedVersionSchema,
    );
    if (version.id !== versionId) {
      throw storageCorrupt("Version id does not match its fact path.");
    }
    if (version.subjectId !== subjectId) {
      throw storageCorrupt("Version subject does not match its fact path.");
    }

    let manifest: VersionMaterialManifest;
    try {
      manifest = await readFactFile(
        this.#layout.root,
        this.#layout.versionMaterialManifestFile(subjectId, versionId),
        storedManifestSchema,
      );
    } catch (error) {
      if (error instanceof DistillyError && error.code === "not_found") {
        throw storageCorrupt("Version directory is missing materials.json.", error);
      }
      throw error;
    }
    if (manifest.items.length !== version.materialCount) {
      throw storageCorrupt("Version material count does not match its manifest.");
    }
    if (hashMaterialSet(manifest.items) !== version.materialSetHash) {
      throw storageCorrupt("Version material-set hash does not match its manifest.");
    }
    for (const entry of manifest.items) {
      let material;
      try {
        material = await this.#materials.read(subjectId, entry.materialId);
      } catch (error) {
        if (error instanceof DistillyError && error.code === "not_found") {
          throw storageCorrupt("Version manifest references a missing material fact.", error);
        }
        throw error;
      }
      if (
        material.record.contentDigest !== entry.contentDigest ||
        material.record.provenanceDigest !== entry.provenanceDigest
      ) {
        throw storageCorrupt("Version manifest digest does not match its material fact.");
      }
    }
    return { version, manifest };
  }
}
