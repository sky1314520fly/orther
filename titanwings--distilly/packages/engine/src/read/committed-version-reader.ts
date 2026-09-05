import { DistillyError } from "@distilly/protocol";
import type {
  EventRecord,
  MaterialId,
  SpaceRecord,
  SubjectId,
  SubjectRecord,
  SubjectStateRecord,
  VersionId,
} from "@distilly/protocol";

import type { FileEventStore } from "../facts/event-store.js";
import type { FileMaterialStore, StoredMaterial } from "../facts/material-store.js";
import type { FileSpaceStore } from "../facts/space-store.js";
import type { FileStateStore } from "../facts/state-store.js";
import type { FileSubjectStore } from "../facts/subject-store.js";
import type { FileVersionStore, StoredCompleteVersion } from "../facts/version-store.js";
import { validateRollbackArtifactCopy } from "../facts/version-store.js";
import { storageCorrupt } from "../internal-errors.js";
import type { FileSubjectLock } from "../transaction/subject-lock.js";

/** One subject's complete fact snapshot after committed-version visibility validation. */
export interface CommittedSubjectSnapshot {
  readonly subject: SubjectRecord;
  readonly space: SpaceRecord;
  readonly state: SubjectStateRecord;
  readonly versions: readonly StoredCompleteVersion[];
  readonly versionsById: ReadonlyMap<VersionId, StoredCompleteVersion>;
  readonly events: readonly EventRecord[];
}

const VERSION_EVENT_KINDS = new Set<EventRecord["event"]["kind"]>([
  "version.current",
  "version.suspended",
  "version.promoted",
  "version.rejected",
  "version.rolled_back",
]);

const expectedCreationEvent = (
  version: StoredCompleteVersion["version"],
): "version.current" | "version.suspended" | "version.rolled_back" => {
  if (version.creation.kind === "rollback") return "version.rolled_back";
  return version.createdDisposition === "current" ? "version.current" : "version.suspended";
};

const actorsEqual = (left: EventRecord["actor"], right: EventRecord["actor"]): boolean =>
  left.kind === right.kind && left.id === right.id && left.host === right.host;

const hasExactCreationEvent = (
  stored: StoredCompleteVersion,
  events: readonly EventRecord[],
): boolean => {
  const creationEvents = events.filter(
    (record) =>
      record.event.versionId === stored.version.id &&
      (record.event.kind === "version.current" ||
        record.event.kind === "version.suspended" ||
        record.event.kind === "version.rolled_back"),
  );
  const creation = creationEvents[0];
  return (
    creationEvents.length === 1 &&
    creation !== undefined &&
    creation.event.kind === expectedCreationEvent(stored.version) &&
    creation.event.at === stored.version.createdAt &&
    actorsEqual(creation.actor, stored.version.actor) &&
    (stored.version.creation.kind !== "rollback" ||
      creation.relatedVersionId === stored.version.creation.targetVersionId)
  );
};

const wasCurrentBy = (
  stored: StoredCompleteVersion,
  decisions: ReadonlyMap<VersionId, EventRecord>,
  at: EventRecord["event"]["at"],
): boolean => {
  if (stored.version.createdAt > at) return false;
  const decision = decisions.get(stored.version.id);
  if (stored.version.createdDisposition === "current") return decision === undefined;
  return (
    decision?.event.kind === "version.promoted" &&
    decision.event.at >= stored.version.createdAt &&
    decision.event.at <= at
  );
};

/**
 * Verifies that rollback bytes copy a source that was historical under the creation-time current.
 *
 * @param rollback - Complete rollback artifacts, published or retained only by a journal.
 * @param versionsById - Complete durable versions available before or after publication.
 * @param events - Durable lineage events visible at the validation boundary.
 */
const validateRollbackHistoricalCopy = (
  rollback: StoredCompleteVersion,
  versionsById: ReadonlyMap<VersionId, StoredCompleteVersion>,
  events: readonly EventRecord[],
): void => {
  if (rollback.version.creation.kind !== "rollback") return;
  const decisions = new Map<VersionId, EventRecord>();
  for (const record of events) {
    const versionId = record.event.versionId;
    if (
      versionId !== undefined &&
      (record.event.kind === "version.promoted" || record.event.kind === "version.rejected")
    ) {
      if (decisions.has(versionId)) {
        throw storageCorrupt("Rollback lineage contains contradictory review decisions.");
      }
      decisions.set(versionId, record);
    }
  }
  const parentId = rollback.version.parentId;
  const targetVersionId = rollback.version.creation.targetVersionId;
  if (parentId === undefined || targetVersionId === parentId) {
    throw storageCorrupt("A rollback source must be historical, not its creation-time current.");
  }
  const source = versionsById.get(targetVersionId);
  if (source === undefined) {
    throw storageCorrupt("A rollback version references a missing historical source.");
  }
  validateRollbackArtifactCopy(source, rollback);

  for (const candidate of versionsById.values()) {
    if (
      candidate.version.id !== rollback.version.id &&
      candidate.version.parentId === parentId &&
      wasCurrentBy(candidate, decisions, rollback.version.createdAt)
    ) {
      if (!hasExactCreationEvent(candidate, events)) {
        throw storageCorrupt("A rollback sibling is missing its exact creation event.");
      }
      throw storageCorrupt("A rollback parent was already historical when rollback was created.");
    }
  }

  const visited = new Set<VersionId>([rollback.version.id]);
  let cursorId: VersionId | undefined = parentId;
  while (cursorId !== undefined) {
    if (visited.has(cursorId)) {
      throw storageCorrupt("Rollback current lineage contains a cycle.");
    }
    visited.add(cursorId);
    const cursor = versionsById.get(cursorId);
    if (
      cursor === undefined ||
      !hasExactCreationEvent(cursor, events) ||
      !wasCurrentBy(cursor, decisions, rollback.version.createdAt)
    ) {
      throw storageCorrupt("A rollback parent lineage was not current when rollback was created.");
    }
    if (cursorId === targetVersionId) return;
    cursorId = cursor.version.parentId;
  }
  throw storageCorrupt("A rollback source is not historical in its creation-time current lineage.");
};

/**
 * Verifies that physical immutable versions are exactly the durable event-visible set.
 *
 * @param subjectId - Subject that owns every supplied fact.
 * @param state - Authoritative state snapshot.
 * @param versions - Every physical immutable version directory for the subject.
 * @param events - Every durable event fact for the subject.
 * @returns A lookup map for the validated committed versions.
 */
export const validateCommittedVersionSet = (
  subjectId: SubjectId,
  state: SubjectStateRecord,
  versions: readonly StoredCompleteVersion[],
  events: readonly EventRecord[],
): ReadonlyMap<VersionId, StoredCompleteVersion> => {
  const versionsById = new Map<VersionId, StoredCompleteVersion>();
  for (const stored of versions) {
    if (stored.version.subjectId !== subjectId || versionsById.has(stored.version.id)) {
      throw storageCorrupt(
        "The immutable-version set has invalid subject ownership or duplicates.",
      );
    }
    versionsById.set(stored.version.id, stored);
  }

  for (const versionId of [state.currentVersionId, state.suspendedVersionId]) {
    if (versionId !== undefined && !versionsById.has(versionId)) {
      throw storageCorrupt("Subject state references a missing committed immutable version.");
    }
  }

  const creationCounts = new Map<VersionId, number>();
  const decisionKinds = new Map<VersionId, "version.promoted" | "version.rejected">();
  const decisionEvents = new Map<VersionId, EventRecord>();
  const replacementTargets = new Map<VersionId, VersionId>();
  for (const record of events) {
    const versionId = record.event.versionId;
    if (VERSION_EVENT_KINDS.has(record.event.kind)) {
      if (versionId === undefined || !versionsById.has(versionId)) {
        throw storageCorrupt("A durable version event references a missing immutable version.");
      }
    }
    if (record.relatedVersionId !== undefined && !versionsById.has(record.relatedVersionId)) {
      throw storageCorrupt("A durable lineage event references a missing related version.");
    }
    if (
      versionId !== undefined &&
      (record.event.kind === "version.current" ||
        record.event.kind === "version.suspended" ||
        record.event.kind === "version.rolled_back")
    ) {
      const stored = versionsById.get(versionId)!;
      if (
        record.event.kind !== expectedCreationEvent(stored.version) ||
        record.event.at !== stored.version.createdAt ||
        !actorsEqual(record.actor, stored.version.actor)
      ) {
        throw storageCorrupt("An immutable version has an invalid durable creation event.");
      }
      creationCounts.set(versionId, (creationCounts.get(versionId) ?? 0) + 1);
    }
    if (
      versionId !== undefined &&
      (record.event.kind === "version.promoted" || record.event.kind === "version.rejected")
    ) {
      if (decisionKinds.has(versionId)) {
        throw storageCorrupt("A suspended version has more than one terminal review decision.");
      }
      const version = versionsById.get(versionId)!;
      if (
        version.version.createdDisposition !== "suspended" ||
        record.event.at < version.version.createdAt
      ) {
        throw storageCorrupt("A review decision does not belong to a prior suspended version.");
      }
      decisionKinds.set(versionId, record.event.kind);
      decisionEvents.set(versionId, record);
    }
    if (record.event.kind === "version.rolled_back" && versionId !== undefined) {
      const version = versionsById.get(versionId)!;
      if (
        version.version.creation.kind !== "rollback" ||
        record.relatedVersionId !== version.version.creation.targetVersionId
      ) {
        throw storageCorrupt("A rollback event does not match its immutable version source.");
      }
    }
    if (
      record.event.kind === "version.rejected" &&
      versionId !== undefined &&
      record.relatedVersionId !== undefined
    ) {
      const replacement = versionsById.get(record.relatedVersionId)!;
      if (
        replacement.version.derivedFromCandidateVersionId !== versionId ||
        record.event.at !== replacement.version.createdAt ||
        !actorsEqual(record.actor, replacement.version.actor)
      ) {
        throw storageCorrupt("A candidate replacement event does not match its derived version.");
      }
      replacementTargets.set(versionId, record.relatedVersionId);
    }
  }

  for (const [versionId, stored] of versionsById) {
    if (creationCounts.get(versionId) !== 1) {
      throw storageCorrupt("Every physical immutable version requires one creation event.");
    }
    const decision = decisionKinds.get(versionId);
    if (
      stored.version.creation.kind === "rollback" &&
      stored.version.createdDisposition !== "current"
    ) {
      throw storageCorrupt("A rollback-created version must be created current.");
    }
    if (
      stored.version.derivedFromCandidateVersionId !== undefined &&
      stored.version.creation.kind !== "correction"
    ) {
      throw storageCorrupt("Only a correction version may derive from a suspended candidate.");
    }
    if (stored.version.createdDisposition === "current" && decision !== undefined) {
      throw storageCorrupt("A version created current cannot have a review decision.");
    }
    if (stored.version.createdDisposition === "suspended") {
      if (state.suspendedVersionId === versionId && decision !== undefined) {
        throw storageCorrupt(
          "The active suspended version already has a terminal review decision.",
        );
      }
      if (state.suspendedVersionId !== versionId && decision === undefined) {
        throw storageCorrupt(
          "An inactive suspended version is missing its terminal review decision.",
        );
      }
      if (state.currentVersionId === versionId && decision !== "version.promoted") {
        throw storageCorrupt("A current version created suspended requires one promote decision.");
      }
    }
    for (const reference of [
      stored.version.parentId,
      stored.version.derivedFromCandidateVersionId,
      stored.version.creation.kind === "rollback"
        ? stored.version.creation.targetVersionId
        : undefined,
      stored.version.creation.kind === "renderer_only"
        ? stored.version.creation.sourceVersionId
        : undefined,
    ]) {
      if (reference !== undefined && !versionsById.has(reference)) {
        throw storageCorrupt("An immutable version references a missing lineage version.");
      }
    }
    if (stored.version.derivedFromCandidateVersionId !== undefined) {
      if (replacementTargets.get(stored.version.derivedFromCandidateVersionId) !== versionId) {
        throw storageCorrupt("A candidate-derived version is missing its replacement event.");
      }
    }
    validateRollbackHistoricalCopy(stored, versionsById, events);
  }

  const currentLineage = new Set<VersionId>();
  for (const [versionId, stored] of versionsById) {
    if (
      stored.version.createdDisposition === "current" ||
      decisionKinds.get(versionId) === "version.promoted"
    ) {
      currentLineage.add(versionId);
    }
  }
  const currentChildren = new Map<VersionId, VersionId>();
  let currentRoots = 0;
  for (const versionId of currentLineage) {
    const stored = versionsById.get(versionId)!;
    const parentId = stored.version.parentId;
    if (parentId === undefined) {
      currentRoots += 1;
      continue;
    }
    const parent = versionsById.get(parentId);
    if (
      parent === undefined ||
      !currentLineage.has(parentId) ||
      !wasCurrentBy(parent, decisionEvents, stored.version.createdAt)
    ) {
      throw storageCorrupt("A current-lineage version does not descend from a prior current.");
    }
    if (currentChildren.has(parentId)) {
      throw storageCorrupt("A current-lineage version has more than one current child.");
    }
    currentChildren.set(parentId, versionId);
  }
  const currentLeaves = [...currentLineage].filter((versionId) => !currentChildren.has(versionId));
  if (
    (currentLineage.size === 0 && state.currentVersionId !== undefined) ||
    (currentLineage.size > 0 && currentRoots !== 1) ||
    currentLeaves.length !== (state.currentVersionId === undefined ? 0 : 1) ||
    (state.currentVersionId !== undefined && currentLeaves[0] !== state.currentVersionId)
  ) {
    throw storageCorrupt("Subject state does not identify the unique current-lineage leaf.");
  }
  if (state.currentVersionId !== undefined) {
    const reachable = new Set<VersionId>();
    let cursorId: VersionId | undefined = state.currentVersionId;
    while (cursorId !== undefined) {
      if (reachable.has(cursorId)) {
        throw storageCorrupt("The current lineage contains a parent cycle.");
      }
      reachable.add(cursorId);
      cursorId = versionsById.get(cursorId)?.version.parentId;
    }
    if (reachable.size !== currentLineage.size) {
      throw storageCorrupt("The current lineage is not one connected root-to-leaf chain.");
    }
  }

  if (state.suspendedVersionId !== undefined) {
    const suspended = versionsById.get(state.suspendedVersionId)!;
    if (
      suspended.version.createdDisposition !== "suspended" ||
      suspended.version.parentId !== state.currentVersionId
    ) {
      throw storageCorrupt(
        "The active suspended version does not match the current state lineage.",
      );
    }
  }
  return versionsById;
};

/**
 * Verifies that physical immutable materials are exactly the state/version referenced set.
 *
 * @param state - Authoritative state whose manifest includes pending-generation materials.
 * @param versions - Every complete committed immutable version for the subject.
 * @param materials - Every complete physical immutable material for the subject.
 * @returns A lookup map for the validated committed material set.
 */
export const validateCommittedMaterialSet = (
  state: SubjectStateRecord,
  versions: readonly StoredCompleteVersion[],
  materials: readonly StoredMaterial[],
): ReadonlyMap<MaterialId, StoredMaterial> => {
  const referenced = new Map<
    MaterialId,
    { readonly content: string; readonly provenance: string }
  >();
  for (const entry of [
    ...state.materialManifest,
    ...versions.flatMap((stored) => stored.manifest.items),
  ]) {
    const previous = referenced.get(entry.materialId);
    if (
      previous !== undefined &&
      (previous.content !== entry.contentDigest || previous.provenance !== entry.provenanceDigest)
    ) {
      throw storageCorrupt("Material manifests disagree about one immutable material identity.");
    }
    referenced.set(entry.materialId, {
      content: entry.contentDigest,
      provenance: entry.provenanceDigest,
    });
  }
  const materialsById = new Map<MaterialId, StoredMaterial>();
  for (const stored of materials) {
    if (stored.record.subjectId !== state.subjectId || materialsById.has(stored.record.id)) {
      throw storageCorrupt("The immutable-material set has invalid ownership or duplicates.");
    }
    const expected = referenced.get(stored.record.id);
    if (
      expected === undefined ||
      expected.content !== stored.record.contentDigest ||
      expected.provenance !== stored.record.provenanceDigest
    ) {
      throw storageCorrupt(
        "A physical immutable material is orphaned or disagrees with manifests.",
      );
    }
    materialsById.set(stored.record.id, stored);
  }
  if (materialsById.size !== referenced.size) {
    throw storageCorrupt("A state or version manifest references a missing immutable material.");
  }
  return materialsById;
};

/** Coordinates read snapshots with recovery, subject writers, and committed-version visibility. */
export class CommittedVersionReader {
  readonly #spaces: Pick<FileSpaceStore, "read">;
  readonly #subjects: Pick<FileSubjectStore, "read">;
  readonly #states: Pick<FileStateStore, "read">;
  readonly #materials: Pick<FileMaterialStore, "list">;
  readonly #versions: Pick<FileVersionStore, "list">;
  readonly #events: Pick<FileEventStore, "list">;
  readonly #subjectLocks: Pick<FileSubjectLock, "acquire">;
  readonly #reconcile: () => Promise<void>;
  readonly #writerPending: (() => Promise<boolean>) | undefined;

  /**
   * Creates a coordinated committed-version reader.
   *
   * @param input - Verified stores, writer lock, and root recovery callback.
   * @param input.spaces - Verified space facts.
   * @param input.subjects - Verified subject facts.
   * @param input.states - Verified authoritative subject states.
   * @param input.materials - Complete immutable material collection reader.
   * @param input.versions - Complete immutable version reader.
   * @param input.events - Durable subject events.
   * @param input.subjectLocks - Subject writer coordination.
   * @param input.reconcile - Root transaction reconciliation callback.
   * @param input.writerPending - O(1) durable writer-intent probe.
   */
  constructor(input: {
    readonly spaces: Pick<FileSpaceStore, "read">;
    readonly subjects: Pick<FileSubjectStore, "read">;
    readonly states: Pick<FileStateStore, "read">;
    readonly materials: Pick<FileMaterialStore, "list">;
    readonly versions: Pick<FileVersionStore, "list">;
    readonly events: Pick<FileEventStore, "list">;
    readonly subjectLocks: Pick<FileSubjectLock, "acquire">;
    readonly reconcile: () => Promise<void>;
    readonly writerPending?: () => Promise<boolean>;
  }) {
    this.#spaces = input.spaces;
    this.#subjects = input.subjects;
    this.#states = input.states;
    this.#materials = input.materials;
    this.#versions = input.versions;
    this.#events = input.events;
    this.#subjectLocks = input.subjectLocks;
    this.#reconcile = input.reconcile;
    this.#writerPending = input.writerPending;
  }

  /**
   * Reads one fact snapshot that cannot observe a prepared version publication.
   *
   * @param subjectId - Existing subject to read.
   * @param read - Callback that consumes the snapshot while its writer lock is held.
   * @returns The callback result after reconciliation and lock release.
   */
  async withSnapshot<T>(
    subjectId: SubjectId,
    read: (snapshot: CommittedSubjectSnapshot) => Promise<T> | T,
  ): Promise<T> {
    await this.#reconcile();
    return this.withReconciledSnapshot(subjectId, read);
  }

  /**
   * Completes the one root reconciliation shared by a multi-subject read.
   *
   * @returns Completion after every visible root journal is reconciled.
   */
  reconcile(): Promise<void> {
    return this.#reconcile();
  }

  /**
   * Reads one subject after the caller has completed this top-level read's reconciliation.
   *
   * @param subjectId - Existing subject to read.
   * @param read - Callback that consumes the snapshot while its writer lock is held.
   * @returns The callback result after releasing the lock.
   */
  async withReconciledSnapshot<T>(
    subjectId: SubjectId,
    read: (snapshot: CommittedSubjectSnapshot) => Promise<T> | T,
  ): Promise<T> {
    for (;;) {
      const lease = await this.#subjectLocks.acquire(subjectId);
      try {
        if (!(await this.#writerPending?.())) {
          const subject = await this.#subjects.read(subjectId);
          let state: SubjectStateRecord;
          try {
            state = await this.#states.read(subjectId);
          } catch (error) {
            if (error instanceof DistillyError && error.code === "not_found") {
              throw storageCorrupt(
                "A published subject is missing its authoritative state.",
                error,
              );
            }
            throw error;
          }
          const [space, materials, versions, events] = await Promise.all([
            this.#spaces.read(subject.spaceId),
            this.#materials.list(subjectId),
            this.#versions.list(subjectId),
            this.#events.list(subjectId),
          ]);
          const versionsById = validateCommittedVersionSet(subjectId, state, versions, events);
          validateCommittedMaterialSet(state, versions, materials);
          const snapshot = {
            subject,
            space,
            state,
            versions,
            versionsById,
            events,
          };
          return await read(snapshot);
        }
      } finally {
        await lease.release();
      }
      await this.#reconcile();
    }
  }
}
