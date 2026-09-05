import {
  DistillyError,
  actorContextSchema,
  engineMethodSchemas,
  mutationContextSchema,
} from "@distilly/protocol";
import { join } from "node:path";
import type {
  ActorContext,
  EngineEvent,
  EventRecord,
  FactChecksum,
  IngestInput,
  IngestItemResult,
  IngestResult,
  IsoDateTime,
  MaterialId,
  MutationContext,
  OperationFact,
  OperationRecord,
  PendingJobMarker,
  SpaceRecord,
  SubjectId,
  SubjectRecord,
  SubjectStateRecord,
  SubjectSummary,
  VersionMaterialEntry,
} from "@distilly/protocol";
import { BUILTIN_PEOPLE_SPACE_ID } from "@distilly/protocol";

import { CryptoIdGenerator } from "../defaults/crypto-id-generator.js";
import { InProcessEventBus } from "../defaults/in-process-event-bus.js";
import type { Clock } from "../defaults/system-clock.js";
import { SystemClock } from "../defaults/system-clock.js";
import type { CommitServiceHooks } from "./legacy-file-commit-service.test.fixture.js";
import { CommitService } from "./legacy-file-commit-service.test.fixture.js";
import { PromptCatalog } from "../distill/prompt-catalog.js";
import { FileCurrentProfileProjection } from "../facts/current-profile-projection.js";
import { computeFactChecksum, sealFact } from "../facts/checksum.js";
import { FileEventStore } from "../facts/event-store.js";
import { FileMaterialStore, type StoredMaterial } from "../facts/material-store.js";
import { FileOperationStore } from "../facts/operation-store.js";
import { FileSpaceStore } from "../facts/space-store.js";
import { FileStateStore } from "../facts/state-store.js";
import { FileSubjectStore } from "../facts/subject-store.js";
import { FileTransactionStore } from "./legacy-file-transaction-store.test.fixture.js";
import { FileVersionManifestStore } from "../facts/version-manifest-store.js";
import { FileVersionStore } from "../facts/version-store.js";
import {
  factNotFound,
  idempotencyConflict,
  invalidInput,
  storageCorrupt,
  subjectAlreadyExists,
} from "../internal-errors.js";
import { Layout } from "../layout.js";
import { MaterialQueryService } from "../material/query-service.js";
import type { EventBus } from "../ports/event-bus.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { ProfileService } from "../profile/service.js";
import type { JsonLibraryProjectionHooks } from "../projection/json-library-projection.js";
import { JsonLibraryProjection } from "../projection/json-library-projection.js";
import { LibraryCoordinatedSubjectLock } from "../projection/library-coordinated-subject-lock.js";
import { LibraryService } from "../projection/library-service.js";
import { ProjectionService } from "../projection/projection-service.js";
import type { SqliteQueueRepositoryHooks } from "./legacy-sqlite-queue-projection.test.fixture.js";
import { SqliteQueueRepository } from "./legacy-sqlite-queue-projection.test.fixture.js";
import { CommittedVersionReader } from "../read/committed-version-reader.js";
import {
  canonicalizeIngestSubjectTarget,
  findCreateConflict,
  type NormalizedCreateSubjectInput,
} from "../subject/identity.js";
import { summarizeSubject } from "../subject/summary.js";
import { FileRequestLock } from "../transaction/request-lock.js";
import { RecoveryService, type RecoveryHooks } from "./legacy-file-recovery.test.fixture.js";
import { FileSubjectLock } from "../transaction/subject-lock.js";
import type { VersionStagingHooks } from "./legacy-file-version-staging.test.fixture.js";
import { FileVersionStaging } from "./legacy-file-version-staging.test.fixture.js";
import { VersionService } from "../version/service.js";
import { normalizeMaterial, prepareMaterial, type PreparedMaterial } from "../ingest/normalize.js";
import { deriveIngestState, type IngestBaseline } from "../ingest/state-transition.js";
import {
  LegacyFileDistillLeaseService,
  type LegacyFileDistillLeaseServiceHooks,
} from "./legacy-file-lease-service.test.fixture.js";

/** Options for the disposable file-backed composition retained only by unmigrated tests. */
export interface LegacyFileEngineTestSupportOptions {
  readonly root: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly eventBus?: EventBus;
  readonly recoveryHooks?: RecoveryHooks;
  readonly queueHooks?: SqliteQueueRepositoryHooks;
  readonly leaseHooks?: LegacyFileDistillLeaseServiceHooks;
  readonly commitHooks?: CommitServiceHooks;
  readonly libraryHooks?: JsonLibraryProjectionHooks;
  readonly versionStagingHooks?: VersionStagingHooks;
  readonly promptCatalog?: PromptCatalog;
}

/** File-backed legacy services still under test while their SQLite migrations are pending. */
export interface LegacyFileEngineTestSupport {
  readonly ingest: LegacyFactSeedService;
  readonly leases: LegacyFileDistillLeaseService;
  readonly commits: CommitService;
  readonly materials: MaterialQueryService;
  readonly profiles: ProfileService;
  readonly versions: VersionService;
  readonly library: LibraryService;
  readonly libraryProjection: ProjectionService;
  readonly recovery: RecoveryService;
  readonly events: EventBus;
}

interface SeedDependencies {
  readonly spaces: FileSpaceStore;
  readonly subjects: FileSubjectStore;
  readonly states: FileStateStore;
  readonly materials: FileMaterialStore;
  readonly versions: FileVersionManifestStore;
  readonly operations: FileOperationStore;
  readonly events: FileEventStore;
  readonly requestLocks: FileRequestLock;
  readonly subjectLocks: FileSubjectLock;
  readonly queue: SqliteQueueRepository;
  readonly libraryProjection: ProjectionService;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly eventBus: EventBus;
}

interface PreparedBatch {
  readonly accepted: readonly PreparedMaterial[];
  readonly items: readonly IngestItemResult[];
  readonly targetManifest: readonly VersionMaterialEntry[];
  readonly storedAtByMaterialId: ReadonlyMap<MaterialId, IsoDateTime>;
}

const BUILTIN_PEOPLE_RECORD = sealFact<SpaceRecord>({
  schemaVersion: 1,
  id: BUILTIN_PEOPLE_SPACE_ID,
  displayName: "People",
  kind: "people",
});

const initialState = (subjectId: SubjectId): SubjectStateRecord =>
  sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId,
    generation: 0,
    materialManifest: [],
  });

const parseBoundary = <T>(parse: () => T, fieldPath: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw invalidInput("The legacy test seed boundary is invalid.", fieldPath);
  }
};

const actorEquals = (left: ActorContext, right: ActorContext): boolean =>
  left.kind === right.kind && left.id === right.id && left.host === right.host;

const sortedEntries = (materials: readonly PreparedMaterial[]): readonly VersionMaterialEntry[] =>
  materials
    .map(({ record }) => ({
      materialId: record.id,
      contentDigest: record.contentDigest,
      provenanceDigest: record.provenanceDigest,
    }))
    .sort((left, right) =>
      left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
    );

const optionalMaterial = async (
  materials: FileMaterialStore,
  subjectId: SubjectId,
  materialId: MaterialId,
): Promise<StoredMaterial | undefined> => {
  try {
    return await materials.read(subjectId, materialId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") return undefined;
    throw error;
  }
};

const replayOperation = (
  operation: OperationFact,
  inputChecksum: FactChecksum,
  actor: ActorContext,
): IngestResult => {
  if (
    operation.method !== "materials.ingest" ||
    operation.inputChecksum !== inputChecksum ||
    (operation.recordKind === "completed" && !actorEquals(operation.actor, actor))
  ) {
    throw idempotencyConflict("RequestId was already used by a different mutation input.");
  }
  if (operation.recordKind === "tombstone") {
    throw factNotFound("The subject previously owned by this request was purged.");
  }
  return operation.result;
};

const makeEventRecord = (
  kind: EngineEvent["kind"],
  subjectId: SubjectId,
  at: IsoDateTime,
  actor: ActorContext,
  requestId: MutationContext["requestId"],
  ids: IdGenerator,
): EventRecord =>
  sealFact<EventRecord>({
    schemaVersion: 1,
    eventId: ids.eventId(),
    event: { kind, subjectId, at },
    actor,
    requestId,
  });

const makeSubjectRecord = (
  input: NormalizedCreateSubjectInput,
  space: SpaceRecord,
  subjectId: SubjectId,
): SubjectRecord =>
  sealFact<SubjectRecord>({
    schemaVersion: 1,
    id: subjectId,
    spaceId: space.id,
    displayName: input.displayName,
    aliases: input.aliases,
    identityHints: input.identityHints,
    ...(input.domainPack === undefined ? {} : { domainPack: input.domainPack }),
    lifecycle: "active",
  });

/**
 * Direct fact seeder for legacy tests. It intentionally has no ingest journal,
 * staging directory, ingest recovery, or production registration.
 */
class LegacyFactSeedService {
  readonly #dependencies: SeedDependencies;

  /**
   * Creates a direct fact seeder for the disposable legacy test composition.
   *
   * @param dependencies - File stores, locks, projections, and deterministic defaults for tests.
   */
  constructor(dependencies: SeedDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Seeds one validated ingest result without a production ingest journal or staging protocol.
   *
   * @param rawInput - Public ingest input used by the unmigrated service test.
   * @param rawActor - Trusted actor attributed to the seeded operation and events.
   * @param rawMutation - Request identity used for test idempotency.
   * @returns The seeded ingest result after legacy projections are updated.
   */
  async ingest(
    rawInput: IngestInput,
    rawActor: ActorContext,
    rawMutation: MutationContext,
  ): Promise<IngestResult> {
    const input = parseBoundary(
      () => engineMethodSchemas["materials.ingest"].params.parse(rawInput),
      "params",
    );
    const actor = parseBoundary(() => actorContextSchema.parse(rawActor) as ActorContext, "actor");
    const mutation = parseBoundary(
      () => mutationContextSchema.parse(rawMutation) as MutationContext,
      "requestId",
    );
    const canonicalTarget = canonicalizeIngestSubjectTarget(input.subject).target;
    const normalizedMaterials = input.materials.map(normalizeMaterial);
    const inputChecksum = computeFactChecksum({
      method: "materials.ingest",
      params: {
        subject: canonicalTarget,
        materials: normalizedMaterials,
        enqueue: input.enqueue,
      },
      actor,
    });

    const requestLease = await this.#dependencies.requestLocks.acquire(mutation.requestId);
    let published: readonly EngineEvent[];
    let result: IngestResult;
    try {
      const replay = await this.#dependencies.operations.readOptional(mutation.requestId);
      if (replay !== undefined) return replayOperation(replay, inputChecksum, actor);

      const candidateSubjectId =
        canonicalTarget.kind === "existing"
          ? canonicalTarget.subjectId
          : this.#dependencies.ids.subjectId();
      const now = this.#dependencies.clock.now();
      const prepared = normalizedMaterials.map((material) =>
        prepareMaterial(material, candidateSubjectId, mutation.requestId, now),
      );
      const resolved =
        canonicalTarget.kind === "existing"
          ? await this.readExisting(canonicalTarget.subjectId)
          : await this.prepareCreate(canonicalTarget.input, candidateSubjectId);
      const subjectLease = await this.#dependencies.subjectLocks.acquire(resolved.subject.id);
      try {
        const repeated = await this.#dependencies.operations.readOptional(mutation.requestId);
        if (repeated !== undefined) return replayOperation(repeated, inputChecksum, actor);

        const batch = await this.classifyBatch(
          resolved.subject.id,
          resolved.previous,
          prepared,
          resolved.created,
        );
        const baseline = await this.readBaseline(resolved.subject.id, resolved.previous);
        const derived = deriveIngestState({
          subjectId: resolved.subject.id,
          previous: resolved.previous,
          targetManifest: batch.targetManifest,
          ...(baseline === undefined ? {} : { baseline }),
          storedAtByMaterialId: batch.storedAtByMaterialId,
          enqueue: input.enqueue,
          now,
          nextJobId: () => this.#dependencies.ids.jobId(),
        });
        if (derived.state.materialSetHash === undefined) {
          throw storageCorrupt("A seeded non-empty state is missing its material-set hash.");
        }
        const summary = summarizeSubject(resolved.subject, resolved.space, derived.state);
        result =
          batch.accepted.length === 0
            ? {
                kind: "unchanged",
                subject: summary,
                items: batch.items,
                materialSetHash: derived.state.materialSetHash,
                generation: derived.state.generation,
                ...(derived.job === undefined ? {} : { job: derived.job }),
              }
            : {
                kind: "ingested",
                subject: summary,
                created: resolved.created,
                items: batch.items,
                materialSetHash: derived.state.materialSetHash,
                generation: derived.state.generation,
                ...(derived.job === undefined ? {} : { job: derived.job }),
              };

        if (resolved.created) {
          await this.#dependencies.spaces.write(resolved.space);
          await this.#dependencies.subjects.write(resolved.subject);
        }
        for (const material of batch.accepted) {
          await this.#dependencies.materials.write(material.record, material.content);
        }
        await this.#dependencies.states.write(derived.state);

        const operation = sealFact<OperationRecord<"materials.ingest">>({
          schemaVersion: 1,
          recordKind: "completed",
          requestId: mutation.requestId,
          method: "materials.ingest",
          scope: { kind: "subject", subjectId: resolved.subject.id },
          actor,
          inputChecksum,
          result,
          completedAt: now,
        });
        const events: EventRecord[] = [];
        if (resolved.created) {
          events.push(
            makeEventRecord(
              "subject.created",
              resolved.subject.id,
              now,
              actor,
              mutation.requestId,
              this.#dependencies.ids,
            ),
          );
        }
        if (batch.accepted.length !== 0) {
          events.push(
            makeEventRecord(
              "material.ingested",
              resolved.subject.id,
              now,
              actor,
              mutation.requestId,
              this.#dependencies.ids,
            ),
          );
        }
        if (derived.pendingChanged) {
          events.push(
            makeEventRecord(
              "job.changed",
              resolved.subject.id,
              now,
              actor,
              mutation.requestId,
              this.#dependencies.ids,
            ),
          );
        }
        await this.#dependencies.operations.write(operation);
        for (const event of events) {
          await this.#dependencies.events.write(resolved.subject.id, event);
        }
        await this.#dependencies.queue.apply({
          subjectId: resolved.subject.id,
          stateChecksum: derived.state.checksum,
          ...(derived.state.pending === undefined ? {} : { pending: derived.state.pending }),
        });
        const library = await this.#dependencies.libraryProjection.apply(resolved.subject.id);
        if (library === "clean") {
          await this.#dependencies.libraryProjection.completeWriter(resolved.subject.id);
        }
        published = events.map((event) => event.event);
      } finally {
        await subjectLease.release();
      }
    } finally {
      await requestLease.release();
    }
    for (const event of published) await this.#dependencies.eventBus.publish(event);
    return result!;
  }

  private async readExisting(subjectId: SubjectId): Promise<{
    readonly subject: SubjectRecord;
    readonly space: SpaceRecord;
    readonly previous: SubjectStateRecord;
    readonly created: false;
  }> {
    const subject = await this.#dependencies.subjects.read(subjectId);
    const [space, previous] = await Promise.all([
      this.#dependencies.spaces.read(subject.spaceId),
      this.#dependencies.states.read(subjectId),
    ]);
    return { subject, space, previous, created: false };
  }

  private async prepareCreate(
    input: NormalizedCreateSubjectInput,
    subjectId: SubjectId,
  ): Promise<{
    readonly subject: SubjectRecord;
    readonly space: SpaceRecord;
    readonly previous: SubjectStateRecord;
    readonly created: true;
  }> {
    const space = await this.resolveCreateSpace(input);
    const candidates: SubjectSummary[] = [];
    for (const candidate of (await this.#dependencies.subjects.listAll()).filter(
      (record) => record.spaceId === space.id,
    )) {
      const state = await this.#dependencies.states.read(candidate.id);
      candidates.push(summarizeSubject(candidate, space, state));
    }
    const conflict = findCreateConflict(input, candidates);
    if (conflict.kind === "already_exists") throw subjectAlreadyExists(conflict.subject);
    if (conflict.kind === "ambiguous") {
      throw invalidInput("Legacy test seed resolved an ambiguous subject.", "subject");
    }
    return {
      subject: makeSubjectRecord(input, space, subjectId),
      space,
      previous: initialState(subjectId),
      created: true,
    };
  }

  private async resolveCreateSpace(input: NormalizedCreateSubjectInput): Promise<SpaceRecord> {
    if (input.space.kind === "existing") return this.#dependencies.spaces.read(input.space.spaceId);
    if (input.space.kind === "builtin_people") return BUILTIN_PEOPLE_RECORD;
    const inlineSpace = input.space;
    const matches = (await this.#dependencies.spaces.list()).filter(
      (space) =>
        space.kind === inlineSpace.spaceKind && space.displayName === inlineSpace.displayName,
    );
    if (matches.length > 1) {
      throw storageCorrupt("Legacy test seed found duplicate inline spaces.");
    }
    return (
      matches[0] ??
      sealFact<SpaceRecord>({
        schemaVersion: 1,
        id: this.#dependencies.ids.spaceId(),
        displayName: inlineSpace.displayName,
        kind: inlineSpace.spaceKind,
      })
    );
  }

  private async classifyBatch(
    subjectId: SubjectId,
    previous: SubjectStateRecord,
    prepared: readonly PreparedMaterial[],
    creating: boolean,
  ): Promise<PreparedBatch> {
    const previousById = new Map(
      previous.materialManifest.map((entry) => [entry.materialId, entry]),
    );
    const storedAtByMaterialId = new Map<MaterialId, IsoDateTime>();
    for (const entry of previous.materialManifest) {
      const existing = await this.#dependencies.materials.read(subjectId, entry.materialId);
      storedAtByMaterialId.set(entry.materialId, existing.record.storedAt);
    }
    const seen = new Map<MaterialId, PreparedMaterial>();
    const accepted: PreparedMaterial[] = [];
    const items: IngestItemResult[] = [];
    for (const material of prepared) {
      let disposition: IngestItemResult["kind"];
      const duplicate = seen.get(material.record.id);
      if (duplicate !== undefined) {
        if (
          duplicate.record.contentDigest !== material.record.contentDigest ||
          duplicate.record.provenanceDigest !== material.record.provenanceDigest ||
          duplicate.content !== material.content
        ) {
          throw storageCorrupt("Legacy test seed found conflicting batch material identity.");
        }
        disposition = "duplicate";
      } else {
        seen.set(material.record.id, material);
        const previousEntry = previousById.get(material.record.id);
        if (previousEntry !== undefined) {
          if (
            previousEntry.contentDigest !== material.record.contentDigest ||
            previousEntry.provenanceDigest !== material.record.provenanceDigest
          ) {
            throw storageCorrupt("Legacy test seed material conflicts with the state manifest.");
          }
          disposition = "duplicate";
        } else {
          if (
            !creating &&
            (await optionalMaterial(
              this.#dependencies.materials,
              subjectId,
              material.record.id,
            )) !== undefined
          ) {
            throw storageCorrupt("Legacy test seed found an orphan material directory.");
          }
          disposition = "accepted";
          accepted.push(material);
          storedAtByMaterialId.set(material.record.id, material.record.storedAt);
        }
      }
      items.push({
        clientRef: material.clientRef,
        kind: disposition,
        materialId: material.record.id,
        contentDigest: material.record.contentDigest,
      });
    }
    const targetManifest = [...previous.materialManifest, ...sortedEntries(accepted)].sort(
      (left, right) =>
        left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
    );
    return { accepted, items, targetManifest, storedAtByMaterialId };
  }

  private async readBaseline(
    subjectId: SubjectId,
    state: SubjectStateRecord,
  ): Promise<IngestBaseline | undefined> {
    if (state.currentVersionId === undefined) return undefined;
    const stored = await this.#dependencies.versions.read(subjectId, state.currentVersionId);
    return { versionId: stored.version.id, manifest: stored.manifest.items };
  }
}

const rebuildQueueSeeds = async function* (
  subjects: FileSubjectStore,
  states: FileStateStore,
): AsyncGenerator<{
  readonly subjectId: SubjectId;
  readonly stateChecksum: FactChecksum;
  readonly pending?: PendingJobMarker;
}> {
  for (const subject of await subjects.listAll()) {
    const state = await states.read(subject.id);
    yield {
      subjectId: subject.id,
      stateChecksum: state.checksum,
      ...(state.pending === undefined ? {} : { pending: state.pending }),
    };
  }
};

/**
 * Opens the explicit test-only file composition for unmigrated service suites.
 *
 * @param options - Disposable root and optional deterministic test dependencies.
 * @returns The legacy services and direct fact seeder used only by test suites.
 */
export const createLegacyFileEngineTestSupport = async (
  options: LegacyFileEngineTestSupportOptions,
): Promise<LegacyFileEngineTestSupport> => {
  const layout = new Layout(options.root);
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new CryptoIdGenerator();
  const eventBus = options.eventBus ?? new InProcessEventBus();
  const spaces = new FileSpaceStore(layout);
  const subjects = new FileSubjectStore(layout, spaces);
  const materials = new FileMaterialStore(layout, subjects);
  const states = new FileStateStore(layout, subjects, materials);
  const versionManifests = new FileVersionManifestStore(layout, materials);
  const versions = new FileVersionStore(layout, materials);
  const versionStaging = new FileVersionStaging(layout, versions, options.versionStagingHooks);
  const currentProfiles = new FileCurrentProfileProjection(layout, versions);
  const operations = new FileOperationStore(layout, subjects);
  const transactions = new FileTransactionStore(layout);
  const events = new FileEventStore(layout, subjects);
  const requestLocks = new FileRequestLock(layout, clock);
  const readSubjectLocks = new FileSubjectLock(layout, clock);
  // This disposable legacy queue projection is test-only; it is not structured authority.
  const queue = new SqliteQueueRepository(
    {
      root: layout.root,
      indexDirectory: layout.indexDirectory(),
      databaseFile: join(layout.indexDirectory(), "queue.db"),
      dirtyFile: join(layout.indexDirectory(), "queue.dirty"),
    },
    options.queueHooks,
  );
  const libraryIndex = new JsonLibraryProjection(layout, clock, options.libraryHooks);
  const subjectLocks = new LibraryCoordinatedSubjectLock(layout, libraryIndex, clock);
  const recoverySubjectLocks = new LibraryCoordinatedSubjectLock(
    layout,
    libraryIndex,
    clock,
    "recovery",
  );
  const libraryProjection: ProjectionService = new ProjectionService({
    spaces,
    subjects,
    states,
    materials,
    versions,
    events,
    projection: libraryIndex,
    reconcile: (): Promise<void> => recovery.reconcilePending().then(() => undefined),
  });
  const recovery = new RecoveryService({
    transactions,
    operations,
    subjects,
    states,
    events,
    versions,
    versionStaging,
    currentProfiles,
    requestLocks,
    subjectLocks: recoverySubjectLocks,
    queue,
    library: libraryProjection,
    eventBus,
    clock,
    ...(options.recoveryHooks === undefined ? {} : { hooks: options.recoveryHooks }),
  });
  const committedVersions = new CommittedVersionReader({
    spaces,
    subjects,
    states,
    materials,
    versions,
    events,
    subjectLocks: readSubjectLocks,
    reconcile: () => recovery.reconcilePending().then(() => undefined),
    writerPending: () => libraryIndex.hasWriterIntent(),
  });
  const promptCatalog = options.promptCatalog ?? new PromptCatalog();
  const leases = new LegacyFileDistillLeaseService({
    spaces,
    subjects,
    states,
    materials,
    versions,
    operations,
    transactions,
    requestLocks,
    subjectLocks,
    queue,
    recovery,
    promptCatalog,
    ids,
    clock,
    eventBus,
    ...(options.leaseHooks === undefined ? {} : { hooks: options.leaseHooks }),
  });
  const commits = new CommitService({
    subjects,
    states,
    materials,
    versions,
    versionStaging,
    operations,
    transactions,
    requestLocks,
    subjectLocks,
    queue,
    recovery,
    promptCatalog,
    ids,
    clock,
    eventBus,
    ...(options.commitHooks === undefined ? {} : { hooks: options.commitHooks }),
  });
  const seed = new LegacyFactSeedService({
    spaces,
    subjects,
    states,
    materials,
    versions: versionManifests,
    operations,
    events,
    requestLocks,
    subjectLocks,
    queue,
    libraryProjection,
    ids,
    clock,
    eventBus,
  });
  const library = new LibraryService({
    projection: libraryIndex,
    reconcile: () => recovery.reconcilePending().then(() => undefined),
  });

  try {
    await queue.verifyAvailable();
  } catch (error) {
    if (!(error instanceof DistillyError) || error.code !== "index_unavailable") throw error;
    await queue.rebuild(() => rebuildQueueSeeds(subjects, states), clock.now());
  }
  await recovery.reconcileAll();
  await queue.verifyAvailable();
  await libraryProjection.rebuild();
  return {
    ingest: seed,
    leases,
    commits,
    materials: new MaterialQueryService({ materials, committedVersions }),
    profiles: new ProfileService({ committedVersions }),
    versions: new VersionService({ committedVersions }),
    library,
    libraryProjection,
    recovery,
    events: eventBus,
  };
};
