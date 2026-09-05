import type {
  ClaimDraft,
  ClaimId,
  DistillPatch,
  EvidenceDraft,
  EvidenceRef,
} from "@distilly/protocol";

import { evidenceInvalid, invalidInput, storageCorrupt } from "../internal-errors.js";
import type { ResolvedClaimOperation, ResolvedPatch } from "../profile/apply-patch.js";
import {
  canonicalizeEvidence,
  canonicalizeResolvedClaimDraft,
  type ResolvedClaimDraft,
} from "../profile/claim-id.js";
import type { EvidenceContext } from "./evidence-context.js";
import { validateAcceptedPatchBytes } from "./validate-patch.js";

const validateDateRange = (
  draft: Pick<ClaimDraft, "validFrom" | "validTo">,
  fieldPath: string,
): void => {
  if (
    draft.validFrom !== undefined &&
    draft.validTo !== undefined &&
    draft.validFrom > draft.validTo
  ) {
    throw invalidInput("validFrom must not be later than validTo.", `${fieldPath}.validTo`);
  }
};

const preflightPatchTargets = (patch: DistillPatch, context: EvidenceContext): void => {
  const targeted = new Set<ClaimId>();
  for (const [index, operation] of patch.operations.entries()) {
    const fieldPath = `patch.operations[${String(index)}]`;
    if (operation.op === "add") {
      validateDateRange(operation.claim, `${fieldPath}.claim`);
      continue;
    }
    if (operation.op === "revise") {
      validateDateRange(operation.replacement, `${fieldPath}.replacement`);
    }
    if (targeted.has(operation.claimId)) {
      throw invalidInput(
        "A base claim may be targeted only once per patch.",
        `${fieldPath}.claimId`,
      );
    }
    targeted.add(operation.claimId);
    const target = context.baseClaims.get(operation.claimId);
    if (target === undefined) {
      throw invalidInput("Claim target is not part of the base version.", `${fieldPath}.claimId`);
    }
    if (target.status === "superseded") {
      throw invalidInput("A superseded claim cannot be targeted again.", `${fieldPath}.claimId`);
    }
  }
};

const verifyQuote = (
  content: string,
  quote: string,
  locator: EvidenceRef["locator"],
  fieldPath: string,
): void => {
  if (quote.length === 0 || !content.includes(quote)) {
    throw evidenceInvalid("Evidence quote is not an exact material-content substring.", fieldPath);
  }
  if (locator === undefined) return;
  const { start, end } = locator;
  const scalars = Array.from(content);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= end ||
    end > scalars.length ||
    scalars.slice(start, end).join("") !== quote
  ) {
    throw evidenceInvalid(
      "Evidence locator does not select the exact quote in Unicode scalar coordinates.",
      `${fieldPath}.locator`,
    );
  }
};

/**
 * Resolves one short or baseline evidence handle against reconstructed fact authority.
 *
 * @param draft - Host evidence handle.
 * @param context - Rebuilt leased-generation evidence context.
 * @param fieldPath - Caller-visible patch path for failures.
 * @returns Durable exact EvidenceRef.
 */
export const resolveEvidence = (
  draft: EvidenceDraft,
  context: EvidenceContext,
  fieldPath = "evidence",
): EvidenceRef => {
  if (draft.kind === "brief_material") {
    const material = context.byBriefRef.get(draft.materialRef);
    if (material === undefined) {
      throw evidenceInvalid("Brief material ref is not part of this leased generation.", fieldPath);
    }
    const content = context.materialBodies.get(material.id);
    if (content === undefined) {
      throw storageCorrupt("Brief material body is missing from verified evidence context.");
    }
    verifyQuote(content, draft.quote, draft.locator, fieldPath);
    return {
      materialId: material.id,
      quote: draft.quote,
      ...(draft.locator === undefined
        ? {}
        : { locator: { start: draft.locator.start, end: draft.locator.end } }),
    };
  }

  if (draft.kind === "baseline_evidence") {
    const claim = context.baseClaims.get(draft.claimId);
    if (claim === undefined) {
      throw evidenceInvalid("Baseline evidence claim is not part of the base version.", fieldPath);
    }
    if (!Number.isSafeInteger(draft.evidenceIndex) || draft.evidenceIndex < 0) {
      throw evidenceInvalid(
        "Baseline evidence index must be a safe non-negative integer.",
        fieldPath,
      );
    }
    const evidence = claim.evidence[draft.evidenceIndex];
    if (evidence === undefined) {
      throw evidenceInvalid("Baseline evidence index is outside the base claim.", fieldPath);
    }
    return {
      materialId: evidence.materialId,
      quote: evidence.quote,
      ...(evidence.locator === undefined
        ? {}
        : { locator: { start: evidence.locator.start, end: evidence.locator.end } }),
    };
  }

  const exhaustive: never = draft;
  throw invalidInput(`Unsupported evidence draft: ${String(exhaustive)}`, fieldPath);
};

const resolveDraft = (
  draft: ClaimDraft,
  context: EvidenceContext,
  fieldPath: string,
): ResolvedClaimDraft => {
  if (draft.evidence.length === 0) {
    throw invalidInput("A claim draft must contain at least one evidence reference.", fieldPath);
  }
  return canonicalizeResolvedClaimDraft(
    {
      facet: draft.facet,
      text: draft.text,
      evidence: draft.evidence.map((evidence, index) =>
        resolveEvidence(evidence, context, `${fieldPath}.evidence[${String(index)}]`),
      ),
      ...(draft.observedIn === undefined ? {} : { observedIn: draft.observedIn }),
      ...(draft.validFrom === undefined ? {} : { validFrom: draft.validFrom }),
      ...(draft.validTo === undefined ? {} : { validTo: draft.validTo }),
    },
    fieldPath,
  );
};

const resolveOperation = (
  operation: DistillPatch["operations"][number],
  context: EvidenceContext,
  index: number,
): ResolvedClaimOperation => {
  const fieldPath = `patch.operations[${String(index)}]`;
  switch (operation.op) {
    case "add":
      return { op: "add", claim: resolveDraft(operation.claim, context, `${fieldPath}.claim`) };
    case "revise":
      return {
        op: "revise",
        claimId: operation.claimId,
        replacement: resolveDraft(operation.replacement, context, `${fieldPath}.replacement`),
        reason: operation.reason,
      };
    case "supersede":
    case "contest":
      if (operation.evidence.length === 0) {
        throw invalidInput("A claim operation must contain supporting evidence.", fieldPath);
      }
      return {
        op: operation.op,
        claimId: operation.claimId,
        reason: operation.reason,
        evidence: canonicalizeEvidence(
          operation.evidence.map((evidence, evidenceIndex) =>
            resolveEvidence(evidence, context, `${fieldPath}.evidence[${String(evidenceIndex)}]`),
          ),
        ),
      };
    default: {
      const exhaustive: never = operation;
      throw invalidInput(`Unsupported claim operation: ${String(exhaustive)}`, fieldPath);
    }
  }
};

/**
 * Validates patch bytes and resolves every host evidence handle to durable MaterialIds.
 *
 * @param patch - Accepted wire patch.
 * @param context - Rebuilt leased-generation evidence context.
 * @returns Canonical package-private resolved patch.
 */
export const resolveHostPatch = (patch: DistillPatch, context: EvidenceContext): ResolvedPatch => {
  validateAcceptedPatchBytes(patch);
  preflightPatchTargets(patch, context);
  return {
    operations: patch.operations.map((operation, index) =>
      resolveOperation(operation, context, index),
    ),
    ...(patch.reviewRequest === undefined ? {} : { reviewRequest: patch.reviewRequest }),
  };
};
