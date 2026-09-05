import type { EngineEvent } from "../events.js";
import type {
  ContentDigest,
  EventId,
  FactChecksum,
  IsoDateTime,
  JobId,
  LeaseId,
  LeaseOwnerId,
  MaterialId,
  MaterialSetHash,
  ProvenanceDigest,
  RequestId,
  SpaceId,
  SubjectId,
  VersionId,
} from "../ids.js";
import type { EngineMethodMap, MutationMethodName } from "../methods.js";
import type { ActorContext } from "../values.js";
import type { Claim, DistillPatch } from "./claims.js";
import type { BriefContract } from "./jobs.js";
import type { Profile } from "./profiles.js";
import type { IdentityHint, SubjectLifecycle } from "./subjects.js";
import type { VersionMaterialManifest, VersionRecord } from "./versions.js";

/** Integrity envelope shared by every persisted JSON fact. */
export interface FactEnvelope<V extends number = number> {
  readonly schemaVersion: V;
  readonly checksum: FactChecksum;
}

/** Persisted namespace for one class of subjects. */
export interface SpaceRecord extends FactEnvelope<1> {
  readonly id: SpaceId;
  readonly displayName: string;
  readonly kind: "people" | "fictional" | "custom";
}

/** Persisted subject identity independent of derived profile state. */
export interface SubjectRecord extends FactEnvelope<1> {
  readonly id: SubjectId;
  readonly spaceId: SpaceId;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly identityHints: readonly IdentityHint[];
  readonly domainPack?: string;
  readonly lifecycle: SubjectLifecycle;
}

/** Digest-only membership entry shared by current and historical manifests. */
export interface VersionMaterialEntry {
  readonly materialId: MaterialId;
  readonly contentDigest: ContentDigest;
  readonly provenanceDigest: ProvenanceDigest;
}

/** Immutable claims owned by one persisted profile version. */
export interface VersionClaimsSnapshot extends FactEnvelope<1> {
  readonly subjectId: SubjectId;
  readonly versionId: VersionId;
  readonly claims: readonly Claim[];
}

/** Persisted time-bounded authority attached to pending work. */
export interface PendingLeaseMarker {
  readonly id: LeaseId;
  readonly owner: LeaseOwnerId;
  readonly acquiredAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly contract: BriefContract;
}

/** Stable pending-work fields that can rebuild the disposable queue. */
export interface PendingJobMarker {
  readonly jobId: JobId;
  readonly generation: number;
  readonly baseVersionId?: VersionId;
  readonly materialSetHash: MaterialSetHash;
  readonly addedMaterialCount: number;
  readonly totalMaterialCount: number;
  readonly queuedAt: IsoDateTime;
  readonly lease?: PendingLeaseMarker;
}

/** Authoritative current state for one subject. */
export interface SubjectStateRecord extends FactEnvelope<2> {
  readonly subjectId: SubjectId;
  readonly generation: number;
  readonly materialSetHash?: MaterialSetHash;
  readonly materialManifest: readonly VersionMaterialEntry[];
  readonly currentVersionId?: VersionId;
  readonly suspendedVersionId?: VersionId;
  readonly pending?: PendingJobMarker;
}

/** Durable wrapper around one post-commit invalidation event. */
export interface EventRecord extends FactEnvelope<1> {
  readonly eventId: EventId;
  readonly event: EngineEvent;
  readonly actor: ActorContext;
  readonly requestId?: RequestId;
  readonly reason?: string;
  readonly relatedVersionId?: VersionId;
}

/** Result stored for one successful mutation method. */
export type StoredOperationResult<M extends MutationMethodName> = EngineMethodMap[M]["result"];

/** Durable ownership scope for one globally keyed mutation result. */
export type OperationScope =
  { readonly kind: "global" } | { readonly kind: "subject"; readonly subjectId: SubjectId };

/** Durable idempotency result correlated by its mutation method discriminant. */
export type OperationRecord<M extends MutationMethodName = MutationMethodName> = {
  [K in M]: FactEnvelope<1> & {
    readonly recordKind: "completed";
    readonly requestId: RequestId;
    readonly method: K;
    readonly scope: OperationScope;
    readonly actor: ActorContext;
    readonly inputChecksum: FactChecksum;
    readonly result: StoredOperationResult<K>;
    readonly completedAt: IsoDateTime;
  };
}[M];

/** Content-free marker retained when privacy purge removes a completed result. */
export interface OperationTombstoneRecord extends FactEnvelope<1> {
  readonly recordKind: "tombstone";
  readonly requestId: RequestId;
  readonly method: MutationMethodName;
  readonly scope: OperationScope;
  readonly inputChecksum: FactChecksum;
  readonly removedAt: IsoDateTime;
  readonly reason: "subject_purged";
}

/** Completed result or its durable privacy-purge marker. */
export type OperationFact = OperationRecord | OperationTombstoneRecord;

type TransactionLifecycle =
  | { readonly state: "prepared" }
  | {
      readonly state: "committed" | "aborted";
      readonly finishedAt: IsoDateTime;
    };

/** Short lease mutation name persisted by a distillation journal. */
export type DistillLeaseTransactionMethod = "brief" | "renew" | "release";

type DistillLeaseEngineMethod<M extends DistillLeaseTransactionMethod> = `distill.${M}`;

interface DistillLeaseTransactionBase<
  M extends DistillLeaseTransactionMethod,
> extends FactEnvelope<1> {
  readonly transactionKind: "distill_lease";
  readonly method: M;
  readonly requestId: RequestId;
  readonly subjectId: SubjectId;
  readonly jobId: JobId;
  readonly previousStateChecksum: FactChecksum;
  readonly targetStateChecksum: FactChecksum;
  readonly previousPending: PendingJobMarker;
  readonly targetPending: PendingJobMarker;
  readonly operation: OperationRecord<DistillLeaseEngineMethod<M>>;
  readonly event: EventRecord;
  readonly preparedAt: IsoDateTime;
}

/** Crash-recoverable journal for one lease acquire, renewal, or release. */
export type DistillLeaseTransactionRecord = {
  [M in DistillLeaseTransactionMethod]: DistillLeaseTransactionBase<M> & {
    readonly method: M;
  } & TransactionLifecycle;
}[DistillLeaseTransactionMethod];

/** Complete prepared payload shared by every distillation commit lifecycle branch. */
export interface DistillCommitTransactionBase extends FactEnvelope<1> {
  readonly transactionKind: "distill_commit";
  readonly requestId: RequestId;
  readonly subjectId: SubjectId;
  readonly jobId: JobId;
  readonly leaseId: LeaseId;
  readonly leaseOwner: LeaseOwnerId;
  readonly previousStateChecksum: FactChecksum;
  readonly previousPending: PendingJobMarker;
  readonly targetState: SubjectStateRecord;
  readonly acceptedPatch: DistillPatch;
  readonly patchDigest: ContentDigest;
  readonly version: VersionRecord;
  readonly materialManifest: VersionMaterialManifest;
  readonly claims: VersionClaimsSnapshot;
  readonly profile: Profile;
  readonly prompt: string;
  readonly operation: OperationRecord<"distill.commit">;
  readonly events: readonly [EventRecord, EventRecord];
  readonly preparedAt: IsoDateTime;
}

/** Crash-recoverable journal for one deterministic distillation commit. */
export type DistillCommitTransactionRecord = DistillCommitTransactionBase & TransactionLifecycle;

/** Short review-decision mutation name persisted by a review journal. */
export type ReviewDecisionTransactionMethod = "promote" | "reject";

type ReviewDecisionEngineMethod<M extends ReviewDecisionTransactionMethod> = `versions.${M}`;

/** Crash-recoverable journal for accepting or rejecting one suspended candidate. */
export type ReviewDecisionTransactionRecord = {
  [M in ReviewDecisionTransactionMethod]: FactEnvelope<1> & {
    readonly transactionKind: "review_decision";
    readonly method: M;
    readonly requestId: RequestId;
    readonly subjectId: SubjectId;
    readonly candidateVersionId: VersionId;
    readonly previousStateChecksum: FactChecksum;
    readonly previousCurrentVersionId?: VersionId;
    readonly previousSuspendedVersionId: VersionId;
    readonly previousPending?: PendingJobMarker;
    readonly targetState: SubjectStateRecord;
    readonly operation: OperationRecord<ReviewDecisionEngineMethod<M>>;
    readonly events: readonly [EventRecord] | readonly [EventRecord, EventRecord];
    readonly preparedAt: IsoDateTime;
  } & TransactionLifecycle;
}[ReviewDecisionTransactionMethod];

/** Complete prepared payload for a rollback-created immutable version. */
export interface RollbackTransactionBase extends FactEnvelope<1> {
  readonly transactionKind: "rollback";
  readonly requestId: RequestId;
  readonly subjectId: SubjectId;
  readonly targetVersionId: VersionId;
  readonly previousStateChecksum: FactChecksum;
  readonly previousCurrentVersionId: VersionId;
  readonly previousPending?: PendingJobMarker;
  readonly targetState: SubjectStateRecord;
  readonly version: VersionRecord;
  readonly materialManifest: VersionMaterialManifest;
  readonly claims: VersionClaimsSnapshot;
  readonly profile: Profile;
  readonly prompt: string;
  readonly operation: OperationRecord<"versions.rollback">;
  readonly events: readonly [EventRecord] | readonly [EventRecord, EventRecord];
  readonly preparedAt: IsoDateTime;
}

/** Crash-recoverable journal for one historical-version rollback. */
export type RollbackTransactionRecord = RollbackTransactionBase & TransactionLifecycle;

/** Root transaction fact union for every atomic fact-layer mutation. */
export type TransactionRecord =
  | DistillLeaseTransactionRecord
  | DistillCommitTransactionRecord
  | ReviewDecisionTransactionRecord
  | RollbackTransactionRecord;
