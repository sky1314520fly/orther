import {
  DistillyError,
  facetPathSchema,
  profileSchema,
  versionClaimsSnapshotSchema,
  versionIdSchema,
  versionMaterialManifestSchema,
  versionRecordSchema,
} from "@distilly/protocol";
import type {
  Claim,
  CoreFacetName,
  MaterialRecord,
  Profile,
  ReviewReason,
  RuntimeSchema,
  SubjectId,
  VersionClaimsSnapshot,
  VersionId,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";
import { join } from "node:path";

import { deriveSourceGroups } from "../ingest/source-groups.js";
import { schemaUnsupported, storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { canonicalizeResolvedClaimDraft, compareUtf8, deriveClaimId } from "../profile/claim-id.js";
import {
  buildMaterialEvidenceIndex,
  CORE_FACET_ORDER,
  deriveEvidenceStrength,
  summarizeQuality,
} from "../profile/quality.js";
import { PROFILE_RENDERER_VERSION, renderProfile, renderPrompt } from "../profile/render.js";
import { deriveVersionId } from "../profile/version-id.js";
import { canonicalJson } from "./canonical-json.js";
import { verifyFactChecksum } from "./checksum.js";
import { listFactDirectory } from "./directory-scan.js";
import { hashMaterialSet } from "./digests.js";
import { readFactFile } from "./fact-file.js";
import type { FileMaterialStore } from "./material-store.js";
import { decodeUtf8, readRegularFile } from "./safe-fs.js";

/** Fixed renderer order and immutable core artifact names. */
export const CORE_PROFILE_FACETS = CORE_FACET_ORDER satisfies readonly CoreFacetName[];

const CORE_PROFILE_SET = new Set<string>(CORE_PROFILE_FACETS);

const storedVersionSchema: RuntimeSchema<VersionRecord> = {
  parse(value) {
    return versionRecordSchema.parse(value) as VersionRecord;
  },
};

const storedManifestSchema: RuntimeSchema<VersionMaterialManifest> = {
  parse(value) {
    return versionMaterialManifestSchema.parse(value);
  },
};

const storedClaimsSchema: RuntimeSchema<VersionClaimsSnapshot> = {
  parse(value) {
    return versionClaimsSnapshotSchema.parse(value) as VersionClaimsSnapshot;
  },
};

const storedProfileSchema: RuntimeSchema<Profile> = {
  parse(value) {
    return profileSchema.parse(value) as Profile;
  },
};

const isNotFound = (error: unknown): boolean =>
  error instanceof DistillyError && error.code === "not_found";

interface VersionArtifactPaths {
  readonly directory: string;
  readonly versionFile: string;
  readonly manifestFile: string;
  readonly claimsFile: string;
  readonly profileDirectory: string;
  readonly profileFile: string;
  readonly domainsDirectory: string;
  readonly promptFile: string;
}

const artifactPaths = (directory: string): VersionArtifactPaths => {
  const profileDirectory = join(directory, "profile");
  return {
    directory,
    versionFile: join(directory, "version.json"),
    manifestFile: join(directory, "materials.json"),
    claimsFile: join(directory, "claims.json"),
    profileDirectory,
    profileFile: join(profileDirectory, "profile.md"),
    domainsDirectory: join(profileDirectory, "domains"),
    promptFile: join(directory, "prompt.md"),
  };
};

const requireArtifact = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  try {
    return await promise;
  } catch (error) {
    if (isNotFound(error)) throw storageCorrupt(`Version directory is missing ${label}.`, error);
    throw error;
  }
};

const readCanonicalFact = async <
  T extends VersionRecord | VersionMaterialManifest | VersionClaimsSnapshot,
>(
  root: string,
  path: string,
  schema: RuntimeSchema<T>,
  label: string,
): Promise<T> => {
  const fact = await requireArtifact(readFactFile(root, path, schema), label);
  const bytes = await requireArtifact(readRegularFile(root, path), label);
  if (!bytes.equals(Buffer.from(`${canonicalJson(fact)}\n`, "utf8"))) {
    throw storageCorrupt(`Version ${label} does not use canonical fact bytes.`);
  }
  return fact;
};

const readTextArtifact = async (root: string, path: string, label: string): Promise<string> =>
  decodeUtf8(await requireArtifact(readRegularFile(root, path), label), `Version ${label}`);

const expectEntries = async (
  root: string,
  directory: string,
  expected: ReadonlyMap<string, "file" | "directory">,
  label: string,
): Promise<void> => {
  const entries = await listFactDirectory(root, directory);
  if (entries.length !== expected.size) {
    throw storageCorrupt(`${label} has an incomplete or unknown entry set.`);
  }
  for (const entry of entries) {
    if (expected.get(entry.name) !== entry.kind) {
      throw storageCorrupt(`${label} has an incomplete or unknown entry set.`);
    }
  }
};

const parseDomainRoot = (fileName: string): string => {
  if (!fileName.endsWith(".md")) {
    throw storageCorrupt("Version profile domains contain an unknown artifact name.");
  }
  const root = fileName.slice(0, -3);
  try {
    const parsed = facetPathSchema.parse(root);
    if (parsed.includes(".") || CORE_PROFILE_SET.has(parsed)) {
      throw new Error("Not a domain root.");
    }
    return parsed;
  } catch (error) {
    throw storageCorrupt("Version profile domain file name is not a safe domain root.", error);
  }
};

const canonicalEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const REVIEW_REASON_ORDER = new Map<ReviewReason["code"], number>([
  ["identity_changed", 0],
  ["coverage_decreased", 1],
  ["voice_examples_removed", 2],
  ["new_contested_claims", 3],
  ["correction_conflict", 4],
  ["source_diversity_decreased", 5],
  ["suspicious_source", 6],
  ["relayed_correction", 7],
  ["imported_profile", 8],
  ["manual_review_requested", 9],
]);

const requireCanonicalNonEmptyStrings = (values: readonly string[]): void => {
  if (values.length === 0) {
    throw storageCorrupt("A version review reason contains an empty identifier tuple.");
  }
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8(values[index - 1]!, values[index]!) >= 0) {
      throw storageCorrupt(
        "Version review reason identifiers must be exact-unique and UTF-8 ordered.",
      );
    }
  }
};

const validateReviewReasons = (reasons: readonly ReviewReason[] | undefined): void => {
  if (reasons === undefined) return;
  let previousRank = -1;
  for (const reason of reasons) {
    const rank = REVIEW_REASON_ORDER.get(reason.code);
    if (rank === undefined || rank <= previousRank) {
      throw storageCorrupt("Version review reasons are not in canonical unique code order.");
    }
    previousRank = rank;
    switch (reason.code) {
      case "identity_changed":
      case "voice_examples_removed":
      case "new_contested_claims":
      case "correction_conflict":
        requireCanonicalNonEmptyStrings(reason.claimIds);
        break;
      case "coverage_decreased":
        requireCanonicalNonEmptyStrings(reason.facets);
        break;
      case "suspicious_source":
        requireCanonicalNonEmptyStrings(reason.materialIds);
        break;
      case "source_diversity_decreased":
      case "relayed_correction":
      case "imported_profile":
      case "manual_review_requested":
        break;
      default: {
        const exhaustive: never = reason;
        throw new Error(`Unsupported review reason: ${String(exhaustive)}`);
      }
    }
  }
};

const requireSupportedImplementations = (version: VersionRecord): void => {
  if (version.rendererVersion !== PROFILE_RENDERER_VERSION) {
    throw schemaUnsupported(`Unsupported profile renderer version: ${version.rendererVersion}`);
  }
  deriveSourceGroups([], version.quality.sourceGroupingVersion);
};

const validateClaimRecords = (version: VersionRecord, claims: readonly Claim[]): void => {
  const byId = new Map(claims.map((claim) => [claim.id, claim] as const));
  for (const claim of claims) {
    const canonicalDraft = canonicalizeResolvedClaimDraft({
      facet: claim.facet,
      text: claim.text,
      evidence: claim.evidence,
      observedIn: claim.observedIn,
      ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
      ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
    });
    if (
      !canonicalEqual(canonicalDraft.evidence, claim.evidence) ||
      !canonicalEqual(canonicalDraft.observedIn, claim.observedIn)
    ) {
      throw storageCorrupt("Version claims do not use canonical evidence and context order.");
    }
    if (
      (claim.status === "active" || claim.status === "contested") &&
      claim.supersededBy !== undefined
    ) {
      throw storageCorrupt("A live version claim cannot name a superseding claim.");
    }
    if (claim.status === "contested" && claim.strength !== "contested") {
      throw storageCorrupt("A contested version claim must retain contested evidence strength.");
    }
    if (claim.status === "active" && claim.strength === "contested") {
      throw storageCorrupt("An active version claim cannot retain contested evidence strength.");
    }
    if (claim.createdIn === version.id) {
      if (
        claim.status !== "active" ||
        claim.supersededBy !== undefined ||
        deriveClaimId(version.subjectId, canonicalDraft) !== claim.id
      ) {
        throw storageCorrupt("A version-created claim does not match its claim-v1 identity.");
      }
    }
    if (version.parentId === undefined && claim.createdIn !== version.id) {
      throw storageCorrupt("A first version claim must originate in that immutable version.");
    }
    if (claim.supersededBy !== undefined && !byId.has(claim.supersededBy)) {
      throw storageCorrupt("A superseding ClaimId is absent from the immutable claim snapshot.");
    }
  }

  const traversalState = new Map<Claim["id"], "visiting" | "done">();
  for (const claim of claims) {
    if (traversalState.get(claim.id) === "done") continue;
    const path: Claim["id"][] = [];
    let cursor: Claim | undefined = claim;
    while (cursor !== undefined) {
      const state = traversalState.get(cursor.id);
      if (state === "visiting") {
        throw storageCorrupt("Version claims contain a supersession cycle.");
      }
      if (state === "done") break;
      traversalState.set(cursor.id, "visiting");
      path.push(cursor.id);
      cursor = cursor.supersededBy === undefined ? undefined : byId.get(cursor.supersededBy);
    }
    for (const claimId of path) {
      traversalState.set(claimId, "done");
    }
  }
};

/**
 * Schema-normalizes and cross-validates one complete journal-owned version payload.
 *
 * Material existence and evidence body checks remain the responsibility of FileVersionStore.
 *
 * @param input - Complete immutable facts and deterministic artifacts.
 * @returns The schema-normalized, internally consistent artifact set.
 */
export const validateVersionArtifactSet = (input: VersionArtifactSet): VersionArtifactSet => {
  let version: VersionRecord;
  let manifest: VersionMaterialManifest;
  let claims: VersionClaimsSnapshot;
  let profile: Profile;
  try {
    version = storedVersionSchema.parse(input.version);
    manifest = storedManifestSchema.parse(input.manifest);
    claims = storedClaimsSchema.parse(input.claims);
    profile = storedProfileSchema.parse(input.profile);
    verifyFactChecksum(version);
    verifyFactChecksum(manifest);
    verifyFactChecksum(claims);
  } catch (error) {
    throw storageCorrupt("Version artifact payload does not match its runtime schemas.", error);
  }
  if (version.subjectId !== claims.subjectId || version.subjectId !== profile.subjectId) {
    throw storageCorrupt("Version artifact payload has inconsistent subject ids.");
  }
  if (version.id !== claims.versionId || version.id !== profile.versionId) {
    throw storageCorrupt("Version artifact payload has inconsistent version ids.");
  }
  if (version.subjectDisplayName !== profile.displayName) {
    throw storageCorrupt("Version profile display name does not match immutable metadata.");
  }
  if (manifest.items.length !== version.materialCount) {
    throw storageCorrupt("Version material count does not match its manifest.");
  }
  if (hashMaterialSet(manifest.items) !== version.materialSetHash) {
    throw storageCorrupt("Version material-set hash does not match its manifest.");
  }
  if (!canonicalEqual(profile.claims, claims.claims)) {
    throw storageCorrupt("Version profile claims do not match claims.json.");
  }
  if (!canonicalEqual(profile.quality, version.quality)) {
    throw storageCorrupt("Version profile quality does not match immutable metadata.");
  }
  validateReviewReasons(version.reviewReasons);
  validateClaimRecords(version, claims.claims);
  requireSupportedImplementations(version);
  for (const root of Object.keys(profile.domains)) {
    parseDomainRoot(`${root}.md`);
  }

  let derivedId: VersionId;
  let expectedRendering: ReturnType<typeof renderProfile>;
  let expectedPrompt: string;
  try {
    derivedId = deriveVersionId(
      {
        subjectId: version.subjectId,
        subjectDisplayName: version.subjectDisplayName,
        generation: version.generation,
        materialSetHash: version.materialSetHash,
        ...(version.parentId === undefined ? {} : { parentId: version.parentId }),
        ...(version.derivedFromCandidateVersionId === undefined
          ? {}
          : { derivedFromCandidateVersionId: version.derivedFromCandidateVersionId }),
        creation: version.creation,
        actor: version.actor,
        createdDisposition: version.createdDisposition,
        rendererVersion: version.rendererVersion,
        ...(version.reviewReasons === undefined ? {} : { reviewReasons: version.reviewReasons }),
        quality: version.quality,
      },
      claims.claims,
    );
    expectedRendering = renderProfile({
      subjectId: version.subjectId,
      displayName: version.subjectDisplayName,
      versionId: version.id,
      claims: claims.claims,
      quality: version.quality,
    });
    expectedPrompt = renderPrompt(profile);
  } catch (error) {
    throw storageCorrupt("Version artifact payload cannot be deterministically reproduced.", error);
  }
  if (derivedId !== version.id) {
    throw storageCorrupt("Version id does not match its canonical semantic preimage.");
  }
  if (
    !canonicalEqual(profile.core, expectedRendering.core) ||
    !canonicalEqual(profile.domains, expectedRendering.domains) ||
    profile.rendered !== expectedRendering.markdown
  ) {
    throw storageCorrupt("Version profile artifacts do not match the deterministic renderer.");
  }
  if (input.prompt !== expectedPrompt) {
    throw storageCorrupt("Version prompt does not match the deterministic renderer.");
  }
  return { version, manifest, claims, profile, prompt: input.prompt };
};

/**
 * Verifies that a rollback artifact set is the canonical new-version wrapper around its source.
 *
 * @param source - Complete immutable historical version selected by the rollback.
 * @param rollback - Complete new immutable artifact set created by the rollback.
 */
export const validateRollbackArtifactCopy = (
  source: StoredCompleteVersion,
  rollback: VersionArtifactSet,
): void => {
  const { version } = rollback;
  if (
    version.creation.kind !== "rollback" ||
    version.creation.targetVersionId !== source.version.id ||
    version.id === source.version.id ||
    version.parentId === undefined ||
    version.subjectId !== source.version.subjectId ||
    version.createdDisposition !== "current" ||
    version.derivedFromCandidateVersionId !== undefined ||
    version.reviewReasons !== undefined
  ) {
    throw storageCorrupt(
      "Rollback metadata does not identify a distinct canonical current version.",
    );
  }
  if (
    version.subjectDisplayName !== source.version.subjectDisplayName ||
    version.generation !== source.version.generation ||
    version.materialSetHash !== source.version.materialSetHash ||
    version.materialCount !== source.version.materialCount ||
    version.rendererVersion !== source.version.rendererVersion ||
    !canonicalEqual(version.quality, source.version.quality) ||
    !canonicalEqual(rollback.manifest, source.manifest) ||
    !canonicalEqual(rollback.claims.claims, source.claims.claims)
  ) {
    throw storageCorrupt("Rollback artifacts do not exactly copy their historical source.");
  }

  const rendered = renderProfile({
    subjectId: source.version.subjectId,
    displayName: source.version.subjectDisplayName,
    versionId: version.id,
    claims: source.claims.claims,
    quality: source.version.quality,
  });
  const expectedProfile: Profile = {
    subjectId: source.version.subjectId,
    displayName: source.version.subjectDisplayName,
    versionId: version.id,
    claims: source.claims.claims,
    core: rendered.core,
    domains: rendered.domains,
    rendered: rendered.markdown,
    quality: source.version.quality,
  };
  if (
    rollback.claims.subjectId !== source.version.subjectId ||
    rollback.claims.versionId !== version.id ||
    !canonicalEqual(rollback.profile, expectedProfile) ||
    rollback.prompt !== renderPrompt(expectedProfile)
  ) {
    throw storageCorrupt("Rollback profile and prompt are not rebuilt from the copied source.");
  }
};

const verifyExpected = (actual: StoredCompleteVersion, expected: VersionArtifactSet): void => {
  for (const [label, left, right] of [
    ["version.json", actual.version, expected.version],
    ["materials.json", actual.manifest, expected.manifest],
    ["claims.json", actual.claims, expected.claims],
    ["Profile", actual.profile, expected.profile],
  ] as const) {
    if (!canonicalEqual(left, right)) {
      throw storageCorrupt(`Version ${label} does not match its journal-owned payload.`);
    }
  }
  if (actual.prompt !== expected.prompt) {
    throw storageCorrupt("Version prompt.md does not match its journal-owned payload.");
  }
};

const validateEvidence = async (
  materials: FileMaterialStore,
  subjectId: SubjectId,
  manifest: VersionMaterialManifest,
  claims: readonly Claim[],
): Promise<void> => {
  const manifestMembers = new Set(manifest.items.map((entry) => entry.materialId));
  const materialBodies = new Map<string, string>();
  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      if (!manifestMembers.has(evidence.materialId)) {
        throw storageCorrupt("Version claim references material outside its manifest.");
      }
      let content = materialBodies.get(evidence.materialId);
      if (content === undefined) {
        try {
          content = (await materials.read(subjectId, evidence.materialId)).content;
        } catch (error) {
          if (isNotFound(error)) {
            throw storageCorrupt("Version evidence references a missing material fact.", error);
          }
          throw error;
        }
        materialBodies.set(evidence.materialId, content);
      }
      if (!content.includes(evidence.quote)) {
        throw storageCorrupt("Version evidence quote does not match material content.");
      }
      if (evidence.locator !== undefined) {
        const scalars = Array.from(content);
        const { start, end } = evidence.locator;
        if (
          start >= end ||
          end > scalars.length ||
          scalars.slice(start, end).join("") !== evidence.quote
        ) {
          throw storageCorrupt("Version evidence locator does not match its exact quote.");
        }
      }
    }
  }
};

const immutableClaimFields = (claim: Claim) => ({
  id: claim.id,
  facet: claim.facet,
  text: claim.text,
  observedIn: claim.observedIn,
  ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
  ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
  createdIn: claim.createdIn,
});

const isCanonicalEvidenceSuperset = (
  candidate: Claim["evidence"],
  parent: Claim["evidence"],
): boolean => {
  const candidateKeys = new Set(candidate.map((reference) => canonicalJson(reference)));
  return parent.every((reference) => candidateKeys.has(canonicalJson(reference)));
};

const validateCarriedClaimTransition = (
  version: VersionRecord,
  parent: Claim,
  candidate: Claim,
  parentIds: ReadonlySet<Claim["id"]>,
  candidateById: ReadonlyMap<Claim["id"], Claim>,
): void => {
  if (!canonicalEqual(immutableClaimFields(parent), immutableClaimFields(candidate))) {
    throw storageCorrupt("A host-distill version rewrote immutable carried claim fields.");
  }

  if (parent.status === "superseded") {
    if (!canonicalEqual(parent, candidate)) {
      throw storageCorrupt("A host-distill version changed an already superseded claim.");
    }
    return;
  }

  switch (candidate.status) {
    case "active":
      if (
        parent.status !== "active" ||
        ((parent.strength === "user_asserted" || parent.strength === "imported_unverified") &&
          candidate.strength !== parent.strength) ||
        !canonicalEqual(candidate.evidence, parent.evidence) ||
        candidate.supersededBy !== undefined
      ) {
        throw storageCorrupt("A host-distill version contains an invalid active claim transition.");
      }
      return;
    case "contested":
      if (
        candidate.strength !== "contested" ||
        candidate.supersededBy !== undefined ||
        !isCanonicalEvidenceSuperset(candidate.evidence, parent.evidence)
      ) {
        throw storageCorrupt(
          "A host-distill contest must retain a canonical superset of prior evidence.",
        );
      }
      return;
    case "superseded": {
      if (
        candidate.strength !== parent.strength ||
        !canonicalEqual(candidate.evidence, parent.evidence)
      ) {
        throw storageCorrupt("A host-distill supersession changed preserved evidence or strength.");
      }
      if (candidate.supersededBy !== undefined) {
        const replacement = candidateById.get(candidate.supersededBy);
        if (
          replacement === undefined ||
          parentIds.has(replacement.id) ||
          replacement.createdIn !== version.id
        ) {
          throw storageCorrupt(
            "A host-distill revision does not point at a claim created by that version.",
          );
        }
      }
      return;
    }
    default: {
      const exhaustive: never = candidate.status;
      throw new Error(`Unsupported claim status: ${String(exhaustive)}`);
    }
  }
};

/** Complete journal-owned immutable version facts and deterministic renderer artifacts. */
export interface VersionArtifactSet {
  readonly version: VersionRecord;
  readonly manifest: VersionMaterialManifest;
  readonly claims: VersionClaimsSnapshot;
  readonly profile: Profile;
  readonly prompt: string;
}

/** Verified immutable semantic facts consumed by existing version-baseline readers. */
export interface StoredVersion {
  readonly version: VersionRecord;
  readonly manifest: VersionMaterialManifest;
  readonly claims: VersionClaimsSnapshot;
}

/** Fully verified immutable version facts and deterministic renderer artifacts. */
export interface StoredCompleteVersion extends StoredVersion {
  readonly profile: Profile;
  readonly prompt: string;
}

/** Verified reader for one immutable version and its complete artifact set. */
export class FileVersionStore {
  readonly #layout: Layout;
  readonly #materials: FileMaterialStore;

  /**
   * Creates a complete immutable-version reader.
   *
   * @param layout - Confined local fact layout.
   * @param materials - Store used to verify manifest members and evidence bodies.
   */
  constructor(layout: Layout, materials: FileMaterialStore) {
    this.#layout = layout;
    this.#materials = materials;
  }

  /**
   * Reads and cross-validates all required facts and projections for one immutable version.
   *
   * @param subjectId - Subject that owns the immutable version.
   * @param versionId - Profile version to load.
   * @returns The complete verified immutable artifact set.
   */
  async read(subjectId: SubjectId, versionId: VersionId): Promise<StoredCompleteVersion> {
    return this.readFromDirectory(
      subjectId,
      versionId,
      this.#layout.versionDirectory(subjectId, versionId),
    );
  }

  /**
   * Lists every complete immutable version for one subject in canonical VersionId order.
   *
   * Only the exact `.staging` directory is excluded. Unknown, near-miss, non-directory, or corrupt
   * entries fail closed so recovery cannot overlook a lineage reference during abort cleanup.
   *
   * @param subjectId - Subject whose immutable versions are scanned.
   * @returns All complete verified versions in canonical UTF-8 identifier order.
   */
  async list(subjectId: SubjectId): Promise<readonly StoredCompleteVersion[]> {
    const entries = await listFactDirectory(
      this.#layout.root,
      this.#layout.versionsDirectory(subjectId),
    );
    const versions: StoredCompleteVersion[] = [];
    for (const entry of entries) {
      if (entry.name === ".staging") {
        if (entry.kind !== "directory") {
          throw storageCorrupt("Version staging collection is not a real directory.");
        }
        continue;
      }
      if (entry.kind !== "directory") {
        throw storageCorrupt("Version collection contains a non-directory artifact.");
      }
      let versionId: VersionId;
      try {
        versionId = versionIdSchema.parse(entry.name);
      } catch (error) {
        throw storageCorrupt("Version collection contains an unknown directory name.", error);
      }
      versions.push(await this.read(subjectId, versionId));
    }
    return versions;
  }

  /**
   * Reads a complete version artifact set from an explicitly owned directory.
   *
   * Fixed staging and recovery use this seam before publication or exact cleanup.
   *
   * @param subjectId - Subject that owns the immutable version.
   * @param versionId - Profile version expected at the directory path.
   * @param directory - Confined version or fixed staging directory.
   * @param expected - Optional exact journal-owned payload to compare.
   * @returns The complete verified immutable artifact set.
   */
  async readFromDirectory(
    subjectId: SubjectId,
    versionId: VersionId,
    directory: string,
    expected?: VersionArtifactSet,
  ): Promise<StoredCompleteVersion> {
    this.#layout.assertInside(directory);
    const paths = artifactPaths(directory);
    await expectEntries(
      this.#layout.root,
      paths.directory,
      new Map([
        ["claims.json", "file"],
        ["materials.json", "file"],
        ["profile", "directory"],
        ["prompt.md", "file"],
        ["version.json", "file"],
      ]),
      "Version directory",
    );
    await expectEntries(
      this.#layout.root,
      paths.profileDirectory,
      new Map([
        ["boundaries.md", "file"],
        ["domains", "directory"],
        ["identity.md", "file"],
        ["profile.md", "file"],
        ["psyche.md", "file"],
        ["relations.md", "file"],
        ["texture.md", "file"],
        ["timeline.md", "file"],
        ["voice.md", "file"],
      ]),
      "Version profile directory",
    );

    const version = await readCanonicalFact(
      this.#layout.root,
      paths.versionFile,
      storedVersionSchema,
      "version.json",
    );
    const manifest = await readCanonicalFact(
      this.#layout.root,
      paths.manifestFile,
      storedManifestSchema,
      "materials.json",
    );
    const claims = await readCanonicalFact(
      this.#layout.root,
      paths.claimsFile,
      storedClaimsSchema,
      "claims.json",
    );

    if (version.id !== versionId || claims.versionId !== versionId) {
      throw storageCorrupt("Version id does not match its artifact path.");
    }
    if (version.subjectId !== subjectId || claims.subjectId !== subjectId) {
      throw storageCorrupt("Version subject does not match its artifact path.");
    }
    await this.validateHostClaimLineage(version, claims);
    requireSupportedImplementations(version);
    if (manifest.items.length !== version.materialCount) {
      throw storageCorrupt("Version material count does not match its manifest.");
    }
    if (hashMaterialSet(manifest.items) !== version.materialSetHash) {
      throw storageCorrupt("Version material-set hash does not match its manifest.");
    }
    const materialRecords: MaterialRecord[] = [];
    for (const entry of manifest.items) {
      let material;
      try {
        material = await this.#materials.read(subjectId, entry.materialId);
      } catch (error) {
        if (isNotFound(error)) {
          throw storageCorrupt("Version manifest references a missing material fact.", error);
        }
        throw error;
      }
      if (
        material.record.contentDigest !== entry.contentDigest ||
        material.record.provenanceDigest !== entry.provenanceDigest
      ) {
        throw storageCorrupt("Version manifest digest does not match its material fact.");
      }
      materialRecords.push(material.record);
    }
    await validateEvidence(this.#materials, subjectId, manifest, claims.claims);
    const grouping = deriveSourceGroups(materialRecords, version.quality.sourceGroupingVersion);
    const evidenceIndex = buildMaterialEvidenceIndex(materialRecords, grouping);
    for (const claim of claims.claims) {
      if (deriveEvidenceStrength(claim, evidenceIndex) !== claim.strength) {
        throw storageCorrupt("Version claim strength does not match its pinned source groups.");
      }
    }
    if (!canonicalEqual(summarizeQuality(claims.claims, evidenceIndex), version.quality)) {
      throw storageCorrupt("Version quality does not match its claims and pinned source groups.");
    }

    const core = {
      identity: await readTextArtifact(
        this.#layout.root,
        join(paths.profileDirectory, "identity.md"),
        "profile/identity.md",
      ),
      voice: await readTextArtifact(
        this.#layout.root,
        join(paths.profileDirectory, "voice.md"),
        "profile/voice.md",
      ),
      psyche: await readTextArtifact(
        this.#layout.root,
        join(paths.profileDirectory, "psyche.md"),
        "profile/psyche.md",
      ),
      relations: await readTextArtifact(
        this.#layout.root,
        join(paths.profileDirectory, "relations.md"),
        "profile/relations.md",
      ),
      boundaries: await readTextArtifact(
        this.#layout.root,
        join(paths.profileDirectory, "boundaries.md"),
        "profile/boundaries.md",
      ),
      texture: await readTextArtifact(
        this.#layout.root,
        join(paths.profileDirectory, "texture.md"),
        "profile/texture.md",
      ),
      timeline: await readTextArtifact(
        this.#layout.root,
        join(paths.profileDirectory, "timeline.md"),
        "profile/timeline.md",
      ),
    };
    const domains: Record<string, string> = {};
    for (const entry of await listFactDirectory(this.#layout.root, paths.domainsDirectory)) {
      if (entry.kind !== "file") {
        throw storageCorrupt("Version profile domains contain an unknown artifact entry.");
      }
      const root = parseDomainRoot(entry.name);
      domains[root] = await readTextArtifact(
        this.#layout.root,
        join(paths.domainsDirectory, entry.name),
        `profile/domains/${entry.name}`,
      );
    }
    const rendered = await readTextArtifact(
      this.#layout.root,
      paths.profileFile,
      "profile/profile.md",
    );
    let profile: Profile;
    try {
      profile = storedProfileSchema.parse({
        subjectId,
        displayName: version.subjectDisplayName,
        versionId,
        claims: claims.claims,
        core,
        domains,
        rendered,
        quality: version.quality,
      });
    } catch (error) {
      throw storageCorrupt("Version profile artifacts do not match the runtime schema.", error);
    }
    const prompt = await readTextArtifact(this.#layout.root, paths.promptFile, "prompt.md");
    const stored = validateVersionArtifactSet({ version, manifest, claims, profile, prompt });
    if (expected !== undefined) verifyExpected(stored, expected);
    return stored;
  }

  private async validateHostClaimLineage(
    version: VersionRecord,
    claims: VersionClaimsSnapshot,
  ): Promise<void> {
    if (version.parentId === undefined || version.creation.kind !== "host_distill") return;
    validateClaimRecords(version, claims.claims);
    const parentVersion = await readCanonicalFact(
      this.#layout.root,
      this.#layout.versionFile(version.subjectId, version.parentId),
      storedVersionSchema,
      "parent version.json",
    );
    const parentClaims = await readCanonicalFact(
      this.#layout.root,
      this.#layout.versionClaimsFile(version.subjectId, version.parentId),
      storedClaimsSchema,
      "parent claims.json",
    );
    if (
      parentVersion.id !== version.parentId ||
      parentVersion.subjectId !== version.subjectId ||
      parentClaims.versionId !== version.parentId ||
      parentClaims.subjectId !== version.subjectId
    ) {
      throw storageCorrupt("A host-distill version parent does not match its lineage path.");
    }
    validateClaimRecords(parentVersion, parentClaims.claims);
    const candidateById = new Map(claims.claims.map((claim) => [claim.id, claim] as const));
    const parentIds = new Set(parentClaims.claims.map((claim) => claim.id));
    for (const parentClaim of parentClaims.claims) {
      const candidate = candidateById.get(parentClaim.id);
      if (candidate === undefined) {
        throw storageCorrupt("A host-distill version dropped a carried parent claim.");
      }
      validateCarriedClaimTransition(version, parentClaim, candidate, parentIds, candidateById);
    }
    for (const claim of claims.claims) {
      if (parentIds.has(claim.id)) continue;
      const canonicalDraft = canonicalizeResolvedClaimDraft({
        facet: claim.facet,
        text: claim.text,
        evidence: claim.evidence,
        observedIn: claim.observedIn,
        ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
        ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
      });
      if (
        claim.createdIn !== version.id ||
        claim.status !== "active" ||
        claim.supersededBy !== undefined ||
        deriveClaimId(version.subjectId, canonicalDraft) !== claim.id
      ) {
        throw storageCorrupt(
          "A new host-distill claim is not an active self-created claim-v1 record.",
        );
      }
    }
  }
}
