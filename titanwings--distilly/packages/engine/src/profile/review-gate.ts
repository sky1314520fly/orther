import type {
  ClaimId,
  FacetPath,
  MaterialId,
  QualitySummary,
  ReviewReason,
} from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import type { SemanticClaim } from "./apply-patch.js";
import { compareUtf8 } from "./claim-id.js";
import type { MaterialEvidenceIndex } from "./quality.js";

/** Immutable profile facts compared by the host-distill quality gate. */
interface ReviewProfileFacts {
  readonly claims: readonly SemanticClaim[];
  readonly quality: QualitySummary;
}

/** Complete pure input for host-distill review reason derivation. */
export interface HostReviewGateInput {
  readonly before?: ReviewProfileFacts;
  readonly after: ReviewProfileFacts;
  readonly materials: MaterialEvidenceIndex;
  readonly reviewRequest?: { readonly note?: string };
}

/** Complete pure input for correction-specific canonical review reason derivation. */
export interface CorrectionReviewGateInput {
  readonly before?: ReviewProfileFacts;
  readonly after: ReviewProfileFacts;
  readonly materials: MaterialEvidenceIndex;
  readonly supersedes: readonly ClaimId[];
  readonly relayedActorKind?: "host" | "sdk" | "executor" | "system";
}

const activeIds = (claims: readonly SemanticClaim[], root: string): ReadonlySet<ClaimId> =>
  new Set(
    claims
      .filter((claim) => claim.status === "active" && claim.facet.split(".", 1)[0] === root)
      .map((claim) => claim.id),
  );

const contestedIds = (claims: readonly SemanticClaim[]): ReadonlySet<ClaimId> =>
  new Set(claims.filter((claim) => claim.status === "contested").map((claim) => claim.id));

const relevantMaterialIds = (claims: readonly SemanticClaim[]): ReadonlySet<MaterialId> =>
  new Set(
    claims
      .filter((claim) => claim.status === "active" || claim.status === "contested")
      .flatMap((claim) => claim.evidence.map((evidence) => evidence.materialId)),
  );

const difference = <T extends string>(left: ReadonlySet<T>, right: ReadonlySet<T>): readonly T[] =>
  [...left].filter((value) => !right.has(value)).sort(compareUtf8);

const requireMatchingGroupingVersion = (
  profile: ReviewProfileFacts,
  materials: MaterialEvidenceIndex,
): void => {
  if (profile.quality.sourceGroupingVersion !== materials.sourceGroupingVersion) {
    throw storageCorrupt("Review quality does not match the pinned material evidence index.");
  }
};

const deltaReasons = (
  before: ReviewProfileFacts | undefined,
  after: ReviewProfileFacts,
): readonly ReviewReason[] => {
  if (before === undefined) return [];
  const reasons: ReviewReason[] = [];
  const identityChanged = difference(
    activeIds(before.claims, "identity"),
    activeIds(after.claims, "identity"),
  );
  if (identityChanged.length > 0)
    reasons.push({ code: "identity_changed", claimIds: identityChanged });

  const coverageDecreased = difference(
    new Set<FacetPath>(before.quality.coveredCoreFacets as readonly FacetPath[]),
    new Set<FacetPath>(after.quality.coveredCoreFacets as readonly FacetPath[]),
  );
  if (coverageDecreased.length > 0)
    reasons.push({ code: "coverage_decreased", facets: coverageDecreased });

  const voiceRemoved = difference(
    activeIds(before.claims, "voice"),
    activeIds(after.claims, "voice"),
  );
  if (voiceRemoved.length > 0)
    reasons.push({ code: "voice_examples_removed", claimIds: voiceRemoved });

  const newlyContested = difference(contestedIds(after.claims), contestedIds(before.claims));
  if (newlyContested.length > 0)
    reasons.push({ code: "new_contested_claims", claimIds: newlyContested });
  return reasons;
};

const diversityDecreased = (
  before: ReviewProfileFacts | undefined,
  after: ReviewProfileFacts,
): boolean =>
  before !== undefined &&
  after.quality.diversityEligibleSourceGroupCount <
    before.quality.diversityEligibleSourceGroupCount;

const suspiciousReason = (
  before: ReviewProfileFacts | undefined,
  after: ReviewProfileFacts,
  materials: MaterialEvidenceIndex,
): ReviewReason | undefined => {
  const beforeMaterials =
    before === undefined ? new Set<MaterialId>() : relevantMaterialIds(before.claims);
  const suspicious = difference(relevantMaterialIds(after.claims), beforeMaterials).filter(
    (materialId) => {
      const facts = materials.byMaterial.get(materialId);
      if (facts === undefined) {
        throw storageCorrupt("Review candidate cites a material missing from its evidence index.");
      }
      return facts.flags.includes("suspicious_source");
    },
  );
  return suspicious.length === 0
    ? undefined
    : { code: "suspicious_source", materialIds: suspicious };
};

/**
 * Derives the exact ordered Step 7 host review reasons without semantic inference.
 *
 * @param input - Before/after profiles, pinned evidence, and optional manual request.
 * @returns Canonically ordered mechanical host review reasons.
 */
export const evaluateHostReviewReasons = (input: HostReviewGateInput): readonly ReviewReason[] => {
  requireMatchingGroupingVersion(input.after, input.materials);
  if (input.before !== undefined) requireMatchingGroupingVersion(input.before, input.materials);

  const reasons = [...deltaReasons(input.before, input.after)];
  if (diversityDecreased(input.before, input.after))
    reasons.push({ code: "source_diversity_decreased" });
  const suspicious = suspiciousReason(input.before, input.after, input.materials);
  if (suspicious !== undefined) reasons.push(suspicious);

  if (input.reviewRequest !== undefined) {
    reasons.push({
      code: "manual_review_requested",
      ...(input.reviewRequest.note === undefined ? {} : { note: input.reviewRequest.note }),
    });
  }
  return reasons;
};

/**
 * Derives exact correction reasons in the global ReviewReason union order.
 * @param input - Current baseline, corrected candidate, evidence, targets, and actor provenance.
 * @returns Canonically ordered mechanical correction review reasons.
 */
export const evaluateCorrectionReviewReasons = (
  input: CorrectionReviewGateInput,
): readonly ReviewReason[] => {
  requireMatchingGroupingVersion(input.after, input.materials);
  if (input.before !== undefined) requireMatchingGroupingVersion(input.before, input.materials);
  const reasons = [...deltaReasons(input.before, input.after)];
  if (input.supersedes.length > 0) {
    reasons.push({ code: "correction_conflict", claimIds: input.supersedes });
  }
  if (diversityDecreased(input.before, input.after))
    reasons.push({ code: "source_diversity_decreased" });
  const suspicious = suspiciousReason(input.before, input.after, input.materials);
  if (suspicious !== undefined) reasons.push(suspicious);
  if (input.relayedActorKind !== undefined) {
    reasons.push({ code: "relayed_correction", actorKind: input.relayedActorKind });
  }
  return reasons;
};
