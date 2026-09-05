import type {
  Claim,
  ClaimId,
  FacetPath,
  MaterialId,
  Profile,
  QualitySummary,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { diffProfiles } from "./diff.js";

const SUBJECT_ID = `subject_${"1".repeat(32)}` as SubjectId;
const OTHER_SUBJECT_ID = `subject_${"2".repeat(32)}` as SubjectId;
const MATERIAL_ID = `mat_${"a".repeat(64)}` as MaterialId;
const BEFORE_VERSION = `version_${"b".repeat(64)}` as VersionId;
const AFTER_VERSION = `version_${"c".repeat(64)}` as VersionId;

const quality = (activeClaimCount: number): QualitySummary => ({
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: activeClaimCount === 0 ? 0 : 1,
  diversityEligibleSourceGroupCount: activeClaimCount === 0 ? 0 : 1,
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
});

const claim = (digit: string, facet: string, text: string): Claim => ({
  id: `claim_${digit.repeat(64)}` as ClaimId,
  facet: facet as FacetPath,
  text,
  evidence: [{ materialId: MATERIAL_ID, quote: text }],
  status: "active",
  strength: "single_source",
  observedIn: [],
  createdIn: BEFORE_VERSION,
});

const profile = (
  versionId: VersionId,
  claims: readonly Claim[],
  subjectId: SubjectId = SUBJECT_ID,
): Profile => ({
  subjectId,
  displayName: "Mira",
  versionId,
  claims,
  core: {
    identity: "identity",
    voice: "voice",
    psyche: "psyche",
    relations: "relations",
    boundaries: "boundaries",
    texture: "texture",
    timeline: "timeline",
  },
  domains: {},
  rendered: "profile\n",
  quality: quality(claims.length),
});

describe("profile diff", () => {
  it("represents a first suspended candidate without inventing before quality", () => {
    const identity = claim("2", "identity.name", "Mira");
    const voice = claim("1", "voice.examples", "A short example");
    const result = diffProfiles(undefined, profile(AFTER_VERSION, [identity, voice]));

    expect(result).toEqual({
      added: [voice, identity],
      removed: [],
      changed: [],
      changedFacets: ["identity.name", "voice.examples"],
      afterQuality: quality(2),
    });
    expect(result).not.toHaveProperty("beforeQuality");
  });

  it("separates id-set changes from same-id canonical claim changes", () => {
    const unchanged = claim("1", "identity.name", "Mira");
    const removed = claim("2", "voice.examples", "Old example");
    const previousChanged = claim("3", "work.craft", "Paper first");
    const nextChanged = {
      ...previousChanged,
      evidence: [{ materialId: MATERIAL_ID, quote: "Paper, then code" }],
      status: "contested",
      strength: "contested",
    } as const satisfies Claim;
    const added = claim("4", "texture.habits", "Draws diagrams");

    const result = diffProfiles(
      profile(BEFORE_VERSION, [unchanged, removed, previousChanged]),
      profile(AFTER_VERSION, [unchanged, nextChanged, added]),
    );

    expect(result.added).toEqual([added]);
    expect(result.removed).toEqual([removed]);
    expect(result.changed).toEqual([{ before: previousChanged, after: nextChanged }]);
    expect(result.changedFacets).toEqual(["texture.habits", "voice.examples", "work.craft"]);
    expect(result.beforeQuality).toEqual(quality(3));
    expect(result.afterQuality).toEqual(quality(3));
  });

  it("fails closed when verified profiles belong to different subjects", () => {
    expect(() =>
      diffProfiles(profile(BEFORE_VERSION, []), profile(AFTER_VERSION, [], OTHER_SUBJECT_ID)),
    ).toThrowError(expect.objectContaining({ code: "storage_corrupt" }));
  });
});
