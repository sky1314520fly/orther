import type {
  BriefContract,
  BriefMaterialRef,
  Claim,
  ClaimId,
  MaterialId,
  MaterialRecord,
  SubjectId,
  SubjectStateRecord,
  SourceGroupingSnapshot,
  VersionClaimsSnapshot,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";

import { digestBriefContract, hashMaterialSet, verifyMaterialIdentity } from "../facts/digests.js";
import { storageCorrupt } from "../internal-errors.js";
import { deriveSourceGroups } from "../ingest/source-groups.js";
import { compareUtf8 } from "../profile/claim-id.js";

/** Rebuilt package-private evidence authority for one active leased generation. */
export interface EvidenceContext {
  readonly contract: BriefContract;
  readonly byBriefRef: ReadonlyMap<BriefMaterialRef, MaterialRecord>;
  readonly baseClaims: ReadonlyMap<ClaimId, Claim>;
  readonly materialBodies: ReadonlyMap<MaterialId, string>;
  readonly grouping: SourceGroupingSnapshot;
}

/** Verified material facts independent of their storage implementation. */
interface EvidenceStoredMaterial {
  readonly record: MaterialRecord;
  readonly content: string;
}

/** Verified immutable version facts independent of their storage implementation. */
interface EvidenceStoredVersion {
  readonly version: VersionRecord;
  readonly manifest: VersionMaterialManifest;
  readonly claims: VersionClaimsSnapshot;
}

/** Verified facts required to reconstruct evidence without a brief OperationRecord. */
export interface BuildEvidenceContextInput {
  readonly subjectId: SubjectId;
  readonly state: SubjectStateRecord;
  readonly materials: readonly EvidenceStoredMaterial[];
  readonly baseline?: EvidenceStoredVersion;
  readonly contract: BriefContract;
}

const entryMatchesMaterial = (entry: VersionMaterialEntry, material: MaterialRecord): boolean =>
  entry.materialId === material.id &&
  entry.contentDigest === material.contentDigest &&
  entry.provenanceDigest === material.provenanceDigest;

const contractsEqual = (left: BriefContract, right: BriefContract): boolean =>
  left.digest === right.digest &&
  left.sourceGroupingVersion === right.sourceGroupingVersion &&
  left.promptVersion === right.promptVersion &&
  left.draftSchemaVersion === right.draftSchemaVersion;

const verifyStoredEvidence = (claim: Claim, bodies: ReadonlyMap<MaterialId, string>): void => {
  for (const evidence of claim.evidence) {
    const content = bodies.get(evidence.materialId);
    if (content === undefined || !content.includes(evidence.quote)) {
      throw storageCorrupt("A baseline claim has evidence outside the verified material set.");
    }
    if (evidence.locator !== undefined) {
      const scalars = Array.from(content);
      const { start, end } = evidence.locator;
      if (
        start < 0 ||
        start >= end ||
        end > scalars.length ||
        scalars.slice(start, end).join("") !== evidence.quote
      ) {
        throw storageCorrupt("A baseline claim has an invalid stored evidence locator.");
      }
    }
  }
};

const requireCurrentMaterials = (
  input: BuildEvidenceContextInput,
): readonly EvidenceStoredMaterial[] => {
  const pending = input.state.pending;
  if (pending === undefined || pending.lease === undefined) {
    throw storageCorrupt("Evidence reconstruction requires an active persisted lease marker.");
  }
  if (
    input.state.subjectId !== input.subjectId ||
    pending.generation !== input.state.generation ||
    pending.baseVersionId !== input.state.currentVersionId ||
    input.state.materialSetHash === undefined ||
    pending.materialSetHash !== input.state.materialSetHash ||
    pending.totalMaterialCount !== input.state.materialManifest.length
  ) {
    throw storageCorrupt("Pending evidence authority does not match current subject state.");
  }
  if (
    !contractsEqual(pending.lease.contract, input.contract) ||
    digestBriefContract(input.contract) !== input.contract.digest
  ) {
    throw storageCorrupt("Evidence reconstruction contract does not match the lease marker.");
  }
  if (hashMaterialSet(input.state.materialManifest) !== input.state.materialSetHash) {
    throw storageCorrupt("Evidence reconstruction material manifest has the wrong hash.");
  }

  const ordered = [...input.materials].sort((left, right) =>
    compareUtf8(left.record.id, right.record.id),
  );
  if (ordered.length !== input.state.materialManifest.length) {
    throw storageCorrupt("Evidence reconstruction is missing current materials.");
  }
  for (const [index, stored] of ordered.entries()) {
    const entry = input.state.materialManifest[index];
    if (
      entry === undefined ||
      (index > 0 &&
        compareUtf8(input.state.materialManifest[index - 1]!.materialId, entry.materialId) >= 0) ||
      (index > 0 && ordered[index - 1]!.record.id === stored.record.id) ||
      !entryMatchesMaterial(entry, stored.record)
    ) {
      throw storageCorrupt("Current materials do not match the canonical state manifest.");
    }
    verifyMaterialIdentity(stored.record, stored.content);
    if (stored.record.subjectId !== input.subjectId) {
      throw storageCorrupt("Evidence reconstruction includes a material from another subject.");
    }
  }
  return ordered;
};

interface BaselineFacts {
  readonly materialIds: ReadonlySet<MaterialId>;
  readonly claims: ReadonlyMap<ClaimId, Claim>;
}

const requireBaseline = (
  input: BuildEvidenceContextInput,
  currentById: ReadonlyMap<MaterialId, EvidenceStoredMaterial>,
  materialBodies: ReadonlyMap<MaterialId, string>,
): BaselineFacts => {
  const pending = input.state.pending!;
  if ((pending.baseVersionId === undefined) !== (input.baseline === undefined)) {
    throw storageCorrupt("Evidence reconstruction baseline presence does not match pending state.");
  }
  if (input.baseline === undefined) {
    return { materialIds: new Set(), claims: new Map() };
  }

  const { version, manifest, claims } = input.baseline;
  if (
    version.id !== pending.baseVersionId ||
    version.id !== input.state.currentVersionId ||
    version.subjectId !== input.subjectId ||
    version.generation > input.state.generation ||
    claims.subjectId !== input.subjectId ||
    claims.versionId !== version.id ||
    version.materialCount !== manifest.items.length ||
    version.materialSetHash !== hashMaterialSet(manifest.items)
  ) {
    throw storageCorrupt("Verified baseline facts do not match the pending generation.");
  }

  const materialIds = new Set<MaterialId>();
  for (const [index, entry] of manifest.items.entries()) {
    if (
      (index > 0 && compareUtf8(manifest.items[index - 1]!.materialId, entry.materialId) >= 0) ||
      materialIds.has(entry.materialId)
    ) {
      throw storageCorrupt("The baseline material manifest is not strictly canonical.");
    }
    const current = currentById.get(entry.materialId);
    if (current === undefined || !entryMatchesMaterial(entry, current.record)) {
      throw storageCorrupt("The baseline manifest is not contained in the current generation.");
    }
    materialIds.add(entry.materialId);
  }

  const baseClaims = new Map<ClaimId, Claim>();
  for (const claim of claims.claims) {
    if (baseClaims.has(claim.id)) {
      throw storageCorrupt("The baseline claims snapshot contains a duplicate ClaimId.");
    }
    for (const evidence of claim.evidence) {
      if (!materialIds.has(evidence.materialId)) {
        throw storageCorrupt("A baseline claim cites material outside its version manifest.");
      }
    }
    verifyStoredEvidence(claim, materialBodies);
    baseClaims.set(claim.id, claim);
  }
  return { materialIds, claims: baseClaims };
};

const briefRef = (index: number): BriefMaterialRef =>
  `m${String(index + 1).padStart(3, "0")}` as BriefMaterialRef;

/**
 * Reconstructs exact short refs, baseline claims, bodies, and source groups from fact authority.
 *
 * @param input - Verified state, materials, baseline, and persisted brief contract.
 * @returns Complete package-private evidence authority for resolution and quality.
 */
export const buildEvidenceContext = (input: BuildEvidenceContextInput): EvidenceContext => {
  const materials = requireCurrentMaterials(input);
  const currentById = new Map(materials.map((stored) => [stored.record.id, stored] as const));
  const materialBodies = new Map(
    materials.map((stored) => [stored.record.id, stored.content] as const),
  );
  const baseline = requireBaseline(input, currentById, materialBodies);
  const incremental = materials.filter((stored) => !baseline.materialIds.has(stored.record.id));
  if (input.state.pending!.addedMaterialCount !== incremental.length || incremental.length > 999) {
    throw storageCorrupt("The pending delta cannot reproduce its canonical briefing refs.");
  }
  const byBriefRef = new Map(
    incremental.map((stored, index) => [briefRef(index), stored.record] as const),
  );
  const grouping = deriveSourceGroups(
    materials.map((stored) => stored.record),
    input.contract.sourceGroupingVersion,
  );
  return {
    contract: input.contract,
    byBriefRef,
    baseClaims: baseline.claims,
    materialBodies,
    grouping,
  };
};
