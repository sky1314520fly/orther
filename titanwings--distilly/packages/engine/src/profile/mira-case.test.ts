import type {
  BriefContractDigest,
  Claim,
  ClaimId,
  FacetPath,
  MaterialId,
  MaterialSetHash,
  SourceGroup,
  SourceGroupKey,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../facts/checksum.js";
import { applyClaimPatch, finalizeClaims } from "./apply-patch.js";
import type { MaterialEvidenceIndex } from "./quality.js";
import { strengthenClaims, summarizeQuality } from "./quality.js";
import { PROFILE_RENDERER_VERSION, renderProfile, renderPrompt } from "./render.js";
import { evaluateHostReviewReasons } from "./review-gate.js";
import { deriveVersionId, type VersionIdentityPayload } from "./version-id.js";

const SUBJECT_ID = `subject_${"a".repeat(32)}` as SubjectId;
const OLD_VERSION = `version_${"b".repeat(64)}` as VersionId;
const materialId = (digit: string): MaterialId => `mat_${digit.repeat(64)}` as MaterialId;
const MIRA_SITE = materialId("1");
const INTERVIEW = materialId("2");
const NOTEBOOK = materialId("3");

const eligibleGroup = (digit: string): SourceGroup => ({
  key: `sg_${digit.repeat(64)}` as SourceGroupKey,
  bases: ["canonical_uri"],
  diversityStatus: "eligible",
  cautions: [],
});

const evidenceIndex: MaterialEvidenceIndex = {
  sourceGroupingVersion: "source-groups-v1",
  byMaterial: new Map([
    [
      MIRA_SITE,
      {
        materialId: MIRA_SITE,
        sourceGroup: eligibleGroup("1"),
        sourceRole: "first_party_expression",
        derivation: { kind: "native_text" },
        kind: "web",
        flags: [],
      },
    ],
    [
      INTERVIEW,
      {
        materialId: INTERVIEW,
        sourceGroup: eligibleGroup("2"),
        sourceRole: "interview",
        derivation: { kind: "native_text" },
        kind: "transcript",
        flags: [],
      },
    ],
    [
      NOTEBOOK,
      {
        materialId: NOTEBOOK,
        sourceGroup: eligibleGroup("3"),
        sourceRole: "first_party_expression",
        derivation: { kind: "native_text" },
        kind: "document",
        flags: ["suspicious_source"],
      },
    ],
  ]),
};

const baseClaims: readonly Claim[] = [
  {
    id: `claim_${"1".repeat(64)}` as ClaimId,
    facet: "identity.name" as FacetPath,
    text: "The subject presents herself as Mira Lin.",
    evidence: [{ materialId: MIRA_SITE, quote: "Mira Lin" }],
    status: "active",
    strength: "single_source",
    observedIn: ["official site"],
    createdIn: OLD_VERSION,
  },
  {
    id: `claim_${"2".repeat(64)}` as ClaimId,
    facet: "voice.examples" as FacetPath,
    text: "Mira usually opens explanations with a concrete example.",
    evidence: [{ materialId: INTERVIEW, quote: "Let me start with a concrete example" }],
    status: "active",
    strength: "single_source",
    observedIn: ["2025 interview"],
    createdIn: OLD_VERSION,
  },
];

describe("realistic synthetic Mira distillation", () => {
  it("runs the sentinel-free pure pipeline into a suspended deterministic profile", () => {
    const patch = {
      operations: [
        {
          op: "add" as const,
          claim: {
            facet: "psyche.decision_style" as FacetPath,
            text: "Mira externalizes uncertain ideas as small physical prototypes.",
            evidence: [
              { materialId: INTERVIEW, quote: "I make a tiny paper version first" },
              { materialId: NOTEBOOK, quote: "paper prototype before committing" },
            ],
            observedIn: ["field notebook", "studio interview"],
          },
        },
        {
          op: "contest" as const,
          claimId: baseClaims[1]!.id,
          reason: "A later notebook shows a different opening pattern.",
          evidence: [{ materialId: NOTEBOOK, quote: "I often begin with the constraint" }],
        },
      ],
      reviewRequest: { note: "Confirm that the notebook is Mira's." },
    };

    const applied = applyClaimPatch(SUBJECT_ID, baseClaims, patch);
    const strengthened = strengthenClaims(applied, evidenceIndex);
    const beforeQuality = summarizeQuality(baseClaims, evidenceIndex);
    const afterQuality = summarizeQuality(strengthened, evidenceIndex);
    const reasons = evaluateHostReviewReasons({
      before: { claims: baseClaims, quality: beforeQuality },
      after: { claims: strengthened, quality: afterQuality },
      materials: evidenceIndex,
      reviewRequest: patch.reviewRequest,
    });
    expect(afterQuality).toMatchObject({
      activeClaimCount: 2,
      contestedClaimCount: 1,
      corroboratedClaimCount: 1,
      coveredCoreFacets: ["identity", "psyche"],
      maturity: "sparse",
    });
    expect(reasons).toEqual([
      { code: "coverage_decreased", facets: ["voice" as FacetPath] },
      { code: "voice_examples_removed", claimIds: [baseClaims[1]!.id] },
      { code: "new_contested_claims", claimIds: [baseClaims[1]!.id] },
      { code: "suspicious_source", materialIds: [NOTEBOOK] },
      { code: "manual_review_requested", note: "Confirm that the notebook is Mira's." },
    ]);
    const [firstReason, ...otherReasons] = reasons;
    if (firstReason === undefined) throw new Error("Mira fixture must suspend.");

    const identity: VersionIdentityPayload = {
      subjectId: SUBJECT_ID,
      subjectDisplayName: "Mira Lin",
      generation: 2,
      materialSetHash: `set_sha256_${"c".repeat(64)}` as MaterialSetHash,
      parentId: OLD_VERSION,
      creation: {
        kind: "host_distill",
        briefContractDigest: `brief_contract_${"d".repeat(64)}` as BriefContractDigest,
        promptVersion: `host-distill-v1-sha256_${"e".repeat(64)}`,
        draftSchemaVersion: 1,
      },
      actor: { kind: "executor", id: "mira-fixture" },
      createdDisposition: "suspended",
      rendererVersion: PROFILE_RENDERER_VERSION,
      reviewReasons: [firstReason, ...otherReasons],
      quality: afterQuality,
    };
    const versionId = deriveVersionId(identity, strengthened);
    const finalized = finalizeClaims(strengthened, versionId);
    const artifacts = renderProfile({
      subjectId: SUBJECT_ID,
      displayName: identity.subjectDisplayName,
      versionId,
      claims: finalized,
      quality: afterQuality,
    });
    const prompt = renderPrompt({
      subjectId: SUBJECT_ID,
      displayName: identity.subjectDisplayName,
      versionId,
      claims: finalized,
      quality: afterQuality,
      core: artifacts.core,
      domains: artifacts.domains,
      rendered: artifacts.markdown,
    });

    expect(versionId).toBe(
      "version_4767279f1c648425f4b6033138297e09841cdbd99a59d62e28e6db3c61b0c2d0",
    );
    expect(finalized.find((item) => item.id === baseClaims[0]!.id)?.createdIn).toBe(OLD_VERSION);
    expect(finalized.find((item) => item.id === baseClaims[1]!.id)).toMatchObject({
      createdIn: OLD_VERSION,
      status: "contested",
      strength: "contested",
    });
    expect(
      finalized.find((item) => !baseClaims.some((base) => base.id === item.id))?.createdIn,
    ).toBe(versionId);
    expect(artifacts.core.voice).toContain("## Contested claims");
    expect(artifacts.core.voice.includes("A later notebook")).toBe(false);
    expect(prompt).toContain("Mira Lin");
    expect(sha256Hex(prompt)).toBe(
      "34cc704fe9c031faf6f7c92301d87f3b015b6e68547019e2059fda8b0947fe2d",
    );
  });
});
