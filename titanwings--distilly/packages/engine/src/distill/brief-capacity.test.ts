import {
  DistillyError,
  briefContractDigestSchema,
  briefMaterialRefSchema,
  contentDigestSchema,
  factChecksumSchema,
  hostDistillBriefingSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialIdSchema,
  materialSetHashSchema,
  operationFactSchema,
  requestIdSchema,
  sourceGroupKeySchema,
  spaceIdSchema,
  subjectIdSchema,
} from "@distilly/protocol";
import type {
  BriefCapacity,
  BriefMaterialRef,
  HostDistillBriefing,
  OperationRecord,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { canonicalJsonBytes } from "../facts/canonical-json.js";
import { sealFact } from "../facts/checksum.js";
import {
  enforceBriefCapacity,
  MAXIMUM_BRIEF_MATERIALS,
  MAXIMUM_OUTPUT_BYTES,
} from "./brief-capacity.js";

const capacity = (maximum: number): BriefCapacity => ({
  maximumInputTokens: maximum,
  maximumToolResultBytes: maximum,
  source: "binding_fixture",
});

const JOB_ID = jobIdSchema.parse(`job_${"1".repeat(32)}`);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${"2".repeat(32)}`);
const SET_HASH = materialSetHashSchema.parse(`set_sha256_${"3".repeat(64)}`);
const LEASE_ID = leaseIdSchema.parse(`lease_${"4".repeat(32)}`);
const CONTRACT_DIGEST = briefContractDigestSchema.parse(`brief_contract_${"5".repeat(64)}`);
const LEASE_OWNER = leaseOwnerIdSchema.parse(`lease_owner_${"6".repeat(32)}`);
const SPACE_ID = spaceIdSchema.parse(`space_${"7".repeat(32)}`);
const MATERIAL_ID = materialIdSchema.parse(`mat_${"8".repeat(64)}`);
const CONTENT_DIGEST = contentDigestSchema.parse(`sha256_${"9".repeat(64)}`);
const SOURCE_GROUP_KEY = sourceGroupKeySchema.parse(`sg_${"a".repeat(64)}`);
const ACQUIRED_AT = isoDateTimeSchema.parse("2026-08-20T00:00:00.000Z");
const EXPIRES_AT = isoDateTimeSchema.parse("2026-08-20T00:30:00.000Z");

const candidate = (content = "Evidence.\n"): Omit<HostDistillBriefing, "limits"> => ({
  job: {
    id: JOB_ID,
    subjectId: SUBJECT_ID,
    generation: 1,
    materialSetHash: SET_HASH,
    addedMaterialCount: 1,
    totalMaterialCount: 1,
    state: "leased",
    queuedAt: ACQUIRED_AT,
    leaseExpiresAt: EXPIRES_AT,
  },
  lease: {
    id: LEASE_ID,
    jobId: JOB_ID,
    generation: 1,
    briefContractDigest: CONTRACT_DIGEST,
    owner: LEASE_OWNER,
    acquiredAt: ACQUIRED_AT,
    expiresAt: EXPIRES_AT,
  },
  subject: {
    id: SUBJECT_ID,
    displayName: "Ada",
    aliases: [],
    identityHints: [],
    space: {
      id: SPACE_ID,
      displayName: "People",
      kind: "people",
    },
    lifecycle: "active",
  },
  materials: [
    {
      ref: briefMaterialRefSchema.parse("m001"),
      materialId: MATERIAL_ID,
      contentDigest: CONTENT_DIGEST,
      kind: "document",
      content,
      source: {
        medium: "document",
        access: "public",
        capturedAt: ACQUIRED_AT,
        authors: [],
      },
      derivation: { kind: "native_text" },
      sourceGroup: {
        key: SOURCE_GROUP_KEY,
        bases: ["unknown"],
        diversityStatus: "unknown",
        cautions: ["insufficient_public_proof"],
      },
      sensitivity: "shareable",
    },
  ],
  contract: {
    digest: CONTRACT_DIGEST,
    sourceGroupingVersion: "source-groups-v1",
    promptVersion: `host-distill-v1-sha256_${"b".repeat(64)}`,
    draftSchemaVersion: 1,
    instructions: "Instructions.\n",
    evidenceRules: [],
  },
});

const largeCandidate = (totalContentBytes: number): Omit<HostDistillBriefing, "limits"> => {
  const base = candidate();
  let remaining = totalContentBytes;
  const materials = Array.from({ length: 5 }, (_, index) => {
    const length = Math.ceil(remaining / (5 - index));
    remaining -= length;
    return {
      ...base.materials[0]!,
      ref: briefMaterialRefSchema.parse(`m${String(index + 1).padStart(3, "0")}`),
      materialId: materialIdSchema.parse(`mat_${String(index + 1).padStart(64, "0")}`),
      content: "x".repeat(length),
    };
  });
  return {
    ...base,
    job: {
      ...base.job,
      addedMaterialCount: materials.length,
      totalMaterialCount: materials.length,
    },
    materials,
  };
};

const measuredBriefingBytes = (value: Omit<HostDistillBriefing, "limits">): number => {
  try {
    return enforceBriefCapacity(value, capacity(10_000_000)).limits.estimatedInputTokens;
  } catch (error) {
    if (!(error instanceof DistillyError) || error.code !== "briefing_too_large") throw error;
    const bytes = error.details?.bytes;
    if (typeof bytes !== "object" || bytes === null || Array.isArray(bytes)) throw error;
    const serialized = (bytes as { readonly serialized?: unknown }).serialized;
    if (typeof serialized !== "number") throw error;
    return serialized;
  }
};

describe("enforceBriefCapacity", () => {
  it("uses the complete canonical JSON byte count as a fixed token upper bound", () => {
    const briefing = enforceBriefCapacity(candidate("多字节🙂\n"), capacity(1_000_000));

    expect(briefing.limits.estimatedInputTokens).toBe(canonicalJsonBytes(briefing).byteLength);
    expect(briefing.limits.maximumOutputBytes).toBe(MAXIMUM_OUTPUT_BYTES);
  });

  it("accepts exact byte and token boundaries and rejects one below either boundary", () => {
    const roomy = enforceBriefCapacity(candidate(), capacity(9_999));
    const exact = roomy.limits.estimatedInputTokens;

    const exactBriefing = enforceBriefCapacity(candidate(), capacity(exact));
    expect(exactBriefing.limits.estimatedInputTokens).toBe(exact);
    expect(canonicalJsonBytes(exactBriefing)).toHaveLength(exact);
    for (const constrained of [
      { ...capacity(exact), maximumInputTokens: exact - 1 },
      { ...capacity(exact), maximumToolResultBytes: exact - 1 },
    ]) {
      expect(() => enforceBriefCapacity(candidate(), constrained)).toThrowError(
        expect.objectContaining({ code: "briefing_too_large" }),
      );
    }
  });

  it("accepts the exact internal 4 MiB boundary and rejects one canonical byte more", () => {
    const maximumBriefingBytes = 4_194_304;
    let totalContentBytes = 4_000_000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const measured = measuredBriefingBytes(largeCandidate(totalContentBytes));
      totalContentBytes += maximumBriefingBytes - measured;
      if (measured === maximumBriefingBytes) break;
    }

    const exact = enforceBriefCapacity(largeCandidate(totalContentBytes), capacity(10_000_000));
    expect(canonicalJsonBytes(exact)).toHaveLength(maximumBriefingBytes);
    expect(() => hostDistillBriefingSchema.parse(exact)).not.toThrow();
    const operation = sealFact<OperationRecord<"distill.brief">>({
      schemaVersion: 1,
      recordKind: "completed",
      requestId: requestIdSchema.parse(`req_${"c".repeat(32)}`),
      method: "distill.brief",
      scope: { kind: "subject", subjectId: SUBJECT_ID },
      actor: { kind: "executor", id: "capacity-boundary" },
      inputChecksum: factChecksumSchema.parse(`fact_sha256_${"d".repeat(64)}`),
      result: exact,
      completedAt: ACQUIRED_AT,
    });
    const decodedOperation: unknown = JSON.parse(JSON.stringify(operation));
    expect(operationFactSchema.parse(decodedOperation)).toEqual(operation);

    let caught: unknown;
    try {
      enforceBriefCapacity(largeCandidate(totalContentBytes + 1), capacity(10_000_000));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DistillyError);
    if (!(caught instanceof DistillyError)) throw caught;
    expect(caught).toMatchObject({
      code: "briefing_too_large",
      details: {
        bytes: { serialized: maximumBriefingBytes + 1 },
        limits: { maximumBriefingBytes },
      },
    });
    expect(JSON.stringify(caught)).not.toContain("xxxxxxxx");
  });

  it("rejects missing capacity without constructing a partial result", () => {
    expect(() => enforceBriefCapacity(candidate(), undefined)).toThrowError(
      expect.objectContaining({ code: "host_unsupported" }),
    );
  });

  it("rejects more than 999 refs with content-free aggregate details", () => {
    const one = candidate();
    const materials = Array.from({ length: MAXIMUM_BRIEF_MATERIALS + 1 }, (_, index) => ({
      ...one.materials[0]!,
      ref: `m${String(index + 1).padStart(3, "0")}` as BriefMaterialRef,
      materialId: materialIdSchema.parse(`mat_${index.toString(16).padStart(64, "0")}`),
    }));
    let caught: unknown;
    try {
      enforceBriefCapacity({ ...one, materials }, capacity(10_000_000));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DistillyError);
    if (!(caught instanceof DistillyError)) throw caught;
    expect(caught.code).toBe("briefing_too_large");
    expect(caught.details).toMatchObject({
      counts: { materials: 1_000, refs: 1_000 },
      limits: { maximumMaterialRefs: 999 },
    });
    expect(JSON.stringify(caught)).not.toContain("Evidence.");
  });
});
