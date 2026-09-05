import {
  DistillyError,
  clientSessionContextSchema,
  distillCommitTransactionRecordSchema,
  engineMethodSchemas,
  mutationContextSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  BriefContract,
  ClientSessionContext,
  CommitInput,
  CommitResult,
  DistillCommitTransactionRecord,
  EngineEvent,
  EventRecord,
  IsoDateTime,
  JobId,
  MutationContext,
  OperationFact,
  OperationRecord,
  Profile,
  ReviewReason,
  SubjectId,
  SubjectStateRecord,
  VersionClaimsSnapshot,
  VersionMaterialManifest,
  VersionRecord,
  VersionSummary,
} from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { computeFactChecksum, sealFact } from "../facts/checksum.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { digestDistillPatch } from "../facts/digests.js";
import type { FileMaterialStore, StoredMaterial } from "../facts/material-store.js";
import type { FileOperationStore } from "../facts/operation-store.js";
import type { FileStateStore } from "../facts/state-store.js";
import type { FileSubjectStore } from "../facts/subject-store.js";
import type { FileTransactionStore } from "./legacy-file-transaction-store.test.fixture.js";
import type {
  FileVersionStore,
  StoredVersion,
  VersionArtifactSet,
} from "../facts/version-store.js";
import {
  factNotFound,
  idempotencyConflict,
  invalidInput,
  leaseConflict,
  leaseExpired,
  reviewConflict,
  schemaUnsupported,
  staleJob,
  storageCorrupt,
} from "../internal-errors.js";
import type { EventBus } from "../ports/event-bus.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { QueueRepository } from "./legacy-queue-repository.test.fixture.js";
import type { FileRequestLock } from "../transaction/request-lock.js";
import type { RecoveryService } from "./legacy-file-recovery.test.fixture.js";
import { validateCommitTransactionTarget } from "./legacy-file-recovery.test.fixture.js";
import type { FileSubjectLock } from "../transaction/subject-lock.js";
import type { FileVersionStaging } from "./legacy-file-version-staging.test.fixture.js";
import { applyClaimPatch, finalizeClaims } from "../profile/apply-patch.js";
import {
  buildMaterialEvidenceIndex,
  strengthenClaims,
  summarizeQuality,
} from "../profile/quality.js";
import { renderProfile, renderPrompt, PROFILE_RENDERER_VERSION } from "../profile/render.js";
import { evaluateHostReviewReasons } from "../profile/review-gate.js";
import { deriveVersionId } from "../profile/version-id.js";
import { buildEvidenceContext } from "../distill/evidence-context.js";
import type { PromptCatalog } from "../distill/prompt-catalog.js";
import { resolveHostPatch } from "../distill/resolve-evidence.js";
import { validateAcceptedPatchBytes } from "../distill/validate-patch.js";

interface CommitOutcome {
  readonly result: CommitResult;
  readonly events: readonly EngineEvent[];
}

/** Fault-injection seams for the package-internal version commit matrix. */
export interface CommitServiceHooks {
  /** Runs after the complete commit journal is durable. */
  readonly afterPrepared?: (transaction: DistillCommitTransactionRecord) => void | Promise<void>;
  /** Runs after every version artifact is durable in the fixed staging directory. */
  readonly afterVersionPrepared?: (
    transaction: DistillCommitTransactionRecord,
  ) => void | Promise<void>;
  /** Runs after the immutable version directory is visible. */
  readonly afterVersionPublished?: (
    transaction: DistillCommitTransactionRecord,
  ) => void | Promise<void>;
  /** Runs after state replacement crosses the commit point. */
  readonly afterFactCommit?: (transaction: DistillCommitTransactionRecord) => void | Promise<void>;
}

/** Concrete facts, locks, projections, and deterministic seams used by Step 7 commit. */
export interface CommitServiceDependencies {
  readonly subjects: FileSubjectStore;
  readonly states: FileStateStore;
  readonly materials: FileMaterialStore;
  readonly versions: FileVersionStore;
  readonly versionStaging: FileVersionStaging;
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
  readonly hooks?: CommitServiceHooks;
}

const parseBoundary = <T>(parse: () => T, fieldPath: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw invalidInput("The distillation commit boundary input is invalid.", fieldPath);
  }
};

const actorEquals = (left: ActorContext, right: ActorContext): boolean =>
  canonicalJson(left) === canonicalJson(right);

const requiredState = async (
  states: FileStateStore,
  subjectId: SubjectId,
): Promise<SubjectStateRecord> => {
  try {
    return await states.read(subjectId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("A commit target is missing its authoritative state.", error);
    }
    throw error;
  }
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
      throw storageCorrupt("Commit material does not match authoritative subject state.");
    }
    stored.push(material);
  }
  return stored;
};

const nonEmptyReasons = (
  reasons: readonly ReviewReason[],
): readonly [ReviewReason, ...ReviewReason[]] | undefined => {
  const [first, ...rest] = reasons;
  return first === undefined ? undefined : [first, ...rest];
};

const versionSummary = (
  version: VersionRecord,
  status: "current" | "suspended",
): VersionSummary => ({
  id: version.id,
  subjectId: version.subjectId,
  ...(version.parentId === undefined ? {} : { parentId: version.parentId }),
  ...(version.derivedFromCandidateVersionId === undefined
    ? {}
    : { derivedFromCandidateVersionId: version.derivedFromCandidateVersionId }),
  generation: version.generation,
  materialSetHash: version.materialSetHash,
  creation: version.creation,
  status,
  actor: version.actor,
  quality: version.quality,
  createdAt: version.createdAt,
});

const replayOperation = (
  operation: OperationFact,
  inputChecksum: OperationRecord["inputChecksum"],
): CommitResult => {
  if (operation.method !== "distill.commit" || operation.inputChecksum !== inputChecksum) {
    throw idempotencyConflict("RequestId was already used by a different mutation input.");
  }
  if (operation.recordKind === "tombstone") {
    throw factNotFound("The subject previously owned by this request was purged.");
  }
  return operation.result;
};

const retainedCommitJobSubject = (
  transactions: readonly DistillCommitTransactionRecord[],
  jobId: JobId,
  currentRequestId: MutationContext["requestId"],
): SubjectId | undefined => {
  const matching = transactions.filter((transaction) => transaction.jobId === jobId);
  for (const transaction of matching) {
    if (transaction.requestId !== currentRequestId) {
      validateCommitTransactionTarget(transaction, transaction.targetState);
    }
  }
  const subjectIds = new Set(matching.map((transaction) => transaction.subjectId));
  if (subjectIds.size > 1) {
    throw storageCorrupt("A committed job is associated with multiple subjects.");
  }
  return subjectIds.values().next().value;
};

const makeEventRecord = (
  kind: "version.current" | "version.suspended" | "job.changed",
  subjectId: SubjectId,
  versionId: VersionRecord["id"] | undefined,
  at: IsoDateTime,
  actor: ActorContext,
  requestId: MutationContext["requestId"],
  ids: IdGenerator,
): EventRecord =>
  sealFact<EventRecord>({
    schemaVersion: 1,
    eventId: ids.eventId(),
    event: {
      kind,
      subjectId,
      ...(versionId === undefined ? {} : { versionId }),
      at,
    },
    actor,
    requestId,
  });

const withoutPending = (
  previous: SubjectStateRecord,
  versionId: VersionRecord["id"],
  disposition: "current" | "suspended",
): SubjectStateRecord =>
  sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: previous.subjectId,
    generation: previous.generation,
    ...(previous.materialSetHash === undefined
      ? {}
      : { materialSetHash: previous.materialSetHash }),
    materialManifest: previous.materialManifest,
    ...(disposition === "current"
      ? { currentVersionId: versionId }
      : {
          ...(previous.currentVersionId === undefined
            ? {}
            : { currentVersionId: previous.currentVersionId }),
          suspendedVersionId: versionId,
        }),
  });

const makePreparedTransaction = (input: {
  readonly requestId: MutationContext["requestId"];
  readonly subjectId: SubjectId;
  readonly previous: SubjectStateRecord;
  readonly target: SubjectStateRecord;
  readonly acceptedPatch: CommitInput["patch"];
  readonly patchDigest: DistillCommitTransactionRecord["patchDigest"];
  readonly leaseOwner: ClientSessionContext["leaseOwner"];
  readonly artifacts: VersionArtifactSet;
  readonly operation: OperationRecord<"distill.commit">;
  readonly events: readonly [EventRecord, EventRecord];
  readonly preparedAt: IsoDateTime;
}): DistillCommitTransactionRecord => {
  if (input.previous.pending === undefined || input.previous.pending.lease === undefined) {
    throw storageCorrupt("A prepared commit requires an active previous pending lease.");
  }
  const payload = {
    schemaVersion: 1,
    transactionKind: "distill_commit",
    requestId: input.requestId,
    subjectId: input.subjectId,
    jobId: input.previous.pending.jobId,
    leaseId: input.previous.pending.lease.id,
    leaseOwner: input.leaseOwner,
    previousStateChecksum: input.previous.checksum,
    previousPending: input.previous.pending,
    targetState: input.target,
    acceptedPatch: input.acceptedPatch,
    patchDigest: input.patchDigest,
    version: input.artifacts.version,
    materialManifest: input.artifacts.manifest,
    claims: input.artifacts.claims,
    profile: input.artifacts.profile,
    prompt: input.artifacts.prompt,
    operation: input.operation,
    events: input.events,
    preparedAt: input.preparedAt,
    state: "prepared",
  } as const;
  try {
    return distillCommitTransactionRecordSchema.parse({
      ...payload,
      checksum: computeFactChecksum(payload),
    }) as DistillCommitTransactionRecord;
  } catch (error) {
    throw storageCorrupt("Prepared commit payload violates its persisted contract.", error);
  }
};

const preparedFromTerminal = (
  transaction: DistillCommitTransactionRecord,
): DistillCommitTransactionRecord => {
  const payload = {
    schemaVersion: 1,
    transactionKind: "distill_commit",
    requestId: transaction.requestId,
    subjectId: transaction.subjectId,
    jobId: transaction.jobId,
    leaseId: transaction.leaseId,
    leaseOwner: transaction.leaseOwner,
    previousStateChecksum: transaction.previousStateChecksum,
    previousPending: transaction.previousPending,
    targetState: transaction.targetState,
    acceptedPatch: transaction.acceptedPatch,
    patchDigest: transaction.patchDigest,
    version: transaction.version,
    materialManifest: transaction.materialManifest,
    claims: transaction.claims,
    profile: transaction.profile,
    prompt: transaction.prompt,
    operation: transaction.operation,
    events: transaction.events,
    preparedAt: transaction.preparedAt,
    state: "prepared",
  } as const;
  return distillCommitTransactionRecordSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  }) as DistillCommitTransactionRecord;
};

/** Package-internal coordinator for deterministic, recoverable claim commits. */
export class CommitService {
  readonly #dependencies: CommitServiceDependencies;

  /**
   * Creates the Step 7 commit coordinator.
   *
   * @param dependencies - Verified stores, locks, projections, and deterministic seams.
   */
  constructor(dependencies: CommitServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Commits one claim-only host patch against its active leased generation.
   *
   * @param rawInput - Untrusted commit params returned by the host distiller.
   * @param rawSession - Trusted actor and session-bound lease owner.
   * @param rawMutation - Globally idempotent request context.
   * @returns The exact current or suspended result persisted in the operation fact.
   */
  async commit(
    rawInput: CommitInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<CommitResult> {
    const input = parseBoundary(
      () => engineMethodSchemas["distill.commit"].params.parse(rawInput),
      "params",
    );
    validateAcceptedPatchBytes(input.patch);
    const session = parseBoundary(
      () => clientSessionContextSchema.parse(rawSession) as ClientSessionContext,
      "session",
    );
    const mutation = parseBoundary(
      () => mutationContextSchema.parse(rawMutation) as MutationContext,
      "requestId",
    );
    const inputChecksum = computeFactChecksum({
      method: "distill.commit",
      params: input,
      actor: session.actor,
      leaseOwner: session.leaseOwner,
    });

    for (;;) {
      await this.#dependencies.recovery.reconcilePending();
      const requestLease = await this.#dependencies.requestLocks.acquire(mutation.requestId);
      let outcome: CommitOutcome | undefined;
      let reconcileRequestId: MutationContext["requestId"] | undefined;
      try {
        const operation = await this.#dependencies.operations.readOptional(mutation.requestId);
        const journal = await this.#dependencies.transactions.readOptional(mutation.requestId);
        if (journal !== undefined) {
          if (
            journal.transactionKind !== "distill_commit" ||
            journal.operation.inputChecksum !== inputChecksum ||
            journal.leaseOwner !== session.leaseOwner ||
            !actorEquals(journal.operation.actor, session.actor)
          ) {
            throw idempotencyConflict("RequestId was already used by a different mutation input.");
          }
          if (journal.state === "prepared") {
            reconcileRequestId = mutation.requestId;
          } else if (journal.state === "committed") {
            validateCommitTransactionTarget(journal, journal.targetState);
            if (operation === undefined) {
              throw storageCorrupt("A committed version journal is missing its operation fact.");
            }
            if (
              operation.recordKind === "completed" &&
              operation.checksum !== journal.operation.checksum
            ) {
              throw storageCorrupt(
                "A committed version journal disagrees with its completed operation fact.",
              );
            }
          } else if (operation !== undefined) {
            throw storageCorrupt("An aborted version journal cannot have an operation fact.");
          }
        }
        if (reconcileRequestId === undefined && operation !== undefined) {
          if (
            journal === undefined &&
            operation.recordKind === "completed" &&
            operation.method === "distill.commit"
          ) {
            throw storageCorrupt("A completed version operation is missing its terminal journal.");
          }
          return replayOperation(operation, inputChecksum);
        }

        if (reconcileRequestId === undefined) {
          const projected =
            journal?.transactionKind === "distill_commit"
              ? undefined
              : await this.#dependencies.queue.read(input.jobId, this.#dependencies.clock.now());
          const commitJournals = (await this.#dependencies.transactions.list()).filter(
            (transaction): transaction is DistillCommitTransactionRecord =>
              transaction.transactionKind === "distill_commit",
          );
          const retainedSubjectId = retainedCommitJobSubject(
            commitJournals,
            input.jobId,
            mutation.requestId,
          );
          if (
            projected !== undefined &&
            retainedSubjectId !== undefined &&
            projected.job.subjectId !== retainedSubjectId
          ) {
            throw storageCorrupt("Queue and commit journal disagree about a job subject.");
          }
          const subjectId =
            journal?.transactionKind === "distill_commit"
              ? journal.subjectId
              : (projected?.job.subjectId ?? retainedSubjectId);
          if (subjectId === undefined) throw staleJob();

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
              const now = this.#dependencies.clock.now();
              const state = await requiredState(this.#dependencies.states, subjectId);
              if (journal?.transactionKind === "distill_commit") {
                outcome = await this.resumeAborted(journal, state, now);
              } else {
                outcome = await this.prepareNew(
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
        throw storageCorrupt("A commit mutation ended without a result or recovery target.");
      }
      for (const event of outcome.events) await this.#dependencies.eventBus.publish(event);
      return outcome.result;
    }
  }

  private async prepareNew(
    input: CommitInput,
    session: ClientSessionContext,
    mutation: MutationContext,
    inputChecksum: OperationRecord["inputChecksum"],
    subjectId: SubjectId,
    previous: SubjectStateRecord,
    now: IsoDateTime,
  ): Promise<CommitOutcome> {
    if (previous.suspendedVersionId !== undefined) throw reviewConflict();
    const pending = previous.pending;
    if (
      pending === undefined ||
      pending.jobId !== input.jobId ||
      pending.generation !== input.generation ||
      pending.baseVersionId !== input.baseVersionId ||
      pending.materialSetHash !== input.materialSetHash
    ) {
      throw staleJob();
    }
    const lease = pending.lease;
    if (lease === undefined) {
      throw leaseConflict("The commit job has no active lease.");
    }
    if (lease.contract.digest !== input.briefContractDigest) {
      throw staleJob("The commit brief contract no longer matches the active lease.");
    }
    if (lease.id !== input.leaseId || lease.owner !== session.leaseOwner) {
      throw leaseConflict("The commit lease belongs to a different session or is not active.");
    }
    if (now >= lease.expiresAt) throw leaseExpired();
    await this.assertPinnedContractAvailable(lease.contract);

    const subject = await this.#dependencies.subjects.read(subjectId);
    const materials = await readMaterials(this.#dependencies.materials, previous);
    const baseline: StoredVersion | undefined =
      pending.baseVersionId === undefined
        ? undefined
        : await this.#dependencies.versions.read(subjectId, pending.baseVersionId);
    const context = buildEvidenceContext({
      subjectId,
      state: previous,
      materials,
      ...(baseline === undefined ? {} : { baseline }),
      contract: lease.contract,
    });
    const resolved = resolveHostPatch(input.patch, context);
    const baseClaims = [...context.baseClaims.values()];
    const provisional = applyClaimPatch(subjectId, baseClaims, resolved);
    const evidenceIndex = buildMaterialEvidenceIndex(
      materials.map((material) => material.record),
      context.grouping,
    );
    const strengthened = strengthenClaims(provisional, evidenceIndex);
    const quality = summarizeQuality(strengthened, evidenceIndex);
    const reasons = nonEmptyReasons(
      evaluateHostReviewReasons({
        ...(baseline === undefined
          ? {}
          : {
              before: {
                claims: baseline.claims.claims,
                quality: baseline.version.quality,
              },
            }),
        after: { claims: strengthened, quality },
        materials: evidenceIndex,
        ...(resolved.reviewRequest === undefined ? {} : { reviewRequest: resolved.reviewRequest }),
      }),
    );
    const disposition = reasons === undefined ? "current" : "suspended";
    const creation = {
      kind: "host_distill",
      briefContractDigest: lease.contract.digest,
      promptVersion: lease.contract.promptVersion,
      draftSchemaVersion: lease.contract.draftSchemaVersion,
    } as const;
    const identity = {
      subjectId,
      subjectDisplayName: subject.displayName,
      generation: previous.generation,
      materialSetHash: pending.materialSetHash,
      ...(previous.currentVersionId === undefined ? {} : { parentId: previous.currentVersionId }),
      creation,
      actor: session.actor,
      createdDisposition: disposition,
      rendererVersion: PROFILE_RENDERER_VERSION,
      ...(reasons === undefined ? {} : { reviewReasons: reasons }),
      quality,
    } as const;
    const versionId = deriveVersionId(identity, strengthened);
    const claims = finalizeClaims(strengthened, versionId);
    const rendering = renderProfile({
      subjectId,
      displayName: subject.displayName,
      versionId,
      claims,
      quality,
    });
    const profile: Profile = {
      subjectId,
      displayName: subject.displayName,
      versionId,
      claims,
      core: rendering.core,
      domains: rendering.domains,
      rendered: rendering.markdown,
      quality,
    };
    const prompt = renderPrompt(profile);
    const version = sealFact<VersionRecord>({
      schemaVersion: 1,
      id: versionId,
      subjectId,
      subjectDisplayName: subject.displayName,
      ...(previous.currentVersionId === undefined ? {} : { parentId: previous.currentVersionId }),
      generation: previous.generation,
      materialSetHash: pending.materialSetHash,
      materialCount: previous.materialManifest.length,
      creation,
      createdDisposition: disposition,
      ...(reasons === undefined ? {} : { reviewReasons: reasons }),
      actor: session.actor,
      quality,
      rendererVersion: PROFILE_RENDERER_VERSION,
      createdAt: now,
    });
    const manifest = sealFact<VersionMaterialManifest>({
      schemaVersion: 1,
      items: previous.materialManifest,
    });
    const claimSnapshot = sealFact<VersionClaimsSnapshot>({
      schemaVersion: 1,
      subjectId,
      versionId,
      claims,
    });
    const artifacts: VersionArtifactSet = {
      version,
      manifest,
      claims: claimSnapshot,
      profile,
      prompt,
    };
    const target = withoutPending(previous, versionId, disposition);
    const summary = versionSummary(version, disposition);
    const result: CommitResult =
      reasons === undefined
        ? { kind: "current", version: summary, profile }
        : {
            kind: "suspended",
            candidate: summary,
            ...(previous.currentVersionId === undefined
              ? {}
              : { currentVersionId: previous.currentVersionId }),
            reasons,
            review: { subjectId, candidateVersionId: versionId },
          };
    const operation = sealFact<OperationRecord<"distill.commit">>({
      schemaVersion: 1,
      recordKind: "completed",
      requestId: mutation.requestId,
      method: "distill.commit",
      scope: { kind: "subject", subjectId },
      actor: session.actor,
      inputChecksum,
      result,
      completedAt: now,
    });
    const events = [
      makeEventRecord(
        disposition === "current" ? "version.current" : "version.suspended",
        subjectId,
        versionId,
        now,
        session.actor,
        mutation.requestId,
        this.#dependencies.ids,
      ),
      makeEventRecord(
        "job.changed",
        subjectId,
        undefined,
        now,
        session.actor,
        mutation.requestId,
        this.#dependencies.ids,
      ),
    ] as const;
    const transaction = makePreparedTransaction({
      requestId: mutation.requestId,
      subjectId,
      previous,
      target,
      acceptedPatch: input.patch,
      patchDigest: digestDistillPatch(input.patch),
      leaseOwner: session.leaseOwner,
      artifacts,
      operation,
      events,
      preparedAt: now,
    });
    return this.commitLocked(transaction, target, result);
  }

  private async resumeAborted(
    terminal: DistillCommitTransactionRecord,
    current: SubjectStateRecord,
    now: IsoDateTime,
  ): Promise<CommitOutcome> {
    if (terminal.state !== "aborted") {
      throw storageCorrupt("Only an aborted version journal can be reprepared.");
    }
    if (current.suspendedVersionId !== undefined) {
      throw reviewConflict("An active suspended version must be reviewed before another commit.");
    }
    const pending = current.pending;
    if (
      pending === undefined ||
      pending.jobId !== terminal.previousPending.jobId ||
      pending.generation !== terminal.previousPending.generation ||
      pending.baseVersionId !== terminal.previousPending.baseVersionId ||
      pending.materialSetHash !== terminal.previousPending.materialSetHash
    ) {
      throw staleJob("The aborted commit no longer matches its previous subject state.");
    }
    const lease = pending.lease;
    if (lease === undefined) {
      throw leaseConflict("The aborted commit lease is no longer owned by this session.");
    }
    if (lease.contract.digest !== terminal.previousPending.lease?.contract.digest) {
      throw staleJob("The aborted commit brief contract no longer matches the active lease.");
    }
    if (lease.id !== terminal.leaseId || lease.owner !== terminal.leaseOwner) {
      throw leaseConflict("The aborted commit lease is no longer owned by this session.");
    }
    if (now >= lease.expiresAt) {
      throw leaseExpired("The aborted commit lease expired before it could be retried.");
    }
    await this.assertPinnedContractAvailable(lease.contract);
    if (
      current.checksum !== terminal.previousStateChecksum ||
      canonicalJson(pending) !== canonicalJson(terminal.previousPending)
    ) {
      throw staleJob("The aborted commit previous fact state changed before retry.");
    }
    const prepared = preparedFromTerminal(terminal);
    return this.commitLocked(prepared, prepared.targetState, prepared.operation.result);
  }

  private async assertPinnedContractAvailable(contract: BriefContract): Promise<void> {
    const available = await this.#dependencies.promptCatalog.load();
    if (
      contract.sourceGroupingVersion !== available.sourceGroupingVersion ||
      contract.promptVersion !== available.promptVersion ||
      contract.draftSchemaVersion !== available.draftSchemaVersion ||
      contract.digest !== available.digest
    ) {
      throw schemaUnsupported("The commit lease pins an unavailable distillation algorithm.");
    }
  }

  private async commitLocked(
    transaction: DistillCommitTransactionRecord,
    target: SubjectStateRecord,
    result: CommitResult,
  ): Promise<CommitOutcome> {
    validateCommitTransactionTarget(transaction, target);
    await this.#dependencies.transactions.write(transaction);
    await this.#dependencies.hooks?.afterPrepared?.(transaction);
    const artifacts: VersionArtifactSet = {
      version: transaction.version,
      manifest: transaction.materialManifest,
      claims: transaction.claims,
      profile: transaction.profile,
      prompt: transaction.prompt,
    };
    await this.#dependencies.versionStaging.prepare(transaction.requestId, artifacts);
    await this.#dependencies.hooks?.afterVersionPrepared?.(transaction);
    await this.#dependencies.versionStaging.publish(transaction.requestId, artifacts);
    await this.#dependencies.hooks?.afterVersionPublished?.(transaction);
    const current = await requiredState(this.#dependencies.states, transaction.subjectId);
    if (current.checksum !== target.checksum) {
      if (current.checksum !== transaction.previousStateChecksum) {
        throw storageCorrupt("A prepared commit encountered a third authoritative state.");
      }
      await this.#dependencies.states.write(target);
    }
    await this.#dependencies.hooks?.afterFactCommit?.(transaction);
    const events = await this.#dependencies.recovery.materializeCommitCommitted(
      transaction,
      target,
    );
    return { result, events };
  }
}
