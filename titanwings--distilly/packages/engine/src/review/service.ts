import type { DatabaseSync } from "node:sqlite";

import {
  DistillyError,
  actorContextSchema,
  engineMethodSchemas,
  eventRecordSchema,
  mutationContextSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  EngineEvent,
  EventRecord,
  IsoDateTime,
  MutationContext,
  ReviewActionInput,
  RollbackInput,
  SubjectId,
  VersionId,
  VersionMaterialManifest,
  VersionRecord,
  VersionSummary,
} from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { sealFact, verifyFactChecksum } from "../facts/checksum.js";
import { hashMaterialSet } from "../facts/digests.js";
import { factNotFound, invalidInput, reviewConflict, storageCorrupt } from "../internal-errors.js";
import { renderProfile, renderPrompt } from "../profile/render.js";
import { deriveVersionId } from "../profile/version-id.js";
import type { EventBus } from "../ports/event-bus.js";
import type { IdGenerator } from "../ports/id-generator.js";
import {
  computeMutationInputChecksum,
  insertCompletedOperationInTransaction,
  insertEventInTransaction,
  replayCompletedMutation,
  type SqliteInlineLedgerMethod,
} from "../storage/mutation-ledger.js";
import {
  materialManifestFromSqlite,
  readSqliteMaterialsInTransaction,
} from "../storage/sqlite-material-reader.js";
import type { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import {
  insertSqliteVersionInTransaction,
  readSqliteVersionInTransaction,
  type SqliteStoredVersion,
} from "../version/sqlite-authority.js";
import { summarizeVersion } from "../version/summary.js";
import {
  readSqliteReviewAuthorityInTransaction,
  type SqliteReviewAuthority,
} from "./sqlite-authority.js";

type ReviewMutationMethod = Extract<
  SqliteInlineLedgerMethod,
  "versions.promote" | "versions.reject" | "versions.rollback"
>;

interface ReviewTransactionOutcome {
  readonly result: VersionSummary;
  readonly events: readonly EngineEvent[];
  readonly committed: boolean;
}

/** Fault-injection seams around the single SQLite review transaction. */
export interface ReviewServiceHooks {
  /** Runs after exact replay lookup and before opening the write transaction. */
  readonly beforeReviewTransaction?: (
    requestId: MutationContext["requestId"],
  ) => void | Promise<void>;
  /** Runs synchronously after every SQL write and immediately before SQLite COMMIT. */
  readonly beforeTransactionCommit?: (requestId: MutationContext["requestId"]) => void;
  /** Runs after SQLite COMMIT and before content-free event publication. */
  readonly afterTransactionCommit?: (
    requestId: MutationContext["requestId"],
  ) => void | Promise<void>;
}

/** Concrete dependencies for SQLite-backed review decisions and rollback. */
export interface ReviewServiceDependencies {
  readonly store: SqliteEngineStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly hooks?: ReviewServiceHooks;
}

const parseBoundary = <T>(parse: () => T, fieldPath: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw invalidInput("The review mutation boundary input is invalid.", fieldPath);
  }
};

const sameManifestEntry = (
  left: VersionMaterialManifest["items"][number],
  right: VersionMaterialManifest["items"][number],
): boolean =>
  left.materialId === right.materialId &&
  left.contentDigest === right.contentDigest &&
  left.provenanceDigest === right.provenanceDigest;

const currentMaterialDelta = (
  database: DatabaseSync,
  authority: SqliteReviewAuthority,
  baseline: VersionMaterialManifest,
): { readonly delta: number; readonly total: number } => {
  const materials = readSqliteMaterialsInTransaction(database, authority.subjectId);
  const current = materialManifestFromSqlite(materials);
  if (
    authority.generation === 0 ||
    authority.materialSetHash === undefined ||
    hashMaterialSet(current) !== authority.materialSetHash
  ) {
    throw storageCorrupt("SQLite review material membership disagrees with subject state.");
  }
  const currentById = new Map(current.map((entry) => [entry.materialId, entry] as const));
  for (const entry of baseline.items) {
    const matched = currentById.get(entry.materialId);
    if (matched === undefined || !sameManifestEntry(entry, matched)) {
      throw storageCorrupt("SQLite review baseline is not an exact current-material subset.");
    }
  }
  if (authority.pending !== undefined && authority.pending.totalMaterialCount !== current.length) {
    throw storageCorrupt("SQLite review pending count disagrees with current materials.");
  }
  return { delta: current.length - baseline.items.length, total: current.length };
};

const rebasePendingInTransaction = (
  database: DatabaseSync,
  authority: SqliteReviewAuthority,
  baseline: VersionMaterialManifest,
  baseVersionId: VersionId,
  now: IsoDateTime,
  ids: IdGenerator,
): boolean => {
  const pending = authority.pending;
  const { delta, total } = currentMaterialDelta(database, authority, baseline);
  if (pending !== undefined) {
    const removed = database
      .prepare(
        `DELETE FROM pending_jobs
         WHERE subject_id = ? AND job_id = ? AND generation = ?
           AND base_version_id IS ? AND material_set_hash = ?
           AND added_material_count = ? AND total_material_count = ? AND queued_at = ?`,
      )
      .run(
        authority.subjectId,
        pending.jobId,
        pending.generation,
        pending.baseVersionId ?? null,
        pending.materialSetHash,
        pending.addedMaterialCount,
        pending.totalMaterialCount,
        pending.queuedAt,
      );
    if (removed.changes !== 1) {
      throw reviewConflict("The pending review work changed before it could be rebased.");
    }
  }
  if (delta !== 0) {
    database
      .prepare(
        `INSERT INTO pending_jobs(
           subject_id, job_id, generation, base_version_id, material_set_hash,
           added_material_count, total_material_count, queued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        authority.subjectId,
        ids.jobId(),
        authority.generation,
        baseVersionId,
        authority.materialSetHash!,
        delta,
        total,
        now,
      );
  }
  return pending !== undefined || delta !== 0;
};

const updateSubjectPointersInTransaction = (
  database: DatabaseSync,
  authority: SqliteReviewAuthority,
  currentVersionId: VersionId | undefined,
): void => {
  const updated = database
    .prepare(
      `UPDATE subject_states
       SET current_version_id = ?, suspended_version_id = NULL
       WHERE subject_id = ? AND generation = ? AND material_set_hash IS ?
         AND current_version_id IS ? AND suspended_version_id IS ?`,
    )
    .run(
      currentVersionId ?? null,
      authority.subjectId,
      authority.generation,
      authority.materialSetHash ?? null,
      authority.current?.version.id ?? null,
      authority.suspended?.version.id ?? null,
    );
  if (updated.changes !== 1) {
    throw reviewConflict("The active review pointers changed before the decision committed.");
  }
};

const updateVersionStatus = (
  database: DatabaseSync,
  stored: SqliteStoredVersion,
  expected: SqliteStoredVersion["status"],
  target: SqliteStoredVersion["status"],
): void => {
  const updated = database
    .prepare(
      `UPDATE version_statuses
       SET status = ?
       WHERE version_id = ? AND subject_id = ? AND status = ?`,
    )
    .run(target, stored.version.id, stored.version.subjectId, expected);
  if (updated.changes !== 1) {
    throw reviewConflict("The review version status changed before the decision committed.");
  }
};

const parseEventReplay = (
  raw: Readonly<Record<string, unknown>>,
  requestId: MutationContext["requestId"],
  actor: ActorContext,
): EventRecord => {
  if (typeof raw.event_json !== "string") {
    throw storageCorrupt("SQLite review event JSON is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.event_json);
  } catch (error) {
    throw storageCorrupt("SQLite review event JSON is malformed.", error);
  }
  let record: EventRecord;
  try {
    record = eventRecordSchema.parse(parsed) as EventRecord;
  } catch (error) {
    throw storageCorrupt("SQLite review event record is invalid.", error);
  }
  verifyFactChecksum(record);
  if (
    canonicalJson(record) !== raw.event_json ||
    record.requestId !== requestId ||
    canonicalJson(record.actor) !== canonicalJson(actor) ||
    raw.event_id !== record.eventId ||
    raw.subject_id !== record.event.subjectId ||
    raw.actor_json !== canonicalJson(record.actor) ||
    raw.occurred_at !== record.event.at
  ) {
    throw storageCorrupt("SQLite review event columns disagree with their canonical record.");
  }
  return record;
};

const verifyReplayEvents = (
  database: DatabaseSync,
  method: ReviewMutationMethod,
  input: ReviewActionInput | RollbackInput,
  actor: ActorContext,
  requestId: MutationContext["requestId"],
  result: VersionSummary,
): void => {
  const operation = database
    .prepare("SELECT completed_at FROM operations WHERE request_id = ?")
    .get(requestId) as { readonly completed_at?: unknown } | undefined;
  if (typeof operation?.completed_at !== "string") {
    throw storageCorrupt("SQLite review replay is missing its operation completion time.");
  }
  let rows: readonly Readonly<Record<string, unknown>>[];
  try {
    rows = database
      .prepare(
        `SELECT event_id, subject_id, actor_json, event_json, occurred_at
         FROM events WHERE request_id = ? ORDER BY sequence`,
      )
      .all(requestId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read review replay events.", error);
  }
  const records = rows.map((row) => parseEventReplay(row, requestId, actor));
  const [decision, pendingChanged] = records;
  const expectedKind =
    method === "versions.promote"
      ? "version.promoted"
      : method === "versions.reject"
        ? "version.rejected"
        : "version.rolled_back";
  if (
    decision === undefined ||
    decision.event.kind !== expectedKind ||
    decision.event.subjectId !== result.subjectId ||
    decision.event.versionId !== result.id ||
    decision.event.at !== operation.completed_at ||
    decision.reason !== input.reason ||
    (method === "versions.rollback"
      ? decision.relatedVersionId !== (input as RollbackInput).targetVersionId
      : decision.relatedVersionId !== undefined)
  ) {
    throw storageCorrupt("SQLite review replay has an inconsistent decision event.");
  }
  if (pendingChanged !== undefined) {
    if (
      method === "versions.reject" ||
      pendingChanged.event.kind !== "job.changed" ||
      pendingChanged.event.subjectId !== result.subjectId ||
      pendingChanged.event.at !== operation.completed_at ||
      pendingChanged.reason !== undefined ||
      pendingChanged.relatedVersionId !== undefined
    ) {
      throw storageCorrupt("SQLite review replay has an inconsistent pending-change event.");
    }
  }
  if (records.length < 1 || records.length > 2) {
    throw storageCorrupt("SQLite review replay has an invalid event count.");
  }
};

const verifyReplay = (
  database: DatabaseSync,
  method: ReviewMutationMethod,
  input: ReviewActionInput | RollbackInput,
  actor: ActorContext,
  requestId: MutationContext["requestId"],
  result: VersionSummary,
): VersionSummary => {
  const stored = readSqliteVersionInTransaction(database, result.subjectId, result.id);
  if (stored === undefined) {
    throw storageCorrupt("SQLite review replay is missing its immutable version authority.");
  }
  const expectedStatus = method === "versions.reject" ? "rejected" : "current";
  const expectedSummary = summarizeVersion(stored.version, expectedStatus);
  if (
    canonicalJson(expectedSummary) !== canonicalJson(result) ||
    (method === "versions.rollback"
      ? stored.version.createdDisposition !== "current" ||
        stored.version.creation.kind !== "rollback" ||
        stored.version.creation.targetVersionId !== (input as RollbackInput).targetVersionId ||
        (stored.status !== "current" && stored.status !== "historical")
      : stored.version.createdDisposition !== "suspended" ||
        (method === "versions.reject"
          ? stored.status !== "rejected"
          : stored.status !== "current" && stored.status !== "historical"))
  ) {
    throw storageCorrupt("SQLite review replay disagrees with immutable version authority.");
  }
  verifyReplayEvents(database, method, input, actor, requestId, result);
  return result;
};

const readRollbackSource = (
  database: DatabaseSync,
  subjectId: SubjectId,
  targetVersionId: VersionId,
): SqliteStoredVersion => {
  const source = readSqliteVersionInTransaction(database, subjectId, targetVersionId);
  if (source !== undefined) return source;
  let foreign: { readonly subject_id?: unknown } | undefined;
  try {
    foreign = database.prepare("SELECT subject_id FROM versions WHERE id = ?").get(targetVersionId);
  } catch (error) {
    throw storageCorrupt("SQLite could not resolve the rollback target.", error);
  }
  if (foreign === undefined) throw factNotFound("The rollback target version does not exist.");
  throw invalidInput("Rollback target belongs to a different subject.", "targetVersionId");
};

const makeRollbackVersion = (
  source: SqliteStoredVersion,
  parentId: VersionId,
  actor: ActorContext,
  now: IsoDateTime,
): { readonly version: VersionRecord; readonly claims: SqliteStoredVersion["claims"] } => {
  const creation = { kind: "rollback", targetVersionId: source.version.id } as const;
  const identity = {
    subjectId: source.version.subjectId,
    subjectDisplayName: source.version.subjectDisplayName,
    generation: source.version.generation,
    materialSetHash: source.version.materialSetHash,
    parentId,
    creation,
    actor,
    createdDisposition: "current",
    rendererVersion: source.version.rendererVersion,
    quality: source.version.quality,
  } as const;
  const versionId = deriveVersionId(identity, source.claims.claims);
  const version = sealFact<VersionRecord>({
    schemaVersion: 1,
    id: versionId,
    ...identity,
    materialCount: source.version.materialCount,
    createdAt: now,
  });
  const claims = sealFact<SqliteStoredVersion["claims"]>({
    schemaVersion: 1,
    subjectId: source.version.subjectId,
    versionId,
    claims: source.claims.claims,
  });
  const rendered = renderProfile({
    subjectId: source.version.subjectId,
    displayName: source.version.subjectDisplayName,
    versionId,
    claims: source.claims.claims,
    quality: source.version.quality,
  });
  void renderPrompt({
    subjectId: source.version.subjectId,
    displayName: source.version.subjectDisplayName,
    versionId,
    claims: source.claims.claims,
    core: rendered.core,
    domains: rendered.domains,
    rendered: rendered.markdown,
    quality: source.version.quality,
  });
  return { version, claims };
};

/** SQLite/WAL coordinator for candidate decisions and immutable-copy rollback. */
export class ReviewService {
  readonly #dependencies: ReviewServiceDependencies;

  /**
   * Creates review mutations over one SQLite Engine authority.
   *
   * @param dependencies - Store, deterministic defaults, event bus, and optional crash hooks.
   */
  constructor(dependencies: ReviewServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Promotes the exact active suspended candidate.
   *
   * @param input - Subject, candidate, and optional direct-review reason.
   * @param actor - Trusted actor bound by the caller.
   * @param context - Global mutation RequestId.
   * @returns The stable current-version summary.
   */
  async promote(
    input: ReviewActionInput,
    actor: ActorContext,
    context: MutationContext,
  ): Promise<VersionSummary> {
    return this.decide("versions.promote", input, actor, context);
  }

  /**
   * Rejects the exact active suspended candidate without changing pending work.
   *
   * @param input - Subject, candidate, and optional direct-review reason.
   * @param actor - Trusted actor bound by the caller.
   * @param context - Global mutation RequestId.
   * @returns The stable rejected-version summary.
   */
  async reject(
    input: ReviewActionInput,
    actor: ActorContext,
    context: MutationContext,
  ): Promise<VersionSummary> {
    return this.decide("versions.reject", input, actor, context);
  }

  /**
   * Creates a new immutable current descendant from one verified historical target.
   *
   * @param rawInput - Subject, historical target, and required rollback reason.
   * @param rawActor - Trusted actor bound by the caller.
   * @param rawContext - Global mutation RequestId.
   * @returns The stable rollback-version summary.
   */
  async rollback(
    rawInput: RollbackInput,
    rawActor: ActorContext,
    rawContext: MutationContext,
  ): Promise<VersionSummary> {
    const input = parseBoundary(
      () => engineMethodSchemas["versions.rollback"].params.parse(rawInput),
      "params",
    );
    const actor = parseBoundary(() => actorContextSchema.parse(rawActor) as ActorContext, "actor");
    const context = parseBoundary(
      () => mutationContextSchema.parse(rawContext) as MutationContext,
      "requestId",
    );
    const method = "versions.rollback" as const;
    const inputChecksum = computeMutationInputChecksum(method, input, actor);
    const earlyReplay = this.#dependencies.store.read((database) => {
      const replay = replayCompletedMutation(database, {
        requestId: context.requestId,
        method,
        inputChecksum,
        actor,
      });
      return replay === undefined
        ? undefined
        : verifyReplay(database, method, input, actor, context.requestId, replay);
    });
    if (earlyReplay !== undefined) return earlyReplay;

    await this.#dependencies.hooks?.beforeReviewTransaction?.(context.requestId);
    const outcome = this.#dependencies.store.write((database): ReviewTransactionOutcome => {
      const replay = replayCompletedMutation(database, {
        requestId: context.requestId,
        method,
        inputChecksum,
        actor,
      });
      if (replay !== undefined) {
        return {
          result: verifyReplay(database, method, input, actor, context.requestId, replay),
          events: [],
          committed: false,
        };
      }
      const authority = readSqliteReviewAuthorityInTransaction(database, input.subjectId);
      if (authority.suspended !== undefined) throw reviewConflict();
      const current = authority.current;
      if (current === undefined) {
        throw invalidInput("Rollback requires an existing current version.", "targetVersionId");
      }
      const source = readRollbackSource(database, input.subjectId, input.targetVersionId);
      if (source.status !== "historical") {
        throw invalidInput("Rollback target must be a historical version.", "targetVersionId");
      }
      const now = this.#dependencies.clock.now();
      const created = makeRollbackVersion(source, current.version.id, actor, now);
      updateVersionStatus(database, current, "current", "historical");
      insertSqliteVersionInTransaction(database, {
        version: created.version,
        manifest: source.manifest,
        claims: created.claims,
        status: "current",
        acceptedPatchDigest: source.acceptedPatchDigest,
      });
      updateSubjectPointersInTransaction(database, authority, created.version.id);
      const pendingChanged = rebasePendingInTransaction(
        database,
        authority,
        source.manifest,
        created.version.id,
        now,
        this.#dependencies.ids,
      );
      const result = summarizeVersion(created.version, "current");
      insertCompletedOperationInTransaction(database, {
        requestId: context.requestId,
        method,
        subjectId: input.subjectId,
        actor,
        inputChecksum,
        result,
        completedAt: now,
      });
      const events: EngineEvent[] = [
        {
          kind: "version.rolled_back",
          subjectId: input.subjectId,
          versionId: created.version.id,
          at: now,
        },
      ];
      if (pendingChanged) {
        events.push({ kind: "job.changed", subjectId: input.subjectId, at: now });
      }
      for (const event of events) {
        insertEventInTransaction(database, {
          eventId: this.#dependencies.ids.eventId(),
          event,
          actor,
          requestId: context.requestId,
          ...(event.kind === "version.rolled_back"
            ? { reason: input.reason, relatedVersionId: input.targetVersionId }
            : {}),
        });
      }
      this.#dependencies.hooks?.beforeTransactionCommit?.(context.requestId);
      return { result, events, committed: true };
    });
    await this.publishCommitted(outcome, context.requestId);
    return outcome.result;
  }

  private async decide(
    method: "versions.promote" | "versions.reject",
    rawInput: ReviewActionInput,
    rawActor: ActorContext,
    rawContext: MutationContext,
  ): Promise<VersionSummary> {
    const input = parseBoundary(() => engineMethodSchemas[method].params.parse(rawInput), "params");
    const actor = parseBoundary(() => actorContextSchema.parse(rawActor) as ActorContext, "actor");
    const context = parseBoundary(
      () => mutationContextSchema.parse(rawContext) as MutationContext,
      "requestId",
    );
    const inputChecksum = computeMutationInputChecksum(method, input, actor);
    const earlyReplay = this.#dependencies.store.read((database) => {
      const replay = replayCompletedMutation(database, {
        requestId: context.requestId,
        method,
        inputChecksum,
        actor,
      });
      return replay === undefined
        ? undefined
        : verifyReplay(database, method, input, actor, context.requestId, replay);
    });
    if (earlyReplay !== undefined) return earlyReplay;

    await this.#dependencies.hooks?.beforeReviewTransaction?.(context.requestId);
    const outcome = this.#dependencies.store.write((database): ReviewTransactionOutcome => {
      const replay = replayCompletedMutation(database, {
        requestId: context.requestId,
        method,
        inputChecksum,
        actor,
      });
      if (replay !== undefined) {
        return {
          result: verifyReplay(database, method, input, actor, context.requestId, replay),
          events: [],
          committed: false,
        };
      }
      const authority = readSqliteReviewAuthorityInTransaction(database, input.subjectId);
      const candidate = authority.suspended;
      if (candidate === undefined || candidate.version.id !== input.candidateVersionId) {
        throw reviewConflict("The requested candidate is no longer the active suspended version.");
      }
      const now = this.#dependencies.clock.now();
      if (method === "versions.promote") {
        if (authority.current !== undefined) {
          updateVersionStatus(database, authority.current, "current", "historical");
        }
        updateVersionStatus(database, candidate, "suspended", "current");
      } else {
        updateVersionStatus(database, candidate, "suspended", "rejected");
      }
      updateSubjectPointersInTransaction(
        database,
        authority,
        method === "versions.promote" ? candidate.version.id : authority.current?.version.id,
      );
      const pendingChanged =
        method === "versions.promote"
          ? rebasePendingInTransaction(
              database,
              authority,
              candidate.manifest,
              candidate.version.id,
              now,
              this.#dependencies.ids,
            )
          : false;
      const result = summarizeVersion(
        candidate.version,
        method === "versions.promote" ? "current" : "rejected",
      );
      insertCompletedOperationInTransaction(database, {
        requestId: context.requestId,
        method,
        subjectId: input.subjectId,
        actor,
        inputChecksum,
        result,
        completedAt: now,
      });
      const decisionEvent: EngineEvent = {
        kind: method === "versions.promote" ? "version.promoted" : "version.rejected",
        subjectId: input.subjectId,
        versionId: candidate.version.id,
        at: now,
      };
      const events: EngineEvent[] = [decisionEvent];
      if (pendingChanged) {
        events.push({ kind: "job.changed", subjectId: input.subjectId, at: now });
      }
      for (const event of events) {
        insertEventInTransaction(database, {
          eventId: this.#dependencies.ids.eventId(),
          event,
          actor,
          requestId: context.requestId,
          ...(event === decisionEvent && input.reason !== undefined
            ? { reason: input.reason }
            : {}),
        });
      }
      this.#dependencies.hooks?.beforeTransactionCommit?.(context.requestId);
      return { result, events, committed: true };
    });
    await this.publishCommitted(outcome, context.requestId);
    return outcome.result;
  }

  private async publishCommitted(
    outcome: ReviewTransactionOutcome,
    requestId: MutationContext["requestId"],
  ): Promise<void> {
    if (!outcome.committed) return;
    await this.#dependencies.hooks?.afterTransactionCommit?.(requestId);
    for (const event of outcome.events) await this.#dependencies.eventBus.publish(event);
  }
}
