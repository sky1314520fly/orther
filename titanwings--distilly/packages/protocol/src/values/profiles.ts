import type { ClaimId, FacetPath, IsoDateTime, SpaceId, SubjectId, VersionId } from "../ids.js";
import type { Claim, CoreFacetName } from "./claims.js";
import type { SubjectLifecycle, SubjectRef, SubjectStatus, SubjectSummary } from "./subjects.js";

export type Maturity = "sparse" | "forming" | "stable";

/** Explainable quality and source-diversity facts for one profile version. */
export interface QualitySummary {
  readonly sourceGroupingVersion: string;
  readonly activeClaimCount: number;
  readonly contestedClaimCount: number;
  readonly userAssertedClaimCount: number;
  readonly corroboratedClaimCount: number;
  readonly sourceGroupCount: number;
  readonly diversityEligibleSourceGroupCount: number;
  readonly unknownSourceGroupCount: number;
  readonly coveredCoreFacets: readonly CoreFacetName[];
  readonly uncoveredCoreFacets: readonly CoreFacetName[];
  readonly maturity: Maturity;
}

/** Complete structured and deterministically rendered profile. */
export interface Profile {
  readonly subjectId: SubjectId;
  readonly displayName: string;
  readonly versionId: VersionId;
  readonly claims: readonly Claim[];
  readonly core: Readonly<Record<CoreFacetName, string>>;
  readonly domains: Readonly<Record<string, string>>;
  readonly rendered: string;
  readonly quality: QualitySummary;
}

/** Stable semantic diff between two immutable profiles. */
export interface ProfileDiff {
  readonly added: readonly Claim[];
  readonly removed: readonly Claim[];
  readonly changed: readonly {
    readonly before: Claim;
    readonly after: Claim;
  }[];
  readonly changedFacets: readonly FacetPath[];
  readonly beforeQuality?: QualitySummary;
  readonly afterQuality: QualitySummary;
}

/** Selects the current or one immutable profile version. */
export interface GetProfileInput extends SubjectRef {
  readonly versionId?: VersionId;
}

/** User correction text and its optional structured supersession target. */
export interface CorrectionDraft {
  readonly text: string;
  readonly facet?: FacetPath;
  readonly supersedes?: readonly ClaimId[];
  readonly baseCandidateVersionId?: VersionId;
}

/** Applies a correction to one subject through the versioning pipeline. */
export interface CorrectInput extends SubjectRef {
  readonly correction: CorrectionDraft;
}

/** Aggregate material sensitivity shown by the local library. */
export type LibraryPrivacy = "none" | "private" | "shareable" | "mixed";

/** Local-library read model for one subject. */
export interface LibraryEntry {
  readonly subject: SubjectSummary;
  readonly status: SubjectStatus;
  readonly privacy: LibraryPrivacy;
  readonly searchTerms: readonly string[];
  readonly currentQuality?: QualitySummary;
  readonly suspendedQuality?: QualitySummary;
  readonly pendingJobs: 0 | 1;
  readonly suspendedVersions: 0 | 1;
  readonly newMaterialCount: number;
  readonly lastChangedAt: IsoDateTime;
}

/** Filters the local library projection. */
export interface LibraryQuery {
  readonly text?: string;
  readonly spaceId?: SpaceId;
  readonly lifecycle?: SubjectLifecycle;
  readonly hasPending?: boolean;
  readonly hasSuspended?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Cursor page of local-library entries. */
export interface LibraryPage {
  readonly items: readonly LibraryEntry[];
  readonly nextCursor?: string;
}

/** Counts and completion time from rebuilding disposable projections. */
export interface RebuildResult {
  readonly subjects: number;
  readonly jobs: number;
  readonly relations: number;
  readonly rebuiltAt: IsoDateTime;
}
