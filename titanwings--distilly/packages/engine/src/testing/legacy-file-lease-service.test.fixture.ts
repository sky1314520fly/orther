/**
 * Test-only snapshot of the retired file-backed lease implementation.
 *
 * It exists only while downstream file-backed commit/review tests await SQLite migration.
 * It is not a production fallback, compatibility path, or package entry point.
 */
import {
  DistillyError,
  clientSessionContextSchema,
  engineMethodSchemas,
  mutationContextSchema,
  transactionRecordSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  BriefInput,
  ClientSessionContext,
  DistillLeaseTransactionMethod,
  DistillLeaseTransactionRecord,
  EngineEvent,
  EventRecord,
  HostDistillBriefing,
  IsoDateTime,
  JobLease,
  MutationContext,
  OperationFact,
  OperationRecord,
  PendingFilter,
  PendingJob,
  PendingJobMarker,
  ReleaseLeaseInput,
  RenewLeaseInput,
  SubjectId,
  SubjectStateRecord,
} from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { computeFactChecksum, sealFact } from "../facts/checksum.js";
import { canonicalJson } from "../facts/canonical-json.js";
import type { FileMaterialStore, StoredMaterial } from "../facts/material-store.js";
import type { FileOperationStore } from "../facts/operation-store.js";
import type { FileSpaceStore } from "../facts/space-store.js";
import type { FileStateStore } from "../facts/state-store.js";
import type { FileSubjectStore } from "../facts/subject-store.js";
import type { FileTransactionStore } from "./legacy-file-transaction-store.test.fixture.js";
import type { FileVersionStore, StoredVersion } from "../facts/version-store.js";
import {
  briefingCapacityUnavailable,
  factNotFound,
  idempotencyConflict,
  invalidInput,
  leaseConflict,
  leaseExpired,
  nothingPending,
  reviewConflict,
  staleJob,
  storageCorrupt,
} from "../internal-errors.js";
import type { EventBus } from "../ports/event-bus.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { QueueRepository } from "./legacy-queue-repository.test.fixture.js";
import type { FileRequestLock } from "../transaction/request-lock.js";
import type { RecoveryService } from "./legacy-file-recovery.test.fixture.js";
import type { FileSubjectLock } from "../transaction/subject-lock.js";
import { buildBriefingCandidate } from "../distill/briefing-builder.js";
import { enforceBriefCapacity } from "../distill/brief-capacity.js";
import type { PromptCatalog } from "../distill/prompt-catalog.js";

const LEASE_DURATION_MILLISECONDS = 30 * 60 * 1_000;

type LeaseMutationInput = BriefInput | RenewLeaseInput | ReleaseLeaseInput;
type LeaseMutationResult = HostDistillBriefing | JobLease | null;
type LeaseEngineMethod<M extends DistillLeaseTransactionMethod> = `distill.${M}`;

interface LockedOutcome {
  readonly result: LeaseMutationResult;
  readonly events: readonly EngineEvent[];
}

/** Fault-injection seams for the package-internal lease transaction matrix. */
export interface LegacyFileDistillLeaseServiceHooks {
  /** Runs after the subject lock and prepared-journal scan, before reading lock-scoped time. */
  readonly beforeLockedMutation?: (subjectId: SubjectId) => void | Promise<void>;
  /** Runs after the complete prepared lease journal is durable. */
  readonly afterPrepared?: (transaction: DistillLeaseTransactionRecord) => void | Promise<void>;
  /** Runs after the target state crosses the lease fact commit point. */
  readonly afterFactCommit?: (transaction: DistillLeaseTransactionRecord) => void | Promise<void>;
}

/** Test-only file facts, projection, locks, recovery, and deterministic seams. */
export interface LegacyFileDistillLeaseServiceDependencies {
  readonly spaces: FileSpaceStore;
  readonly subjects: FileSubjectStore;
  readonly states: FileStateStore;
  readonly materials: FileMaterialStore;
  readonly versions: FileVersionStore;
  readonly operations: FileOperationStore;
  readonly transactions: FileTransactionStore;
  readonly requestLocks: FileRequestLock;
  readonly subjectLocks: FileSubjectLock;
  readonly queue: QueueRepository;
  readonly recovery: RecoveryService;
  readonly promptCatalog: PromptCatalog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly hooks?: LegacyFileDistillLeaseServiceHooks;
}

const parseBoundary = <T>(parse: () => T, fieldPath: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw invalidInput("The distillation lease boundary input is invalid.", fieldPath);
  }
};

const requiredState = async (
  states: FileStateStore,
  subjectId: SubjectId,
): Promise<SubjectStateRecord> => {
  try {
    return await states.read(subjectId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("A queued subject is missing its authoritative state.", error);
    }
    throw error;
  }
};

const stateWithPending = (
  state: SubjectStateRecord,
  pending: PendingJobMarker,
): SubjectStateRecord =>
  sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: state.subjectId,
    generation: state.generation,
    ...(state.materialSetHash === undefined ? {} : { materialSetHash: state.materialSetHash }),
    materialManifest: state.materialManifest,
    ...(state.currentVersionId === undefined ? {} : { currentVersionId: state.currentVersionId }),
    ...(state.suspendedVersionId === undefined
      ? {}
      : { suspendedVersionId: state.suspendedVersionId }),
    pending,
  });

const addLeaseDuration = (now: IsoDateTime): IsoDateTime =>
  new Date(Date.parse(now) + LEASE_DURATION_MILLISECONDS).toISOString() as IsoDateTime;

const actorEquals = (left: ActorContext, right: ActorContext): boolean =>
  canonicalJson(left) === canonicalJson(right);

const makeEventRecord = (
  subjectId: SubjectId,
  at: IsoDateTime,
  actor: ActorContext,
  requestId: MutationContext["requestId"],
  ids: IdGenerator,
): EventRecord =>
  sealFact<EventRecord>({
    schemaVersion: 1,
    eventId: ids.eventId(),
    event: { kind: "job.changed", subjectId, at },
    actor,
    requestId,
  });

const makePreparedTransaction = (input: {
  readonly method: DistillLeaseTransactionMethod;
  readonly requestId: MutationContext["requestId"];
  readonly subjectId: SubjectId;
  readonly previous: SubjectStateRecord;
  readonly target: SubjectStateRecord;
  readonly previousPending: PendingJobMarker;
  readonly targetPending: PendingJobMarker;
  readonly operation: OperationRecord<"distill.brief" | "distill.renew" | "distill.release">;
  readonly event: EventRecord;
  readonly preparedAt: IsoDateTime;
}): DistillLeaseTransactionRecord => {
  const payload = {
    schemaVersion: 1,
    transactionKind: "distill_lease",
    method: input.method,
    requestId: input.requestId,
    subjectId: input.subjectId,
    jobId: input.previousPending.jobId,
    previousStateChecksum: input.previous.checksum,
    targetStateChecksum: input.target.checksum,
    previousPending: input.previousPending,
    targetPending: input.targetPending,
    operation: input.operation,
    event: input.event,
    preparedAt: input.preparedAt,
    state: "prepared",
  } as const;
  return transactionRecordSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  }) as DistillLeaseTransactionRecord;
};

const preparedFromTerminal = (
  transaction: DistillLeaseTransactionRecord,
): DistillLeaseTransactionRecord => {
  const payload = {
    schemaVersion: 1,
    transactionKind: "distill_lease",
    method: transaction.method,
    requestId: transaction.requestId,
    subjectId: transaction.subjectId,
    jobId: transaction.jobId,
    previousStateChecksum: transaction.previousStateChecksum,
    targetStateChecksum: transaction.targetStateChecksum,
    previousPending: transaction.previousPending,
    targetPending: transaction.targetPending,
    operation: transaction.operation,
    event: transaction.event,
    preparedAt: transaction.preparedAt,
    state: "prepared",
  } as const;
  return transactionRecordSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  }) as DistillLeaseTransactionRecord;
};

const replayOperation = (
  operation: OperationFact,
  method: LeaseEngineMethod<DistillLeaseTransactionMethod>,
  inputChecksum: OperationRecord["inputChecksum"],
): LeaseMutationResult => {
  if (operation.method !== method || operation.inputChecksum !== inputChecksum) {
    throw idempotencyConflict("RequestId was already used by a different mutation input.");
  }
  if (operation.recordKind === "tombstone") {
    throw factNotFound("The subject previously owned by this request was purged.");
  }
  if (
    operation.method !== "distill.brief" &&
    operation.method !== "distill.renew" &&
    operation.method !== "distill.release"
  ) {
    throw idempotencyConflict("RequestId was already used by a different mutation method.");
  }
  return operation.result;
};

const readMaterials = async (
  materials: FileMaterialStore,
  state: SubjectStateRecord,
): Promise<readonly StoredMaterial[]> => {
  const stored: StoredMaterial[] = [];
  for (const entry of state.materialManifest) {
    const material = await materials.read(state.subjectId, entry.materialId);
    if (
      material.record.contentDigest !== entry.contentDigest ||
      material.record.provenanceDigest !== entry.provenanceDigest
    ) {
      throw storageCorrupt("A briefing material does not match the authoritative state manifest.");
    }
    stored.push(material);
  }
  return stored;
};

/**
 * Test-only coordinator retained to seed and exercise unmigrated file-backed commit/review suites.
 * Production compositions must never import this fixture.
 */
export class LegacyFileDistillLeaseService {
  readonly #dependencies: LegacyFileDistillLeaseServiceDependencies;

  /**
   * Creates the Step 6 lease coordinator.
   *
   * @param dependencies - Verified stores, locks, queue projection, and deterministic seams.
   */
  constructor(dependencies: LegacyFileDistillLeaseServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Lists projected pending work in the repository's canonical order.
   *
   * @param rawFilter - Untrusted pending-job filter.
   * @returns Public pending jobs with lease expiry derived at the current instant.
   */
  async pending(rawFilter: PendingFilter): Promise<readonly PendingJob[]> {
    const filter = parseBoundary(
      () => engineMethodSchemas["distill.pending"].params.parse(rawFilter),
      "params",
    );
    await this.#dependencies.recovery.reconcilePending();
    const jobs = (await this.#dependencies.queue.list(filter, this.#dependencies.clock.now())).map(
      (record) => record.job,
    );
    return engineMethodSchemas["distill.pending"].result.parse(jobs);
  }

  /**
   * Acquires a complete, capacity-checked host briefing lease.
   *
   * @param rawInput - Untrusted job selector.
   * @param rawSession - Trusted session actor, lease owner, and capacity.
   * @param rawMutation - Globally idempotent mutation context.
   * @returns The exact complete briefing stored by the operation fact.
   */
  async brief(
    rawInput: BriefInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<HostDistillBriefing> {
    const input = parseBoundary(
      () => engineMethodSchemas["distill.brief"].params.parse(rawInput),
      "params",
    );
    return (await this.mutate("brief", input, rawSession, rawMutation)) as HostDistillBriefing;
  }

  /**
   * Extends one active, session-owned lease by the frozen v1 duration.
   *
   * @param rawInput - Untrusted job and lease selector.
   * @param rawSession - Trusted session actor and lease owner.
   * @param rawMutation - Globally idempotent mutation context.
   * @returns The extended lease with its original identity and contract.
   */
  async renew(
    rawInput: RenewLeaseInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<JobLease> {
    const input = parseBoundary(
      () => engineMethodSchemas["distill.renew"].params.parse(rawInput),
      "params",
    );
    return (await this.mutate("renew", input, rawSession, rawMutation)) as JobLease;
  }

  /**
   * Releases one active, session-owned lease back to the same pending job.
   *
   * @param rawInput - Untrusted job and lease selector.
   * @param rawSession - Trusted session actor and lease owner.
   * @param rawMutation - Globally idempotent mutation context.
   * @returns The protocol's JSON-safe empty result.
   */
  async release(
    rawInput: ReleaseLeaseInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<null> {
    const input = parseBoundary(
      () => engineMethodSchemas["distill.release"].params.parse(rawInput),
      "params",
    );
    return (await this.mutate("release", input, rawSession, rawMutation)) as null;
  }

  private async mutate(
    method: DistillLeaseTransactionMethod,
    input: LeaseMutationInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<LeaseMutationResult> {
    const session = parseBoundary(
      () => clientSessionContextSchema.parse(rawSession) as ClientSessionContext,
      "session",
    );
    const mutation = parseBoundary(
      () => mutationContextSchema.parse(rawMutation) as MutationContext,
      "requestId",
    );
    const engineMethod = `distill.${method}` as const;
    const inputChecksum = computeFactChecksum({
      method: engineMethod,
      params: input,
      actor: session.actor,
      leaseOwner: session.leaseOwner,
      ...(method === "brief" && session.capacity !== undefined
        ? { capacity: session.capacity }
        : {}),
    });

    for (;;) {
      await this.#dependencies.recovery.reconcilePending();
      const requestLease = await this.#dependencies.requestLocks.acquire(mutation.requestId);
      let outcome: LockedOutcome | undefined;
      let reconcileRequestId: MutationContext["requestId"] | undefined;
      try {
        const operation = await this.#dependencies.operations.readOptional(mutation.requestId);
        const journal = await this.#dependencies.transactions.readOptional(mutation.requestId);
        if (journal !== undefined) {
          if (
            journal.transactionKind !== "distill_lease" ||
            journal.method !== method ||
            journal.operation.inputChecksum !== inputChecksum ||
            !actorEquals(journal.operation.actor, session.actor)
          ) {
            throw idempotencyConflict("RequestId was already used by a different mutation input.");
          }
          if (journal.state === "prepared") {
            reconcileRequestId = mutation.requestId;
          } else if (journal.state === "committed") {
            if (operation === undefined) {
              throw storageCorrupt("A committed lease journal is missing its operation fact.");
            }
            if (
              operation.recordKind === "completed" &&
              operation.checksum !== journal.operation.checksum
            ) {
              throw storageCorrupt(
                "A committed lease journal disagrees with its completed operation fact.",
              );
            }
          } else if (operation !== undefined) {
            throw storageCorrupt("An aborted lease journal cannot have a completed operation.");
          }
        }
        if (reconcileRequestId === undefined && operation !== undefined) {
          return replayOperation(operation, engineMethod, inputChecksum);
        }

        if (reconcileRequestId === undefined) {
          if (method === "brief" && session.capacity === undefined) {
            throw briefingCapacityUnavailable();
          }
          const projectionNow = this.#dependencies.clock.now();
          const projected =
            journal?.transactionKind === "distill_lease"
              ? undefined
              : await this.#dependencies.queue.read(input.jobId, projectionNow);
          const subjectId =
            journal?.transactionKind === "distill_lease"
              ? journal.subjectId
              : projected?.job.subjectId;
          if (subjectId === undefined) throw nothingPending();

          const subjectLease = await this.#dependencies.subjectLocks.acquire(subjectId);
          try {
            const otherPrepared = (await this.#dependencies.transactions.list()).find(
              (transaction) =>
                transaction.requestId !== mutation.requestId &&
                transaction.state === "prepared" &&
                transaction.subjectId === subjectId,
            );
            if (otherPrepared !== undefined) {
              reconcileRequestId = otherPrepared.requestId;
            } else {
              await this.#dependencies.hooks?.beforeLockedMutation?.(subjectId);
              const now = this.#dependencies.clock.now();
              const state = await requiredState(this.#dependencies.states, subjectId);
              if (journal?.transactionKind === "distill_lease") {
                outcome = await this.resumeAborted(journal, state, now);
              } else {
                outcome = await this.prepareNew(
                  method,
                  input,
                  session,
                  mutation,
                  inputChecksum,
                  subjectId,
                  state,
                  now,
                );
              }
            }
          } finally {
            await subjectLease.release();
          }
        }
      } finally {
        await requestLease.release();
      }

      if (reconcileRequestId !== undefined) {
        await this.#dependencies.recovery.reconcile(reconcileRequestId);
        continue;
      }
      if (outcome === undefined) {
        throw storageCorrupt("A lease mutation ended without a result or recovery target.");
      }
      for (const event of outcome.events) await this.#dependencies.eventBus.publish(event);
      return outcome.result;
    }
  }

  private async prepareNew(
    method: DistillLeaseTransactionMethod,
    input: LeaseMutationInput,
    session: ClientSessionContext,
    mutation: MutationContext,
    inputChecksum: OperationRecord["inputChecksum"],
    subjectId: SubjectId,
    previous: SubjectStateRecord,
    now: IsoDateTime,
  ): Promise<LockedOutcome> {
    if (method === "brief" && previous.suspendedVersionId !== undefined) {
      throw reviewConflict();
    }
    const previousPending = previous.pending;
    if (previousPending === undefined || previousPending.jobId !== input.jobId) throw staleJob();

    const subject = await this.#dependencies.subjects.read(subjectId);
    const space = await this.#dependencies.spaces.read(subject.spaceId);
    const event = makeEventRecord(
      subjectId,
      now,
      session.actor,
      mutation.requestId,
      this.#dependencies.ids,
    );

    let targetPending: PendingJobMarker;
    let result: LeaseMutationResult;
    let operation: OperationRecord<"distill.brief" | "distill.renew" | "distill.release">;
    if (method === "brief") {
      if (previousPending.lease !== undefined && now < previousPending.lease.expiresAt) {
        throw leaseConflict();
      }
      if (session.capacity === undefined) {
        throw storageCorrupt("A validated briefing mutation lost its session capacity.");
      }
      const contract = await this.#dependencies.promptCatalog.load();
      const lease = {
        id: this.#dependencies.ids.leaseId(),
        jobId: previousPending.jobId,
        generation: previousPending.generation,
        briefContractDigest: contract.digest,
        owner: session.leaseOwner,
        acquiredAt: now,
        expiresAt: addLeaseDuration(now),
      } satisfies JobLease;
      targetPending = {
        ...previousPending,
        lease: {
          id: lease.id,
          owner: lease.owner,
          acquiredAt: lease.acquiredAt,
          expiresAt: lease.expiresAt,
          contract: {
            digest: contract.digest,
            sourceGroupingVersion: contract.sourceGroupingVersion,
            promptVersion: contract.promptVersion,
            draftSchemaVersion: contract.draftSchemaVersion,
          },
        },
      };
      const target = stateWithPending(previous, targetPending);
      const materials = await readMaterials(this.#dependencies.materials, previous);
      const baseline: StoredVersion | undefined =
        previousPending.baseVersionId === undefined
          ? undefined
          : await this.#dependencies.versions.read(subjectId, previousPending.baseVersionId);
      const candidate = buildBriefingCandidate({
        subject,
        space,
        state: target,
        materials,
        ...(baseline === undefined ? {} : { baseline }),
        lease,
        contract,
      });
      result = enforceBriefCapacity(candidate, session.capacity);
      operation = sealFact<OperationRecord<"distill.brief">>({
        schemaVersion: 1,
        recordKind: "completed",
        requestId: mutation.requestId,
        method: "distill.brief",
        scope: { kind: "subject", subjectId },
        actor: session.actor,
        inputChecksum,
        result,
        completedAt: now,
      });
    } else {
      const leaseInput = input as RenewLeaseInput | ReleaseLeaseInput;
      const previousLease = previousPending.lease;
      if (previousLease === undefined) throw leaseExpired("The requested lease is not active.");
      if (now >= previousLease.expiresAt) throw leaseExpired();
      if (leaseInput.leaseId !== previousLease.id || session.leaseOwner !== previousLease.owner) {
        throw leaseConflict("The requested lease belongs to a different session.");
      }
      if (method === "renew") {
        const expiresAt = addLeaseDuration(now);
        if (expiresAt <= previousLease.expiresAt) {
          throw leaseConflict("Renewal would not extend the current lease expiry.");
        }
        targetPending = {
          ...previousPending,
          lease: { ...previousLease, expiresAt },
        };
        result = {
          id: previousLease.id,
          jobId: previousPending.jobId,
          generation: previousPending.generation,
          briefContractDigest: previousLease.contract.digest,
          owner: previousLease.owner,
          acquiredAt: previousLease.acquiredAt,
          expiresAt,
        };
        operation = sealFact<OperationRecord<"distill.renew">>({
          schemaVersion: 1,
          recordKind: "completed",
          requestId: mutation.requestId,
          method: "distill.renew",
          scope: { kind: "subject", subjectId },
          actor: session.actor,
          inputChecksum,
          result,
          completedAt: now,
        });
      } else {
        targetPending = {
          jobId: previousPending.jobId,
          generation: previousPending.generation,
          ...(previousPending.baseVersionId === undefined
            ? {}
            : { baseVersionId: previousPending.baseVersionId }),
          materialSetHash: previousPending.materialSetHash,
          addedMaterialCount: previousPending.addedMaterialCount,
          totalMaterialCount: previousPending.totalMaterialCount,
          queuedAt: previousPending.queuedAt,
        };
        result = null;
        operation = sealFact<OperationRecord<"distill.release">>({
          schemaVersion: 1,
          recordKind: "completed",
          requestId: mutation.requestId,
          method: "distill.release",
          scope: { kind: "subject", subjectId },
          actor: session.actor,
          inputChecksum,
          result,
          completedAt: now,
        });
      }
    }

    const target = stateWithPending(previous, targetPending);
    const transaction = makePreparedTransaction({
      method,
      requestId: mutation.requestId,
      subjectId,
      previous,
      target,
      previousPending,
      targetPending,
      operation,
      event,
      preparedAt: now,
    });
    return this.commitLocked(transaction, target, result);
  }

  private async resumeAborted(
    terminal: DistillLeaseTransactionRecord,
    current: SubjectStateRecord,
    now: IsoDateTime,
  ): Promise<LockedOutcome> {
    if (terminal.state !== "aborted") {
      throw storageCorrupt("Only an aborted lease journal can be reprepared.");
    }
    if (
      current.checksum !== terminal.previousStateChecksum &&
      current.checksum !== terminal.targetStateChecksum
    ) {
      throw staleJob("The aborted lease request no longer matches the current subject state.");
    }
    const previousLease = terminal.previousPending.lease;
    const targetLease = terminal.targetPending.lease;
    if (
      (terminal.method === "brief" &&
        (targetLease === undefined || now >= targetLease.expiresAt)) ||
      (terminal.method !== "brief" &&
        (previousLease === undefined || now >= previousLease.expiresAt))
    ) {
      throw leaseExpired("The aborted lease request expired before it could be retried.");
    }
    const target = stateWithPending(current, terminal.targetPending);
    if (target.checksum !== terminal.targetStateChecksum) {
      throw storageCorrupt("An aborted lease journal cannot reproduce its target state.");
    }
    const prepared = preparedFromTerminal(terminal);
    return this.commitLocked(prepared, target, terminal.operation.result);
  }

  private async commitLocked(
    transaction: DistillLeaseTransactionRecord,
    target: SubjectStateRecord,
    result: LeaseMutationResult,
  ): Promise<LockedOutcome> {
    await this.#dependencies.transactions.write(transaction);
    await this.#dependencies.hooks?.afterPrepared?.(transaction);
    const current = await requiredState(this.#dependencies.states, transaction.subjectId);
    if (current.checksum !== target.checksum) {
      if (current.checksum !== transaction.previousStateChecksum) {
        throw storageCorrupt("A prepared lease encountered a third authoritative state.");
      }
      await this.#dependencies.states.write(target);
    }
    await this.#dependencies.hooks?.afterFactCommit?.(transaction);
    const events = await this.#dependencies.recovery.materializeLeaseCommitted(transaction, target);
    return { result, events };
  }
}
