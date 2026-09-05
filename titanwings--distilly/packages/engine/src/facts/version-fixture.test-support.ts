import {
  contentDigestSchema,
  facetPathSchema,
  isoDateTimeSchema,
  materialIdSchema,
  provenanceDigestSchema,
  requestIdSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  Claim,
  ClaimId,
  CreatedDisposition,
  MaterialRecord,
  Profile,
  QualitySummary,
  RequestId,
  SpaceRecord,
  SubjectRecord,
  VersionId,
  VersionClaimsSnapshot,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Layout } from "../layout.js";
import { compareUtf8, deriveClaimId } from "../profile/claim-id.js";
import { renderProfile, renderPrompt, PROFILE_RENDERER_VERSION } from "../profile/render.js";
import type { VersionIdentityPayload } from "../profile/version-id.js";
import { deriveVersionId } from "../profile/version-id.js";
import { FileVersionStaging } from "../testing/legacy-file-version-staging.test.fixture.js";
import { sealFact } from "./checksum.js";
import {
  deriveMaterialId,
  digestContent,
  digestMaterialProvenance,
  hashMaterialSet,
} from "./digests.js";
import { FileMaterialStore } from "./material-store.js";
import { FileSpaceStore } from "./space-store.js";
import { FileSubjectStore } from "./subject-store.js";
import type { VersionArtifactSet } from "./version-store.js";
import { FileVersionStore } from "./version-store.js";

const ZERO_32 = "0".repeat(32);
const ONE_64 = "1".repeat(64);
const TWO_64 = "2".repeat(64);

/** Stable test space id. */
const TEST_SPACE_ID = spaceIdSchema.parse(`space_${ZERO_32}`);
/** Stable test subject id. */
export const TEST_SUBJECT_ID = subjectIdSchema.parse(`subject_${ZERO_32}`);
/** Stable journal request id for version fixtures. */
export const TEST_REQUEST_ID = requestIdSchema.parse(`req_${ZERO_32}`);
/** Stable fixture time. */
export const TEST_AT = isoDateTimeSchema.parse("2026-08-21T00:00:00.000Z");
/** Exact fixture material body. */
const TEST_CONTENT = "Ada writes software and poetry.\n";

/** Quality facts shared by deterministic version fixtures. */
export const TEST_QUALITY: QualitySummary = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 2,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 1,
  diversityEligibleSourceGroupCount: 1,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: ["identity"],
  uncoveredCoreFacets: ["voice", "psyche", "relations", "boundaries", "texture", "timeline"],
  maturity: "sparse",
};

/** Fact stores and a material seeded for complete version storage tests. */
export interface VersionFixtureHarness {
  readonly root: string;
  readonly layout: Layout;
  readonly spaces: FileSpaceStore;
  readonly subjects: FileSubjectStore;
  readonly materials: FileMaterialStore;
  readonly versions: FileVersionStore;
  readonly staging: FileVersionStaging;
  readonly material: MaterialRecord;
}

/** Options that produce a distinct but internally consistent immutable version fixture. */
export interface VersionArtifactOptions {
  readonly generation?: number;
  readonly displayName?: string;
  readonly parentId?: VersionId;
  readonly disposition?: CreatedDisposition;
  readonly claimTextSuffix?: string;
  readonly domainRoot?: string;
  readonly firstClaimStrength?: Claim["strength"];
  readonly firstClaimId?: ClaimId;
  readonly firstClaimCreatedIn?: VersionId;
  readonly quality?: QualitySummary;
  readonly rendererVersion?: string;
}

const makeMaterial = (): MaterialRecord => {
  const contentDigest = digestContent(TEST_CONTENT);
  const provisional = sealFact<MaterialRecord>({
    schemaVersion: 1,
    id: materialIdSchema.parse(`mat_${ONE_64}`),
    subjectId: TEST_SUBJECT_ID,
    kind: "web",
    contentDigest,
    provenanceDigest: provenanceDigestSchema.parse(`provenance_sha256_${ONE_64}`),
    sourceIdentity: "source-uri-v1\0https://example.com/ada",
    source: {
      uri: "https://example.com/ada",
      medium: "article",
      access: "public",
      role: "first_party_expression",
      capturedAt: TEST_AT,
      authors: ["Ada"],
    },
    derivation: { kind: "native_text" },
    participants: [],
    sensitivity: "private",
    flags: [],
    storedAt: TEST_AT,
  });
  const provenanceDigest = digestMaterialProvenance(provisional);
  return sealFact<MaterialRecord>({
    ...provisional,
    provenanceDigest,
    id: deriveMaterialId(provisional.sourceIdentity, provenanceDigest, contentDigest),
  });
};

/**
 * Creates one private fact root with a subject and immutable evidence material.
 *
 * @returns The seeded complete-version storage harness.
 */
export const createVersionFixtureHarness = async (): Promise<VersionFixtureHarness> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-version-fixture-"));
  const layout = new Layout(root);
  const spaces = new FileSpaceStore(layout);
  const subjects = new FileSubjectStore(layout, spaces);
  const materials = new FileMaterialStore(layout, subjects);
  const versions = new FileVersionStore(layout, materials);
  const staging = new FileVersionStaging(layout, versions);
  const space = sealFact<SpaceRecord>({
    schemaVersion: 1,
    id: TEST_SPACE_ID,
    displayName: "People",
    kind: "people",
  });
  const subject = sealFact<SubjectRecord>({
    schemaVersion: 1,
    id: TEST_SUBJECT_ID,
    spaceId: TEST_SPACE_ID,
    displayName: "Ada",
    aliases: [],
    identityHints: [],
    lifecycle: "active",
  });
  await spaces.write(space);
  await subjects.write(subject);
  const material = makeMaterial();
  await materials.write(material, TEST_CONTENT);
  return { root, layout, spaces, subjects, materials, versions, staging, material };
};

const materialEntry = (record: MaterialRecord): VersionMaterialEntry => ({
  materialId: record.id,
  contentDigest: record.contentDigest,
  provenanceDigest: record.provenanceDigest,
});

const provisionalClaims = (
  material: MaterialRecord,
  suffix: string,
  domainRoot: string,
): readonly Claim[] => {
  const drafts = [
    {
      facet: facetPathSchema.parse("identity"),
      text: `Ada writes.${suffix}`,
      evidence: [{ materialId: material.id, quote: "Ada", locator: { start: 0, end: 3 } }],
      observedIn: ["2026"],
    },
    {
      facet: facetPathSchema.parse(`${domainRoot}.writing`),
      text: `Ada writes software.${suffix}`,
      evidence: [{ materialId: material.id, quote: "software" }],
      observedIn: ["2026"],
    },
  ] as const;
  return drafts
    .map((draft): Claim => ({
      id: deriveClaimId(TEST_SUBJECT_ID, draft),
      ...draft,
      status: "active",
      strength: "single_source",
      createdIn: versionIdSchema.parse(`version_${ONE_64}`),
    }))
    .sort((left, right) => compareUtf8(left.id, right.id));
};

/**
 * Builds one complete canonical version payload for the fixture subject and material.
 *
 * @param harness - Seeded fixture whose material the version references.
 * @param options - Optional semantic fields used to create a distinct version.
 * @returns One internally consistent immutable version artifact set.
 */
export const makeVersionArtifacts = (
  harness: VersionFixtureHarness,
  options: VersionArtifactOptions = {},
): VersionArtifactSet => {
  const generation = options.generation ?? 1;
  const displayName = options.displayName ?? "Ada";
  const disposition = options.disposition ?? "current";
  const quality = options.quality ?? TEST_QUALITY;
  const manifestItems = [materialEntry(harness.material)];
  const claimsBeforeId = provisionalClaims(
    harness.material,
    options.claimTextSuffix ?? "",
    options.domainRoot ?? "career",
  ).map((claim, index) => {
    if (index !== 0) return claim;
    return {
      ...claim,
      ...(options.firstClaimStrength === undefined ? {} : { strength: options.firstClaimStrength }),
      ...(options.firstClaimId === undefined ? {} : { id: options.firstClaimId }),
    };
  });
  const identity: VersionIdentityPayload = {
    subjectId: TEST_SUBJECT_ID,
    subjectDisplayName: displayName,
    generation,
    materialSetHash: hashMaterialSet(manifestItems),
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    creation: {
      kind: "bundle_import",
      bundleDigest: contentDigestSchema.parse(`sha256_${TWO_64}`),
    },
    actor: { kind: "system", id: "version-fixture" },
    createdDisposition: disposition,
    rendererVersion: options.rendererVersion ?? PROFILE_RENDERER_VERSION,
    ...(disposition === "current"
      ? {}
      : { reviewReasons: [{ code: "manual_review_requested", note: "fixture" }] }),
    quality,
  };
  const versionId = deriveVersionId(identity, claimsBeforeId);
  const claims = claimsBeforeId.map((claim, index) => ({
    ...claim,
    createdIn:
      index === 0 && options.firstClaimCreatedIn !== undefined
        ? options.firstClaimCreatedIn
        : versionId,
  }));
  const version = sealFact<VersionRecord>({
    schemaVersion: 1,
    id: versionId,
    ...identity,
    materialCount: manifestItems.length,
    createdAt: TEST_AT,
  });
  const manifest = sealFact<VersionMaterialManifest>({
    schemaVersion: 1,
    items: manifestItems,
  });
  const claimsSnapshot = sealFact<VersionClaimsSnapshot>({
    schemaVersion: 1,
    subjectId: TEST_SUBJECT_ID,
    versionId,
    claims,
  });
  const rendered = renderProfile({
    subjectId: TEST_SUBJECT_ID,
    displayName,
    versionId,
    claims,
    quality,
  });
  const profile: Profile = {
    subjectId: TEST_SUBJECT_ID,
    displayName,
    versionId,
    claims,
    core: rendered.core,
    domains: rendered.domains,
    rendered: rendered.markdown,
    quality,
  };
  return {
    version,
    manifest,
    claims: claimsSnapshot,
    profile,
    prompt: renderPrompt(profile),
  };
};

/**
 * Stages and publishes one complete version fixture through the production storage seam.
 *
 * @param harness - Seeded fixture whose production stores receive the version.
 * @param artifacts - Complete immutable version artifacts to publish.
 * @param requestId - Journal request that owns the fixed staging path.
 * @returns Completion after verified publication.
 */
export const publishVersionArtifacts = async (
  harness: VersionFixtureHarness,
  artifacts: VersionArtifactSet,
  requestId: RequestId = TEST_REQUEST_ID,
): Promise<void> => {
  await harness.staging.prepare(requestId, artifacts);
  await harness.staging.publish(requestId, artifacts);
};
