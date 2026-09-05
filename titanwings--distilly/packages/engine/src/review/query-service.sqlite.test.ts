import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  briefMaterialRefSchema,
  facetPathSchema,
  isoDateTimeSchema,
  leaseOwnerIdSchema,
  requestIdSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  ClientSessionContext,
  CommitInput,
  IngestInput,
  RequestId,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { InternalEngineComposition } from "../ingest/composition.js";
import { createInternalEngineComposition } from "../ingest/composition.js";

const AT = isoDateTimeSchema.parse("2026-08-31T16:00:00.000Z");
const ACTOR: ActorContext = { kind: "sdk", id: "sqlite-review-query" };
const SESSION: ClientSessionContext = {
  actor: ACTOR,
  leaseOwner: leaseOwnerIdSchema.parse("lease_owner_00000000000000000000000000000001"),
  capacity: {
    maximumInputTokens: 4_194_304,
    maximumToolResultBytes: 4_194_304,
    source: "sdk_explicit",
  },
};
const IDENTITY = facetPathSchema.parse("identity");
const VOICE = facetPathSchema.parse("voice");
const FIRST_REF = briefMaterialRefSchema.parse("m001");

const roots: string[] = [];
const compositions: InternalEngineComposition[] = [];
let requestCounter = 1;

const request = (): RequestId =>
  requestIdSchema.parse(`req_${(requestCounter++).toString(16).padStart(32, "0")}`);

const material = (label: string, content: string): IngestInput["materials"][number] => ({
  clientRef: `review-query-${label}`,
  kind: "document",
  content,
  source: {
    uri: `https://example.test/review-query/${label}`,
    medium: "document",
    access: "public",
    role: "first_party_expression",
    capturedAt: AT,
  },
  derivation: { kind: "native_text" },
});

const commitInput = (
  briefing: Awaited<ReturnType<InternalEngineComposition["leases"]["brief"]>>,
  patch: CommitInput["patch"],
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

const seedCandidate = async (
  composition: InternalEngineComposition,
  label: string,
): Promise<{ readonly subjectId: SubjectId; readonly candidateId: VersionId }> => {
  const firstContent = `${label} builds reliable systems and explains decisions precisely.`;
  const ingested = await composition.ingest.ingest(
    {
      subject: {
        kind: "create",
        input: {
          displayName: `Subject ${label}`,
          identityHints: [{ kind: "url", value: `https://example.test/people/${label}` }],
        },
      },
      materials: [material(`${label}-first`, firstContent)],
      enqueue: "now",
    },
    ACTOR,
    { requestId: request() },
  );
  const firstBrief = await composition.leases.brief({ jobId: ingested.job!.id }, SESSION, {
    requestId: request(),
  });
  await composition.commits.commit(
    commitInput(firstBrief, {
      operations: [
        {
          op: "add",
          claim: {
            facet: IDENTITY,
            text: `${label} builds reliable systems.`,
            evidence: [
              {
                kind: "brief_material",
                materialRef: FIRST_REF,
                quote: "builds reliable systems",
              },
            ],
          },
        },
      ],
    }),
    SESSION,
    { requestId: request() },
  );

  const second = await composition.ingest.ingest(
    {
      subject: { kind: "existing", subjectId: ingested.subject.id },
      materials: [
        material(`${label}-second`, `${label} explains decisions precisely in short examples.`),
      ],
      enqueue: "now",
    },
    ACTOR,
    { requestId: request() },
  );
  const secondBrief = await composition.leases.brief({ jobId: second.job!.id }, SESSION, {
    requestId: request(),
  });
  const committed = await composition.commits.commit(
    commitInput(secondBrief, {
      operations: [
        {
          op: "add",
          claim: {
            facet: VOICE,
            text: `${label} explains decisions precisely.`,
            evidence: [
              {
                kind: "brief_material",
                materialRef: FIRST_REF,
                quote: "explains decisions precisely",
              },
            ],
          },
        },
      ],
      reviewRequest: { note: "Review this voice observation." },
    }),
    SESSION,
    { requestId: request() },
  );
  if (committed.kind !== "suspended") throw new Error("Expected a suspended candidate.");
  return { subjectId: ingested.subject.id, candidateId: committed.candidate.id };
};

const seedFirstVersionCandidate = async (
  composition: InternalEngineComposition,
  label: string,
): Promise<{ readonly subjectId: SubjectId; readonly candidateId: VersionId }> => {
  const content = `${label} builds reliable systems.`;
  const ingested = await composition.ingest.ingest(
    {
      subject: {
        kind: "create",
        input: {
          displayName: `Subject ${label}`,
          identityHints: [{ kind: "url", value: `https://example.test/people/${label}` }],
        },
      },
      materials: [material(`${label}-first-only`, content)],
      enqueue: "now",
    },
    ACTOR,
    { requestId: request() },
  );
  const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, SESSION, {
    requestId: request(),
  });
  const committed = await composition.commits.commit(
    commitInput(briefing, {
      operations: [
        {
          op: "add",
          claim: {
            facet: IDENTITY,
            text: `${label} builds reliable systems.`,
            evidence: [
              {
                kind: "brief_material",
                materialRef: FIRST_REF,
                quote: "builds reliable systems",
              },
            ],
          },
        },
      ],
      reviewRequest: { note: "Review this first profile." },
    }),
    SESSION,
    { requestId: request() },
  );
  if (committed.kind !== "suspended") throw new Error("Expected a first-version candidate.");
  return { subjectId: ingested.subject.id, candidateId: committed.candidate.id };
};

afterEach(async () => {
  for (const composition of compositions.splice(0)) composition.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  requestCounter = 1;
});

describe("SQLite ReviewQueryService", () => {
  it("returns verified active diffs with stable filtering and pagination", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-review-query-"));
    roots.push(root);
    const composition = await createInternalEngineComposition({ root });
    compositions.push(composition);
    const first = await seedCandidate(composition, "alpha");
    const second = await seedCandidate(composition, "beta");

    const page = await composition.reviews.list({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const cursor = page.nextCursor;
    if (cursor === undefined) throw new Error("Expected a second review page.");
    const next = await composition.reviews.list({ limit: 1, cursor });
    expect(next.items).toHaveLength(1);
    expect(new Set([...page.items, ...next.items].map((item) => item.candidate.id))).toEqual(
      new Set([first.candidateId, second.candidateId]),
    );
    await expect(composition.reviews.list({ subjectId: first.subjectId })).resolves.toMatchObject({
      items: [
        {
          candidate: { id: first.candidateId, status: "suspended" },
          current: { status: "current" },
          reasons: [{ code: "manual_review_requested" }],
          diff: { added: [expect.any(Object)] },
        },
      ],
    });
  });

  it("does not read unrelated pending rows while building a ReviewItem", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-review-query-scope-"));
    roots.push(root);
    const composition = await createInternalEngineComposition({ root });
    compositions.push(composition);
    const seeded = await seedCandidate(composition, "scope");
    await composition.ingest.ingest(
      {
        subject: { kind: "existing", subjectId: seeded.subjectId },
        materials: [material("scope-third", "scope records one later unreviewed observation.")],
        enqueue: "now",
      },
      ACTOR,
      { requestId: request() },
    );

    const database = new DatabaseSync(join(root, "store.sqlite3"));
    try {
      database
        .prepare("UPDATE pending_jobs SET base_version_id = NULL WHERE subject_id = ?")
        .run(seeded.subjectId);
    } finally {
      database.close();
    }

    await expect(composition.reviews.list({ subjectId: seeded.subjectId })).resolves.toMatchObject({
      items: [{ candidate: { id: seeded.candidateId } }],
    });
  });

  it("projects a first-version candidate without inventing a current baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-review-query-first-"));
    roots.push(root);
    const composition = await createInternalEngineComposition({ root });
    compositions.push(composition);
    const seeded = await seedFirstVersionCandidate(composition, "first");

    const page = await composition.reviews.list({ subjectId: seeded.subjectId });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.candidate.id).toBe(seeded.candidateId);
    expect(page.items[0]?.reasons).toEqual([
      { code: "manual_review_requested", note: "Review this first profile." },
    ]);
    expect(page.items[0]?.diff.added).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty("current");
    expect(page.items[0]?.diff).not.toHaveProperty("beforeQuality");
    expect(page.items[0]?.diff.removed).toEqual([]);
    expect(page.items[0]?.diff.changed).toEqual([]);
  });

  it("returns not_found for an unknown filtered subject and fails closed on a corrupt pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-review-query-corrupt-"));
    roots.push(root);
    const composition = await createInternalEngineComposition({ root });
    compositions.push(composition);
    const seeded = await seedFirstVersionCandidate(composition, "corrupt");

    await expect(
      composition.reviews.list({
        subjectId: `subject_${"f".repeat(32)}` as SubjectId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const database = new DatabaseSync(join(root, "store.sqlite3"));
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database
        .prepare("UPDATE subject_states SET suspended_version_id = ? WHERE subject_id = ?")
        .run(`version_${"f".repeat(64)}`, seeded.subjectId);
    } finally {
      database.close();
    }
    await expect(composition.reviews.list({ subjectId: seeded.subjectId })).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });
});
