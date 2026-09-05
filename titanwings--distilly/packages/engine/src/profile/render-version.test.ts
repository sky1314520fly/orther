import type {
  BriefContractDigest,
  Claim,
  ClaimId,
  FacetPath,
  MaterialId,
  MaterialSetHash,
  QualitySummary,
  ReviewReason,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../facts/checksum.js";
import {
  PROFILE_RENDERER_VERSION,
  renderFacet,
  renderProfile,
  renderPrompt,
  type VersionedProfile,
} from "./render.js";
import {
  createVersionIdPreimage,
  deriveVersionId,
  type VersionIdentityPayload,
} from "./version-id.js";

const SUBJECT_ID = `subject_${"a".repeat(32)}` as SubjectId;
const MATERIAL_ID = `mat_${"b".repeat(64)}` as MaterialId;
const OLD_VERSION = `version_${"c".repeat(64)}` as VersionId;
const OTHER_VERSION = `version_${"d".repeat(64)}` as VersionId;
const MATERIAL_SET_HASH = `set_sha256_${"e".repeat(64)}` as MaterialSetHash;
const claimId = (digit: string): ClaimId => `claim_${digit.repeat(64)}` as ClaimId;
const indexedClaimId = (index: number): ClaimId =>
  `claim_${index.toString(16).padStart(64, "0")}` as ClaimId;

const quality: QualitySummary = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 2,
  contestedClaimCount: 1,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 1,
  diversityEligibleSourceGroupCount: 1,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: ["identity"],
  uncoveredCoreFacets: ["voice", "psyche", "relations", "boundaries", "texture", "timeline"],
  maturity: "sparse",
};

const claim = (overrides: Partial<Claim> & Pick<Claim, "id" | "facet" | "text">): Claim => ({
  evidence: [{ materialId: MATERIAL_ID, quote: "exact quote" }],
  status: "active",
  strength: "single_source",
  observedIn: [],
  createdIn: OLD_VERSION,
  ...overrides,
});

const claims: readonly Claim[] = [
  claim({
    id: claimId("2"),
    facet: "identity.name" as FacetPath,
    text: "Mira says:\n# forged heading\n```html\n<b>not markup</b>\n``` 🌱",
    observedIn: ["public profile", "访谈"],
  }),
  claim({
    id: claimId("1"),
    facet: "identity.alias" as FacetPath,
    text: "The alias is contested.",
    status: "contested",
    strength: "contested",
  }),
  claim({
    id: claimId("3"),
    facet: "work.craft" as FacetPath,
    text: "Mira prototypes with paper before code.",
  }),
  claim({
    id: claimId("4"),
    facet: "zine.archive" as FacetPath,
    text: "Superseded domain detail.",
    status: "superseded",
  }),
];

describe("profile-renderer-v1", () => {
  it("renders exact canonical JSON records without allowing hostile Markdown structure", () => {
    const identity = renderFacet("identity.name" as FacetPath, claims);
    expect(identity).toBe(
      `# core.identity\n\n## Active claims\n\n    [{"facet":"identity.name","id":"${claimId("2")}","observedIn":["public profile","访谈"],"strength":"single_source","text":"Mira says:\\n# forged heading\\n\`\`\`html\\n<b>not markup</b>\\n\`\`\` 🌱"}]\n\n## Contested claims\n\n    [{"facet":"identity.alias","id":"${claimId("1")}","observedIn":[],"strength":"contested","text":"The alias is contested."}]\n`,
    );
    expect(identity.match(/^# /gm)).toHaveLength(1);
    expect(identity.match(/^## /gm)).toHaveLength(2);
    expect(identity.endsWith("\n")).toBe(true);
    expect(identity.endsWith("\n\n")).toBe(false);
  });

  it("renders seven ordered core files, sorted non-empty domains, and stable combined bytes", () => {
    const rendered = renderProfile({
      subjectId: SUBJECT_ID,
      displayName: "Mira 林",
      versionId: OTHER_VERSION,
      claims,
      quality,
    });
    expect(Object.keys(rendered.core)).toEqual([
      "identity",
      "voice",
      "psyche",
      "relations",
      "boundaries",
      "texture",
      "timeline",
    ]);
    expect(Object.keys(rendered.domains)).toEqual(["work"]);
    expect(rendered.domains.work).toBe(
      `# domain.work\n\n## Active claims\n\n    [{"facet":"work.craft","id":"${claimId("3")}","observedIn":[],"strength":"single_source","text":"Mira prototypes with paper before code."}]\n\n## Contested claims\n\n    []\n`,
    );
    for (const artifact of [
      ...Object.values(rendered.core),
      ...Object.values(rendered.domains),
      rendered.markdown,
    ]) {
      expect(artifact.endsWith("\n")).toBe(true);
      expect(artifact.endsWith("\n\n")).toBe(false);
      expect(artifact.includes("\r")).toBe(false);
    }
    expect(sha256Hex(rendered.markdown)).toBe(
      "02a415753006b8ff8a89693158795bedf46c99420c2b904f1667b703cd99caac",
    );
  });

  it("reads every live facet once while rendering many domain sections", () => {
    let facetReads = 0;
    const domainClaims = Array.from({ length: 64 }, (_, index) => {
      const contested = index % 2 === 1;
      const item = claim({
        id: indexedClaimId(index),
        facet: `domain${index}.fact` as FacetPath,
        text: `Domain fact ${index}`,
        ...(contested ? { status: "contested", strength: "contested" } : {}),
      });
      const facet = item.facet;
      return Object.defineProperty(item, "facet", {
        enumerable: true,
        get(): FacetPath {
          facetReads += 1;
          return facet;
        },
      });
    });

    const rendered = renderProfile({
      subjectId: SUBJECT_ID,
      displayName: "Mira 林",
      versionId: OTHER_VERSION,
      claims: domainClaims,
      quality,
    });

    expect(Object.keys(rendered.domains)).toHaveLength(domainClaims.length);
    expect(facetReads).toBe(domainClaims.length);
  });

  it("renders exact version-time metadata and the immutable behavior suffix", () => {
    const rendered = renderProfile({
      subjectId: SUBJECT_ID,
      displayName: "Mira 林",
      versionId: OTHER_VERSION,
      claims,
      quality,
    });
    const profile: VersionedProfile = {
      subjectId: SUBJECT_ID,
      displayName: "Mira 林",
      versionId: OTHER_VERSION,
      claims,
      quality,
      core: rendered.core,
      domains: rendered.domains,
      rendered: rendered.markdown,
    };
    const prompt = renderPrompt(profile);
    expect(prompt).toContain(
      `    {"displayName":"Mira 林","maturity":"sparse","subjectId":"${SUBJECT_ID}","versionId":"${OTHER_VERSION}"}\n\n# Distilly profile`,
    );
    expect(prompt).toContain("<b>not markup</b>");
    expect(prompt.endsWith("\n")).toBe(true);
    expect(prompt.endsWith("\n\n")).toBe(false);
    expect(sha256Hex(prompt)).toBe(
      "26859a1db0fd929ad9b9a734e14233b66a04fd6ee8e9359cd9ed2981f23f9bcb",
    );
  });
});

describe("VersionId canonical preimage", () => {
  const reviewReasons = [
    { code: "manual_review_requested", note: "Check this." },
  ] as const satisfies readonly [ReviewReason, ...ReviewReason[]];
  const payload: VersionIdentityPayload = {
    subjectId: SUBJECT_ID,
    subjectDisplayName: "Mira 林",
    generation: 3,
    materialSetHash: MATERIAL_SET_HASH,
    parentId: OLD_VERSION,
    creation: {
      kind: "host_distill",
      briefContractDigest: `brief_contract_${"f".repeat(64)}` as BriefContractDigest,
      promptVersion: `host-distill-v1-sha256_${"0".repeat(64)}`,
      draftSchemaVersion: 1,
    },
    actor: { kind: "executor", id: "fixture-executor" },
    createdDisposition: "suspended",
    rendererVersion: PROFILE_RENDERER_VERSION,
    reviewReasons,
    quality,
  };

  it("deletes all createdIn and provisional provenance before one un-namespaced golden hash", () => {
    const provisional = claims.map((item) => ({ ...item, provenance: "base" as const }));
    const preimage = createVersionIdPreimage(payload, provisional);
    expect(preimage.claims.every((item) => !("createdIn" in item))).toBe(true);
    expect(preimage.claims.every((item) => !("provenance" in item))).toBe(true);
    expect(preimage.claims.map((item) => item.id)).toEqual([
      claimId("1"),
      claimId("2"),
      claimId("3"),
      claimId("4"),
    ]);
    expect(deriveVersionId(payload, provisional)).toBe(
      "version_27a5130e3377f2079d13d03ea0ca649542547bd5414b56fa8dcad6701309b461",
    );
  });

  it("ignores createdIn changes but covers name, reasons, and other semantic claim fields", () => {
    const changedLineage = claims.map((item) => ({ ...item, createdIn: OTHER_VERSION }));
    const baseline = deriveVersionId(payload, claims);
    expect(deriveVersionId(payload, changedLineage)).toBe(baseline);
    expect(deriveVersionId({ ...payload, subjectDisplayName: "Mira Renamed" }, claims)).not.toBe(
      baseline,
    );
    const { reviewReasons: _reviewReasons, ...withoutReviewReasons } = payload;
    void _reviewReasons;
    expect(deriveVersionId(withoutReviewReasons, claims)).not.toBe(baseline);
    expect(
      deriveVersionId(
        payload,
        claims.map((item) =>
          item.id === claimId("3") ? { ...item, text: `${item.text} Changed.` } : item,
        ),
      ),
    ).not.toBe(baseline);
  });
});
