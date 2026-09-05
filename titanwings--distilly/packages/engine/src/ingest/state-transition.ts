import type {
  IsoDateTime,
  JobId,
  MaterialId,
  PendingJob,
  SubjectId,
  SubjectStateRecord,
  VersionId,
  VersionMaterialEntry,
} from "@distilly/protocol";

import { sealFact } from "../facts/checksum.js";
import { hashMaterialSet } from "../facts/digests.js";
import { storageCorrupt } from "../internal-errors.js";

const AUTO_MINIMUM_MATERIALS = 3;
const AUTO_MAXIMUM_AGE_MILLISECONDS = 30 * 60 * 1000;

const compareMaterialId = (left: VersionMaterialEntry, right: VersionMaterialEntry): number =>
  left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0;

const sortManifest = (
  entries: readonly VersionMaterialEntry[],
): readonly VersionMaterialEntry[] => {
  const sorted = [...entries].sort(compareMaterialId);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]!.materialId === sorted[index]!.materialId) {
      throw storageCorrupt("A subject material manifest cannot contain duplicate ids.");
    }
  }
  return sorted;
};

const manifestsEqual = (
  left: readonly VersionMaterialEntry[],
  right: readonly VersionMaterialEntry[],
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.materialId === other.materialId &&
      entry.contentDigest === other.contentDigest &&
      entry.provenanceDigest === other.provenanceDigest
    );
  });

/** Verified current-version baseline used only for enqueue decisions. */
export interface IngestBaseline {
  readonly versionId: VersionId;
  readonly manifest: readonly VersionMaterialEntry[];
}

/** Complete inputs for the deterministic ingest state transition. */
export interface DeriveIngestStateInput {
  readonly subjectId: SubjectId;
  readonly previous: SubjectStateRecord;
  readonly targetManifest: readonly VersionMaterialEntry[];
  readonly baseline?: IngestBaseline;
  readonly storedAtByMaterialId: ReadonlyMap<MaterialId, IsoDateTime>;
  readonly enqueue: "auto" | "now";
  readonly now: IsoDateTime;
  readonly nextJobId: () => JobId;
}

/** State transition plus the public pending-job view when work is queued. */
export interface DerivedIngestState {
  readonly state: SubjectStateRecord;
  readonly changed: boolean;
  readonly pendingChanged: boolean;
  readonly job?: PendingJob;
}

const toPendingJob = (
  subjectId: SubjectId,
  marker: NonNullable<SubjectStateRecord["pending"]>,
  now: IsoDateTime,
): PendingJob => {
  const common = {
    id: marker.jobId,
    subjectId,
    generation: marker.generation,
    ...(marker.baseVersionId === undefined ? {} : { baseVersionId: marker.baseVersionId }),
    materialSetHash: marker.materialSetHash,
    addedMaterialCount: marker.addedMaterialCount,
    totalMaterialCount: marker.totalMaterialCount,
    queuedAt: marker.queuedAt,
  };
  return marker.lease !== undefined && now < marker.lease.expiresAt
    ? { ...common, state: "leased", leaseExpiresAt: marker.lease.expiresAt }
    : { ...common, state: "pending" };
};

const assertPreviousIsSubset = (
  previous: readonly VersionMaterialEntry[],
  target: readonly VersionMaterialEntry[],
): void => {
  const targetById = new Map(target.map((entry) => [entry.materialId, entry]));
  for (const entry of previous) {
    const next = targetById.get(entry.materialId);
    if (
      next === undefined ||
      next.contentDigest !== entry.contentDigest ||
      next.provenanceDigest !== entry.provenanceDigest
    ) {
      throw storageCorrupt("A text ingest cannot remove or rewrite committed manifest entries.");
    }
  }
};

const assertBaselineIsSubset = (
  baseline: readonly VersionMaterialEntry[],
  previous: readonly VersionMaterialEntry[],
): void => {
  const previousById = new Map(previous.map((entry) => [entry.materialId, entry]));
  for (const entry of baseline) {
    const current = previousById.get(entry.materialId);
    if (
      current === undefined ||
      current.contentDigest !== entry.contentDigest ||
      current.provenanceDigest !== entry.provenanceDigest
    ) {
      throw storageCorrupt("The current-version baseline is not contained in subject state.");
    }
  }
};

/**
 * Applies generation, baseline, auto-v1, and pending-marker rules without I/O.
 *
 * @param input - Verified previous facts, target manifest, and trusted clock/id seams.
 * @returns The sealed target state and optional public pending job.
 */
export const deriveIngestState = (input: DeriveIngestStateInput): DerivedIngestState => {
  if (input.previous.subjectId !== input.subjectId) {
    throw storageCorrupt("The previous state belongs to a different subject.");
  }
  if (
    (input.previous.currentVersionId === undefined) !== (input.baseline === undefined) ||
    (input.baseline !== undefined && input.baseline.versionId !== input.previous.currentVersionId)
  ) {
    throw storageCorrupt("The ingest baseline does not match currentVersionId.");
  }

  const previousManifest = sortManifest(input.previous.materialManifest);
  const targetManifest = sortManifest(input.targetManifest);
  if (targetManifest.length === 0) {
    throw storageCorrupt("A text ingest target manifest cannot be empty.");
  }
  assertPreviousIsSubset(previousManifest, targetManifest);

  const changed = !manifestsEqual(previousManifest, targetManifest);
  const generation = changed ? input.previous.generation + 1 : input.previous.generation;
  const materialSetHash = hashMaterialSet(targetManifest);
  const baselineManifest = sortManifest(input.baseline?.manifest ?? []);
  assertBaselineIsSubset(baselineManifest, previousManifest);
  const baselineIds = new Set(baselineManifest.map((entry) => entry.materialId));
  const uncommitted = targetManifest.filter((entry) => !baselineIds.has(entry.materialId));

  let oldestStoredAt: number | undefined;
  for (const entry of uncommitted) {
    const storedAt = input.storedAtByMaterialId.get(entry.materialId);
    if (storedAt === undefined) {
      throw storageCorrupt("An uncommitted material is missing its verified storedAt timestamp.");
    }
    const instant = Date.parse(storedAt);
    if (!Number.isFinite(instant)) {
      throw storageCorrupt("An uncommitted material has an invalid storedAt timestamp.");
    }
    oldestStoredAt = oldestStoredAt === undefined ? instant : Math.min(oldestStoredAt, instant);
  }

  const previousPending = input.previous.pending;
  let pending =
    previousPending !== undefined &&
    previousPending.generation === generation &&
    previousPending.materialSetHash === materialSetHash
      ? previousPending
      : undefined;

  if (pending === undefined) {
    const now = Date.parse(input.now);
    if (!Number.isFinite(now))
      throw storageCorrupt("The ingest clock returned an invalid instant.");
    const reachedAge =
      oldestStoredAt !== undefined && now - oldestStoredAt >= AUTO_MAXIMUM_AGE_MILLISECONDS;
    const shouldQueue =
      (changed && previousPending !== undefined) ||
      (input.enqueue === "now"
        ? uncommitted.length > 0 || previousPending !== undefined
        : uncommitted.length >= AUTO_MINIMUM_MATERIALS || reachedAge);
    if (shouldQueue) {
      pending = {
        jobId: input.nextJobId(),
        generation,
        ...(input.previous.currentVersionId === undefined
          ? {}
          : { baseVersionId: input.previous.currentVersionId }),
        materialSetHash,
        addedMaterialCount: uncommitted.length,
        totalMaterialCount: targetManifest.length,
        queuedAt: input.now,
      };
    }
  }

  const state = sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: input.subjectId,
    generation,
    materialSetHash,
    materialManifest: targetManifest,
    ...(input.previous.currentVersionId === undefined
      ? {}
      : { currentVersionId: input.previous.currentVersionId }),
    ...(input.previous.suspendedVersionId === undefined
      ? {}
      : { suspendedVersionId: input.previous.suspendedVersionId }),
    ...(pending === undefined ? {} : { pending }),
  });

  return {
    state,
    changed,
    pendingChanged:
      (input.previous.pending === undefined) !== (pending === undefined) ||
      (input.previous.pending !== undefined &&
        pending !== undefined &&
        (input.previous.pending.jobId !== pending.jobId ||
          input.previous.pending.generation !== pending.generation ||
          input.previous.pending.materialSetHash !== pending.materialSetHash)),
    ...(pending === undefined ? {} : { job: toPendingJob(input.subjectId, pending, input.now) }),
  };
};
