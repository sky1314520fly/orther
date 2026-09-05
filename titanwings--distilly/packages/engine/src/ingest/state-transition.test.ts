import { describe, expect, it, vi } from "vitest";

import type {
  BriefContractDigest,
  ContentDigest,
  IsoDateTime,
  JobId,
  LeaseId,
  LeaseOwnerId,
  MaterialId,
  ProvenanceDigest,
  SubjectId,
  SubjectStateRecord,
  VersionId,
  VersionMaterialEntry,
} from "@distilly/protocol";

import { sealFact } from "../facts/checksum.js";
import { hashMaterialSet } from "../facts/digests.js";
import { deriveIngestState } from "./state-transition.js";

const SUBJECT_ID = "subject_11111111111111111111111111111111" as SubjectId;
const VERSION_ID = `version_${"2".repeat(64)}` as VersionId;
const NOW = "2026-08-20T10:30:00.000Z" as IsoDateTime;
const LEASE_ID = "lease_11111111111111111111111111111111" as LeaseId;
const LEASE_OWNER_ID = "lease_owner_11111111111111111111111111111111" as LeaseOwnerId;
const BRIEF_CONTRACT = {
  digest: `brief_contract_${"3".repeat(64)}` as BriefContractDigest,
  sourceGroupingVersion: "source-groups-v1",
  promptVersion: `host-distill-v1-sha256_${"4".repeat(64)}` as const,
  draftSchemaVersion: 1,
} as const;

const entry = (digit: string): VersionMaterialEntry => ({
  materialId: `mat_${digit.repeat(64)}` as MaterialId,
  contentDigest: `sha256_${digit.repeat(64)}` as ContentDigest,
  provenanceDigest: `provenance_sha256_${digit.repeat(64)}` as ProvenanceDigest,
});

const state = (
  manifest: readonly VersionMaterialEntry[],
  options: {
    readonly generation?: number;
    readonly currentVersionId?: VersionId;
    readonly pending?: SubjectStateRecord["pending"];
  } = {},
): SubjectStateRecord =>
  sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: SUBJECT_ID,
    generation: options.generation ?? (manifest.length === 0 ? 0 : 1),
    ...(manifest.length === 0 ? {} : { materialSetHash: hashMaterialSet(manifest) }),
    materialManifest: manifest,
    ...(options.currentVersionId === undefined
      ? {}
      : { currentVersionId: options.currentVersionId }),
    ...(options.pending === undefined ? {} : { pending: options.pending }),
  });

const stored = (
  manifest: readonly VersionMaterialEntry[],
  oldest = "2026-08-20T10:29:00.000Z" as IsoDateTime,
): ReadonlyMap<MaterialId, IsoDateTime> =>
  new Map(manifest.map((item, index) => [item.materialId, index === 0 ? oldest : NOW]));

describe("ingest state transition", () => {
  it("increments generation only when the manifest changes", () => {
    const first = entry("1");
    const nextJobId = vi.fn(() => "job_11111111111111111111111111111111" as JobId);
    const created = deriveIngestState({
      subjectId: SUBJECT_ID,
      previous: state([]),
      targetManifest: [first],
      storedAtByMaterialId: stored([first]),
      enqueue: "auto",
      now: NOW,
      nextJobId,
    });
    expect(created.state.generation).toBe(1);
    expect(created.changed).toBe(true);
    expect(created.pendingChanged).toBe(false);
    expect(created.job).toBeUndefined();

    const duplicate = deriveIngestState({
      subjectId: SUBJECT_ID,
      previous: created.state,
      targetManifest: [first],
      storedAtByMaterialId: stored([first]),
      enqueue: "auto",
      now: NOW,
      nextJobId,
    });
    expect(duplicate.state.generation).toBe(1);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.pendingChanged).toBe(false);
    expect(nextJobId).not.toHaveBeenCalled();
  });

  it("queues auto-v1 at count three but not count two", () => {
    const two = [entry("1"), entry("2")];
    const three = [...two, entry("3")];
    const nextJobId = vi
      .fn<() => JobId>()
      .mockReturnValue("job_11111111111111111111111111111111" as JobId);

    expect(
      deriveIngestState({
        subjectId: SUBJECT_ID,
        previous: state([]),
        targetManifest: two,
        storedAtByMaterialId: stored(two),
        enqueue: "auto",
        now: NOW,
        nextJobId,
      }).job,
    ).toBeUndefined();
    expect(
      deriveIngestState({
        subjectId: SUBJECT_ID,
        previous: state([]),
        targetManifest: three,
        storedAtByMaterialId: stored(three),
        enqueue: "auto",
        now: NOW,
        nextJobId,
      }).job,
    ).toMatchObject({ addedMaterialCount: 3, totalMaterialCount: 3, generation: 1 });
  });

  it("queues duplicate-only auto-v1 at the exact oldest-material age boundary", () => {
    const first = entry("1");
    const previous = state([first]);
    const nextJobId = () => "job_11111111111111111111111111111111" as JobId;
    expect(
      deriveIngestState({
        subjectId: SUBJECT_ID,
        previous,
        targetManifest: [first],
        storedAtByMaterialId: stored([first], "2026-08-20T10:00:00.001Z" as IsoDateTime),
        enqueue: "auto",
        now: NOW,
        nextJobId,
      }).job,
    ).toBeUndefined();
    expect(
      deriveIngestState({
        subjectId: SUBJECT_ID,
        previous,
        targetManifest: [first],
        storedAtByMaterialId: stored([first], "2026-08-20T10:00:00.000Z" as IsoDateTime),
        enqueue: "auto",
        now: NOW,
        nextJobId,
      }).job,
    ).toBeDefined();
  });

  it("queues duplicate-only now when the set is uncommitted", () => {
    const first = entry("1");
    const previous = state([first]);
    const derived = deriveIngestState({
      subjectId: SUBJECT_ID,
      previous,
      targetManifest: [first],
      storedAtByMaterialId: stored([first]),
      enqueue: "now",
      now: NOW,
      nextJobId: () => "job_11111111111111111111111111111111" as JobId,
    });
    expect(derived.changed).toBe(false);
    expect(derived.pendingChanged).toBe(true);
    expect(derived.job).toMatchObject({ generation: 1, addedMaterialCount: 1 });
  });

  it("does not queue now when the current version already owns the complete set", () => {
    const first = entry("1");
    const previous = state([first], { currentVersionId: VERSION_ID });
    const derived = deriveIngestState({
      subjectId: SUBJECT_ID,
      previous,
      targetManifest: [first],
      baseline: { versionId: VERSION_ID, manifest: [first] },
      storedAtByMaterialId: new Map(),
      enqueue: "now",
      now: NOW,
      nextJobId: () => "job_11111111111111111111111111111111" as JobId,
    });
    expect(derived.job).toBeUndefined();
  });

  it("preserves a same-generation lease view and drops the lease after a new generation", () => {
    const first = entry("1");
    const second = entry("2");
    const materialSetHash = hashMaterialSet([first]);
    const pending = {
      jobId: "job_11111111111111111111111111111111" as JobId,
      generation: 1,
      materialSetHash,
      addedMaterialCount: 1,
      totalMaterialCount: 1,
      queuedAt: "2026-08-20T10:00:00.000Z" as IsoDateTime,
      lease: {
        id: LEASE_ID,
        owner: LEASE_OWNER_ID,
        acquiredAt: "2026-08-20T10:00:00.000Z" as IsoDateTime,
        expiresAt: "2026-08-20T11:00:00.000Z" as IsoDateTime,
        contract: BRIEF_CONTRACT,
      },
    };
    const previous = state([first], {
      pending,
    });
    const nextJobId = vi.fn(() => "job_22222222222222222222222222222222" as JobId);

    for (const enqueue of ["auto", "now"] as const) {
      const same = deriveIngestState({
        subjectId: SUBJECT_ID,
        previous,
        targetManifest: [first],
        storedAtByMaterialId: stored([first]),
        enqueue,
        now: NOW,
        nextJobId,
      });
      expect(same.job).toMatchObject({
        id: previous.pending?.jobId,
        state: "leased",
        leaseExpiresAt: pending.lease.expiresAt,
      });
      expect(same.state.pending?.lease).toEqual(pending.lease);
      expect(same.pendingChanged).toBe(false);
    }
    expect(nextJobId).not.toHaveBeenCalled();

    const expiredPrevious = state([first], {
      pending: {
        ...pending,
        lease: {
          ...pending.lease,
          expiresAt: "2026-08-20T10:15:00.000Z" as IsoDateTime,
        },
      },
    });
    const expired = deriveIngestState({
      subjectId: SUBJECT_ID,
      previous: expiredPrevious,
      targetManifest: [first],
      storedAtByMaterialId: stored([first]),
      enqueue: "auto",
      now: NOW,
      nextJobId,
    });
    expect(expired.job).toMatchObject({ id: pending.jobId, state: "pending" });
    expect(expired.job).not.toHaveProperty("leaseExpiresAt");
    expect(expired.state.pending).toEqual(expiredPrevious.pending);
    expect(expired.pendingChanged).toBe(false);
    expect(nextJobId).not.toHaveBeenCalled();

    const changed = deriveIngestState({
      subjectId: SUBJECT_ID,
      previous,
      targetManifest: [first, second],
      storedAtByMaterialId: stored([first, second]),
      enqueue: "auto",
      now: NOW,
      nextJobId,
    });
    expect(changed.state.generation).toBe(2);
    expect(changed.pendingChanged).toBe(true);
    expect(changed.job).toMatchObject({
      id: "job_22222222222222222222222222222222",
      state: "pending",
      generation: 2,
    });
    expect(changed.state.pending).not.toHaveProperty("lease");
  });

  it("rejects manifest rewrites and mismatched baselines", () => {
    const first = entry("1");
    const rewritten = { ...first, contentDigest: entry("2").contentDigest };
    const previous = state([first]);
    expect(() =>
      deriveIngestState({
        subjectId: SUBJECT_ID,
        previous,
        targetManifest: [rewritten],
        storedAtByMaterialId: stored([rewritten]),
        enqueue: "auto",
        now: NOW,
        nextJobId: () => "job_11111111111111111111111111111111" as JobId,
      }),
    ).toThrowError(expect.objectContaining({ code: "storage_corrupt" }));

    expect(() =>
      deriveIngestState({
        subjectId: SUBJECT_ID,
        previous: state([first], { currentVersionId: VERSION_ID }),
        targetManifest: [first],
        storedAtByMaterialId: new Map(),
        enqueue: "auto",
        now: NOW,
        nextJobId: () => "job_11111111111111111111111111111111" as JobId,
      }),
    ).toThrowError(expect.objectContaining({ code: "storage_corrupt" }));

    expect(() =>
      deriveIngestState({
        subjectId: SUBJECT_ID,
        previous: state([first], { currentVersionId: VERSION_ID }),
        targetManifest: [first],
        baseline: { versionId: VERSION_ID, manifest: [entry("2")] },
        storedAtByMaterialId: new Map(),
        enqueue: "now",
        now: NOW,
        nextJobId: () => "job_11111111111111111111111111111111" as JobId,
      }),
    ).toThrowError(expect.objectContaining({ code: "storage_corrupt" }));

    expect(() =>
      deriveIngestState({
        subjectId: SUBJECT_ID,
        previous: state([first], { currentVersionId: VERSION_ID }),
        targetManifest: [first],
        baseline: {
          versionId: VERSION_ID,
          manifest: [{ ...first, contentDigest: entry("2").contentDigest }],
        },
        storedAtByMaterialId: new Map(),
        enqueue: "now",
        now: NOW,
        nextJobId: () => "job_11111111111111111111111111111111" as JobId,
      }),
    ).toThrowError(expect.objectContaining({ code: "storage_corrupt" }));
  });
});
