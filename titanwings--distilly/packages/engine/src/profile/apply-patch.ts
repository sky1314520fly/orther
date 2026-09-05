import type { Claim, ClaimId, EvidenceRef, VersionId } from "@distilly/protocol";

import { invalidInput, storageCorrupt } from "../internal-errors.js";
import {
  canonicalizeEvidence,
  canonicalizeResolvedClaimDraft,
  compareUtf8,
  deriveClaimId,
  type ResolvedClaimDraft,
} from "./claim-id.js";

/** Engine-internal claim operation after every evidence draft has been resolved. */
export type ResolvedClaimOperation =
  | { readonly op: "add"; readonly claim: ResolvedClaimDraft }
  | {
      readonly op: "revise";
      readonly claimId: ClaimId;
      readonly replacement: ResolvedClaimDraft;
      readonly reason: string;
    }
  | {
      readonly op: "supersede" | "contest";
      readonly claimId: ClaimId;
      readonly reason: string;
      readonly evidence: readonly EvidenceRef[];
    };

/** Engine-internal patch whose evidence already uses durable MaterialIds. */
export interface ResolvedPatch {
  readonly operations: readonly ResolvedClaimOperation[];
  readonly reviewRequest?: { readonly note?: string };
}

/** Engine-internal correction algebra after its full-body evidence has been resolved. */
export interface ResolvedCorrectionReplacement extends ResolvedClaimDraft {
  readonly evidence: readonly [EvidenceRef];
  readonly observedIn: readonly [];
  readonly supersedes: readonly ClaimId[];
}

/** Existing or newly created claim before the candidate VersionId exists. */
export type ProvisionalClaim =
  | (Claim & { readonly provenance: "base" })
  | (Omit<Claim, "createdIn" | "strength"> & {
      readonly provenance: "candidate";
      readonly status: "active";
      readonly createdIn?: never;
      readonly strength?: never;
    });

/** Provisional claim after engine-owned strength has been derived. */
export type StrengthenedClaim =
  | (Claim & { readonly provenance: "base" })
  | (Omit<Claim, "createdIn"> & {
      readonly provenance: "candidate";
      readonly createdIn?: never;
    });

/** Claim semantics available before or after candidate lineage finalization. */
export type SemanticClaim = Omit<Claim, "createdIn"> & {
  readonly createdIn?: VersionId;
};

const baseClaim = (claim: Claim): Claim & { readonly provenance: "base" } => ({
  ...claim,
  provenance: "base",
});

const newClaim = (
  subjectId: Parameters<typeof deriveClaimId>[0],
  draft: ResolvedClaimDraft,
): Extract<ProvisionalClaim, { readonly provenance: "candidate" }> => {
  const canonical = canonicalizeResolvedClaimDraft(draft);
  return {
    provenance: "candidate",
    id: deriveClaimId(subjectId, canonical),
    facet: canonical.facet,
    text: canonical.text,
    evidence: canonical.evidence,
    status: "active",
    observedIn: canonical.observedIn,
    ...(canonical.validFrom === undefined ? {} : { validFrom: canonical.validFrom }),
    ...(canonical.validTo === undefined ? {} : { validTo: canonical.validTo }),
  };
};

const withoutSupersededBy = <T extends { readonly supersededBy?: ClaimId }>(
  claim: T,
): Omit<T, "supersededBy"> => {
  const { supersededBy: _discard, ...rest } = claim;
  void _discard;
  return rest;
};

const requireUniqueBase = (base: readonly Claim[]): ReadonlyMap<ClaimId, Claim> => {
  const byId = new Map<ClaimId, Claim>();
  for (const claim of base) {
    if (byId.has(claim.id)) throw storageCorrupt("Base claims contain a duplicate ClaimId.");
    byId.set(claim.id, claim);
  }
  return byId;
};

const requireTarget = (
  base: ReadonlyMap<ClaimId, Claim>,
  claimId: ClaimId,
  fieldPath: string,
): Claim => {
  const target = base.get(claimId);
  if (target === undefined)
    throw invalidInput("Claim target is not part of the base version.", fieldPath);
  if (target.status === "superseded") {
    throw invalidInput("A superseded claim cannot be targeted again.", fieldPath);
  }
  return target;
};

/**
 * Applies exact add/revise/supersede/contest algebra without inventing a VersionId sentinel.
 *
 * @param subjectId - Subject whose claim namespace is being changed.
 * @param base - Verified base-version claims.
 * @param patch - Canonical resolved claim operations.
 * @returns Canonically ordered claims with new claims marked only by provenance.
 */
export const applyClaimPatch = (
  subjectId: Parameters<typeof deriveClaimId>[0],
  base: readonly Claim[],
  patch: ResolvedPatch,
): readonly ProvisionalClaim[] => {
  const baseById = requireUniqueBase(base);
  const result = new Map<ClaimId, ProvisionalClaim>(
    base.map((claim) => [claim.id, baseClaim(claim)] as const),
  );
  const targeted = new Set<ClaimId>();

  for (const [index, operation] of patch.operations.entries()) {
    const operationPath = `patch.operations[${String(index)}]`;
    if (operation.op === "add") {
      const created = newClaim(subjectId, operation.claim);
      if (result.has(created.id)) {
        throw invalidInput("Patch creates a duplicate ClaimId.", `${operationPath}.claim`);
      }
      result.set(created.id, created);
      continue;
    }

    if (targeted.has(operation.claimId)) {
      throw invalidInput(
        "A base claim may be targeted only once per patch.",
        `${operationPath}.claimId`,
      );
    }
    targeted.add(operation.claimId);
    const target = requireTarget(baseById, operation.claimId, `${operationPath}.claimId`);

    switch (operation.op) {
      case "revise": {
        const replacement = newClaim(subjectId, operation.replacement);
        if (replacement.id === target.id || result.has(replacement.id)) {
          throw invalidInput(
            "Revision would create a duplicate or cyclic ClaimId.",
            `${operationPath}.replacement`,
          );
        }
        result.set(target.id, {
          ...target,
          provenance: "base",
          status: "superseded",
          supersededBy: replacement.id,
        });
        result.set(replacement.id, replacement);
        break;
      }
      case "supersede":
        result.set(target.id, {
          ...withoutSupersededBy(target),
          provenance: "base",
          status: "superseded",
        });
        break;
      case "contest":
        result.set(target.id, {
          ...withoutSupersededBy(target),
          provenance: "base",
          evidence: canonicalizeEvidence([...target.evidence, ...operation.evidence]),
          status: "contested",
          strength: "contested",
        });
        break;
      default: {
        const exhaustive: never = operation;
        throw new Error(`Unsupported resolved operation: ${String(exhaustive)}`);
      }
    }
  }

  const ordered = [...result.values()].sort((left, right) => compareUtf8(left.id, right.id));
  for (const claim of ordered) {
    if (claim.status === "active" && claim.evidence.length === 0) {
      throw invalidInput("An active claim must retain at least one evidence reference.", "patch");
    }
  }
  return ordered;
};

/**
 * Applies one full-body correction replacement without expanding it into host patch operations.
 *
 * @param subjectId - Subject whose canonical claim namespace owns the replacement.
 * @param base - Verified current or explicitly selected candidate claims.
 * @param replacement - Canonical correction replacement and exact supersession targets.
 * @returns Canonically ordered carried and replacement claims before strength derivation.
 */
export const applyCorrectionReplacement = (
  subjectId: Parameters<typeof deriveClaimId>[0],
  base: readonly Claim[],
  replacement: ResolvedCorrectionReplacement,
): readonly ProvisionalClaim[] => {
  const baseById = requireUniqueBase(base);
  const created = newClaim(subjectId, replacement);
  if (baseById.has(created.id)) {
    throw invalidInput(
      "Correction replacement would create a duplicate or cyclic ClaimId.",
      "correction",
    );
  }
  const targets = new Set<ClaimId>();
  for (const [index, claimId] of replacement.supersedes.entries()) {
    if (targets.has(claimId)) {
      throw invalidInput(
        "A correction cannot supersede the same claim more than once.",
        `correction.supersedes[${String(index)}]`,
      );
    }
    targets.add(claimId);
    requireTarget(baseById, claimId, `correction.supersedes[${String(index)}]`);
  }

  const result = new Map<ClaimId, ProvisionalClaim>();
  for (const claim of base) {
    result.set(
      claim.id,
      targets.has(claim.id)
        ? {
            ...claim,
            provenance: "base",
            status: "superseded",
            supersededBy: created.id,
          }
        : baseClaim(claim),
    );
  }
  result.set(created.id, created);
  return [...result.values()].sort((left, right) => compareUtf8(left.id, right.id));
};

/**
 * Replaces only genuinely new claims' absent lineage with the derived candidate VersionId.
 *
 * @param claims - Strengthened base and candidate claims.
 * @param versionId - Already derived candidate version identity.
 * @returns Final canonical Claim records.
 */
export const finalizeClaims = (
  claims: readonly StrengthenedClaim[],
  versionId: VersionId,
): readonly Claim[] =>
  claims
    .map((claim): Claim => {
      const createdIn = claim.provenance === "base" ? claim.createdIn : versionId;
      return {
        id: claim.id,
        facet: claim.facet,
        text: claim.text,
        evidence: claim.evidence,
        status: claim.status,
        strength: claim.strength,
        observedIn: claim.observedIn,
        ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
        ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
        createdIn,
        ...(claim.supersededBy === undefined ? {} : { supersededBy: claim.supersededBy }),
      };
    })
    .sort((left, right) => compareUtf8(left.id, right.id));
