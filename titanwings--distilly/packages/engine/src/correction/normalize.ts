import type {
  ActorContext,
  ClaimId,
  ContentDigest,
  CorrectionDraft,
  CorrectionProvenance,
  FacetPath,
  IsoDateTime,
  MaterialRecord,
  RequestId,
  SubjectId,
} from "@distilly/protocol";
import { FACT_LIMITS } from "@distilly/protocol";

import { canonicalJsonBytes } from "../facts/canonical-json.js";
import { sealFact, sha256Hex } from "../facts/checksum.js";
import { deriveMaterialId, digestContent, digestProvenance } from "../facts/digests.js";
import { invalidInput } from "../internal-errors.js";
import { normalizeCorrectionTextV1 } from "../ingest/normalize.js";
import { compareUtf8 } from "../profile/claim-id.js";
import { enforceCanonicalUtf8Limit } from "../utf8-boundary.js";

const ACCEPTED_CORRECTION_NAMESPACE = "distilly:accepted-correction:v1\0";
const CORRECTION_SOURCE_NAMESPACE = "correction-request-v1\0";
const DEFAULT_CORRECTION_FACET = "corrections.unassigned" as FacetPath;

/** Canonical correction semantics used by identity, claim replacement, and the mutation ledger. */
export interface AcceptedCorrection {
  readonly text: string;
  readonly facet: FacetPath;
  readonly supersedes: readonly ClaimId[];
  readonly baseCandidateVersionId?: NonNullable<CorrectionDraft["baseCandidateVersionId"]>;
}

/** Immutable correction material paired with its canonical full body. */
export interface PreparedCorrectionMaterial {
  readonly record: MaterialRecord;
  readonly content: string;
}

/**
 * Normalizes one schema-valid correction without silently accepting duplicate targets.
 * @param input - Schema-valid correction draft from the method boundary.
 * @returns Canonical correction semantics for hashing and application.
 */
export const normalizeCorrectionDraft = (input: CorrectionDraft): AcceptedCorrection => {
  const supersedes = input.supersedes ?? [];
  const seen = new Set<ClaimId>();
  for (const [index, claimId] of supersedes.entries()) {
    if (seen.has(claimId)) {
      throw invalidInput(
        "A correction cannot supersede the same claim more than once.",
        `correction.supersedes[${String(index)}]`,
      );
    }
    seen.add(claimId);
  }
  return {
    text: normalizeCorrectionTextV1(input.text),
    facet: input.facet ?? DEFAULT_CORRECTION_FACET,
    supersedes: [...supersedes].sort(compareUtf8),
    ...(input.baseCandidateVersionId === undefined
      ? {}
      : { baseCandidateVersionId: input.baseCandidateVersionId }),
  };
};

/**
 * Binds correction provenance to the trusted actor rather than caller-controlled parameters.
 * @param actor - Trusted actor supplied by the runtime boundary.
 * @returns Direct-user or exact relayed correction provenance.
 */
export const correctionProvenanceForActor = (actor: ActorContext): CorrectionProvenance =>
  actor.kind === "user"
    ? { kind: "direct_user" }
    : { kind: "relayed", actorKind: actor.kind, actorId: actor.id };

/**
 * Hashes canonical accepted correction semantics under a correction-specific namespace.
 * @param correction - Canonical accepted correction.
 * @returns Content digest of its namespaced canonical encoding.
 */
export const digestAcceptedCorrection = (correction: AcceptedCorrection): ContentDigest =>
  `sha256_${sha256Hex(
    new Uint8Array([
      ...new TextEncoder().encode(ACCEPTED_CORRECTION_NAMESPACE),
      ...canonicalJsonBytes(correction),
    ]),
  )}` as ContentDigest;

/**
 * Derives the request-scoped, retry-stable correction source identity.
 * @param requestId - Mutation request that owns the correction source.
 * @returns Canonical correction source identity.
 */
export const deriveCorrectionSourceIdentity = (requestId: RequestId): string =>
  enforceCanonicalUtf8Limit(
    `${CORRECTION_SOURCE_NAMESPACE}${requestId}`,
    FACT_LIMITS.sourceIdentityBytes,
    "sourceIdentity",
  );

/**
 * Creates the exact private correction material fact used by one correction transaction.
 * @param correction - Canonical accepted correction.
 * @param subjectId - Subject receiving the correction.
 * @param requestId - Mutation request that owns the correction source.
 * @param actor - Trusted actor used to derive correction provenance.
 * @param storedAt - Canonical mutation timestamp.
 * @returns Sealed correction material and its normalized body.
 */
export const prepareCorrectionMaterial = (
  correction: AcceptedCorrection,
  subjectId: SubjectId,
  requestId: RequestId,
  actor: ActorContext,
  storedAt: IsoDateTime,
): PreparedCorrectionMaterial => {
  const correctionProvenance = correctionProvenanceForActor(actor);
  const source = {
    medium: "other",
    access: "private",
    role: "personal_communication",
    capturedAt: storedAt,
    authors: [],
  } as const;
  const derivation = { kind: "native_text" } as const;
  const provenanceDigest = digestProvenance({
    kind: "correction",
    source,
    derivation,
    participants: [],
    sensitivity: "private",
    flags: [],
    correctionProvenance,
  });
  const contentDigest = digestContent(correction.text);
  const sourceIdentity = deriveCorrectionSourceIdentity(requestId);
  const id = deriveMaterialId(sourceIdentity, provenanceDigest, contentDigest);
  return {
    content: correction.text,
    record: sealFact<MaterialRecord>({
      schemaVersion: 1,
      id,
      subjectId,
      kind: "correction",
      contentDigest,
      provenanceDigest,
      sourceIdentity,
      source,
      derivation,
      participants: [],
      sensitivity: "private",
      correctionProvenance,
      flags: [],
      storedAt,
    }),
  };
};
