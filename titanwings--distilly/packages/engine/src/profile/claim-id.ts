import type { ClaimId, EvidenceRef, FacetPath, IsoDateTime, SubjectId } from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { sha256Hex } from "../facts/checksum.js";
import { invalidInput } from "../internal-errors.js";

/** Claim fields after evidence handles have been resolved to durable material ids. */
export interface ResolvedClaimDraft {
  readonly facet: FacetPath;
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly observedIn: readonly string[];
  readonly validFrom?: IsoDateTime;
  readonly validTo?: IsoDateTime;
}

/**
 * Compares strings by their canonical UTF-8 bytes.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive according to byte order.
 */
export const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const locatorKey = (evidence: EvidenceRef): string =>
  evidence.locator === undefined ? "" : `${evidence.locator.start}:${evidence.locator.end}`;

const compareEvidence = (left: EvidenceRef, right: EvidenceRef): number =>
  compareUtf8(left.materialId, right.materialId) ||
  compareUtf8(locatorKey(left), locatorKey(right)) ||
  compareUtf8(left.quote, right.quote);

/**
 * Exact-deduplicates and canonicalizes evidence according to claim-v1.
 *
 * @param evidence - Resolved evidence in any order.
 * @returns Exact-unique evidence in canonical tuple order.
 */
export const canonicalizeEvidence = (evidence: readonly EvidenceRef[]): readonly EvidenceRef[] => {
  const exact = new Map<string, EvidenceRef>();
  for (const item of evidence) {
    const copy: EvidenceRef = {
      materialId: item.materialId,
      quote: item.quote,
      ...(item.locator === undefined
        ? {}
        : { locator: { start: item.locator.start, end: item.locator.end } }),
    };
    exact.set(canonicalJson(copy), copy);
  }
  return [...exact.values()].sort(compareEvidence);
};

/**
 * Exact-deduplicates and UTF-8 sorts observed contexts.
 *
 * @param values - Observed context labels in any order.
 * @returns Exact-unique labels in canonical UTF-8 order.
 */
const canonicalizeObservedIn = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort(compareUtf8);

/**
 * Normalizes every hash-significant resolved draft field.
 *
 * @param draft - Resolved draft to canonicalize.
 * @param fieldPath - Caller-visible path used for invalid date ranges.
 * @returns The exact claim-v1 canonical resolved draft.
 */
export const canonicalizeResolvedClaimDraft = (
  draft: Omit<ResolvedClaimDraft, "observedIn"> & { readonly observedIn?: readonly string[] },
  fieldPath = "claim",
): ResolvedClaimDraft => {
  if (
    draft.validFrom !== undefined &&
    draft.validTo !== undefined &&
    draft.validFrom > draft.validTo
  ) {
    throw invalidInput("validFrom must not be later than validTo.", `${fieldPath}.validTo`);
  }
  return {
    facet: draft.facet,
    text: draft.text,
    evidence: canonicalizeEvidence(draft.evidence),
    observedIn: canonicalizeObservedIn(draft.observedIn ?? []),
    ...(draft.validFrom === undefined ? {} : { validFrom: draft.validFrom }),
    ...(draft.validTo === undefined ? {} : { validTo: draft.validTo }),
  };
};

/**
 * Derives the complete claim-v1 semantic id for one canonical resolved draft.
 *
 * @param subjectId - Subject that owns the semantic claim.
 * @param draft - Canonical resolved claim draft.
 * @returns The namespaced full SHA-256 ClaimId.
 */
export const deriveClaimId = (subjectId: SubjectId, draft: ResolvedClaimDraft): ClaimId =>
  `claim_${sha256Hex(`claim-v1\0${canonicalJson({ subjectId, draft })}`)}` as ClaimId;
