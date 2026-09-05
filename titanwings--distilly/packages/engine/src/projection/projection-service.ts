import { DistillyError } from "@distilly/protocol";
import type {
  EventRecord,
  LibraryEntry,
  LibraryPrivacy,
  RebuildResult,
  SubjectId,
  SubjectRecord,
  SubjectStateRecord,
  VersionMaterialEntry,
} from "@distilly/protocol";

import type { FileEventStore } from "../facts/event-store.js";
import type { FileMaterialStore, StoredMaterial } from "../facts/material-store.js";
import type { FileSpaceStore } from "../facts/space-store.js";
import type { FileStateStore } from "../facts/state-store.js";
import type { FileSubjectStore } from "../facts/subject-store.js";
import type { FileVersionStore, StoredCompleteVersion } from "../facts/version-store.js";
import { storageCorrupt } from "../internal-errors.js";
import { compareUtf8 } from "../profile/claim-id.js";
import {
  validateCommittedMaterialSet,
  validateCommittedVersionSet,
} from "../read/committed-version-reader.js";
import { summarizeSubject } from "../subject/service.js";
import type { CoordinatedLibraryProjection, LibraryApplyStatus } from "./library-projection.js";

type SubjectReader = Pick<FileSubjectStore, "read" | "listAll">;
type SpaceReader = Pick<FileSpaceStore, "read">;
type StateReader = Pick<FileStateStore, "read">;
type MaterialReader = Pick<FileMaterialStore, "list">;
type VersionReader = Pick<FileVersionStore, "list">;
type EventReader = Pick<FileEventStore, "list">;

const requiredState = async (
  states: StateReader,
  subjectId: SubjectId,
): Promise<SubjectStateRecord> => {
  try {
    return await states.read(subjectId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("A published subject is missing its authoritative state.", error);
    }
    throw error;
  }
};

const privacyFor = (
  materials: ReadonlyMap<VersionMaterialEntry["materialId"], StoredMaterial>,
  manifest: readonly VersionMaterialEntry[],
): LibraryPrivacy => {
  if (manifest.length === 0) return "none";
  let privateCount = 0;
  for (const entry of manifest) {
    const material = materials.get(entry.materialId);
    if (material === undefined) {
      throw storageCorrupt("Subject state references a missing material fact.");
    }
    if (
      material.record.contentDigest !== entry.contentDigest ||
      material.record.provenanceDigest !== entry.provenanceDigest
    ) {
      throw storageCorrupt("Subject material manifest does not match its immutable fact.");
    }
    if (material.record.sensitivity === "private") privateCount += 1;
  }
  if (privateCount === 0) return "shareable";
  return privateCount === manifest.length ? "private" : "mixed";
};

const lastChangedAt = (events: readonly EventRecord[]): EventRecord["event"]["at"] => {
  if (!events.some((record) => record.event.kind === "subject.created")) {
    throw storageCorrupt("A published subject has no creation-event baseline.");
  }
  let latest = events[0]?.event.at;
  if (latest === undefined) {
    throw storageCorrupt("A published subject has no durable events.");
  }
  for (const record of events.slice(1)) {
    if (record.event.at > latest) latest = record.event.at;
  }
  return latest;
};

const searchTermsFor = (
  subject: SubjectRecord,
  state: SubjectStateRecord,
  current: StoredCompleteVersion | undefined,
  privacy: LibraryPrivacy,
): readonly string[] =>
  [
    ...(subject.domainPack === undefined ? [] : [subject.domainPack]),
    ...Object.keys(current?.profile.domains ?? {}),
    subject.lifecycle,
    privacy,
    ...(current === undefined ? [] : [current.version.quality.maturity]),
    ...(state.pending === undefined ? [] : ["pending"]),
    ...(state.suspendedVersionId === undefined ? [] : ["suspended"]),
  ]
    .filter((term, index, terms) => terms.indexOf(term) === index)
    .sort(compareUtf8);

/** Builds canonical Library aggregates from verified facts and applies them under projection lock. */
export class ProjectionService {
  readonly #spaces: SpaceReader;
  readonly #subjects: SubjectReader;
  readonly #states: StateReader;
  readonly #materials: MaterialReader;
  readonly #versions: VersionReader;
  readonly #events: EventReader;
  readonly #projection: CoordinatedLibraryProjection;
  readonly #reconcile: () => Promise<void>;

  /**
   * Creates the fact-to-projection aggregate service.
   *
   * @param input - Verified stores and coordinated projection.
   * @param input.spaces - Immutable space fact reader.
   * @param input.subjects - Published subject fact reader.
   * @param input.states - Authoritative subject-state reader.
   * @param input.materials - Immutable material fact reader.
   * @param input.versions - Complete immutable-version reader.
   * @param input.events - Durable subject-event reader.
   * @param input.projection - Lock-coordinated Library projection.
   * @param input.reconcile - Root prepared-journal reconciliation callback.
   */
  constructor(input: {
    readonly spaces: SpaceReader;
    readonly subjects: SubjectReader;
    readonly states: StateReader;
    readonly materials: MaterialReader;
    readonly versions: VersionReader;
    readonly events: EventReader;
    readonly projection: CoordinatedLibraryProjection;
    readonly reconcile: () => Promise<void>;
  }) {
    this.#spaces = input.spaces;
    this.#subjects = input.subjects;
    this.#states = input.states;
    this.#materials = input.materials;
    this.#versions = input.versions;
    this.#events = input.events;
    this.#projection = input.projection;
    this.#reconcile = input.reconcile;
  }

  /**
   * Aggregates one subject from one verified subject/state snapshot and referenced facts.
   *
   * @param subjectId - Published subject whose aggregate is requested.
   * @returns The canonical fact-derived Library entry.
   */
  async entry(subjectId: SubjectId): Promise<LibraryEntry> {
    const subject = await this.#subjects.read(subjectId);
    const [space, state] = await Promise.all([
      this.#spaces.read(subject.spaceId),
      requiredState(this.#states, subject.id),
    ]);
    const [materials, versions, events] = await Promise.all([
      this.#materials.list(subject.id),
      this.#versions.list(subject.id),
      this.#events.list(subject.id),
    ]);
    const versionsById = validateCommittedVersionSet(subject.id, state, versions, events);
    const materialsById = validateCommittedMaterialSet(state, versions, materials);
    const privacy = privacyFor(materialsById, state.materialManifest);
    const current =
      state.currentVersionId === undefined ? undefined : versionsById.get(state.currentVersionId);
    const suspended =
      state.suspendedVersionId === undefined
        ? undefined
        : versionsById.get(state.suspendedVersionId);
    return this.toEntry(subject, state, space, current, suspended, privacy, events);
  }

  /**
   * Recovery seam: computes the exact post-commit entry while holding the projection lock.
   *
   * @param subjectId - Committed subject whose projection must be updated.
   * @returns Completion after a durable clean projection update.
   */
  async apply(subjectId: SubjectId): Promise<LibraryApplyStatus> {
    return this.#projection.apply(subjectId, () => this.entry(subjectId));
  }

  /**
   * Removes one purged subject while holding the projection lock.
   *
   * @param subjectId - Purged subject whose projection row is removed.
   * @returns Completion after a durable clean projection update.
   */
  async remove(subjectId: SubjectId): Promise<LibraryApplyStatus> {
    return this.#projection.apply(subjectId, () => Promise.resolve(undefined));
  }

  /**
   * Checks whether root recovery is required before a projection-backed read.
   *
   * @returns Whether a durable writer intent is present.
   */
  hasWriterIntent(): Promise<boolean> {
    return this.#projection.hasWriterIntent();
  }

  /**
   * Clears a normal writer intent after the corresponding journal is terminal.
   *
   * @param subjectId - Subject whose mutation completed.
   * @returns Completion after the durable intent is cleared or deliberately retained by recovery.
   */
  completeWriter(subjectId: SubjectId): Promise<void> {
    return this.#projection.completeWriter(subjectId);
  }

  /**
   * Clears a writer intent only while reconciliation proves no prepared journal remains.
   *
   * @param hasPreparedJournal - Transaction-store predicate executed under projection lock.
   * @returns Whether recovery must continue or the intent is settled.
   */
  settleReconciledIntent(
    hasPreparedJournal: () => Promise<boolean>,
  ): Promise<"pending" | "settled"> {
    return this.#projection.settleReconciledIntent(hasPreparedJournal);
  }

  /**
   * Rebuilds the complete projection with verified seed iteration beginning under its lock.
   *
   * @returns Exact Library-phase aggregate counts and completion time.
   */
  async rebuild(): Promise<RebuildResult> {
    await this.#reconcile();
    try {
      return await this.#projection.rebuild(() => this.entries());
    } catch (error) {
      if (!(error instanceof DistillyError) || error.code !== "busy") throw error;
      await this.#reconcile();
      return this.#projection.rebuild(() => this.entries());
    }
  }

  /**
   * Lazily yields one verified aggregate for every published subject.
   *
   * @returns An asynchronous stream of canonical fact-derived entries.
   */
  async *entries(): AsyncGenerator<LibraryEntry> {
    for (const subject of await this.#subjects.listAll()) {
      yield await this.entry(subject.id);
    }
  }

  private toEntry(
    subject: SubjectRecord,
    state: SubjectStateRecord,
    space: Awaited<ReturnType<SpaceReader["read"]>>,
    current: StoredCompleteVersion | undefined,
    suspended: StoredCompleteVersion | undefined,
    privacy: LibraryPrivacy,
    events: readonly EventRecord[],
  ): LibraryEntry {
    const summary = summarizeSubject(subject, space, state);
    const status = {
      subject: summary,
      generation: state.generation,
      ...(state.materialSetHash === undefined ? {} : { materialSetHash: state.materialSetHash }),
      ...(state.pending === undefined ? {} : { pendingJobId: state.pending.jobId }),
      ...(state.suspendedVersionId === undefined
        ? {}
        : { suspendedVersionId: state.suspendedVersionId }),
      ...(current === undefined ? {} : { maturity: current.version.quality.maturity }),
    };
    return {
      subject: summary,
      status,
      privacy,
      searchTerms: searchTermsFor(subject, state, current, privacy),
      ...(current === undefined ? {} : { currentQuality: current.version.quality }),
      ...(suspended === undefined ? {} : { suspendedQuality: suspended.version.quality }),
      pendingJobs: state.pending === undefined ? 0 : 1,
      suspendedVersions: state.suspendedVersionId === undefined ? 0 : 1,
      newMaterialCount: state.pending?.addedMaterialCount ?? 0,
      lastChangedAt: lastChangedAt(events),
    } satisfies LibraryEntry;
  }
}
