import type {
  ActorContext,
  Claim,
  CreatedDisposition,
  MaterialSetHash,
  QualitySummary,
  ReviewReason,
  SubjectId,
  VersionCreation,
  VersionId,
} from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { sha256Hex } from "../facts/checksum.js";
import { compareUtf8 } from "./claim-id.js";

/** Exact version metadata included in the VersionId preimage. */
export interface VersionIdentityPayload {
  readonly subjectId: SubjectId;
  readonly subjectDisplayName: string;
  readonly generation: number;
  readonly materialSetHash: MaterialSetHash;
  readonly parentId?: VersionId;
  readonly derivedFromCandidateVersionId?: VersionId;
  readonly creation: VersionCreation;
  readonly actor: ActorContext;
  readonly createdDisposition: CreatedDisposition;
  readonly rendererVersion: string;
  readonly reviewReasons?: readonly [ReviewReason, ...ReviewReason[]];
  readonly quality: QualitySummary;
}

/** Canonical hash input for one immutable profile version. */
export interface VersionIdPreimage extends VersionIdentityPayload {
  readonly claims: readonly Omit<Claim, "createdIn">[];
}

/** Claim shape accepted both before and after new createdIn values are finalized. */
export type VersionIdentityClaim = Omit<Claim, "createdIn"> & {
  readonly createdIn?: VersionId;
};

const withoutCreatedIn = (claim: VersionIdentityClaim): Omit<Claim, "createdIn"> => ({
  id: claim.id,
  facet: claim.facet,
  text: claim.text,
  evidence: claim.evidence,
  status: claim.status,
  strength: claim.strength,
  observedIn: claim.observedIn,
  ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
  ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
  ...(claim.supersededBy === undefined ? {} : { supersededBy: claim.supersededBy }),
});

/**
 * Builds the exact VersionId preimage while removing every circular createdIn field.
 *
 * @param payload - Exact version-time metadata covered by identity.
 * @param claims - Strengthened claims before or after createdIn finalization.
 * @returns Canonical preimage with exact Claim fields and no createdIn.
 */
export const createVersionIdPreimage = (
  payload: VersionIdentityPayload,
  claims: readonly VersionIdentityClaim[],
): VersionIdPreimage => ({
  subjectId: payload.subjectId,
  subjectDisplayName: payload.subjectDisplayName,
  generation: payload.generation,
  materialSetHash: payload.materialSetHash,
  ...(payload.parentId === undefined ? {} : { parentId: payload.parentId }),
  ...(payload.derivedFromCandidateVersionId === undefined
    ? {}
    : { derivedFromCandidateVersionId: payload.derivedFromCandidateVersionId }),
  creation: payload.creation,
  actor: payload.actor,
  createdDisposition: payload.createdDisposition,
  rendererVersion: payload.rendererVersion,
  ...(payload.reviewReasons === undefined ? {} : { reviewReasons: payload.reviewReasons }),
  claims: [...claims].sort((left, right) => compareUtf8(left.id, right.id)).map(withoutCreatedIn),
  quality: payload.quality,
});

/**
 * Derives version_ plus the un-namespaced SHA-256 of the canonical version preimage.
 *
 * @param payload - Exact version-time metadata covered by identity.
 * @param claims - Strengthened claims before or after createdIn finalization.
 * @returns Full lowercase SHA-256 VersionId.
 */
export const deriveVersionId = (
  payload: VersionIdentityPayload,
  claims: readonly VersionIdentityClaim[],
): VersionId =>
  `version_${sha256Hex(canonicalJson(createVersionIdPreimage(payload, claims)))}` as VersionId;
