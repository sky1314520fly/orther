import type {
  Claim,
  ClaimId,
  EvidenceRef,
  FacetPath,
  IsoDateTime,
  MaterialId,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { applyClaimPatch, finalizeClaims, type StrengthenedClaim } from "./apply-patch.js";
import {
  canonicalizeResolvedClaimDraft,
  deriveClaimId,
  type ResolvedClaimDraft,
} from "./claim-id.js";

const SUBJECT_ID = `subject_${"1".repeat(32)}` as SubjectId;
const MATERIAL_A = `mat_${"a".repeat(64)}` as MaterialId;
const MATERIAL_B = `mat_${"b".repeat(64)}` as MaterialId;
const OLD_VERSION = `version_${"c".repeat(64)}` as VersionId;
const NEW_VERSION = `version_${"d".repeat(64)}` as VersionId;
const VALID_FROM = "2025-01-02T03:04:05.006Z" as IsoDateTime;
const VALID_TO = "2026-01-02T03:04:05.006Z" as IsoDateTime;

const evidence = (materialId: MaterialId, quote: string): EvidenceRef => ({ materialId, quote });

const resolvedDraft = (overrides: Partial<ResolvedClaimDraft> = {}): ResolvedClaimDraft => ({
  facet: "voice.examples" as FacetPath,
  text: "Mira answers with a short concrete example.",
  evidence: [evidence(MATERIAL_A, "short concrete example")],
  observedIn: ["interview"],
  ...overrides,
});

const baseClaim = (digit: string, overrides: Partial<Claim> = {}): Claim => ({
  id: `claim_${digit.repeat(64)}` as ClaimId,
  facet: "voice.examples" as FacetPath,
  text: `Base claim ${digit}`,
  evidence: [evidence(MATERIAL_A, `base evidence ${digit}`)],
  status: "active",
  strength: "single_source",
  observedIn: ["baseline"],
  createdIn: OLD_VERSION,
  ...overrides,
});

describe("claim-v1 canonical identity", () => {
  it("exact-deduplicates and sorts resolved evidence and observed contexts before a golden hash", () => {
    const canonical = canonicalizeResolvedClaimDraft({
      facet: "voice.examples" as FacetPath,
      text: "Mira says 🌱 now.\n# not a heading",
      evidence: [
        { materialId: MATERIAL_B, quote: "🌱", locator: { start: 2, end: 3 } },
        { materialId: MATERIAL_A, quote: "z" },
        { materialId: MATERIAL_A, quote: "z" },
        { materialId: MATERIAL_A, quote: "a", locator: { start: 10, end: 11 } },
      ],
      observedIn: ["访谈", "alpha", "访谈"],
      validFrom: VALID_FROM,
      validTo: VALID_TO,
    });

    expect(canonical.evidence).toEqual([
      { materialId: MATERIAL_A, quote: "z" },
      { materialId: MATERIAL_A, quote: "a", locator: { start: 10, end: 11 } },
      { materialId: MATERIAL_B, quote: "🌱", locator: { start: 2, end: 3 } },
    ]);
    expect(canonical.observedIn).toEqual(["alpha", "访谈"]);
    expect(deriveClaimId(SUBJECT_ID, canonical)).toBe(
      "claim_74125829a10ee776836c3fd34a8f4507db036f83a3eabbc4fe5122d111ab7140",
    );
  });

  it("rejects an inverted validity interval at the canonical boundary", () => {
    expect(() =>
      canonicalizeResolvedClaimDraft(
        resolvedDraft({ validFrom: VALID_TO, validTo: VALID_FROM }),
        "patch.operations[0].claim",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_input",
        fieldPath: "patch.operations[0].claim.validTo",
      }),
    );
  });
});

describe("claim patch algebra", () => {
  it("accepts an empty no-op and marks only new add claims for later lineage finalization", () => {
    const base = baseClaim("1");
    const unchanged = applyClaimPatch(SUBJECT_ID, [base], { operations: [] });
    expect(unchanged).toEqual([{ ...base, provenance: "base" }]);

    const added = applyClaimPatch(SUBJECT_ID, [base], {
      operations: [{ op: "add", claim: resolvedDraft() }],
    });
    const candidate = added.find((claim) => claim.provenance === "candidate")!;
    expect(candidate).not.toHaveProperty("createdIn");
    expect(candidate).not.toHaveProperty("strength");

    const strengthened = added.map((claim): StrengthenedClaim =>
      claim.provenance === "base" ? claim : { ...claim, strength: "single_source" },
    );
    const finalized = finalizeClaims(strengthened, NEW_VERSION);
    expect(finalized.find((claim) => claim.id === base.id)?.createdIn).toBe(OLD_VERSION);
    expect(finalized.find((claim) => claim.id === candidate.id)?.createdIn).toBe(NEW_VERSION);
  });

  it("applies revise, supersede, and contest with immutable lineage and canonical evidence", () => {
    const revised = baseClaim("1");
    const superseded = baseClaim("2", {
      supersededBy: `claim_${"e".repeat(64)}` as ClaimId,
    });
    const contested = baseClaim("3", {
      text: "Mira avoids abstractions.",
      validFrom: VALID_FROM,
      validTo: VALID_TO,
    });
    const replacement = resolvedDraft({
      facet: "voice.examples" as FacetPath,
      text: "Mira now starts with a concrete example.",
      evidence: [evidence(MATERIAL_B, "starts with a concrete example")],
      observedIn: ["2026 interview"],
    });
    const replacementId = deriveClaimId(SUBJECT_ID, canonicalizeResolvedClaimDraft(replacement));

    const result = applyClaimPatch(SUBJECT_ID, [revised, superseded, contested], {
      operations: [
        { op: "revise", claimId: revised.id, replacement, reason: "New direct example." },
        {
          op: "supersede",
          claimId: superseded.id,
          reason: "No longer supported.",
          evidence: [evidence(MATERIAL_B, "not supported")],
        },
        {
          op: "contest",
          claimId: contested.id,
          reason: "Conflicting interview.",
          evidence: [
            evidence(MATERIAL_B, "uses abstractions"),
            evidence(MATERIAL_A, "base evidence 3"),
          ],
        },
      ],
    });

    expect(result.find((claim) => claim.id === revised.id)).toMatchObject({
      status: "superseded",
      supersededBy: replacementId,
      createdIn: OLD_VERSION,
    });
    expect(result.find((claim) => claim.id === replacementId)).toMatchObject({
      status: "active",
      provenance: "candidate",
    });
    expect(result.find((claim) => claim.id === superseded.id)).toMatchObject({
      status: "superseded",
      createdIn: OLD_VERSION,
    });
    expect(result.find((claim) => claim.id === superseded.id)).not.toHaveProperty("supersededBy");
    expect(result.find((claim) => claim.id === contested.id)).toMatchObject({
      id: contested.id,
      text: contested.text,
      validFrom: VALID_FROM,
      validTo: VALID_TO,
      createdIn: OLD_VERSION,
      status: "contested",
      strength: "contested",
      evidence: [
        evidence(MATERIAL_A, "base evidence 3"),
        evidence(MATERIAL_B, "uses abstractions"),
      ],
    });
  });

  it("rejects missing, superseded, repeated, cyclic, duplicate, and evidence-empty targets", () => {
    const active = baseClaim("1");
    const gone = baseClaim("2", { status: "superseded" });
    const missing = `claim_${"9".repeat(64)}` as ClaimId;
    const contest = {
      op: "contest" as const,
      claimId: active.id,
      reason: "Conflict.",
      evidence: [evidence(MATERIAL_B, "conflict")],
    };

    expect(() =>
      applyClaimPatch(SUBJECT_ID, [active], {
        operations: [{ ...contest, claimId: missing }],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      applyClaimPatch(SUBJECT_ID, [gone], {
        operations: [{ ...contest, claimId: gone.id }],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      applyClaimPatch(SUBJECT_ID, [active], { operations: [contest, contest] }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    const cyclicDraft = canonicalizeResolvedClaimDraft({
      facet: active.facet,
      text: active.text,
      evidence: active.evidence,
      observedIn: active.observedIn,
    });
    const cyclic = { ...active, id: deriveClaimId(SUBJECT_ID, cyclicDraft) };
    expect(() =>
      applyClaimPatch(SUBJECT_ID, [cyclic], {
        operations: [
          {
            op: "revise",
            claimId: cyclic.id,
            replacement: cyclicDraft,
            reason: "Same semantic claim.",
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      applyClaimPatch(SUBJECT_ID, [], {
        operations: [{ op: "add", claim: resolvedDraft({ evidence: [] }) }],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });
});
