import type { DistillyErrorCode } from "../errors.js";
import type {
  BriefContractDigest,
  BriefMaterialRef,
  ContentDigest,
  IsoDateTime,
  JobId,
  LeaseId,
  LeaseOwnerId,
  MaterialId,
  MaterialSetHash,
  SubjectId,
  VersionId,
} from "../ids.js";
import type { Claim } from "./claims.js";
import type { MaterialRecord, MaterialSource, SourceGroup, TextDerivation } from "./materials.js";
import type { QualitySummary } from "./profiles.js";
import type { SubjectSummary } from "./subjects.js";

export type PublicJobState = "pending" | "leased" | "failed";

interface PendingJobBase {
  readonly id: JobId;
  readonly subjectId: SubjectId;
  readonly generation: number;
  readonly baseVersionId?: VersionId;
  readonly materialSetHash: MaterialSetHash;
  readonly addedMaterialCount: number;
  readonly totalMaterialCount: number;
  readonly queuedAt: IsoDateTime;
}

/** Public failure details projected for a failed pending job. */
export interface PendingJobFailure {
  readonly code: DistillyErrorCode;
  readonly retryable: boolean;
  readonly remediation?: string;
}

/** Public queue state for one immutable subject generation. */
export type PendingJob = PendingJobBase &
  (
    | {
        readonly state: "pending";
        readonly leaseExpiresAt?: never;
        readonly failure?: never;
      }
    | {
        readonly state: "leased";
        readonly leaseExpiresAt: IsoDateTime;
        readonly failure?: never;
      }
    | {
        readonly state: "failed";
        readonly leaseExpiresAt?: never;
        readonly failure: PendingJobFailure;
      }
  );

/** Filters public pending-job reads. */
export interface PendingFilter {
  readonly subjectId?: SubjectId;
  readonly state?: PublicJobState;
  readonly limit?: number;
}

/** Version-pinned rules that make a host distillation reproducible. */
export interface BriefContract {
  readonly digest: BriefContractDigest;
  readonly sourceGroupingVersion: "source-groups-v1";
  readonly promptVersion: `host-distill-v1-sha256_${string}`;
  readonly draftSchemaVersion: 1;
}

/** Exclusive, time-bounded authority to complete one job generation. */
export interface JobLease {
  readonly id: LeaseId;
  readonly jobId: JobId;
  readonly generation: number;
  readonly briefContractDigest: BriefContractDigest;
  readonly owner: LeaseOwnerId;
  readonly acquiredAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}

/** Material content and provenance supplied to the host distiller. */
export interface BriefMaterial {
  readonly ref: BriefMaterialRef;
  readonly materialId: MaterialId;
  readonly contentDigest: ContentDigest;
  readonly kind: MaterialRecord["kind"];
  readonly content: string;
  readonly source: MaterialSource;
  readonly derivation: TextDerivation;
  readonly sourceGroup: SourceGroup;
  readonly sensitivity: MaterialRecord["sensitivity"];
}

/** Existing evidence metadata needed to classify a new material set. */
export interface BriefEvidenceFact {
  readonly materialId: MaterialId;
  readonly source: MaterialSource;
  readonly derivation: TextDerivation;
  readonly sourceGroup: SourceGroup;
  readonly sensitivity: MaterialRecord["sensitivity"];
  readonly flags: MaterialRecord["flags"];
}

/** Host-facing distillation instructions pinned by the brief contract. */
export interface HostDistillContract extends BriefContract {
  readonly instructions: string;
  readonly evidenceRules: readonly string[];
}

/** Complete, untruncated unit of host distillation work. */
export interface HostDistillBriefing {
  readonly job: PendingJob;
  readonly lease: JobLease;
  readonly subject: SubjectSummary;
  readonly baseline?: {
    readonly versionId: VersionId;
    readonly claims: readonly Claim[];
    readonly quality: QualitySummary;
    readonly evidenceFacts: readonly BriefEvidenceFact[];
  };
  readonly materials: readonly BriefMaterial[];
  readonly contract: HostDistillContract;
  readonly limits: {
    readonly estimatedInputTokens: number;
    readonly maximumInputTokens: number;
    readonly maximumOutputBytes: number;
  };
}

/** Selects and atomically leases a pending job for briefing. */
export interface BriefInput {
  readonly jobId: JobId;
}

/** Identifies a lease to extend without changing its pinned contract. */
export interface RenewLeaseInput {
  readonly jobId: JobId;
  readonly leaseId: LeaseId;
}

/** Returns leased work to pending without completing the job. */
export interface ReleaseLeaseInput extends RenewLeaseInput {
  readonly reason?: string;
}

/** Requests an explicit incremental or full distillation run. */
export interface RedistillInput {
  readonly subjectId: SubjectId;
  readonly mode: "incremental" | "full";
  readonly reason: string;
}
