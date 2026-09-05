import type {
  BriefMaterialRef,
  ClaimId,
  FacetPath,
  IsoDateTime,
  MaterialId,
  VersionId,
} from "../ids.js";

export type CoreFacetName =
  "identity" | "voice" | "psyche" | "relations" | "boundaries" | "texture" | "timeline";

/** Exact evidence quote and optional normalized-content locator. */
export interface EvidenceRef {
  readonly materialId: MaterialId;
  readonly quote: string;
  readonly locator?: {
    readonly start: number;
    readonly end: number;
  };
}

export type ClaimStatus = "active" | "contested" | "superseded";

export type EvidenceStrength =
  "user_asserted" | "single_source" | "corroborated" | "contested" | "imported_unverified";

/** Immutable structured claim stored in a profile version. */
export interface Claim {
  readonly id: ClaimId;
  readonly facet: FacetPath;
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly status: ClaimStatus;
  readonly strength: EvidenceStrength;
  readonly observedIn: readonly string[];
  readonly validFrom?: IsoDateTime;
  readonly validTo?: IsoDateTime;
  readonly createdIn: VersionId;
  readonly supersededBy?: ClaimId;
}

/** Evidence reference to a new material in the active briefing. */
export interface BriefEvidenceDraft {
  readonly kind: "brief_material";
  readonly materialRef: BriefMaterialRef;
  readonly quote: string;
  readonly locator?: { readonly start: number; readonly end: number };
}

/** Stable reference to existing baseline evidence. */
export interface BaselineEvidenceDraft {
  readonly kind: "baseline_evidence";
  readonly claimId: ClaimId;
  readonly evidenceIndex: number;
}

export type EvidenceDraft = BriefEvidenceDraft | BaselineEvidenceDraft;

/** Host-produced claim fields before engine-owned ids and status are derived. */
export interface ClaimDraft {
  readonly facet: FacetPath;
  readonly text: string;
  readonly evidence: readonly EvidenceDraft[];
  readonly observedIn?: readonly string[];
  readonly validFrom?: IsoDateTime;
  readonly validTo?: IsoDateTime;
}

export type ClaimOperation =
  | { readonly op: "add"; readonly claim: ClaimDraft }
  | {
      readonly op: "revise";
      readonly claimId: ClaimId;
      readonly replacement: ClaimDraft;
      readonly reason: string;
    }
  | {
      readonly op: "supersede";
      readonly claimId: ClaimId;
      readonly reason: string;
      readonly evidence: readonly EvidenceDraft[];
    }
  | {
      readonly op: "contest";
      readonly claimId: ClaimId;
      readonly reason: string;
      readonly evidence: readonly EvidenceDraft[];
    };

/** Claim-only host draft accepted by the deterministic commit engine. */
export interface DistillPatch {
  readonly operations: readonly ClaimOperation[];
  readonly reviewRequest?: { readonly note?: string };
  readonly notes?: string;
}
