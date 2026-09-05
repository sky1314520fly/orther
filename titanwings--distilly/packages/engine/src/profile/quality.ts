import type {
  CoreFacetName,
  EvidenceRef,
  EvidenceStrength,
  MaterialId,
  MaterialRecord,
  QualitySummary,
  SourceDiversityStatus,
  SourceGroup,
  SourceGroupingSnapshot,
} from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import type { ProvisionalClaim, SemanticClaim, StrengthenedClaim } from "./apply-patch.js";
import { compareUtf8 } from "./claim-id.js";

/** The only canonical order for core profile facets. */
export const CORE_FACET_ORDER = [
  "identity",
  "voice",
  "psyche",
  "relations",
  "boundaries",
  "texture",
  "timeline",
] as const satisfies readonly CoreFacetName[];

const CORE_FACETS = new Set<string>(CORE_FACET_ORDER);

/** Material provenance and grouping facts that may affect evidence quality. */
export interface MaterialEvidenceFacts {
  readonly materialId: MaterialId;
  readonly sourceGroup: SourceGroup;
  readonly sourceRole?: MaterialRecord["source"]["role"];
  readonly derivation: MaterialRecord["derivation"];
  readonly kind: MaterialRecord["kind"];
  readonly flags: MaterialRecord["flags"];
}

/** Version-pinned material lookup consumed by deterministic quality functions. */
export interface MaterialEvidenceIndex {
  readonly sourceGroupingVersion: string;
  readonly byMaterial: ReadonlyMap<MaterialId, MaterialEvidenceFacts>;
}

const requireMaterial = (
  index: MaterialEvidenceIndex,
  materialId: MaterialId,
): MaterialEvidenceFacts => {
  const facts = index.byMaterial.get(materialId);
  if (facts === undefined) {
    throw storageCorrupt("Claim evidence is missing from the material evidence index.");
  }
  return facts;
};

const referencedGroups = (
  evidence: readonly EvidenceRef[],
  index: MaterialEvidenceIndex,
): ReadonlyMap<string, SourceGroup> => {
  const groups = new Map<string, SourceGroup>();
  for (const reference of evidence) {
    const group = requireMaterial(index, reference.materialId).sourceGroup;
    const existing = groups.get(group.key);
    if (
      existing !== undefined &&
      (existing.diversityStatus !== group.diversityStatus ||
        existing.bases.join("\0") !== group.bases.join("\0") ||
        existing.cautions.join("\0") !== group.cautions.join("\0"))
    ) {
      throw storageCorrupt("One source-group key maps to conflicting grouping facts.");
    }
    groups.set(group.key, group);
  }
  return groups;
};

const eligibleGroupCount = (
  evidence: readonly EvidenceRef[],
  index: MaterialEvidenceIndex,
): number =>
  [...referencedGroups(evidence, index).values()].filter(
    (group) => group.diversityStatus === "eligible",
  ).length;

/**
 * Builds the exact grouping-pinned evidence lookup for a complete material set.
 *
 * @param records - Verified complete material records.
 * @param grouping - Source groups derived over those exact records.
 * @returns A version-pinned material evidence index.
 */
export const buildMaterialEvidenceIndex = (
  records: readonly MaterialRecord[],
  grouping: SourceGroupingSnapshot,
): MaterialEvidenceIndex => {
  if (grouping.sourceGroupingVersion.length === 0) {
    throw storageCorrupt("The source grouping snapshot has no algorithm version.");
  }
  const byMaterial = new Map<MaterialId, MaterialEvidenceFacts>();
  for (const record of records) {
    if (byMaterial.has(record.id)) {
      throw storageCorrupt("The material evidence index contains a duplicate MaterialId.");
    }
    const sourceGroup = grouping.groups.get(record.id);
    if (sourceGroup === undefined) {
      throw storageCorrupt("The source grouping snapshot is missing a material.");
    }
    byMaterial.set(record.id, {
      materialId: record.id,
      sourceGroup,
      ...(record.source.role === undefined ? {} : { sourceRole: record.source.role }),
      derivation: record.derivation,
      kind: record.kind,
      flags: record.flags,
    });
  }
  if (grouping.groups.size !== byMaterial.size) {
    throw storageCorrupt("The source grouping snapshot contains an unknown material.");
  }
  return { sourceGroupingVersion: grouping.sourceGroupingVersion, byMaterial };
};

/**
 * Derives an existing claim's engine-owned strength from the pinned source groups.
 *
 * @param claim - Existing claim to classify.
 * @param materials - Candidate generation's material evidence index.
 * @returns Historical provenance strength or a recomputed mechanical strength.
 */
export const deriveEvidenceStrength = (
  claim: SemanticClaim,
  materials: MaterialEvidenceIndex,
): EvidenceStrength => {
  if (claim.status === "superseded") return claim.strength;
  const groups = referencedGroups(claim.evidence, materials);
  if (claim.status === "contested") return "contested";
  if (claim.strength === "user_asserted" || claim.strength === "imported_unverified") {
    return claim.strength;
  }
  return [...groups.values()].filter((group) => group.diversityStatus === "eligible").length >= 2
    ? "corroborated"
    : "single_source";
};

/**
 * Adds engine-owned strength to candidate claims while preserving historical provenance strengths.
 *
 * @param claims - Applied claims with candidate lineage still absent.
 * @param materials - Candidate generation's material evidence index.
 * @returns Canonically ordered claims with exact engine-owned strength.
 */
export const strengthenClaims = (
  claims: readonly ProvisionalClaim[],
  materials: MaterialEvidenceIndex,
): readonly StrengthenedClaim[] =>
  claims
    .map((claim): StrengthenedClaim => {
      if (claim.provenance === "base") {
        return { ...claim, strength: deriveEvidenceStrength(claim, materials) };
      }
      return {
        ...claim,
        strength:
          eligibleGroupCount(claim.evidence, materials) >= 2 ? "corroborated" : "single_source",
      };
    })
    .sort((left, right) => compareUtf8(left.id, right.id));

/**
 * Derives carried strengths normally while forcing the sole correction claim to user_asserted.
 * @param claims - Carried claims plus the correction replacement.
 * @param materials - Pinned material evidence index for carried strengths.
 * @returns Canonically ordered claims with correction-owned strength.
 */
export const strengthenCorrectionClaims = (
  claims: readonly ProvisionalClaim[],
  materials: MaterialEvidenceIndex,
): readonly StrengthenedClaim[] =>
  claims
    .map((claim): StrengthenedClaim =>
      claim.provenance === "base"
        ? { ...claim, strength: deriveEvidenceStrength(claim, materials) }
        : { ...claim, strength: "user_asserted" },
    )
    .sort((left, right) => compareUtf8(left.id, right.id));

const facetRoot = (claim: Pick<SemanticClaim, "facet">): string => claim.facet.split(".", 1)[0]!;

const countReferencedGroups = (
  claims: readonly SemanticClaim[],
  materials: MaterialEvidenceIndex,
): Readonly<Record<SourceDiversityStatus | "all", number>> => {
  const groups = new Map<string, SourceGroup>();
  for (const claim of claims) {
    if (claim.status === "superseded") continue;
    for (const [key, group] of referencedGroups(claim.evidence, materials)) {
      const existing = groups.get(key);
      if (existing !== undefined && existing.diversityStatus !== group.diversityStatus) {
        throw storageCorrupt("One cited source-group key has conflicting diversity status.");
      }
      groups.set(key, group);
    }
  }
  const statuses = [...groups.values()].map((group) => group.diversityStatus);
  return {
    all: groups.size,
    eligible: statuses.filter((status) => status === "eligible").length,
    ineligible: statuses.filter((status) => status === "ineligible").length,
    unknown: statuses.filter((status) => status === "unknown").length,
  };
};

/**
 * Summarizes exact claim coverage and source diversity without a subjective score.
 *
 * @param claims - Final strengthened claims.
 * @param materials - Candidate generation's material evidence index.
 * @returns Exact explainable quality counters and maturity.
 */
export const summarizeQuality = (
  claims: readonly SemanticClaim[],
  materials: MaterialEvidenceIndex,
): QualitySummary => {
  if (materials.sourceGroupingVersion.length === 0) {
    throw storageCorrupt("The material evidence index has no source-grouping version.");
  }
  const active = claims.filter((claim) => claim.status === "active");
  const contested = claims.filter((claim) => claim.status === "contested");
  const coveredSet = new Set(
    active.map(facetRoot).filter((root): root is CoreFacetName => CORE_FACETS.has(root)),
  );
  const coveredCoreFacets = CORE_FACET_ORDER.filter((facet) => coveredSet.has(facet));
  const uncoveredCoreFacets = CORE_FACET_ORDER.filter((facet) => !coveredSet.has(facet));
  const groups = countReferencedGroups(claims, materials);

  const maturity =
    !coveredSet.has("identity") || !coveredSet.has("voice") || coveredSet.size < 3
      ? "sparse"
      : coveredSet.size >= 5 && groups.eligible >= 2 && contested.length === 0
        ? "stable"
        : "forming";

  return {
    sourceGroupingVersion: materials.sourceGroupingVersion,
    activeClaimCount: active.length,
    contestedClaimCount: contested.length,
    userAssertedClaimCount: active.filter((claim) => claim.strength === "user_asserted").length,
    corroboratedClaimCount: active.filter(
      (claim) => eligibleGroupCount(claim.evidence, materials) >= 2,
    ).length,
    sourceGroupCount: groups.all,
    diversityEligibleSourceGroupCount: groups.eligible,
    unknownSourceGroupCount: groups.unknown,
    coveredCoreFacets,
    uncoveredCoreFacets,
    maturity,
  };
};
