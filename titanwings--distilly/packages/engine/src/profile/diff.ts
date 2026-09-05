import type { Claim, FacetPath, Profile, ProfileDiff } from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { storageCorrupt } from "../internal-errors.js";
import { compareUtf8 } from "./claim-id.js";

const compareClaim = (left: Claim, right: Claim): number => compareUtf8(left.id, right.id);

const canonicalClaimEqual = (left: Claim, right: Claim): boolean =>
  canonicalJson(left) === canonicalJson(right);

/**
 * Computes the stable semantic diff between two verified profiles.
 *
 * @param before - Optional current profile; absent only for a first suspended candidate.
 * @param after - Candidate or later profile being compared.
 * @returns Canonically ordered claim and quality changes.
 */
export const diffProfiles = (before: Profile | undefined, after: Profile): ProfileDiff => {
  if (before !== undefined && before.subjectId !== after.subjectId) {
    throw storageCorrupt("A profile diff cannot compare different subjects.");
  }

  const beforeById = new Map((before?.claims ?? []).map((claim) => [claim.id, claim] as const));
  const afterById = new Map(after.claims.map((claim) => [claim.id, claim] as const));
  const added = after.claims.filter((claim) => !beforeById.has(claim.id)).sort(compareClaim);
  const removed = (before?.claims ?? [])
    .filter((claim) => !afterById.has(claim.id))
    .sort(compareClaim);
  const changed = after.claims
    .flatMap((claim) => {
      const previous = beforeById.get(claim.id);
      return previous !== undefined && !canonicalClaimEqual(previous, claim)
        ? [{ before: previous, after: claim }]
        : [];
    })
    .sort((left, right) => compareUtf8(left.after.id, right.after.id));

  const facets = new Set<FacetPath>();
  for (const claim of added) facets.add(claim.facet);
  for (const claim of removed) facets.add(claim.facet);
  for (const change of changed) {
    facets.add(change.before.facet);
    facets.add(change.after.facet);
  }

  return {
    added,
    removed,
    changed,
    changedFacets: [...facets].sort(compareUtf8),
    ...(before === undefined ? {} : { beforeQuality: before.quality }),
    afterQuality: after.quality,
  };
};
