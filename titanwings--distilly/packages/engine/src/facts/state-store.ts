import { DistillyError, subjectStateRecordSchema } from "@distilly/protocol";
import type { RuntimeSchema, SubjectId, SubjectStateRecord } from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { digestBriefContract, hashMaterialSet } from "./digests.js";
import { readMutableFactFile, replaceFactFile } from "./fact-file.js";
import type { FileMaterialStore } from "./material-store.js";
import type { FileSubjectStore } from "./subject-store.js";
import type { StoredVersion } from "./version-store.js";
import { FileVersionStore } from "./version-store.js";

const stateFactSchema: RuntimeSchema<SubjectStateRecord> = {
  parse(value) {
    return subjectStateRecordSchema.parse(value) as SubjectStateRecord;
  },
};

const requireSubject = async (subjects: FileSubjectStore, subjectId: SubjectId): Promise<void> => {
  try {
    await subjects.read(subjectId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("State fact references a missing subject.", error);
    }
    throw error;
  }
};

const requireManifestFacts = async (
  materials: FileMaterialStore,
  record: SubjectStateRecord,
): Promise<void> => {
  for (const entry of record.materialManifest) {
    let material;
    try {
      material = await materials.read(record.subjectId, entry.materialId);
    } catch (error) {
      if (error instanceof DistillyError && error.code === "not_found") {
        throw storageCorrupt("State manifest references a missing material fact.", error);
      }
      throw error;
    }
    if (material.record.contentDigest !== entry.contentDigest) {
      throw storageCorrupt("State manifest content digest does not match its material fact.");
    }
    if (material.record.provenanceDigest !== entry.provenanceDigest) {
      throw storageCorrupt("State manifest provenance digest does not match its material fact.");
    }
  }

  if (
    record.materialManifest.length !== 0 &&
    hashMaterialSet(record.materialManifest) !== record.materialSetHash
  ) {
    throw storageCorrupt("State material-set hash does not match its manifest.");
  }
};

const requireLeaseContract = (record: SubjectStateRecord): void => {
  const contract = record.pending?.lease?.contract;
  if (contract !== undefined && digestBriefContract(contract) !== contract.digest) {
    throw storageCorrupt("State pending lease contract digest does not match its version fields.");
  }
};

const requirePendingBaseline = async (
  versions: FileVersionStore,
  record: SubjectStateRecord,
): Promise<void> => {
  const pending = record.pending;
  if (pending === undefined) return;

  if (record.currentVersionId === undefined) {
    if (pending.addedMaterialCount !== record.materialManifest.length) {
      throw storageCorrupt(
        "State pending added-material count does not match its first-version manifest.",
      );
    }
    return;
  }

  let baseline;
  try {
    baseline = await versions.read(record.subjectId, record.currentVersionId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("State pending work references a missing current version.", error);
    }
    throw error;
  }

  const currentEntries = new Map(record.materialManifest.map((entry) => [entry.materialId, entry]));
  for (const entry of baseline.manifest.items) {
    const current = currentEntries.get(entry.materialId);
    if (
      current === undefined ||
      current.contentDigest !== entry.contentDigest ||
      current.provenanceDigest !== entry.provenanceDigest
    ) {
      throw storageCorrupt(
        "State pending baseline manifest is not an exact subset of the current manifest.",
      );
    }
  }

  const addedMaterialCount = record.materialManifest.length - baseline.manifest.items.length;
  if (pending.addedMaterialCount !== addedMaterialCount) {
    throw storageCorrupt(
      "State pending added-material count does not match its verified version baseline.",
    );
  }
};

const requireVersionManifestSubset = (record: SubjectStateRecord, stored: StoredVersion): void => {
  if (stored.version.generation > record.generation) {
    throw storageCorrupt("State version generation is newer than the authoritative state.");
  }
  const currentEntries = new Map(record.materialManifest.map((entry) => [entry.materialId, entry]));
  for (const entry of stored.manifest.items) {
    const current = currentEntries.get(entry.materialId);
    if (
      current === undefined ||
      current.contentDigest !== entry.contentDigest ||
      current.provenanceDigest !== entry.provenanceDigest
    ) {
      throw storageCorrupt(
        "State version manifest is not an exact subset of the current manifest.",
      );
    }
  }
};

const requireVersionPointers = async (
  versions: FileVersionStore,
  record: SubjectStateRecord,
): Promise<void> => {
  let current: StoredVersion | undefined;
  if (record.currentVersionId !== undefined) {
    current = await versions.read(record.subjectId, record.currentVersionId);
    requireVersionManifestSubset(record, current);
  }

  if (record.suspendedVersionId !== undefined) {
    const suspended = await versions.read(record.subjectId, record.suspendedVersionId);
    requireVersionManifestSubset(record, suspended);
    if (suspended.version.createdDisposition !== "suspended") {
      throw storageCorrupt("Suspended pointer does not identify a suspended-created version.");
    }
    if (suspended.version.parentId !== record.currentVersionId) {
      throw storageCorrupt("Suspended version parent does not match the current version pointer.");
    }
  }
};

/** Concrete local store for authoritative mutable subject state. */
export class FileStateStore {
  readonly #layout: Layout;
  readonly #subjects: FileSubjectStore;
  readonly #materials: FileMaterialStore;
  readonly #versions: FileVersionStore;

  /**
   * Creates a state store with subject and material fact dependencies.
   *
   * @param layout - Confined local fact layout.
   * @param subjects - Store used to validate subject ownership.
   * @param materials - Store used to validate manifest membership.
   */
  constructor(layout: Layout, subjects: FileSubjectStore, materials: FileMaterialStore) {
    this.#layout = layout;
    this.#subjects = subjects;
    this.#materials = materials;
    this.#versions = new FileVersionStore(layout, materials);
  }

  /**
   * Atomically publishes a state whose complete manifest is valid.
   *
   * @param record - Complete authoritative subject state.
   * @returns Completion after durable replacement.
   */
  async write(record: SubjectStateRecord): Promise<void> {
    let parsed: SubjectStateRecord;
    try {
      parsed = stateFactSchema.parse(record);
    } catch (error) {
      throw storageCorrupt("State fact cannot be written because its schema is invalid.", error);
    }
    await requireSubject(this.#subjects, parsed.subjectId);
    await requireManifestFacts(this.#materials, parsed);
    await requirePendingBaseline(this.#versions, parsed);
    await requireVersionPointers(this.#versions, parsed);
    requireLeaseContract(parsed);
    await replaceFactFile(
      this.#layout.root,
      this.#layout.stateFile(parsed.subjectId),
      parsed,
      stateFactSchema,
    );
  }

  /**
   * Reads state and validates its subject, manifest facts, and material-set hash.
   *
   * @param subjectId - Owning subject path segment.
   * @returns The verified authoritative state.
   */
  async read(subjectId: SubjectId): Promise<SubjectStateRecord> {
    await requireSubject(this.#subjects, subjectId);
    const record = await readMutableFactFile(
      this.#layout.root,
      this.#layout.stateFile(subjectId),
      stateFactSchema,
    );
    if (record.subjectId !== subjectId) {
      throw storageCorrupt("State subject id does not match its fact path.");
    }
    await requireManifestFacts(this.#materials, record);
    await requirePendingBaseline(this.#versions, record);
    await requireVersionPointers(this.#versions, record);
    requireLeaseContract(record);
    return record;
  }
}
