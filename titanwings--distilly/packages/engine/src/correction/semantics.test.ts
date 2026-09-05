import type {
  Claim,
  ClaimId,
  FacetPath,
  MaterialId,
  QualitySummary,
  SourceGroupKey,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { applyCorrectionReplacement } from "../profile/apply-patch.js";
import { canonicalizeResolvedClaimDraft, deriveClaimId } from "../profile/claim-id.js";
import { strengthenCorrectionClaims, type MaterialEvidenceIndex } from "../profile/quality.js";
import { evaluateCorrectionReviewReasons } from "../profile/review-gate.js";

const SUBJECT_ID = `subject_${"1".repeat(32)}` as SubjectId;
const VERSION_ID = `version_${"2".repeat(64)}` as VersionId;
const M1 = `mat_${"1".repeat(64)}` as MaterialId;
const M2 = `mat_${"2".repeat(64)}` as MaterialId;

const claim = (
  id: ClaimId,
  facet: FacetPath,
  materialId: MaterialId,
  overrides: Partial<Claim> = {},
): Claim => ({
  id,
  facet,
  text: `claim ${id.slice(-1)}`,
  evidence: [{ materialId, quote: "evidence" }],
  status: "active",
  strength: "single_source",
  observedIn: [],
  createdIn: VERSION_ID,
  ...overrides,
});

const index: MaterialEvidenceIndex = {
  sourceGroupingVersion: "source-groups-v1",
  byMaterial: new Map([
    [
      M1,
      {
        materialId: M1,
        sourceGroup: {
          key: `sg_${"1".repeat(64)}` as SourceGroupKey,
          bases: ["canonical_uri"],
          diversityStatus: "eligible",
          cautions: [],
        },
        derivation: { kind: "native_text" },
        kind: "web",
        flags: [],
      },
    ],
    [
      M2,
      {
        materialId: M2,
        sourceGroup: {
          key: `sg_${"2".repeat(64)}` as SourceGroupKey,
          bases: ["unknown"],
          diversityStatus: "ineligible",
          cautions: ["correction"],
        },
        derivation: { kind: "native_text" },
        kind: "correction",
        flags: [],
      },
    ],
  ]),
};

const quality = (overrides: Partial<QualitySummary> = {}): QualitySummary => ({
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
  ...overrides,
});

describe("correction claim and review semantics", () => {
  it("creates one full-body user-asserted replacement and preserves target fields", () => {
    const targetId = `claim_${"a".repeat(64)}` as ClaimId;
    const untouchedId = `claim_${"b".repeat(64)}` as ClaimId;
    const base = [
      claim(targetId, "identity.name" as FacetPath, M1),
      claim(untouchedId, "voice.example" as FacetPath, M1),
    ];
    const replacement = {
      facet: "identity.name" as FacetPath,
      text: "Corrected identity",
      evidence: [
        {
          materialId: M2,
          quote: "Corrected identity",
          locator: { start: 0, end: 18 },
        },
      ] as const,
      observedIn: [] as const,
      supersedes: [targetId],
    };
    const replacementId = deriveClaimId(SUBJECT_ID, canonicalizeResolvedClaimDraft(replacement));
    const provisional = applyCorrectionReplacement(SUBJECT_ID, base, replacement);
    const strengthened = strengthenCorrectionClaims(provisional, index);

    expect(strengthened.find(({ id }) => id === targetId)).toMatchObject({
      status: "superseded",
      supersededBy: replacementId,
      text: base[0]!.text,
      strength: "single_source",
    });
    expect(strengthened.find(({ id }) => id === untouchedId)).toMatchObject({ status: "active" });
    expect(strengthened.find(({ id }) => id === replacementId)).toMatchObject({
      status: "active",
      strength: "user_asserted",
      evidence: replacement.evidence,
    });
  });

  it("rejects missing, already-superseded, duplicate-replacement, and duplicate targets", () => {
    const targetId = `claim_${"a".repeat(64)}` as ClaimId;
    const base = [claim(targetId, "identity.name" as FacetPath, M1)];
    const replacement = {
      facet: "identity.name" as FacetPath,
      text: "Corrected identity",
      evidence: [{ materialId: M2, quote: "Corrected identity" }] as const,
      observedIn: [] as const,
      supersedes: [targetId],
    };
    expect(() =>
      applyCorrectionReplacement(SUBJECT_ID, base, {
        ...replacement,
        supersedes: [`claim_${"f".repeat(64)}` as ClaimId],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      applyCorrectionReplacement(SUBJECT_ID, [{ ...base[0]!, status: "superseded" }], replacement),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      applyCorrectionReplacement(SUBJECT_ID, base, {
        ...replacement,
        supersedes: [targetId, targetId],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    const duplicateId = deriveClaimId(SUBJECT_ID, canonicalizeResolvedClaimDraft(replacement));
    expect(() =>
      applyCorrectionReplacement(
        SUBJECT_ID,
        [...base, claim(duplicateId, replacement.facet, M2)],
        replacement,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("orders correction conflict before diversity and relayed provenance reasons", () => {
    const identityId = `claim_${"a".repeat(64)}` as ClaimId;
    const voiceId = `claim_${"b".repeat(64)}` as ClaimId;
    const beforeClaims = [
      claim(identityId, "identity.name" as FacetPath, M1),
      claim(voiceId, "voice.example" as FacetPath, M1),
    ];
    const afterClaims = [
      { ...beforeClaims[0]!, status: "superseded" as const },
      { ...beforeClaims[1]!, status: "superseded" as const },
      claim(`claim_${"c".repeat(64)}` as ClaimId, "psyche.values" as FacetPath, M2),
    ];
    expect(
      evaluateCorrectionReviewReasons({
        before: {
          claims: beforeClaims,
          quality: quality({ coveredCoreFacets: ["identity", "voice"] }),
        },
        after: {
          claims: afterClaims,
          quality: quality({
            coveredCoreFacets: ["psyche"],
            diversityEligibleSourceGroupCount: 0,
          }),
        },
        materials: index,
        supersedes: [identityId, voiceId],
        relayedActorKind: "host",
      }),
    ).toEqual([
      { code: "identity_changed", claimIds: [identityId] },
      { code: "coverage_decreased", facets: ["identity", "voice"] },
      { code: "voice_examples_removed", claimIds: [voiceId] },
      { code: "correction_conflict", claimIds: [identityId, voiceId] },
      { code: "source_diversity_decreased" },
      { code: "relayed_correction", actorKind: "host" },
    ]);
  });
});
