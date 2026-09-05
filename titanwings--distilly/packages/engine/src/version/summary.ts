import type { VersionRecord, VersionStatus, VersionSummary } from "@distilly/protocol";

/**
 * Projects verified immutable version metadata with its lifecycle status.
 *
 * @param version - Verified immutable version fact.
 * @param status - Lifecycle status derived from authoritative pointers and events.
 * @returns Public version metadata with the supplied current lifecycle status.
 */
export const summarizeVersion = (
  version: VersionRecord,
  status: VersionStatus,
): VersionSummary => ({
  id: version.id,
  subjectId: version.subjectId,
  ...(version.parentId === undefined ? {} : { parentId: version.parentId }),
  ...(version.derivedFromCandidateVersionId === undefined
    ? {}
    : { derivedFromCandidateVersionId: version.derivedFromCandidateVersionId }),
  generation: version.generation,
  materialSetHash: version.materialSetHash,
  creation: version.creation,
  status,
  actor: version.actor,
  quality: version.quality,
  createdAt: version.createdAt,
});
