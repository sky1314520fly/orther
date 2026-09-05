import type {
  BriefEvidenceFact,
  BriefContract,
  BriefMaterial,
  BriefMaterialRef,
  HostDistillBriefing,
  HostDistillContract,
  JobLease,
  MaterialRecord,
  MaterialId,
  MaterialSource,
  PendingJob,
  SpaceRecord,
  SubjectRecord,
  SubjectStateRecord,
  SourceGroup,
  VersionClaimsSnapshot,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";
import { posix, win32 } from "node:path";

import { hashMaterialSet, verifyMaterialIdentity } from "../facts/digests.js";
import { storageCorrupt } from "../internal-errors.js";
import { deriveSourceGroups } from "../ingest/source-groups.js";
import { summarizeSubject } from "../subject/service.js";
import { createBriefContract } from "./prompt-catalog.js";

type BriefingCandidate = Omit<HostDistillBriefing, "limits">;

/** Verified material bytes independent of any storage backend. */
export interface BriefingStoredMaterial {
  readonly record: MaterialRecord;
  readonly content: string;
}

/** Verified baseline facts independent of any storage backend. */
interface BriefingStoredVersion {
  readonly version: VersionRecord;
  readonly manifest: VersionMaterialManifest;
  readonly claims: VersionClaimsSnapshot;
}

/** Complete verified facts needed to build one deterministic briefing candidate. */
export interface BuildBriefingCandidateInput {
  readonly subject: SubjectRecord;
  readonly space: SpaceRecord;
  readonly state: SubjectStateRecord;
  readonly materials: readonly BriefingStoredMaterial[];
  readonly baseline?: BriefingStoredVersion;
  readonly lease: JobLease;
  readonly contract: HostDistillContract;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const projectModelFacingSource = (source: MaterialSource): MaterialSource => {
  const title = source.title;
  if (title === undefined) return source;
  const pathFlavor = win32.isAbsolute(title) ? win32 : posix.isAbsolute(title) ? posix : undefined;
  if (pathFlavor === undefined) return source;
  const { title: _absolutePath, ...withoutTitle } = source;
  void _absolutePath;
  const label = pathFlavor.basename(title);
  return label.length === 0 ? withoutTitle : { ...withoutTitle, title: label };
};

const entryMatchesMaterial = (
  entry: VersionMaterialEntry,
  material: BriefingStoredMaterial["record"],
): boolean =>
  entry.materialId === material.id &&
  entry.contentDigest === material.contentDigest &&
  entry.provenanceDigest === material.provenanceDigest;

const contractsEqual = (left: BriefContract, right: HostDistillContract): boolean =>
  left.digest === right.digest &&
  left.sourceGroupingVersion === right.sourceGroupingVersion &&
  left.promptVersion === right.promptVersion &&
  left.draftSchemaVersion === right.draftSchemaVersion;

const requirePending = (state: SubjectStateRecord): NonNullable<SubjectStateRecord["pending"]> => {
  if (state.pending === undefined) {
    throw storageCorrupt("A briefing candidate requires pending subject work.");
  }
  return state.pending;
};

const requirePendingLease = (
  pending: NonNullable<SubjectStateRecord["pending"]>,
): NonNullable<NonNullable<SubjectStateRecord["pending"]>["lease"]> => {
  if (pending.lease === undefined) {
    throw storageCorrupt("A briefing candidate requires a persisted pending lease.");
  }
  return pending.lease;
};

const validateLeaseAndContract = (
  pending: NonNullable<SubjectStateRecord["pending"]>,
  lease: JobLease,
  contract: HostDistillContract,
): void => {
  const marker = requirePendingLease(pending);
  if (
    lease.id !== marker.id ||
    lease.owner !== marker.owner ||
    lease.acquiredAt !== marker.acquiredAt ||
    lease.expiresAt !== marker.expiresAt ||
    lease.jobId !== pending.jobId ||
    lease.generation !== pending.generation ||
    lease.briefContractDigest !== marker.contract.digest
  ) {
    throw storageCorrupt("The candidate lease does not match the authoritative pending marker.");
  }
  if (lease.expiresAt <= lease.acquiredAt) {
    throw storageCorrupt("The candidate lease has an invalid time interval.");
  }
  if (!contractsEqual(marker.contract, contract)) {
    throw storageCorrupt("The host contract does not match the persisted pending lease.");
  }
  if (createBriefContract(contract).digest !== contract.digest) {
    throw storageCorrupt("The host contract digest does not match its version fields.");
  }
};

const validateCurrentMaterials = (
  input: BuildBriefingCandidateInput,
  pending: NonNullable<SubjectStateRecord["pending"]>,
): readonly BriefingStoredMaterial[] => {
  const ordered = [...input.materials].sort((left, right) =>
    compareStrings(left.record.id, right.record.id),
  );
  const manifest = input.state.materialManifest;
  if (ordered.length !== manifest.length || pending.totalMaterialCount !== manifest.length) {
    throw storageCorrupt("The complete material set does not match the pending manifest count.");
  }
  for (const [index, stored] of ordered.entries()) {
    const entry = manifest[index];
    if (index > 0 && ordered[index - 1]!.record.id === stored.record.id) {
      throw storageCorrupt("The complete material set contains a duplicate MaterialId.");
    }
    verifyMaterialIdentity(stored.record, stored.content);
    if (stored.record.subjectId !== input.subject.id) {
      throw storageCorrupt("A briefing material belongs to a different subject.");
    }
    if (entry === undefined || !entryMatchesMaterial(entry, stored.record)) {
      throw storageCorrupt("The complete material set does not match subject state.");
    }
  }
  if (
    input.state.materialSetHash === undefined ||
    hashMaterialSet(manifest) !== input.state.materialSetHash ||
    input.state.materialSetHash !== pending.materialSetHash
  ) {
    throw storageCorrupt("The briefing material-set hash does not match subject state.");
  }
  return ordered;
};

interface BaselineProjection {
  readonly materialIds: ReadonlySet<MaterialId>;
  readonly value?: NonNullable<BriefingCandidate["baseline"]>;
}

const projectBaseline = (
  input: BuildBriefingCandidateInput,
  pending: NonNullable<SubjectStateRecord["pending"]>,
  currentById: ReadonlyMap<MaterialId, BriefingStoredMaterial>,
  groups: ReadonlyMap<MaterialId, SourceGroup>,
): BaselineProjection => {
  if (
    (pending.baseVersionId === undefined) !== (input.baseline === undefined) ||
    pending.baseVersionId !== input.state.currentVersionId
  ) {
    throw storageCorrupt("The briefing baseline does not match current subject state.");
  }
  if (input.baseline === undefined) return { materialIds: new Set() };

  const { version, manifest, claims } = input.baseline;
  if (
    version.id !== pending.baseVersionId ||
    version.subjectId !== input.subject.id ||
    version.generation > input.state.generation ||
    claims.subjectId !== input.subject.id ||
    claims.versionId !== version.id ||
    version.materialCount !== manifest.items.length ||
    version.materialSetHash !== hashMaterialSet(manifest.items)
  ) {
    throw storageCorrupt("The verified version does not match the requested briefing baseline.");
  }

  const baselineIds = new Set<MaterialId>();
  for (const [index, entry] of manifest.items.entries()) {
    if (index > 0 && manifest.items[index - 1]!.materialId >= entry.materialId) {
      throw storageCorrupt("The baseline manifest is not strictly ordered by MaterialId.");
    }
    const current = currentById.get(entry.materialId);
    if (current === undefined || !entryMatchesMaterial(entry, current.record)) {
      throw storageCorrupt("The baseline manifest is not contained in current subject state.");
    }
    baselineIds.add(entry.materialId);
  }

  const evidenceIds = new Set<MaterialId>();
  for (const claim of claims.claims) {
    for (const evidence of claim.evidence) {
      if (!baselineIds.has(evidence.materialId)) {
        throw storageCorrupt("A baseline claim references material outside its manifest.");
      }
      evidenceIds.add(evidence.materialId);
    }
  }
  const evidenceFacts: BriefEvidenceFact[] = [...evidenceIds]
    .sort(compareStrings)
    .map((materialId) => {
      const stored = currentById.get(materialId);
      const sourceGroup = stored === undefined ? undefined : groups.get(stored.record.id);
      if (stored === undefined || sourceGroup === undefined) {
        throw storageCorrupt("Baseline evidence is missing from the current grouping snapshot.");
      }
      return {
        materialId: stored.record.id,
        source: projectModelFacingSource(stored.record.source),
        derivation: stored.record.derivation,
        sourceGroup,
        sensitivity: stored.record.sensitivity,
        flags: stored.record.flags,
      };
    });

  return {
    materialIds: baselineIds,
    value: {
      versionId: version.id,
      claims: claims.claims,
      quality: version.quality,
      evidenceFacts,
    },
  };
};

const briefMaterialRef = (index: number): BriefMaterialRef => {
  // The unbounded internal candidate may temporarily contain m1000+ so the
  // capacity layer can compute exact failure details before rejecting it. The
  // decimal sequence never wraps or duplicates and is never a public result.
  return `m${String(index + 1).padStart(3, "0")}` as BriefMaterialRef;
};

/**
 * Builds the complete deterministic briefing body before capacity metadata is added.
 *
 * @param input - Verified subject, state, material, version, lease, and contract facts.
 * @returns A complete internal candidate for the capacity gate.
 */
export const buildBriefingCandidate = (input: BuildBriefingCandidateInput): BriefingCandidate => {
  if (input.subject.spaceId !== input.space.id) {
    throw storageCorrupt("The briefing subject belongs to a different space.");
  }
  if (input.state.subjectId !== input.subject.id) {
    throw storageCorrupt("The briefing state belongs to a different subject.");
  }

  const pending = requirePending(input.state);
  if (
    pending.generation !== input.state.generation ||
    pending.baseVersionId !== input.state.currentVersionId
  ) {
    throw storageCorrupt("The pending job does not match current subject generation or base.");
  }
  validateLeaseAndContract(pending, input.lease, input.contract);

  const orderedMaterials = validateCurrentMaterials(input, pending);
  const currentById = new Map(
    orderedMaterials.map((material) => [material.record.id, material] as const),
  );
  const grouping = deriveSourceGroups(
    orderedMaterials.map((material) => material.record),
    input.contract.sourceGroupingVersion,
  );
  const baseline = projectBaseline(input, pending, currentById, grouping.groups);
  const incremental = orderedMaterials.filter(
    (material) => !baseline.materialIds.has(material.record.id),
  );
  if (pending.addedMaterialCount !== incremental.length) {
    throw storageCorrupt("The pending added-material count does not match the briefing delta.");
  }

  const materials: BriefMaterial[] = incremental.map((stored, index) => {
    const sourceGroup = grouping.groups.get(stored.record.id);
    if (sourceGroup === undefined) {
      throw storageCorrupt("A briefing material is missing its derived source group.");
    }
    return {
      ref: briefMaterialRef(index),
      materialId: stored.record.id,
      contentDigest: stored.record.contentDigest,
      kind: stored.record.kind,
      content: stored.content,
      source: projectModelFacingSource(stored.record.source),
      derivation: stored.record.derivation,
      sourceGroup,
      sensitivity: stored.record.sensitivity,
    };
  });

  const job: PendingJob = {
    id: pending.jobId,
    subjectId: input.subject.id,
    generation: pending.generation,
    ...(pending.baseVersionId === undefined ? {} : { baseVersionId: pending.baseVersionId }),
    materialSetHash: pending.materialSetHash,
    addedMaterialCount: pending.addedMaterialCount,
    totalMaterialCount: pending.totalMaterialCount,
    state: "leased",
    queuedAt: pending.queuedAt,
    leaseExpiresAt: input.lease.expiresAt,
  };

  return {
    job,
    lease: input.lease,
    subject: summarizeSubject(input.subject, input.space, input.state),
    ...(baseline.value === undefined ? {} : { baseline: baseline.value }),
    materials,
    contract: input.contract,
  };
};
