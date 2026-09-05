import {
  briefContractDigestSchema,
  DistillyError,
  claimIdSchema,
  facetPathSchema,
  materialIdSchema,
  materialRecordSchema,
  versionIdSchema,
  versionClaimsSnapshotSchema,
  versionRecordSchema,
} from "@distilly/protocol";
import type {
  Claim,
  ClaimId,
  DistillyErrorCode,
  MaterialRecord,
  MaterialSource,
  ReviewReason,
  RuntimeSchema,
  VersionClaimsSnapshot,
  VersionCreation,
  VersionId,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { deriveSourceGroups } from "../ingest/source-groups.js";
import { canonicalizeEvidence, compareUtf8, deriveClaimId } from "../profile/claim-id.js";
import { buildMaterialEvidenceIndex, summarizeQuality } from "../profile/quality.js";
import { PROFILE_RENDERER_VERSION, renderProfile, renderPrompt } from "../profile/render.js";
import { deriveVersionId } from "../profile/version-id.js";
import { legacyVersionStagingRootDirectory } from "../testing/legacy-file-version-staging.test.fixture.js";
import { sealFact } from "./checksum.js";
import { deriveMaterialId, digestContent, digestProvenance, hashMaterialSet } from "./digests.js";
import { replaceFactFile } from "./fact-file.js";
import type { VersionArtifactSet } from "./version-store.js";
import {
  createVersionFixtureHarness,
  makeVersionArtifacts,
  publishVersionArtifacts,
  TEST_AT,
  TEST_QUALITY,
  TEST_REQUEST_ID,
  TEST_SUBJECT_ID,
} from "./version-fixture.test-support.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const expectCode = async (promise: Promise<unknown>, code: DistillyErrorCode): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

const claimsSchema: RuntimeSchema<VersionClaimsSnapshot> = {
  parse(value) {
    return versionClaimsSnapshotSchema.parse(value) as VersionClaimsSnapshot;
  },
};

const versionSchema: RuntimeSchema<VersionRecord> = {
  parse(value) {
    return versionRecordSchema.parse(value) as VersionRecord;
  },
};

type Harness = Awaited<ReturnType<typeof createVersionFixtureHarness>>;
type PathSelector = (harness: Harness, versionId: VersionId) => string;

interface SemanticArtifactOptions {
  readonly claims: readonly Claim[];
  readonly materials?: readonly MaterialRecord[];
  readonly newClaimIds?: ReadonlySet<ClaimId>;
  readonly parentId?: VersionId;
  readonly generation?: number;
  readonly creation?: VersionCreation;
  readonly reviewReasons?: readonly [ReviewReason, ...ReviewReason[]];
}

const HOST_CREATION: VersionCreation = {
  kind: "host_distill",
  briefContractDigest: briefContractDigestSchema.parse(`brief_contract_${"4".repeat(64)}`),
  promptVersion: "distill-prompt-v1",
  draftSchemaVersion: 1,
};

const makeSemanticArtifacts = (
  harness: Harness,
  options: SemanticArtifactOptions,
): VersionArtifactSet => {
  const seed = makeVersionArtifacts(harness);
  const materials = options.materials ?? [harness.material];
  const manifestItems: readonly VersionMaterialEntry[] = materials
    .map((record) => ({
      materialId: record.id,
      contentDigest: record.contentDigest,
      provenanceDigest: record.provenanceDigest,
    }))
    .sort((left, right) => compareUtf8(left.materialId, right.materialId));
  const manifest = sealFact<VersionMaterialManifest>({
    schemaVersion: 1,
    items: manifestItems,
  });
  const claimsBeforeLineage = [...options.claims].sort((left, right) =>
    compareUtf8(left.id, right.id),
  );
  const grouping = deriveSourceGroups(materials, TEST_QUALITY.sourceGroupingVersion);
  const quality = summarizeQuality(
    claimsBeforeLineage,
    buildMaterialEvidenceIndex(materials, grouping),
  );
  const disposition = options.reviewReasons === undefined ? "current" : "suspended";
  const identity = {
    subjectId: TEST_SUBJECT_ID,
    subjectDisplayName: "Ada",
    generation: options.generation ?? (options.parentId === undefined ? 1 : 2),
    materialSetHash: hashMaterialSet(manifestItems),
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    creation: options.creation ?? seed.version.creation,
    actor: { kind: "system", id: "semantic-version-fixture" },
    createdDisposition: disposition,
    rendererVersion: PROFILE_RENDERER_VERSION,
    ...(options.reviewReasons === undefined ? {} : { reviewReasons: options.reviewReasons }),
    quality,
  } as const;
  const versionId = deriveVersionId(identity, claimsBeforeLineage);
  const newClaimIds = options.newClaimIds ?? new Set<ClaimId>();
  const claims = claimsBeforeLineage.map((claim) =>
    newClaimIds.has(claim.id) ? { ...claim, createdIn: versionId } : claim,
  );
  const version = sealFact<VersionRecord>({
    schemaVersion: 1,
    id: versionId,
    ...identity,
    materialCount: manifestItems.length,
    createdAt: TEST_AT,
  });
  const claimsSnapshot = sealFact<VersionClaimsSnapshot>({
    schemaVersion: 1,
    subjectId: TEST_SUBJECT_ID,
    versionId,
    claims,
  });
  const rendering = renderProfile({
    subjectId: TEST_SUBJECT_ID,
    displayName: version.subjectDisplayName,
    versionId,
    claims,
    quality,
  });
  const profile = {
    subjectId: TEST_SUBJECT_ID,
    displayName: version.subjectDisplayName,
    versionId,
    claims,
    core: rendering.core,
    domains: rendering.domains,
    rendered: rendering.markdown,
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

const makePublicMaterial = (
  label: string,
  content: string,
  source: MaterialSource,
): MaterialRecord => {
  const kind = "web" as const;
  const derivation = { kind: "native_text" } as const;
  const sensitivity = "private" as const;
  const provenance = {
    kind,
    source,
    derivation,
    participants: [],
    sensitivity,
    flags: [],
  } as const;
  const contentDigest = digestContent(content);
  const provenanceDigest = digestProvenance(provenance);
  const sourceIdentity = `fixture-v1:${label}`;
  return materialRecordSchema.parse(
    sealFact<MaterialRecord>({
      schemaVersion: 1,
      id: deriveMaterialId(sourceIdentity, provenanceDigest, contentDigest),
      subjectId: TEST_SUBJECT_ID,
      kind,
      contentDigest,
      provenanceDigest,
      sourceIdentity,
      source,
      derivation,
      participants: [],
      sensitivity,
      flags: [],
      storedAt: TEST_AT,
    }),
  ) as MaterialRecord;
};

describe("FileVersionStore", () => {
  it("reads the complete immutable fact, Profile, domain, and prompt artifact set", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, artifacts);

    await expect(harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id)).resolves.toEqual(
      artifacts,
    );
  });

  it("lists complete versions canonically while skipping only exact fixed staging", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    await expect(harness.versions.list(TEST_SUBJECT_ID)).resolves.toEqual([]);
    const first = makeVersionArtifacts(harness);
    const second = makeVersionArtifacts(harness, {
      generation: 2,
      parentId: first.version.id,
      claimTextSuffix: " Second",
    });
    const staged = makeVersionArtifacts(harness, {
      generation: 3,
      parentId: second.version.id,
      claimTextSuffix: " Staged only",
    });
    await publishVersionArtifacts(harness, second);
    await publishVersionArtifacts(harness, first);
    await harness.staging.prepare(TEST_REQUEST_ID, staged);

    expect((await harness.versions.list(TEST_SUBJECT_ID)).map(({ version }) => version.id)).toEqual(
      [first.version.id, second.version.id].sort(compareUtf8),
    );
  });

  it("fails closed on near-miss, non-directory, or malformed staging collection entries", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, artifacts);
    const versions = harness.layout.versionsDirectory(TEST_SUBJECT_ID);
    const nearMiss = join(versions, `version_${"f".repeat(64)}.bak`);
    await mkdir(nearMiss);
    await expectCode(harness.versions.list(TEST_SUBJECT_ID), "storage_corrupt");
    await rm(nearMiss, { recursive: true });

    const versionFile = join(versions, `version_${"f".repeat(64)}`);
    await writeFile(versionFile, "not a directory\n");
    await expectCode(harness.versions.list(TEST_SUBJECT_ID), "storage_corrupt");
    await rm(versionFile);

    const staging = legacyVersionStagingRootDirectory(harness.layout, TEST_SUBJECT_ID);
    await rm(staging, { recursive: true });
    await writeFile(staging, "not a directory\n");
    await expectCode(harness.versions.list(TEST_SUBJECT_ID), "storage_corrupt");
  });

  it("rejects every required artifact family when it is absent", async () => {
    const selectors: readonly PathSelector[] = [
      (harness, versionId) => harness.layout.versionFile(TEST_SUBJECT_ID, versionId),
      (harness, versionId) =>
        harness.layout.versionMaterialManifestFile(TEST_SUBJECT_ID, versionId),
      (harness, versionId) => harness.layout.versionClaimsFile(TEST_SUBJECT_ID, versionId),
      (harness, versionId) => harness.layout.versionProfileFile(TEST_SUBJECT_ID, versionId),
      (harness, versionId) =>
        harness.layout.versionCoreProfileFile(TEST_SUBJECT_ID, versionId, "identity"),
      (harness, versionId) =>
        harness.layout.versionDomainProfileFile(TEST_SUBJECT_ID, versionId, "career"),
      (harness, versionId) => harness.layout.versionPromptFile(TEST_SUBJECT_ID, versionId),
    ];
    for (const selectPath of selectors) {
      const harness = await createVersionFixtureHarness();
      roots.push(harness.root);
      const artifacts = makeVersionArtifacts(harness);
      await publishVersionArtifacts(harness, artifacts);
      await rm(selectPath(harness, artifacts.version.id));
      await expectCode(
        harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id),
        "storage_corrupt",
      );
    }
  }, 20_000);

  it("rejects unknown artifacts and non-canonical JSON fact bytes", async () => {
    const unknown = await createVersionFixtureHarness();
    roots.push(unknown.root);
    const unknownArtifacts = makeVersionArtifacts(unknown);
    await publishVersionArtifacts(unknown, unknownArtifacts);
    await writeFile(
      `${unknown.layout.versionDirectory(TEST_SUBJECT_ID, unknownArtifacts.version.id)}/unknown`,
      "unknown",
    );
    await expectCode(
      unknown.versions.read(TEST_SUBJECT_ID, unknownArtifacts.version.id),
      "storage_corrupt",
    );

    const nonCanonical = await createVersionFixtureHarness();
    roots.push(nonCanonical.root);
    const nonCanonicalArtifacts = makeVersionArtifacts(nonCanonical);
    await publishVersionArtifacts(nonCanonical, nonCanonicalArtifacts);
    await writeFile(
      nonCanonical.layout.versionFile(TEST_SUBJECT_ID, nonCanonicalArtifacts.version.id),
      `${JSON.stringify(nonCanonicalArtifacts.version, null, 2)}\n`,
    );
    await expectCode(
      nonCanonical.versions.read(TEST_SUBJECT_ID, nonCanonicalArtifacts.version.id),
      "storage_corrupt",
    );

    const linked = await createVersionFixtureHarness();
    roots.push(linked.root);
    const linkedArtifacts = makeVersionArtifacts(linked);
    await publishVersionArtifacts(linked, linkedArtifacts);
    const domain = linked.layout.versionDomainProfileFile(
      TEST_SUBJECT_ID,
      linkedArtifacts.version.id,
      "career",
    );
    await rm(domain);
    await symlink(linked.layout.materialContentFile(TEST_SUBJECT_ID, linked.material.id), domain);
    await expectCode(
      linked.versions.read(TEST_SUBJECT_ID, linkedArtifacts.version.id),
      "storage_corrupt",
    );
  });

  it("rejects deterministic profile or prompt byte drift", async () => {
    const selectors: readonly PathSelector[] = [
      (harness, versionId) => harness.layout.versionProfileFile(TEST_SUBJECT_ID, versionId),
      (harness, versionId) =>
        harness.layout.versionCoreProfileFile(TEST_SUBJECT_ID, versionId, "voice"),
      (harness, versionId) =>
        harness.layout.versionDomainProfileFile(TEST_SUBJECT_ID, versionId, "career"),
      (harness, versionId) => harness.layout.versionPromptFile(TEST_SUBJECT_ID, versionId),
    ];
    for (const selectPath of selectors) {
      const harness = await createVersionFixtureHarness();
      roots.push(harness.root);
      const artifacts = makeVersionArtifacts(harness);
      await publishVersionArtifacts(harness, artifacts);
      await writeFile(selectPath(harness, artifacts.version.id), "tampered\n");
      await expectCode(
        harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id),
        "storage_corrupt",
      );
    }
  }, 20_000);

  it("maps schema-invalid profile artifact text to storage corruption", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, artifacts);
    await writeFile(
      harness.layout.versionCoreProfileFile(TEST_SUBJECT_ID, artifacts.version.id, "identity"),
      "",
    );

    await expectCode(
      harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id),
      "storage_corrupt",
    );
  });

  it("rejects evidence outside the manifest and invalid quote or scalar locator", async () => {
    const cases: readonly ((claim: Claim) => Claim)[] = [
      (claim) => ({
        ...claim,
        evidence: [
          {
            ...claim.evidence[0]!,
            materialId: materialIdSchema.parse(`mat_${"f".repeat(64)}`),
          },
        ],
      }),
      (claim) => ({ ...claim, evidence: [{ ...claim.evidence[0]!, quote: "missing" }] }),
      (claim) => ({
        ...claim,
        evidence: [{ ...claim.evidence[0]!, locator: { start: 1, end: 4 } }],
      }),
    ];
    for (const mutate of cases) {
      const harness = await createVersionFixtureHarness();
      roots.push(harness.root);
      const artifacts = makeVersionArtifacts(harness);
      await publishVersionArtifacts(harness, artifacts);
      const first = artifacts.claims.claims[0]!;
      const tampered = sealFact<VersionClaimsSnapshot>({
        schemaVersion: 1,
        subjectId: artifacts.claims.subjectId,
        versionId: artifacts.claims.versionId,
        claims: [mutate(first), ...artifacts.claims.claims.slice(1)],
      });
      await replaceFactFile(
        harness.root,
        harness.layout.versionClaimsFile(TEST_SUBJECT_ID, artifacts.version.id),
        tampered,
        claimsSchema,
      );
      await expectCode(
        harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id),
        "storage_corrupt",
      );
    }
  }, 20_000);

  it("rejects a VersionRecord whose semantic fields no longer derive its id", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, artifacts);
    const changed = sealFact<VersionRecord>({
      ...artifacts.version,
      actor: { kind: "system", id: "changed-actor" },
    });
    await replaceFactFile(
      harness.root,
      harness.layout.versionFile(TEST_SUBJECT_ID, artifacts.version.id),
      changed,
      versionSchema,
    );

    await expectCode(
      harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id),
      "storage_corrupt",
    );
  });

  it("reports unknown pinned renderer and source-grouping implementations as unsupported", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    await expectCode(
      harness.staging.prepare(
        TEST_REQUEST_ID,
        makeVersionArtifacts(harness, { rendererVersion: "profile-renderer-v2" }),
      ),
      "schema_unsupported",
    );
    await expectCode(
      harness.staging.prepare(
        TEST_REQUEST_ID,
        makeVersionArtifacts(harness, {
          quality: { ...TEST_QUALITY, sourceGroupingVersion: "source-groups-v2" },
        }),
      ),
      "schema_unsupported",
    );
  });

  it("dispatches pinned implementations before verifying a published version's semantics", async () => {
    const mutations: readonly ((version: VersionRecord) => VersionRecord)[] = [
      (version) => sealFact<VersionRecord>({ ...version, rendererVersion: "profile-renderer-v2" }),
      (version) =>
        sealFact<VersionRecord>({
          ...version,
          quality: { ...version.quality, sourceGroupingVersion: "source-groups-v2" },
        }),
    ];
    for (const mutate of mutations) {
      const harness = await createVersionFixtureHarness();
      roots.push(harness.root);
      const artifacts = makeVersionArtifacts(harness);
      await publishVersionArtifacts(harness, artifacts);
      await replaceFactFile(
        harness.root,
        harness.layout.versionFile(TEST_SUBJECT_ID, artifacts.version.id),
        mutate(artifacts.version),
        versionSchema,
      );
      await expectCode(
        harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id),
        "schema_unsupported",
      );
    }
  });

  it("recomputes claim strength and quality from the complete pinned material set", async () => {
    const strengthDrift = await createVersionFixtureHarness();
    roots.push(strengthDrift.root);
    await expectCode(
      strengthDrift.staging.prepare(
        TEST_REQUEST_ID,
        makeVersionArtifacts(strengthDrift, { firstClaimStrength: "corroborated" }),
      ),
      "storage_corrupt",
    );

    const qualityDrift = await createVersionFixtureHarness();
    roots.push(qualityDrift.root);
    await expectCode(
      qualityDrift.staging.prepare(
        TEST_REQUEST_ID,
        makeVersionArtifacts(qualityDrift, {
          quality: { ...TEST_QUALITY, activeClaimCount: 1 },
        }),
      ),
      "storage_corrupt",
    );
  });

  it("rejects a self-consistent version whose new ClaimId is not claim-v1 derived", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    await expectCode(
      harness.staging.prepare(
        TEST_REQUEST_ID,
        makeVersionArtifacts(harness, {
          firstClaimId: claimIdSchema.parse(`claim_${"f".repeat(64)}`),
        }),
      ),
      "storage_corrupt",
    );
  });

  it("rejects a first-version claim whose createdIn points at another version", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    await expectCode(
      harness.staging.prepare(
        TEST_REQUEST_ID,
        makeVersionArtifacts(harness, {
          firstClaimCreatedIn: versionIdSchema.parse(`version_${"f".repeat(64)}`),
        }),
      ),
      "storage_corrupt",
    );
  });

  it("accepts only the canonical unique ReviewReason tuple and canonical non-empty members", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const seed = makeVersionArtifacts(harness);
    const claimIds = seed.claims.claims.map((claim) => claim.id).sort(compareUtf8);
    const reviewFacets = [facetPathSchema.parse("identity"), facetPathSchema.parse("voice")];
    const allReasons = [
      { code: "identity_changed", claimIds },
      { code: "coverage_decreased", facets: reviewFacets },
      { code: "voice_examples_removed", claimIds },
      { code: "new_contested_claims", claimIds },
      { code: "correction_conflict", claimIds },
      { code: "source_diversity_decreased" },
      { code: "suspicious_source", materialIds: [harness.material.id] },
      { code: "relayed_correction", actorKind: "host" },
      { code: "imported_profile" },
      { code: "manual_review_requested", note: "fixture" },
    ] as const satisfies readonly [ReviewReason, ...ReviewReason[]];
    const newClaimIds = new Set(claimIds);
    await expect(
      harness.staging.prepare(
        TEST_REQUEST_ID,
        makeSemanticArtifacts(harness, {
          claims: seed.claims.claims,
          newClaimIds,
          reviewReasons: allReasons,
        }),
      ),
    ).resolves.toBeUndefined();

    const firstId = claimIds[0]!;
    const secondId = claimIds[1]!;
    const invalidReasons: readonly (readonly [ReviewReason, ...ReviewReason[]])[] = [
      [{ code: "manual_review_requested" }, { code: "identity_changed", claimIds: [firstId] }],
      [
        { code: "identity_changed", claimIds: [firstId] },
        { code: "identity_changed", claimIds: [secondId] },
      ],
      [{ code: "identity_changed", claimIds: [] }],
      [{ code: "coverage_decreased", facets: [] }],
      [{ code: "voice_examples_removed", claimIds: [firstId, firstId] }],
      [{ code: "correction_conflict", claimIds: [secondId, firstId] }],
      [{ code: "suspicious_source", materialIds: [] }],
      [{ code: "suspicious_source", materialIds: [harness.material.id, harness.material.id] }],
    ];
    for (const reviewReasons of invalidReasons) {
      await expectCode(
        harness.staging.prepare(
          TEST_REQUEST_ID,
          makeSemanticArtifacts(harness, {
            claims: seed.claims.claims,
            newClaimIds,
            reviewReasons,
          }),
        ),
        "storage_corrupt",
      );
    }
  }, 20_000);

  it("rejects a self-consistent supersededBy cycle", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const seed = makeVersionArtifacts(harness);
    const origin = versionIdSchema.parse(`version_${"e".repeat(64)}`);
    const first = seed.claims.claims[0]!;
    const second = seed.claims.claims[1]!;
    const cyclicClaims: readonly Claim[] = [
      {
        ...first,
        status: "superseded",
        createdIn: origin,
        supersededBy: second.id,
      },
      {
        ...second,
        status: "superseded",
        createdIn: origin,
        supersededBy: first.id,
      },
    ];

    await expectCode(
      harness.staging.prepare(
        TEST_REQUEST_ID,
        makeSemanticArtifacts(harness, {
          claims: cyclicClaims,
          parentId: origin,
          creation: seed.version.creation,
        }),
      ),
      "storage_corrupt",
    );
  });

  it("accepts exact carry, canonical contest supersets, and revision lineage", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const parent = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, parent);

    const exactCarry = makeSemanticArtifacts(harness, {
      claims: parent.claims.claims,
      parentId: parent.version.id,
      creation: HOST_CREATION,
    });
    await publishVersionArtifacts(harness, exactCarry);
    await expect(harness.versions.read(TEST_SUBJECT_ID, exactCarry.version.id)).resolves.toEqual(
      exactCarry,
    );

    const identity = parent.claims.claims.find((claim) => claim.facet === "identity")!;
    const contestedClaims = parent.claims.claims.map((claim): Claim =>
      claim.id === identity.id
        ? {
            ...claim,
            evidence: canonicalizeEvidence([
              ...claim.evidence,
              { materialId: harness.material.id, quote: "software" },
            ]),
            status: "contested",
            strength: "contested",
          }
        : claim,
    );
    const contested = makeSemanticArtifacts(harness, {
      claims: contestedClaims,
      parentId: parent.version.id,
      creation: HOST_CREATION,
      reviewReasons: [
        { code: "identity_changed", claimIds: [identity.id] },
        { code: "new_contested_claims", claimIds: [identity.id] },
      ],
    });
    await publishVersionArtifacts(harness, contested);
    await expect(harness.versions.read(TEST_SUBJECT_ID, contested.version.id)).resolves.toEqual(
      contested,
    );

    const replacementDraft = {
      facet: identity.facet,
      text: `${identity.text} More precisely.`,
      evidence: identity.evidence,
      observedIn: identity.observedIn,
      ...(identity.validFrom === undefined ? {} : { validFrom: identity.validFrom }),
      ...(identity.validTo === undefined ? {} : { validTo: identity.validTo }),
    };
    const replacementId = deriveClaimId(TEST_SUBJECT_ID, replacementDraft);
    const replacement: Claim = {
      id: replacementId,
      ...replacementDraft,
      status: "active",
      strength: identity.strength,
      createdIn: parent.version.id,
    };
    const revisedClaims = [
      ...parent.claims.claims.map((claim): Claim =>
        claim.id === identity.id
          ? { ...claim, status: "superseded", supersededBy: replacementId }
          : claim,
      ),
      replacement,
    ];
    const revised = makeSemanticArtifacts(harness, {
      claims: revisedClaims,
      newClaimIds: new Set([replacementId]),
      parentId: parent.version.id,
      creation: HOST_CREATION,
      reviewReasons: [{ code: "identity_changed", claimIds: [identity.id] }],
    });
    await publishVersionArtifacts(harness, revised);
    await expect(harness.versions.read(TEST_SUBJECT_ID, revised.version.id)).resolves.toEqual(
      revised,
    );
  }, 20_000);

  it("recomputes ordinary carried strength when a new bridge merges source groups", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const independentContent = "Independent reporting about Ada.\n";
    const independent = makePublicMaterial("independent", independentContent, {
      medium: "article",
      access: "public",
      capturedAt: TEST_AT,
      authors: [],
      artifact: { provider: "fixture", externalId: "independent" },
    });
    const bridgeContent = "A representation bridge.\n";
    const bridge = makePublicMaterial("bridge", bridgeContent, {
      medium: "article",
      access: "public",
      capturedAt: TEST_AT,
      authors: [],
      uri: "https://example.com/ada",
      representationOf: { provider: "fixture", externalId: "independent" },
    });
    await harness.materials.write(independent, independentContent);
    await harness.materials.write(bridge, bridgeContent);

    const seed = makeVersionArtifacts(harness);
    const seedIdentity = seed.claims.claims.find((claim) => claim.facet === "identity")!;
    const identityDraft = {
      facet: seedIdentity.facet,
      text: seedIdentity.text,
      evidence: canonicalizeEvidence([
        ...seedIdentity.evidence,
        { materialId: independent.id, quote: "Independent" },
      ]),
      observedIn: seedIdentity.observedIn,
      ...(seedIdentity.validFrom === undefined ? {} : { validFrom: seedIdentity.validFrom }),
      ...(seedIdentity.validTo === undefined ? {} : { validTo: seedIdentity.validTo }),
    };
    const identityId = deriveClaimId(TEST_SUBJECT_ID, identityDraft);
    const parentClaims = seed.claims.claims.map((claim): Claim =>
      claim.id === seedIdentity.id
        ? {
            id: identityId,
            ...identityDraft,
            status: "active",
            strength: "corroborated",
            createdIn: claim.createdIn,
          }
        : claim,
    );
    const parent = makeSemanticArtifacts(harness, {
      claims: parentClaims,
      materials: [harness.material, independent],
      newClaimIds: new Set(parentClaims.map((claim) => claim.id)),
    });
    await publishVersionArtifacts(harness, parent);

    const candidateClaims = parent.claims.claims.map((claim): Claim =>
      claim.id === identityId ? { ...claim, strength: "single_source" } : claim,
    );
    const candidate = makeSemanticArtifacts(harness, {
      claims: candidateClaims,
      materials: [harness.material, independent, bridge],
      parentId: parent.version.id,
      creation: HOST_CREATION,
    });
    await publishVersionArtifacts(harness, candidate);

    expect(parent.version.quality.corroboratedClaimCount).toBe(1);
    expect(candidate.version.quality.corroboratedClaimCount).toBe(0);
    await expect(harness.versions.read(TEST_SUBJECT_ID, candidate.version.id)).resolves.toEqual(
      candidate,
    );
  }, 20_000);

  it("rejects dropped, rewritten, non-contest evidence, forged revision, and forged-new lineage", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const parent = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, parent);
    const identity = parent.claims.claims.find((claim) => claim.facet === "identity")!;
    const other = parent.claims.claims.find((claim) => claim.id !== identity.id)!;
    const extraEvidence = { materialId: harness.material.id, quote: "software" } as const;
    const forgedDraft = {
      facet: identity.facet,
      text: "A forged new claim.",
      evidence: identity.evidence,
      observedIn: identity.observedIn,
    };
    const forgedNew: Claim = {
      id: deriveClaimId(TEST_SUBJECT_ID, forgedDraft),
      ...forgedDraft,
      status: "active",
      strength: "single_source",
      createdIn: versionIdSchema.parse(`version_${"d".repeat(64)}`),
    };
    const invalidClaims: readonly (readonly Claim[])[] = [
      parent.claims.claims.filter((claim) => claim.id !== identity.id),
      parent.claims.claims.map((claim) =>
        claim.id === identity.id ? { ...claim, text: `${claim.text} rewritten` } : claim,
      ),
      parent.claims.claims.map((claim) =>
        claim.id === identity.id
          ? { ...claim, evidence: canonicalizeEvidence([...claim.evidence, extraEvidence]) }
          : claim,
      ),
      parent.claims.claims.map((claim) =>
        claim.id === identity.id
          ? { ...claim, status: "superseded" as const, supersededBy: other.id }
          : claim,
      ),
      [...parent.claims.claims, forgedNew],
    ];

    for (const claims of invalidClaims) {
      await expectCode(
        harness.staging.prepare(
          TEST_REQUEST_ID,
          makeSemanticArtifacts(harness, {
            claims,
            parentId: parent.version.id,
            creation: HOST_CREATION,
          }),
        ),
        "storage_corrupt",
      );
    }
  }, 20_000);

  it("rejects contested regression, contested evidence loss, and mutation after supersession", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const parent = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, parent);
    const identity = parent.claims.claims.find((claim) => claim.facet === "identity")!;
    const extraEvidence = { materialId: harness.material.id, quote: "software" } as const;
    const contestedClaims = parent.claims.claims.map((claim): Claim =>
      claim.id === identity.id
        ? {
            ...claim,
            evidence: canonicalizeEvidence([...claim.evidence, extraEvidence]),
            status: "contested",
            strength: "contested",
          }
        : claim,
    );
    const contested = makeSemanticArtifacts(harness, {
      claims: contestedClaims,
      parentId: parent.version.id,
      creation: HOST_CREATION,
      reviewReasons: [
        { code: "identity_changed", claimIds: [identity.id] },
        { code: "new_contested_claims", claimIds: [identity.id] },
      ],
    });
    await publishVersionArtifacts(harness, contested);
    const contestedIdentity = contested.claims.claims.find((claim) => claim.id === identity.id)!;
    const invalidGrandchildren: readonly (readonly Claim[])[] = [
      contested.claims.claims.map((claim) =>
        claim.id === identity.id
          ? { ...claim, status: "active" as const, strength: "single_source" as const }
          : claim,
      ),
      contested.claims.claims.map((claim) =>
        claim.id === identity.id ? { ...claim, evidence: [extraEvidence] } : claim,
      ),
    ];
    for (const claims of invalidGrandchildren) {
      await expectCode(
        harness.staging.prepare(
          TEST_REQUEST_ID,
          makeSemanticArtifacts(harness, {
            claims,
            parentId: contested.version.id,
            generation: 3,
            creation: HOST_CREATION,
          }),
        ),
        "storage_corrupt",
      );
    }

    const replacementDraft = {
      facet: identity.facet,
      text: `${identity.text} replacement`,
      evidence: identity.evidence,
      observedIn: identity.observedIn,
    };
    const replacementId = deriveClaimId(TEST_SUBJECT_ID, replacementDraft);
    const revisedClaims = [
      ...parent.claims.claims.map((claim): Claim =>
        claim.id === identity.id
          ? { ...claim, status: "superseded", supersededBy: replacementId }
          : claim,
      ),
      {
        id: replacementId,
        ...replacementDraft,
        status: "active" as const,
        strength: identity.strength,
        createdIn: parent.version.id,
      },
    ];
    const revised = makeSemanticArtifacts(harness, {
      claims: revisedClaims,
      newClaimIds: new Set([replacementId]),
      parentId: parent.version.id,
      creation: HOST_CREATION,
      reviewReasons: [{ code: "identity_changed", claimIds: [identity.id] }],
    });
    await publishVersionArtifacts(harness, revised);
    const rewrittenSuperseded = revised.claims.claims.map((claim) =>
      claim.id === identity.id ? { ...claim, text: `${claim.text} rewritten` } : claim,
    );
    await expectCode(
      harness.staging.prepare(
        TEST_REQUEST_ID,
        makeSemanticArtifacts(harness, {
          claims: rewrittenSuperseded,
          parentId: revised.version.id,
          generation: 3,
          creation: HOST_CREATION,
        }),
      ),
      "storage_corrupt",
    );
    expect(contestedIdentity.status).toBe("contested");
  }, 20_000);
});
