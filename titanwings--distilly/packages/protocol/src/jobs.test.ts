import { describe, expect, it } from "vitest";

import {
  briefContractSchema,
  hostDistillBriefingSchema,
  jobLeaseSchema,
  pendingJobFailureSchema,
  pendingJobSchema,
} from "./schemas/jobs.js";

const HEX_32 = "0".repeat(32);
const HEX_64 = "0".repeat(64);
const ALT_HEX_64 = "1".repeat(64);

const subjectId = `subject_${HEX_32}`;
const spaceId = `space_${HEX_32}`;
const jobId = `job_${HEX_32}`;
const leaseId = `lease_${HEX_32}`;
const leaseOwner = `lease_owner_${HEX_32}`;
const versionId = `version_${HEX_64}`;
const materialId = `mat_${HEX_64}`;
const secondMaterialId = `mat_${ALT_HEX_64}`;
const contentDigest = `sha256_${HEX_64}`;
const materialSetHash = `set_sha256_${HEX_64}`;
const sourceGroupKey = `sg_${HEX_64}`;
const briefContractDigest = `brief_contract_${HEX_64}`;
const promptVersion = `host-distill-v1-sha256_${HEX_64}` as const;
const acquiredAt = "2026-08-20T00:00:00.000Z";
const expiresAt = "2026-08-20T00:30:00.000Z";

const briefContract = {
  digest: briefContractDigest,
  sourceGroupingVersion: "source-groups-v1",
  promptVersion,
  draftSchemaVersion: 1,
} as const;

const pendingJob = {
  id: jobId,
  subjectId,
  generation: 1,
  baseVersionId: versionId,
  materialSetHash,
  addedMaterialCount: 1,
  totalMaterialCount: 2,
  state: "pending",
  queuedAt: acquiredAt,
} as const;

const leasedJob = {
  ...pendingJob,
  state: "leased",
  leaseExpiresAt: expiresAt,
} as const;

const failure = { code: "adapter_failed", retryable: true, remediation: "Retry." } as const;
const failedJob = { ...pendingJob, state: "failed", failure } as const;

const lease = {
  id: leaseId,
  jobId,
  generation: 1,
  briefContractDigest,
  owner: leaseOwner,
  acquiredAt,
  expiresAt,
} as const;

const subject = {
  id: subjectId,
  displayName: "Ada",
  aliases: [],
  identityHints: [],
  space: { id: spaceId, displayName: "People", kind: "people" },
  lifecycle: "active",
  currentVersionId: versionId,
} as const;

const quality = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 0,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 1,
  diversityEligibleSourceGroupCount: 1,
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
} as const;

const source = {
  uri: "https://example.com/ada",
  medium: "article",
  access: "public",
  role: "first_party_expression",
  capturedAt: acquiredAt,
  authors: ["Ada"],
} as const;

const sourceGroup = {
  key: sourceGroupKey,
  bases: ["canonical_uri"],
  diversityStatus: "eligible",
  cautions: [],
} as const;

const evidenceFact = {
  materialId,
  source,
  derivation: { kind: "native_text" },
  sourceGroup,
  sensitivity: "shareable",
  flags: [],
} as const;

const material = {
  ref: "m001",
  materialId,
  contentDigest,
  kind: "web",
  content: "Ada writes.",
  source,
  derivation: { kind: "native_text" },
  sourceGroup,
  sensitivity: "shareable",
} as const;

const briefing = {
  job: leasedJob,
  lease,
  subject,
  baseline: { versionId, claims: [], quality, evidenceFacts: [evidenceFact] },
  materials: [material],
  contract: {
    ...briefContract,
    instructions: "Distill evidence-bounded claims.",
    evidenceRules: ["Use exact quotes."],
  },
  limits: {
    estimatedInputTokens: 1,
    maximumInputTokens: 4_096,
    maximumOutputBytes: 65_536,
  },
} as const;

describe("pending job and lease schemas", () => {
  it("keeps pending, leased, and failed wire states disjoint", () => {
    expect(pendingJobSchema.parse(pendingJob)).toEqual(pendingJob);
    expect(pendingJobSchema.parse(leasedJob)).toEqual(leasedJob);
    expect(pendingJobSchema.parse(failedJob)).toEqual(failedJob);

    expect(() => pendingJobSchema.parse({ ...pendingJob, leaseExpiresAt: expiresAt })).toThrow();
    expect(() => pendingJobSchema.parse({ ...pendingJob, failure })).toThrow();
    expect(() => pendingJobSchema.parse({ ...leasedJob, leaseExpiresAt: undefined })).toThrow();
    expect(() => pendingJobSchema.parse({ ...leasedJob, failure })).toThrow();
    expect(() => pendingJobSchema.parse({ ...failedJob, failure: undefined })).toThrow();
    expect(() => pendingJobSchema.parse({ ...failedJob, leaseExpiresAt: expiresAt })).toThrow();
    expect(() => pendingJobSchema.parse({ ...pendingJob, addedMaterialCount: 3 })).toThrow();
    expect(pendingJobFailureSchema.parse(failure)).toEqual(failure);
  });

  it("requires a branded owner and a strictly positive lease interval", () => {
    expect(jobLeaseSchema.parse(lease)).toEqual(lease);
    expect(() => jobLeaseSchema.parse({ ...lease, owner: "sdk-test" })).toThrow();
    expect(() => jobLeaseSchema.parse({ ...lease, expiresAt: acquiredAt })).toThrow();
    expect(() =>
      jobLeaseSchema.parse({ ...lease, expiresAt: "2026-08-19T23:59:59.999Z" }),
    ).toThrow();
  });

  it("pins the first briefing contract vocabulary", () => {
    expect(briefContractSchema.parse(briefContract)).toMatchObject({
      sourceGroupingVersion: "source-groups-v1",
      promptVersion,
      draftSchemaVersion: 1,
    });
    expect(() =>
      briefContractSchema.parse({ ...briefContract, sourceGroupingVersion: "future" }),
    ).toThrow();
    expect(() =>
      briefContractSchema.parse({ ...briefContract, promptVersion: "host-distill-v1" }),
    ).toThrow();
    expect(() => briefContractSchema.parse({ ...briefContract, draftSchemaVersion: 2 })).toThrow();
  });
});

describe("host distill briefing cross-record contract", () => {
  it("accepts one fully correlated, version-pinned briefing", () => {
    expect(hostDistillBriefingSchema.parse(briefing)).toEqual(briefing);
  });

  it.each([
    { ...briefing, job: pendingJob },
    { ...briefing, job: { ...leasedJob, id: `job_${"1".repeat(32)}` } },
    { ...briefing, job: { ...leasedJob, generation: 2 } },
    { ...briefing, job: { ...leasedJob, leaseExpiresAt: "2026-08-20T00:31:00.000Z" } },
    { ...briefing, subject: { ...subject, id: `subject_${"1".repeat(32)}` } },
    {
      ...briefing,
      contract: { ...briefing.contract, digest: `brief_contract_${ALT_HEX_64}` },
    },
    { ...briefing, baseline: undefined },
    {
      ...briefing,
      baseline: { ...briefing.baseline, versionId: `version_${ALT_HEX_64}` },
    },
    { ...briefing, limits: { ...briefing.limits, estimatedInputTokens: 0 } },
  ])("rejects an uncorrelated briefing", (invalid) => {
    expect(() => hostDistillBriefingSchema.parse(invalid)).toThrow();
  });

  it("requires contiguous refs and unique material identities", () => {
    const secondMaterial = {
      ...material,
      ref: "m002",
      materialId: secondMaterialId,
      contentDigest: `sha256_${ALT_HEX_64}`,
    } as const;
    expect(() =>
      hostDistillBriefingSchema.parse({ ...briefing, materials: [material, secondMaterial] }),
    ).not.toThrow();
    expect(() =>
      hostDistillBriefingSchema.parse({
        ...briefing,
        materials: [material, { ...secondMaterial, ref: "m003" }],
      }),
    ).toThrow();
    expect(() =>
      hostDistillBriefingSchema.parse({
        ...briefing,
        materials: [material, { ...secondMaterial, materialId }],
      }),
    ).toThrow();
    expect(() =>
      hostDistillBriefingSchema.parse({
        ...briefing,
        materials: [
          { ...secondMaterial, ref: "m001" },
          { ...material, ref: "m002" },
        ],
      }),
    ).toThrow();
  });

  it("requires baseline evidence facts to be strictly sorted and unique", () => {
    const secondEvidenceFact = { ...evidenceFact, materialId: secondMaterialId } as const;
    expect(() =>
      hostDistillBriefingSchema.parse({
        ...briefing,
        baseline: {
          ...briefing.baseline,
          evidenceFacts: [evidenceFact, secondEvidenceFact],
        },
      }),
    ).not.toThrow();
    expect(() =>
      hostDistillBriefingSchema.parse({
        ...briefing,
        baseline: {
          ...briefing.baseline,
          evidenceFacts: [secondEvidenceFact, evidenceFact],
        },
      }),
    ).toThrow();
    expect(() =>
      hostDistillBriefingSchema.parse({
        ...briefing,
        baseline: { ...briefing.baseline, evidenceFacts: [evidenceFact, evidenceFact] },
      }),
    ).toThrow();
  });
});
