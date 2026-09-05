import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  briefMaterialRefSchema,
  DistillyError,
  facetPathSchema,
  requestIdSchema,
  type ActorContext,
  type ClientSessionContext,
  type CommitInput,
  type EventId,
  type IngestInput,
  type IsoDateTime,
  type JobId,
  type LeaseId,
  type LeaseOwnerId,
  type RequestId,
  type SpaceId,
  type SubjectId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import { canonicalJsonBytes } from "../facts/canonical-json.js";
import type { InternalEngineComposition } from "../ingest/composition.js";
import { createInternalEngineComposition } from "../ingest/composition.js";
import type { IdGenerator } from "../ports/id-generator.js";

const AT = "2026-08-31T14:00:00.000Z" as IsoDateTime;
const ACTOR: ActorContext = { kind: "sdk", id: "sqlite-commit-test" };
const IDENTITY_FACET = facetPathSchema.parse("identity");
const VOICE_FACET = facetPathSchema.parse("voice");
const PSYCHE_FACET = facetPathSchema.parse("psyche");
const FIRST_REF = briefMaterialRefSchema.parse("m001");

class FakeClock implements Clock {
  current = AT;

  now(): IsoDateTime {
    return this.current;
  }
}

class SequenceIds implements IdGenerator {
  private subject = 1;
  private space = 1;
  private job = 1;
  private lease = 1;
  private owner = 1;
  private event = 1;

  subjectId(): SubjectId {
    return `subject_${(this.subject++).toString(16).padStart(32, "0")}` as SubjectId;
  }

  spaceId(): SpaceId {
    return `space_${(this.space++).toString(16).padStart(32, "0")}` as SpaceId;
  }

  jobId(): JobId {
    return `job_${(this.job++).toString(16).padStart(32, "0")}` as JobId;
  }

  leaseId(): LeaseId {
    return `lease_${(this.lease++).toString(16).padStart(32, "0")}` as LeaseId;
  }

  leaseOwnerId(): LeaseOwnerId {
    return `lease_owner_${(this.owner++).toString(16).padStart(32, "0")}` as LeaseOwnerId;
  }

  eventId(): EventId {
    return `event_${(this.event++).toString(16).padStart(32, "0")}` as EventId;
  }
}

const roots: string[] = [];
const compositions: InternalEngineComposition[] = [];

const request = (digit: number): RequestId =>
  requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

const session = (owner = 1, actor = ACTOR): ClientSessionContext => ({
  actor,
  leaseOwner: `lease_owner_${owner.toString(16).padStart(32, "0")}` as LeaseOwnerId,
  capacity: {
    maximumInputTokens: 4_194_304,
    maximumToolResultBytes: 4_194_304,
    source: "sdk_explicit",
  },
});

const firstInput = (): IngestInput => ({
  subject: {
    kind: "create",
    input: {
      displayName: "Mira Chen",
      aliases: ["Mira"],
      identityHints: [{ kind: "url", value: "https://example.test/mira" }],
    },
  },
  materials: [
    {
      clientRef: "mira-profile",
      kind: "web",
      content: "Mira Chen designs reliable local-first research systems and speaks precisely.",
      source: {
        uri: "https://example.test/mira",
        medium: "article",
        access: "public",
        role: "first_party_expression",
        capturedAt: AT,
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
});

const additionalInput = (subjectId: SubjectId, suffix = "notes"): IngestInput => ({
  subject: { kind: "existing", subjectId },
  materials: [
    {
      clientRef: `mira-${suffix}`,
      kind: "document",
      content: `Mira documents ${suffix} with explicit tradeoffs and concise examples.`,
      source: {
        uri: `https://example.test/mira/${suffix}`,
        medium: "document",
        access: "public",
        role: "first_party_expression",
        capturedAt: AT,
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-sqlite-commit-"));
  roots.push(root);
  return root;
};

const open = async (
  root: string,
  ids = new SequenceIds(),
  clock = new FakeClock(),
  overrides: Omit<
    Parameters<typeof createInternalEngineComposition>[0],
    "root" | "ids" | "clock"
  > = {},
): Promise<InternalEngineComposition> => {
  const composition = await createInternalEngineComposition({
    root,
    ids,
    clock,
    ...overrides,
  });
  compositions.push(composition);
  return composition;
};

const firstPatch = (): CommitInput["patch"] => ({
  operations: [
    {
      op: "add" as const,
      claim: {
        facet: IDENTITY_FACET,
        text: "Mira designs reliable local-first research systems.",
        evidence: [
          {
            kind: "brief_material" as const,
            materialRef: FIRST_REF,
            quote: "Mira Chen designs reliable local-first research systems",
          },
        ],
        observedIn: ["2026"],
      },
    },
    {
      op: "add" as const,
      claim: {
        facet: VOICE_FACET,
        text: "Mira speaks precisely.",
        evidence: [
          {
            kind: "brief_material" as const,
            materialRef: FIRST_REF,
            quote: "speaks precisely",
          },
        ],
      },
    },
  ],
});

const commitInput = (
  briefing: Awaited<ReturnType<InternalEngineComposition["leases"]["brief"]>>,
  patch: CommitInput["patch"] = firstPatch(),
): CommitInput => ({
  jobId: briefing.job.id,
  generation: briefing.job.generation,
  leaseId: briefing.lease.id,
  briefContractDigest: briefing.contract.digest,
  materialSetHash: briefing.job.materialSetHash,
  ...(briefing.job.baseVersionId === undefined
    ? {}
    : { baseVersionId: briefing.job.baseVersionId }),
  patch,
});

const patchWithCanonicalSize = (targetBytes: number): CommitInput["patch"] => {
  const operations = Array.from({ length: 4 }, () => ({
    op: "add" as const,
    claim: {
      facet: IDENTITY_FACET,
      text: "",
      evidence: [
        {
          kind: "brief_material" as const,
          materialRef: FIRST_REF,
          quote: "Mira Chen designs reliable local-first research systems",
        },
      ],
    },
  }));
  let remaining = targetBytes - canonicalJsonBytes({ operations }).byteLength;
  const lengths: number[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const remainingSlots = operations.length - index - 1;
    const length = Math.min(16_384, remaining - remainingSlots);
    if (length < 1) throw new Error("Target patch size is too small for the fixture.");
    lengths.push(length);
    remaining -= length;
  }
  if (remaining !== 0) throw new Error("Target patch size exceeds the fixture capacity.");
  return {
    operations: operations.map((operation, index) => ({
      ...operation,
      claim: {
        ...operation.claim,
        text: `${String.fromCharCode(65 + index)}${"x".repeat(lengths[index]! - 1)}`,
      },
    })),
  };
};

const count = (root: string, table: string): number => {
  const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
  try {
    const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
      readonly count: number;
    };
    return row.count;
  } finally {
    database.close();
  }
};

const scalar = (root: string, sql: string, ...values: (string | number)[]): unknown => {
  const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
  try {
    const row = database.prepare(sql).get(...values) as Record<string, unknown> | undefined;
    return row?.value;
  } finally {
    database.close();
  }
};

const expectCode = async (promise: Promise<unknown>, code: string): Promise<DistillyError> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
    return error as DistillyError;
  }
};

afterEach(async () => {
  for (const composition of compositions.splice(0)) composition.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite CommitService", () => {
  it("atomically creates a current version and replays the exact stored result", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, session(), {
      requestId: request(2),
    });
    const input = commitInput(briefing);
    const result = await composition.commits.commit(input, session(), { requestId: request(3) });

    expect(result).toMatchObject({
      kind: "current",
      version: {
        subjectId: ingested.subject.id,
        generation: 1,
        status: "current",
      },
      profile: { displayName: "Mira Chen", claims: [{}, {}] },
    });
    await expect(
      composition.commits.commit(input, session(), { requestId: request(3) }),
    ).resolves.toEqual(result);
    expect(count(root, "versions")).toBe(1);
    expect(count(root, "version_statuses")).toBe(1);
    expect(count(root, "version_materials")).toBe(1);
    expect(count(root, "version_claims")).toBe(2);
    expect(count(root, "version_claim_evidence")).toBe(2);
    expect(count(root, "pending_jobs")).toBe(0);
    expect(count(root, "job_leases")).toBe(0);
    expect(scalar(root, "SELECT current_version_id AS value FROM subject_states")).toBe(
      result.kind === "current" ? result.version.id : undefined,
    );
    expect(
      scalar(
        root,
        "SELECT status AS value FROM version_statuses WHERE version_id = ?",
        result.kind === "current" ? result.version.id : "",
      ),
    ).toBe("current");
    expect(count(root, "operations")).toBe(3);
    expect(count(root, "events")).toBe(6);
  });

  it("binds idempotency to params, actor, and lease owner after pending is consumed", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, session(), {
      requestId: request(2),
    });
    const input = commitInput(briefing);
    await composition.commits.commit(input, session(), { requestId: request(3) });

    await expectCode(
      composition.commits.commit(
        { ...input, patch: { ...input.patch, notes: "different" } },
        session(),
        { requestId: request(3) },
      ),
      "idempotency_conflict",
    );
    await expectCode(
      composition.commits.commit(input, session(1, { kind: "sdk", id: "different-actor" }), {
        requestId: request(3),
      }),
      "idempotency_conflict",
    );
    await expectCode(
      composition.commits.commit(input, session(2), { requestId: request(3) }),
      "idempotency_conflict",
    );
    expect(count(root, "versions")).toBe(1);
  });

  it("fails replay when the sealed accepted-patch authority is altered", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, session(), {
      requestId: request(2),
    });
    const input = commitInput(briefing);
    await composition.commits.commit(input, session(), { requestId: request(3) });
    composition.close();

    const database = new DatabaseSync(join(root, "store.sqlite3"));
    try {
      database
        .prepare("UPDATE versions SET accepted_patch_digest = ?")
        .run(`sha256_${"f".repeat(64)}`);
    } finally {
      database.close();
    }
    const reopened = await open(root);
    await expectCode(
      reopened.commits.commit(input, session(), { requestId: request(3) }),
      "storage_corrupt",
    );
    expect(count(root, "versions")).toBe(1);
    expect(count(root, "operations")).toBe(3);
  });

  it("hard-rejects stale, foreign, and invalid evidence without consuming the lease", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, session(), {
      requestId: request(2),
    });
    const input = commitInput(briefing);

    await expectCode(
      composition.commits.commit({ ...input, generation: input.generation + 1 }, session(), {
        requestId: request(3),
      }),
      "stale_job",
    );
    await expectCode(
      composition.commits.commit(
        {
          ...input,
          patch: {
            operations: [
              {
                op: "add",
                claim: {
                  facet: IDENTITY_FACET,
                  text: "Unsupported claim.",
                  evidence: [
                    {
                      kind: "brief_material",
                      materialRef: FIRST_REF,
                      quote: "not present in the material",
                    },
                  ],
                },
              },
            ],
          },
        },
        session(),
        { requestId: request(4) },
      ),
      "evidence_invalid",
    );
    await expectCode(
      composition.commits.commit(input, session(2), { requestId: request(5) }),
      "lease_conflict",
    );
    expect(count(root, "versions")).toBe(0);
    expect(count(root, "pending_jobs")).toBe(1);
    expect(count(root, "job_leases")).toBe(1);
    expect(count(root, "operations")).toBe(2);
  });

  it("accepts exactly 65,536 patch bytes and rejects one extra byte with zero writes", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, session(), {
      requestId: request(2),
    });
    const exactPatch = patchWithCanonicalSize(65_536);
    const oversizedPatch = patchWithCanonicalSize(65_537);
    expect(canonicalJsonBytes(exactPatch)).toHaveLength(65_536);
    expect(canonicalJsonBytes(oversizedPatch)).toHaveLength(65_537);

    await expectCode(
      composition.commits.commit(commitInput(briefing, oversizedPatch), session(), {
        requestId: request(3),
      }),
      "invalid_input",
    );
    expect(count(root, "versions")).toBe(0);
    expect(count(root, "pending_jobs")).toBe(1);
    expect(count(root, "job_leases")).toBe(1);
    expect(count(root, "operations")).toBe(2);

    await expect(
      composition.commits.commit(commitInput(briefing, exactPatch), session(), {
        requestId: request(4),
      }),
    ).resolves.toMatchObject({ kind: "current" });
    expect(count(root, "versions")).toBe(1);
    expect(count(root, "pending_jobs")).toBe(0);
  });

  it("creates a suspended first version for manual review without replacing current", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, session(), {
      requestId: request(2),
    });
    const result = await composition.commits.commit(
      commitInput(briefing, {
        ...firstPatch(),
        reviewRequest: { note: "Please verify the voice example." },
      }),
      session(),
      { requestId: request(3) },
    );

    expect(result).toMatchObject({
      kind: "suspended",
      reasons: [{ code: "manual_review_requested", note: "Please verify the voice example." }],
      review: { subjectId: ingested.subject.id },
    });
    expect("currentVersionId" in result).toBe(false);
    expect(scalar(root, "SELECT current_version_id AS value FROM subject_states")).toBeNull();
    expect(scalar(root, "SELECT suspended_version_id AS value FROM subject_states")).toBe(
      result.kind === "suspended" ? result.candidate.id : undefined,
    );
    expect(scalar(root, "SELECT status AS value FROM version_statuses")).toBe("suspended");
    expect(count(root, "pending_jobs")).toBe(0);
  });

  it("uses a committed current as the next incremental ingest and briefing baseline", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(firstInput(), ACTOR, { requestId: request(1) });
    const firstBrief = await composition.leases.brief({ jobId: first.job!.id }, session(), {
      requestId: request(2),
    });
    const committed = await composition.commits.commit(commitInput(firstBrief), session(), {
      requestId: request(3),
    });
    if (committed.kind !== "current") throw new Error("expected a current version");

    const second = await composition.ingest.ingest(additionalInput(first.subject.id), ACTOR, {
      requestId: request(4),
    });
    expect(second.job).toMatchObject({
      baseVersionId: committed.version.id,
      generation: 2,
      addedMaterialCount: 1,
      totalMaterialCount: 2,
    });
    const secondBrief = await composition.leases.brief({ jobId: second.job!.id }, session(), {
      requestId: request(5),
    });
    expect(secondBrief).toMatchObject({
      baseline: {
        versionId: committed.version.id,
        claims: committed.profile.claims,
      },
      materials: [{ ref: "m001" }],
    });
    expect(secondBrief.baseline?.evidenceFacts).toHaveLength(1);

    const secondCommit = await composition.commits.commit(
      commitInput(secondBrief, {
        operations: [
          {
            op: "add",
            claim: {
              facet: PSYCHE_FACET,
              text: "Mira makes tradeoffs explicit and grounds them in examples.",
              evidence: [
                {
                  kind: "baseline_evidence",
                  claimId: committed.profile.claims[0]!.id,
                  evidenceIndex: 0,
                },
                {
                  kind: "brief_material",
                  materialRef: FIRST_REF,
                  quote: "explicit tradeoffs and concise examples",
                },
              ],
            },
          },
        ],
      }),
      session(),
      { requestId: request(6) },
    );
    expect(secondCommit).toMatchObject({
      kind: "current",
      version: { parentId: committed.version.id, generation: 2 },
    });
    expect(count(root, "versions")).toBe(2);
    expect(
      scalar(
        root,
        "SELECT status AS value FROM version_statuses WHERE version_id = ?",
        committed.version.id,
      ),
    ).toBe("historical");
  });

  it("rolls back every version write when the process boundary hook fails before COMMIT", async () => {
    const root = await temporaryRoot();
    const composition = await open(root, new SequenceIds(), new FakeClock(), {
      commitHooks: {
        beforeTransactionCommit: () => {
          throw new Error("fault before sqlite commit");
        },
      },
    });
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, session(), {
      requestId: request(2),
    });

    await expect(
      composition.commits.commit(commitInput(briefing), session(), { requestId: request(3) }),
    ).rejects.toThrow("fault before sqlite commit");
    expect(count(root, "versions")).toBe(0);
    expect(count(root, "version_claims")).toBe(0);
    expect(count(root, "pending_jobs")).toBe(1);
    expect(count(root, "job_leases")).toBe(1);
    expect(count(root, "operations")).toBe(2);
  });

  it("serializes competing commits so exactly one consumes the leased generation", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, session(), {
      requestId: request(2),
    });
    const input = commitInput(briefing);

    const outcomes = await Promise.allSettled([
      composition.commits.commit(input, session(), { requestId: request(3) }),
      composition.commits.commit(input, session(), { requestId: request(4) }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "stale_job" } });
    expect(count(root, "versions")).toBe(1);
    expect(count(root, "pending_jobs")).toBe(0);
    expect(count(root, "operations")).toBe(3);
  });

  it("returns review_conflict before stale or lease errors when a suspended target is active", async () => {
    const root = await temporaryRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(firstInput(), ACTOR, { requestId: request(1) });
    const briefing = await composition.leases.brief({ jobId: first.job!.id }, session(), {
      requestId: request(2),
    });
    const suspended = await composition.commits.commit(
      commitInput(briefing, { ...firstPatch(), reviewRequest: {} }),
      session(),
      { requestId: request(3) },
    );
    expect(suspended.kind).toBe("suspended");
    const next = await composition.ingest.ingest(
      additionalInput(first.subject.id, "after-review"),
      ACTOR,
      { requestId: request(4) },
    );
    if (next.job === undefined) throw new Error("expected pending work behind review");

    await expectCode(
      composition.commits.commit(
        {
          jobId: next.job.id,
          generation: next.job.generation + 1,
          leaseId: briefing.lease.id,
          briefContractDigest: briefing.contract.digest,
          materialSetHash: next.job.materialSetHash,
          patch: { operations: [] },
        },
        session(2),
        { requestId: request(5) },
      ),
      "review_conflict",
    );
    await expectCode(
      composition.leases.brief({ jobId: next.job.id }, session(), { requestId: request(6) }),
      "review_conflict",
    );
    expect(count(root, "versions")).toBe(1);
    expect(count(root, "pending_jobs")).toBe(1);
  });
});
