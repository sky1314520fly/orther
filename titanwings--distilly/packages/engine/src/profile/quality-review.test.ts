import type {
  Claim,
  ClaimId,
  IsoDateTime,
  FacetPath,
  MaterialId,
  MaterialRecord,
  MaterialSource,
  QualitySummary,
  SourceGroup,
  SourceGroupKey,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { sealFact } from "../facts/checksum.js";
import { deriveMaterialId, digestContent, digestProvenance } from "../facts/digests.js";
import { evaluateHostReviewReasons } from "./review-gate.js";
import {
  buildMaterialEvidenceIndex,
  deriveEvidenceStrength,
  strengthenClaims,
  summarizeQuality,
  type MaterialEvidenceFacts,
  type MaterialEvidenceIndex,
} from "./quality.js";

const VERSION_ID = `version_${"1".repeat(64)}` as VersionId;
const SUBJECT_ID = `subject_${"9".repeat(32)}` as SubjectId;
const NOW = "2026-08-21T00:00:00.000Z" as IsoDateTime;
const materialId = (digit: string): MaterialId => `mat_${digit.repeat(64)}` as MaterialId;
const claimId = (digit: string): ClaimId => `claim_${digit.repeat(64)}` as ClaimId;
const M1 = materialId("1");
const M2 = materialId("2");
const M3 = materialId("3");
const M4 = materialId("4");
const M5 = materialId("5");

const group = (digit: string, diversityStatus: SourceGroup["diversityStatus"]): SourceGroup => ({
  key: `sg_${digit.repeat(64)}` as SourceGroupKey,
  bases: ["canonical_uri"],
  diversityStatus,
  cautions: diversityStatus === "eligible" ? [] : ["insufficient_public_proof"],
});

const G1 = group("1", "eligible");
const G2 = group("2", "eligible");
const G3 = group("3", "unknown");
const G4 = group("4", "ineligible");

const materialFacts = (
  materialIdValue: MaterialId,
  sourceGroup: SourceGroup,
  suspicious = false,
): MaterialEvidenceFacts => ({
  materialId: materialIdValue,
  sourceGroup,
  sourceRole: "first_party_expression",
  derivation: { kind: "native_text" },
  kind: "web",
  flags: suspicious ? ["suspicious_source"] : [],
});

const index = (suspicious = false): MaterialEvidenceIndex => ({
  sourceGroupingVersion: "source-groups-v1",
  byMaterial: new Map([
    [M1, materialFacts(M1, G1)],
    [M2, materialFacts(M2, G2)],
    [M3, materialFacts(M3, G3)],
    [M4, materialFacts(M4, G4)],
    [M5, materialFacts(M5, G2, suspicious)],
  ]),
});

const claim = (
  digit: string,
  facet: string,
  materials: readonly MaterialId[],
  overrides: Partial<Claim> = {},
): Claim => ({
  id: claimId(digit),
  facet: facet as FacetPath,
  text: `Claim ${digit}`,
  evidence: materials.map((id) => ({ materialId: id, quote: `quote ${id.slice(-1)}` })),
  status: "active",
  strength: "single_source",
  observedIn: [],
  createdIn: VERSION_ID,
  ...overrides,
});

const quality = (overrides: Partial<QualitySummary> = {}): QualitySummary => ({
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 0,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 0,
  diversityEligibleSourceGroupCount: 0,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: [],
  uncoveredCoreFacets: [
    "identity",
    "voice",
    "psyche",
    "relations",
    "boundaries",
    "texture",
    "timeline",
  ],
  maturity: "sparse",
  ...overrides,
});

describe("source-group-backed quality", () => {
  it("builds an exact material index and rejects incomplete grouping snapshots", () => {
    const record = (label: string): MaterialRecord => {
      const content = `Material ${label}`;
      const materialSource: MaterialSource = {
        uri: `https://example.com/${label}`,
        medium: "article",
        access: "public",
        role: "reference",
        capturedAt: NOW,
        authors: [],
      };
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
      const sourceIdentity = `quality-fixture-v1:${label}`;
      return sealFact<MaterialRecord>({
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
      });
    };
    const records = [record("one"), record("two")];
    const [recordOne, recordTwo] = records;
    if (recordOne === undefined || recordTwo === undefined) throw new Error("fixture records");
    const built = buildMaterialEvidenceIndex(records, {
      sourceGroupingVersion: "source-groups-v1",
      groups: new Map([
        [recordOne.id, G1],
        [recordTwo.id, G2],
      ]),
    });
    expect(built.byMaterial.get(recordOne.id)).toMatchObject({
      materialId: recordOne.id,
      sourceGroup: G1,
    });
    expect(() =>
      buildMaterialEvidenceIndex(records, {
        sourceGroupingVersion: "source-groups-v1",
        groups: new Map([[recordOne.id, G1]]),
      }),
    ).toThrowError(expect.objectContaining({ code: "storage_corrupt" }));
  });

  it("retains provenance strengths and mechanically recomputes all other active claims", () => {
    const user = claim("1", "identity.name", [M1], { strength: "user_asserted" });
    const imported = claim("2", "voice.example", [M1], {
      strength: "imported_unverified",
    });
    const corroborated = claim("3", "psyche.values", [M1, M2]);
    const contested = claim("4", "timeline.change", [M1], {
      status: "contested",
      strength: "single_source",
    });
    const superseded = claim("5", "relations.team", [M1, M2], {
      status: "superseded",
      strength: "single_source",
    });

    expect(deriveEvidenceStrength(user, index())).toBe("user_asserted");
    expect(deriveEvidenceStrength(imported, index())).toBe("imported_unverified");
    expect(deriveEvidenceStrength(corroborated, index())).toBe("corroborated");
    expect(deriveEvidenceStrength(contested, index())).toBe("contested");
    expect(deriveEvidenceStrength(superseded, index())).toBe("single_source");

    const strengthened = strengthenClaims(
      [
        { ...user, provenance: "base" },
        {
          provenance: "candidate",
          id: claimId("6"),
          facet: "boundaries.refusal" as FacetPath,
          text: "Candidate",
          evidence: [
            { materialId: M1, quote: "one" },
            { materialId: M2, quote: "two" },
          ],
          status: "active",
          observedIn: [],
        },
      ],
      index(),
    );
    expect(strengthened.map(({ id, strength }) => ({ id, strength }))).toEqual([
      { id: claimId("1"), strength: "user_asserted" },
      { id: claimId("6"), strength: "corroborated" },
    ]);
  });

  it("counts only cited active/contested groups and derives sparse/forming/stable exactly", () => {
    const claims = [
      claim("1", "identity.name", [M1]),
      claim("2", "voice.example", [M1, M2], { strength: "corroborated" }),
      claim("3", "psyche.values", [M3]),
      claim("4", "relations.team", [M4]),
      claim("5", "boundaries.refusal", [M4], { strength: "user_asserted" }),
      claim("6", "timeline.change", [M2], {
        status: "contested",
        strength: "contested",
      }),
      claim("7", "texture.detail", [M5], { status: "superseded" }),
    ];
    expect(summarizeQuality(claims, index())).toEqual({
      sourceGroupingVersion: "source-groups-v1",
      activeClaimCount: 5,
      contestedClaimCount: 1,
      userAssertedClaimCount: 1,
      corroboratedClaimCount: 1,
      sourceGroupCount: 4,
      diversityEligibleSourceGroupCount: 2,
      unknownSourceGroupCount: 1,
      coveredCoreFacets: ["identity", "voice", "psyche", "relations", "boundaries"],
      uncoveredCoreFacets: ["texture", "timeline"],
      maturity: "forming",
    });
    expect(
      summarizeQuality(
        claims.map((item) =>
          item.id === claimId("6") ? { ...item, status: "superseded" as const } : item,
        ),
        index(),
      ).maturity,
    ).toBe("stable");
    expect(summarizeQuality([claim("1", "identity.name", [M1])], index()).maturity).toBe("sparse");
  });
});

describe("host review gate", () => {
  it("emits each mechanical reason once in exact code order with canonical inner arrays", () => {
    const beforeClaims = [
      claim("2", "identity.name", [M1]),
      claim("3", "voice.example", [M2]),
      claim("4", "psyche.values", [M3]),
      claim("8", "timeline.change", [M4], {
        status: "contested",
        strength: "contested",
      }),
    ];
    const afterClaims = [
      claim("2", "identity.name", [M1], {
        status: "contested",
        strength: "contested",
      }),
      claim("3", "voice.example", [M2], { status: "superseded" }),
      claim("4", "psyche.values", [M3, M5]),
      claim("8", "timeline.change", [M4], {
        status: "contested",
        strength: "contested",
      }),
      claim("1", "work.mode", [M5], {
        status: "contested",
        strength: "contested",
      }),
    ];
    const reasons = evaluateHostReviewReasons({
      before: {
        claims: beforeClaims,
        quality: quality({
          coveredCoreFacets: ["identity", "voice", "psyche"],
          uncoveredCoreFacets: ["relations", "boundaries", "texture", "timeline"],
          diversityEligibleSourceGroupCount: 2,
        }),
      },
      after: {
        claims: afterClaims,
        quality: quality({
          coveredCoreFacets: ["psyche"],
          uncoveredCoreFacets: [
            "identity",
            "voice",
            "relations",
            "boundaries",
            "texture",
            "timeline",
          ],
          diversityEligibleSourceGroupCount: 1,
        }),
      },
      materials: index(true),
      reviewRequest: { note: "Please verify identity." },
    });

    expect(reasons).toEqual([
      { code: "identity_changed", claimIds: [claimId("2")] },
      {
        code: "coverage_decreased",
        facets: ["identity" as FacetPath, "voice" as FacetPath],
      },
      { code: "voice_examples_removed", claimIds: [claimId("3")] },
      { code: "new_contested_claims", claimIds: [claimId("1"), claimId("2")] },
      { code: "source_diversity_decreased" },
      { code: "suspicious_source", materialIds: [M5] },
      { code: "manual_review_requested", note: "Please verify identity." },
    ]);
  });

  it("skips delta reasons for a first version but still catches suspicious and manual review", () => {
    const newClaim = claim("1", "identity.name", [M5]);
    expect(
      evaluateHostReviewReasons({
        after: { claims: [newClaim], quality: quality() },
        materials: index(true),
        reviewRequest: {},
      }),
    ).toEqual([
      { code: "suspicious_source", materialIds: [M5] },
      { code: "manual_review_requested" },
    ]);
  });
});
