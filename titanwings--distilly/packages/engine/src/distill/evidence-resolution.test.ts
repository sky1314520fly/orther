import type {
  BriefContract,
  BriefMaterialRef,
  Claim,
  ClaimId,
  DistillPatch,
  FacetPath,
  IsoDateTime,
  JobId,
  LeaseId,
  LeaseOwnerId,
  MaterialRecord,
  MaterialSource,
  QualitySummary,
  SubjectId,
  SubjectStateRecord,
  VersionClaimsSnapshot,
  VersionId,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { canonicalJsonBytes } from "../facts/canonical-json.js";
import { sealFact } from "../facts/checksum.js";
import {
  deriveMaterialId,
  digestContent,
  digestProvenance,
  hashMaterialSet,
} from "../facts/digests.js";
import type { StoredMaterial } from "../facts/material-store.js";
import type { StoredVersion } from "../facts/version-store.js";
import { createBriefContract } from "./prompt-catalog.js";
import { buildEvidenceContext, type BuildEvidenceContextInput } from "./evidence-context.js";
import { resolveEvidence, resolveHostPatch } from "./resolve-evidence.js";
import { MAX_ACCEPTED_PATCH_BYTES, validateAcceptedPatchBytes } from "./validate-patch.js";

const SUBJECT_ID = `subject_${"1".repeat(32)}` as SubjectId;
const JOB_ID = `job_${"2".repeat(32)}` as JobId;
const LEASE_ID = `lease_${"3".repeat(32)}` as LeaseId;
const LEASE_OWNER = `lease_owner_${"4".repeat(32)}` as LeaseOwnerId;
const VERSION_ID = `version_${"5".repeat(64)}` as VersionId;
const NOW = "2026-08-21T00:00:00.000Z" as IsoDateTime;
const EXPIRES = "2026-08-21T00:30:00.000Z" as IsoDateTime;
const contract: BriefContract = createBriefContract({
  sourceGroupingVersion: "source-groups-v1",
  promptVersion: `host-distill-v1-sha256_${"6".repeat(64)}`,
  draftSchemaVersion: 1,
});

const quality: QualitySummary = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 1,
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

const source = (label: string): MaterialSource => ({
  uri: `https://example.com/${label}`,
  medium: "article",
  access: "public",
  role: "first_party_expression",
  capturedAt: NOW,
  authors: ["Mira"],
});

const storedMaterial = (label: string, content: string): StoredMaterial => {
  const materialSource = source(label);
  const derivation = { kind: "native_text" } as const;
  const provenance = {
    kind: "web",
    source: materialSource,
    derivation,
    participants: [],
    sensitivity: "shareable",
    flags: [],
  } as const;
  const contentDigest = digestContent(content);
  const provenanceDigest = digestProvenance(provenance);
  const sourceIdentity = `evidence-fixture-v1:${label}`;
  return {
    content,
    record: sealFact<MaterialRecord>({
      schemaVersion: 1,
      id: deriveMaterialId(sourceIdentity, provenanceDigest, contentDigest),
      subjectId: SUBJECT_ID,
      kind: "web",
      contentDigest,
      provenanceDigest,
      sourceIdentity,
      source: materialSource,
      derivation,
      participants: [],
      sensitivity: "shareable",
      flags: [],
      storedAt: NOW,
    }),
  };
};

const first = storedMaterial("mira-voice", "Mira 🌱 says yes.\nSecond line.");
const second = storedMaterial(
  "mira-craft",
  "Independent source says Mira prototypes on paper before code.",
);

const entryFor = (material: StoredMaterial): VersionMaterialEntry => ({
  materialId: material.record.id,
  contentDigest: material.record.contentDigest,
  provenanceDigest: material.record.provenanceDigest,
});

const entriesFor = (materials: readonly StoredMaterial[]): readonly VersionMaterialEntry[] =>
  materials
    .map(entryFor)
    .sort((left, right) =>
      left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
    );

const baselineClaim: Claim = {
  id: `claim_${"7".repeat(64)}` as ClaimId,
  facet: "identity.name" as FacetPath,
  text: "The subject uses the name Mira.",
  evidence: [{ materialId: first.record.id, quote: "Mira" }],
  status: "active",
  strength: "single_source",
  observedIn: ["profile"],
  createdIn: VERSION_ID,
};

const baselineVersion = (): StoredVersion => {
  const items = entriesFor([first]);
  const versionPayload = {
    schemaVersion: 1,
    id: VERSION_ID,
    subjectId: SUBJECT_ID,
    subjectDisplayName: "Mira",
    generation: 1,
    materialSetHash: hashMaterialSet(items),
    materialCount: items.length,
    creation: {
      kind: "host_distill",
      briefContractDigest: contract.digest,
      promptVersion: contract.promptVersion,
      draftSchemaVersion: contract.draftSchemaVersion,
    },
    createdDisposition: "current",
    actor: { kind: "executor", id: "fixture" },
    quality,
    rendererVersion: "profile-renderer-v1",
    createdAt: NOW,
  } as const;
  const version = sealFact<VersionRecord>(versionPayload);
  const manifest = sealFact<VersionMaterialManifest>({ schemaVersion: 1, items });
  const claims = sealFact<VersionClaimsSnapshot>({
    schemaVersion: 1,
    subjectId: SUBJECT_ID,
    versionId: VERSION_ID,
    claims: [baselineClaim],
  });
  return { version, manifest, claims };
};

const contextInput = (baseline?: StoredVersion): BuildEvidenceContextInput => {
  const materials = baseline === undefined ? [first, second] : [second, first];
  const materialManifest = entriesFor(materials);
  const baselineIds = new Set(baseline?.manifest.items.map((entry) => entry.materialId) ?? []);
  const generation = baseline === undefined ? 1 : 2;
  const pending = {
    jobId: JOB_ID,
    generation,
    ...(baseline === undefined ? {} : { baseVersionId: VERSION_ID }),
    materialSetHash: hashMaterialSet(materialManifest),
    addedMaterialCount: materialManifest.filter((entry) => !baselineIds.has(entry.materialId))
      .length,
    totalMaterialCount: materialManifest.length,
    queuedAt: NOW,
    lease: {
      id: LEASE_ID,
      owner: LEASE_OWNER,
      acquiredAt: NOW,
      expiresAt: EXPIRES,
      contract,
    },
  } as const;
  const state = sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: SUBJECT_ID,
    generation,
    materialSetHash: pending.materialSetHash,
    materialManifest,
    ...(baseline === undefined ? {} : { currentVersionId: VERSION_ID }),
    pending,
  });
  return {
    subjectId: SUBJECT_ID,
    state,
    materials,
    ...(baseline === undefined ? {} : { baseline }),
    contract,
  };
};

describe("EvidenceContext reconstruction", () => {
  it("rebuilds m001.. refs from sorted fact manifests without any brief operation payload", () => {
    const context = buildEvidenceContext(contextInput());
    const orderedIds = [first.record.id, second.record.id].sort();
    expect([...context.byBriefRef.keys()]).toEqual([
      "m001" as BriefMaterialRef,
      "m002" as BriefMaterialRef,
    ]);
    expect([...context.byBriefRef.values()].map((record) => record.id)).toEqual(orderedIds);
    expect(context.baseClaims.size).toBe(0);
    expect(context.materialBodies.size).toBe(2);
    expect(context.grouping.sourceGroupingVersion).toBe("source-groups-v1");
  });

  it("reconstructs only the sorted manifest delta while retaining verified baseline evidence", () => {
    const context = buildEvidenceContext(contextInput(baselineVersion()));
    expect([...context.byBriefRef.entries()]).toEqual([
      ["m001" as BriefMaterialRef, second.record],
    ]);
    expect(context.baseClaims.get(baselineClaim.id)).toEqual(baselineClaim);
    expect(
      resolveEvidence(
        { kind: "baseline_evidence", claimId: baselineClaim.id, evidenceIndex: 0 },
        context,
      ),
    ).toEqual({ materialId: first.record.id, quote: "Mira" });
  });
});

describe("host evidence resolution", () => {
  it("uses Unicode scalar locators and canonicalizes the resolved patch", () => {
    const context = buildEvidenceContext(contextInput());
    const entry = [...context.byBriefRef].find(([, record]) => record.id === first.record.id)!;
    const patch: DistillPatch = {
      operations: [
        {
          op: "add",
          claim: {
            facet: "voice.examples" as FacetPath,
            text: "Mira uses a sprout marker.",
            evidence: [
              {
                kind: "brief_material",
                materialRef: entry[0],
                quote: "🌱 says",
                locator: { start: 5, end: 11 },
              },
              {
                kind: "brief_material",
                materialRef: entry[0],
                quote: "Mira",
              },
              {
                kind: "brief_material",
                materialRef: entry[0],
                quote: "Mira",
              },
            ],
            observedIn: ["访谈", "alpha", "访谈"],
          },
        },
      ],
      reviewRequest: { note: "Check attribution." },
      notes: "Host-only trace retained in accepted wire patch.",
    };
    expect(resolveHostPatch(patch, context)).toEqual({
      operations: [
        {
          op: "add",
          claim: {
            facet: "voice.examples",
            text: "Mira uses a sprout marker.",
            evidence: [
              { materialId: first.record.id, quote: "Mira" },
              {
                materialId: first.record.id,
                quote: "🌱 says",
                locator: { start: 5, end: 11 },
              },
            ],
            observedIn: ["alpha", "访谈"],
          },
        },
      ],
      reviewRequest: { note: "Check attribution." },
    });
  });

  it("rejects stale refs, altered quotes, UTF-16 offsets, and baseline index forgery", () => {
    const context = buildEvidenceContext(contextInput());
    const entry = [...context.byBriefRef].find(([, record]) => record.id === first.record.id)!;
    expect(() =>
      resolveEvidence(
        {
          kind: "brief_material",
          materialRef: "m999" as BriefMaterialRef,
          quote: "Mira",
        },
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "evidence_invalid" }));
    expect(() =>
      resolveEvidence(
        { kind: "brief_material", materialRef: entry[0], quote: "Mira says no" },
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "evidence_invalid" }));
    expect(() =>
      resolveEvidence(
        {
          kind: "brief_material",
          materialRef: entry[0],
          quote: "🌱 says",
          locator: { start: 5, end: 12 },
        },
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "evidence_invalid" }));
    expect(() =>
      resolveEvidence(
        {
          kind: "baseline_evidence",
          claimId: baselineClaim.id,
          evidenceIndex: 0,
        },
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "evidence_invalid" }));
  });

  it("reports patch target and date invalid_input before later evidence failures", () => {
    const context = buildEvidenceContext(contextInput(baselineVersion()));
    const staleEvidence = [
      {
        kind: "brief_material" as const,
        materialRef: "m999" as BriefMaterialRef,
        quote: "not present",
      },
    ];
    expect(() =>
      resolveHostPatch(
        {
          operations: [
            {
              op: "contest",
              claimId: `claim_${"9".repeat(64)}` as ClaimId,
              reason: "Invalid target must win.",
              evidence: staleEvidence,
            },
          ],
        },
        context,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_input",
        fieldPath: "patch.operations[0].claimId",
      }),
    );
    expect(() =>
      resolveHostPatch(
        {
          operations: [
            {
              op: "add",
              claim: {
                facet: "timeline.change" as FacetPath,
                text: "Invalid dates must win.",
                evidence: staleEvidence,
                validFrom: EXPIRES,
                validTo: NOW,
              },
            },
          ],
        },
        context,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_input",
        fieldPath: "patch.operations[0].claim.validTo",
      }),
    );
  });
});

describe("accepted patch byte boundary", () => {
  it("accepts exactly 65,536 canonical bytes and rejects 65,537", () => {
    const fixed = canonicalJsonBytes({ notes: "", operations: [] }).byteLength;
    const exactNotes = "x".repeat(MAX_ACCEPTED_PATCH_BYTES - fixed);
    const exact = {
      operations: [],
      notes: exactNotes,
    } as DistillPatch;
    const tooLarge = { ...exact, notes: `${exactNotes}x` } as DistillPatch;
    expect(validateAcceptedPatchBytes(exact)).toHaveLength(MAX_ACCEPTED_PATCH_BYTES);
    expect(() => validateAcceptedPatchBytes(tooLarge)).toThrowError(
      expect.objectContaining({ code: "invalid_input", fieldPath: "patch" }),
    );
  });

  it("runtime-rejects the relation placeholder even through an outdated typed caller", () => {
    const patch = { operations: [], relationOperations: [] } as unknown as DistillPatch;
    expect(() => validateAcceptedPatchBytes(patch)).toThrowError(
      expect.objectContaining({
        code: "invalid_input",
        fieldPath: "patch.relationOperations",
      }),
    );
  });
});
