import type { JobId, MaterialSetHash, SpaceId, SubjectId, VersionId } from "../ids.js";
import type { Maturity } from "./profiles.js";

export type SubjectLifecycle = "active" | "archived";

export type IdentityHint =
  | { readonly kind: "url"; readonly value: string }
  | {
      readonly kind: "account";
      readonly provider: string;
      readonly handle: string;
    }
  | {
      readonly kind: "external_id";
      readonly provider: string;
      readonly value: string;
    }
  | { readonly kind: "description"; readonly value: string };

/** Stable summary of a subject namespace. */
export interface SpaceSummary {
  readonly id: SpaceId;
  readonly displayName: string;
  readonly kind: "people" | "fictional" | "custom";
}

/** Shared subject identity returned by SDK and review surfaces. */
export interface SubjectSummary {
  readonly id: SubjectId;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly identityHints: readonly IdentityHint[];
  readonly space: SpaceSummary;
  readonly lifecycle: SubjectLifecycle;
  readonly currentVersionId?: VersionId;
}

export type AmbiguousSubjectCandidates = readonly [
  SubjectSummary,
  SubjectSummary,
  ...SubjectSummary[],
];

/** Current distillation and review status for one subject. */
export interface SubjectStatus {
  readonly subject: SubjectSummary;
  readonly generation: number;
  readonly materialSetHash?: MaterialSetHash;
  readonly pendingJobId?: JobId;
  readonly suspendedVersionId?: VersionId;
  readonly maturity?: Maturity;
}

/** Canonical subject-id parameter shared by engine methods. */
export interface SubjectRef {
  readonly subjectId: SubjectId;
}

export type SubjectSelector =
  | { readonly kind: "id"; readonly subjectId: SubjectId }
  | {
      readonly kind: "query";
      readonly query: string;
      readonly spaceId?: SpaceId;
    };

/** Filters the subject library without changing subject state. */
export interface SubjectQuery {
  readonly text?: string;
  readonly spaceId?: SpaceId;
  readonly lifecycle?: SubjectLifecycle;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Cursor page of subject summaries. */
export interface SubjectPage {
  readonly items: readonly SubjectSummary[];
  readonly nextCursor?: string;
}

/** Input to exact-or-ambiguous subject resolution. */
export interface ResolveSubjectInput {
  readonly selector: SubjectSelector;
}

export type ResolveSubjectResult =
  | { readonly kind: "found"; readonly subject: SubjectSummary }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous"; readonly candidates: AmbiguousSubjectCandidates };

/** Explicitly confirmed destructive subject purge. */
export interface PurgeSubjectInput extends SubjectRef {
  readonly confirmation: string;
}

/** Stable logical and physical deletion result for an idempotent purge. */
export type PurgeResult =
  | {
      readonly subjectId: SubjectId;
      readonly logicalDeletion: "complete";
      readonly physicalDeletion: "complete";
    }
  | {
      readonly subjectId: SubjectId;
      readonly logicalDeletion: "complete";
      readonly physicalDeletion: "pending";
      readonly pendingBlobCount: number;
    };

/** User-supplied fields for creating an engine-owned subject identity. */
export interface CreateSubjectInput {
  readonly displayName: string;
  readonly spaceId?: SpaceId;
  readonly space?: {
    readonly displayName: string;
    readonly kind: "people" | "fictional" | "custom";
  };
  readonly aliases?: readonly string[];
  readonly domainPack?: string;
  readonly identityHints?: readonly IdentityHint[];
}
