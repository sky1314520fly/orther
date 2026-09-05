import type {
  BriefContractDigest,
  ClaimId,
  ContentDigest,
  EventId,
  FacetPath,
  IsoDateTime,
  JobId,
  LeaseId,
  MaterialId,
  MaterialSetHash,
  SubjectId,
  VersionId,
} from "../ids.js";
import type { ActorContext } from "../values.js";
import type { DistillPatch } from "./claims.js";
import type { FactEnvelope, VersionMaterialEntry } from "./facts.js";
import type { Profile, ProfileDiff, QualitySummary } from "./profiles.js";
import type { SubjectRef } from "./subjects.js";

export type ReviewReason =
  | {
      readonly code: "identity_changed";
      readonly claimIds: readonly ClaimId[];
    }
  | {
      readonly code: "coverage_decreased";
      readonly facets: readonly FacetPath[];
    }
  | {
      readonly code: "voice_examples_removed";
      readonly claimIds: readonly ClaimId[];
    }
  | {
      readonly code: "new_contested_claims";
      readonly claimIds: readonly ClaimId[];
    }
  | {
      readonly code: "correction_conflict";
      readonly claimIds: readonly ClaimId[];
    }
  | { readonly code: "source_diversity_decreased" }
  | {
      readonly code: "suspicious_source";
      readonly materialIds: readonly MaterialId[];
    }
  | {
      readonly code: "relayed_correction";
      readonly actorKind: "host" | "sdk" | "executor" | "system";
    }
  | { readonly code: "imported_profile" }
  | { readonly code: "manual_review_requested"; readonly note?: string };

export type VersionStatus = "current" | "suspended" | "historical" | "rejected";

export type CreatedDisposition = "current" | "suspended";

export type VersionCreation =
  | {
      readonly kind: "host_distill";
      readonly briefContractDigest: BriefContractDigest;
      readonly promptVersion: string;
      readonly draftSchemaVersion: number;
    }
  | {
      readonly kind: "correction";
      readonly correctionMaterialId: MaterialId;
    }
  | { readonly kind: "rollback"; readonly targetVersionId: VersionId }
  | { readonly kind: "bundle_import"; readonly bundleDigest: ContentDigest }
  | { readonly kind: "renderer_only"; readonly sourceVersionId: VersionId };

/** Immutable persisted metadata for one material-set profile version. */
export interface VersionRecord extends FactEnvelope<1> {
  readonly id: VersionId;
  readonly subjectId: SubjectId;
  readonly subjectDisplayName: string;
  readonly parentId?: VersionId;
  readonly derivedFromCandidateVersionId?: VersionId;
  readonly generation: number;
  readonly materialSetHash: MaterialSetHash;
  readonly materialCount: number;
  readonly creation: VersionCreation;
  readonly createdDisposition: CreatedDisposition;
  readonly reviewReasons?: readonly [ReviewReason, ...ReviewReason[]];
  readonly actor: ActorContext;
  readonly quality: QualitySummary;
  readonly rendererVersion: string;
  readonly createdAt: IsoDateTime;
}

/** Historical material membership stored beside one immutable version. */
export interface VersionMaterialManifest extends FactEnvelope<1> {
  readonly items: readonly VersionMaterialEntry[];
}

/** Immutable-version summary with its current derived lifecycle status. */
export interface VersionSummary {
  readonly id: VersionId;
  readonly subjectId: SubjectId;
  readonly parentId?: VersionId;
  readonly derivedFromCandidateVersionId?: VersionId;
  readonly generation: number;
  readonly materialSetHash: MaterialSetHash;
  readonly creation: VersionCreation;
  readonly status: VersionStatus;
  readonly actor: ActorContext;
  readonly quality: QualitySummary;
  readonly createdAt: IsoDateTime;
}

/** Stable locator for a suspended candidate review. */
export interface ReviewRef {
  readonly subjectId: SubjectId;
  readonly candidateVersionId: VersionId;
}

/** Browser launch target for a suspended candidate review. */
export interface ReviewLaunch {
  readonly ref: ReviewRef;
  readonly url: string;
}

/** Verified host patch and lease identity submitted for commit. */
export interface CommitInput {
  readonly jobId: JobId;
  readonly generation: number;
  readonly leaseId: LeaseId;
  readonly briefContractDigest: BriefContractDigest;
  readonly materialSetHash: MaterialSetHash;
  readonly baseVersionId?: VersionId;
  readonly patch: DistillPatch;
}

export type CommitResult =
  | {
      readonly kind: "current";
      readonly version: VersionSummary;
      readonly profile: Profile;
    }
  | {
      readonly kind: "suspended";
      readonly candidate: VersionSummary;
      readonly currentVersionId?: VersionId;
      readonly reasons: readonly [ReviewReason, ...ReviewReason[]];
      readonly review: ReviewRef;
    };

/** Selects two immutable versions for a semantic profile diff. */
export interface DiffInput extends SubjectRef {
  readonly before: VersionId;
  readonly after: VersionId;
}

/** Applies a user review decision to the active suspended candidate. */
export interface ReviewActionInput extends SubjectRef {
  readonly candidateVersionId: VersionId;
  readonly reason?: string;
}

/** Creates a new current version from one historical version. */
export interface RollbackInput extends SubjectRef {
  readonly targetVersionId: VersionId;
  readonly reason: string;
}

/** Filters immutable versions for one subject. */
export interface VersionQuery extends SubjectRef {
  readonly cursor?: string;
  readonly limit?: number;
}

/** Cursor page of immutable version summaries. */
export interface VersionPage {
  readonly items: readonly VersionSummary[];
  readonly nextCursor?: string;
}

/** Filters the projected lineage for one subject. */
export interface LineageInput extends SubjectRef {
  readonly cursor?: string;
  readonly limit?: number;
}

/** Projected version-lineage event returned by the read API. */
export interface LineageEvent {
  readonly eventId: EventId;
  readonly kind:
    | "created"
    | "committed"
    | "suspended"
    | "promoted"
    | "rejected"
    | "candidate_replaced"
    | "rolled_back"
    | "corrected"
    | "imported";
  readonly versionId?: VersionId;
  readonly relatedVersionId?: VersionId;
  readonly actor: ActorContext;
  readonly at: IsoDateTime;
  readonly reason?: string;
}

/** Cursor page of projected lineage events. */
export interface LineagePage {
  readonly items: readonly LineageEvent[];
  readonly nextCursor?: string;
}

/** Filters suspended-candidate review projections. */
export interface ReviewQuery {
  readonly subjectId?: SubjectId;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Complete review read model used by the panel and SDK. */
export interface ReviewItem {
  readonly candidate: VersionSummary;
  readonly current?: VersionSummary;
  readonly reasons: readonly [ReviewReason, ...ReviewReason[]];
  readonly diff: ProfileDiff;
}

/** Cursor page of active suspended-candidate reviews. */
export interface ReviewPage {
  readonly items: readonly ReviewItem[];
  readonly nextCursor?: string;
}
