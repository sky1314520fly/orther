import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  briefMaterialRefSchema,
  DistillyError,
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
  IsoDateTime,
  RequestId,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import type { InternalEngineComposition } from "../ingest/composition.js";
import { createInternalEngineComposition } from "../ingest/composition.js";

const AT = isoDateTimeSchema.parse("2026-08-31T17:00:00.000Z");
const LATER = isoDateTimeSchema.parse("2026-08-31T17:15:00.000Z");
const ACTOR: ActorContext = { kind: "user", id: "sqlite-review" };
const HOST_ACTOR: ActorContext = { kind: "sdk", id: "sqlite-review-distill" };
const SESSION: ClientSessionContext = {
  actor: HOST_ACTOR,
  leaseOwner: leaseOwnerIdSchema.parse("lease_owner_00000000000000000000000000000001"),
  capacity: {
    maximumInputTokens: 4_194_304,
    maximumToolResultBytes: 4_194_304,
    source: "sdk_explicit",
  },
};
const FIRST_REF = briefMaterialRefSchema.parse("m001");
const IDENTITY = facetPathSchema.parse("identity");
const VOICE = facetPathSchema.parse("voice");

class MutableClock implements Clock {
  current: IsoDateTime = AT;

  now(): IsoDateTime {
    return this.current;
  }
}

interface CurrentCandidate {
  readonly subjectId: SubjectId;
  readonly currentId: VersionId;
  readonly candidateId: VersionId;
}

const roots: string[] = [];
const compositions: InternalEngineComposition[] = [];
let requestCounter = 1;

const request = (): RequestId =>
  requestIdSchema.parse(`req_${(requestCounter++).toString(16).padStart(32, "0")}`);

const material = (label: string, content: string): IngestInput["materials"][number] => ({
  clientRef: `review-service-${label}`,
  kind: "document",
  content,
  source: {
    uri: `https://example.test/review-service/${label}`,
    medium: "document",
    access: "public",
    role: "first_party_expression",
    capturedAt: AT,
  },
  derivation: { kind: "native_text" },
});

const open = async (): Promise<{
  readonly root: string;
  readonly clock: MutableClock;
  readonly composition: InternalEngineComposition;
}> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-review-service-"));
  roots.push(root);
  const clock = new MutableClock();
  const composition = await createInternalEngineComposition({ root, clock });
  compositions.push(composition);
  return { root, clock, composition };
};

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

const createFirstVersion = async (
  composition: InternalEngineComposition,
  label: string,
  suspended = false,
): Promise<{ readonly subjectId: SubjectId; readonly versionId: VersionId }> => {
  const ingested = await composition.ingest.ingest(
    {
      subject: {
        kind: "create",
        input: {
          displayName: `Review ${label}`,
          identityHints: [{ kind: "url", value: `https://example.test/review/${label}` }],
        },
      },
      materials: [material(`${label}-first`, `${label} builds reliable local-first systems.`)],
      enqueue: "now",
    },
    HOST_ACTOR,
    { requestId: request() },
  );
  const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, SESSION, {
    requestId: request(),
  });
  const result = await composition.commits.commit(
    commitInput(briefing, {
      operations: [
        {
          op: "add",
          claim: {
            facet: IDENTITY,
            text: `${label} builds reliable local-first systems.`,
            evidence: [
              {
                kind: "brief_material",
                materialRef: FIRST_REF,
                quote: "builds reliable local-first systems",
              },
            ],
          },
        },
      ],
      ...(suspended ? { reviewRequest: { note: "Review the first profile." } } : {}),
    }),
    SESSION,
    { requestId: request() },
  );
  if (suspended) {
    if (result.kind !== "suspended") throw new Error("Expected a suspended first version.");
    return { subjectId: ingested.subject.id, versionId: result.candidate.id };
  }
  if (result.kind !== "current") throw new Error("Expected a current first version.");
  return { subjectId: ingested.subject.id, versionId: result.version.id };
};

const createCurrentCandidate = async (
  composition: InternalEngineComposition,
  label: string,
): Promise<CurrentCandidate> => {
  const first = await createFirstVersion(composition, label);
  const ingested = await composition.ingest.ingest(
    {
      subject: { kind: "existing", subjectId: first.subjectId },
      materials: [
        material(`${label}-second`, `${label} explains decisions precisely with short examples.`),
      ],
      enqueue: "now",
    },
    HOST_ACTOR,
    { requestId: request() },
  );
  const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, SESSION, {
    requestId: request(),
  });
  const result = await composition.commits.commit(
    commitInput(briefing, {
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
      reviewRequest: { note: "Review the voice profile." },
    }),
    SESSION,
    { requestId: request() },
  );
  if (result.kind !== "suspended") throw new Error("Expected a suspended candidate.");
  return {
    subjectId: first.subjectId,
    currentId: first.versionId,
    candidateId: result.candidate.id,
  };
};

const addPending = async (
  composition: InternalEngineComposition,
  subjectId: SubjectId,
  label: string,
): Promise<void> => {
  const result = await composition.ingest.ingest(
    {
      subject: { kind: "existing", subjectId },
      materials: [material(`${label}-pending`, `${label} records a later unreviewed observation.`)],
      enqueue: "now",
    },
    HOST_ACTOR,
    { requestId: request() },
  );
  if (result.job === undefined) throw new Error("Expected pending review work.");
};

const row = (
  root: string,
  sql: string,
  ...values: readonly string[]
): Readonly<Record<string, unknown>> | undefined => {
  const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
  try {
    return database.prepare(sql).get(...values);
  } finally {
    database.close();
  }
};

const rows = (
  root: string,
  sql: string,
  ...values: readonly string[]
): readonly Readonly<Record<string, unknown>>[] => {
  const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
  try {
    return database.prepare(sql).all(...values);
  } finally {
    database.close();
  }
};

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

afterEach(async () => {
  for (const composition of compositions.splice(0)) composition.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  requestCounter = 1;
});

describe("SQLite ReviewService", () => {
  it("promotes a first-version candidate and persists its direct-review reason", async () => {
    const { root, composition } = await open();
    const first = await createFirstVersion(composition, "first", true);
    const result = await composition.review.promote(
      {
        subjectId: first.subjectId,
        candidateVersionId: first.versionId,
        reason: "I reviewed the first profile.",
      },
      ACTOR,
      { requestId: request() },
    );

    expect(result).toMatchObject({ id: first.versionId, status: "current" });
    expect(
      row(
        root,
        "SELECT current_version_id AS value FROM subject_states WHERE subject_id = ?",
        first.subjectId,
      ),
    ).toEqual({ value: first.versionId });
    expect(row(root, "SELECT count(*) AS value FROM pending_jobs")).toEqual({ value: 0 });
    const events = rows(
      root,
      "SELECT event_json FROM events WHERE request_id = (SELECT request_id FROM operations WHERE method = 'versions.promote') ORDER BY sequence",
    );
    expect(JSON.parse(events[0]!.event_json as string)).toMatchObject({
      event: { kind: "version.promoted", versionId: first.versionId },
      reason: "I reviewed the first profile.",
    });
  });

  it("rebases promote pending work and reject preserves its pending row exactly", async () => {
    const promoted = await open();
    const promoteCandidate = await createCurrentCandidate(promoted.composition, "promote");
    await addPending(promoted.composition, promoteCandidate.subjectId, "promote");
    const beforePromote = row(
      promoted.root,
      "SELECT * FROM pending_jobs WHERE subject_id = ?",
      promoteCandidate.subjectId,
    )!;
    promoted.clock.current = LATER;
    await promoted.composition.review.promote(
      {
        subjectId: promoteCandidate.subjectId,
        candidateVersionId: promoteCandidate.candidateId,
      },
      ACTOR,
      { requestId: request() },
    );
    const afterPromote = row(
      promoted.root,
      "SELECT * FROM pending_jobs WHERE subject_id = ?",
      promoteCandidate.subjectId,
    )!;
    expect(afterPromote).toMatchObject({
      base_version_id: promoteCandidate.candidateId,
      added_material_count: 1,
      total_material_count: 3,
      queued_at: LATER,
    });
    expect(afterPromote.job_id).not.toBe(beforePromote.job_id);

    const rejected = await open();
    const rejectCandidate = await createCurrentCandidate(rejected.composition, "reject");
    await addPending(rejected.composition, rejectCandidate.subjectId, "reject");
    const beforeReject = row(
      rejected.root,
      "SELECT * FROM pending_jobs WHERE subject_id = ?",
      rejectCandidate.subjectId,
    );
    await rejected.composition.review.reject(
      {
        subjectId: rejectCandidate.subjectId,
        candidateVersionId: rejectCandidate.candidateId,
        reason: "The evidence is too weak.",
      },
      ACTOR,
      { requestId: request() },
    );
    expect(
      row(
        rejected.root,
        "SELECT * FROM pending_jobs WHERE subject_id = ?",
        rejectCandidate.subjectId,
      ),
    ).toEqual(beforeReject);
    const rejectEvent = rows(
      rejected.root,
      "SELECT event_json FROM events WHERE request_id = (SELECT request_id FROM operations WHERE method = 'versions.reject') ORDER BY sequence",
    );
    expect(JSON.parse(rejectEvent[0]!.event_json as string)).toMatchObject({
      event: { kind: "version.rejected", versionId: rejectCandidate.candidateId },
      reason: "The evidence is too weak.",
    });
  });

  it("creates rollback pending without an old job and replays promote after it becomes historical", async () => {
    const { root, clock, composition } = await open();
    const candidate = await createCurrentCandidate(composition, "history");
    const promoteRequest = request();
    const promoteInput = {
      subjectId: candidate.subjectId,
      candidateVersionId: candidate.candidateId,
      reason: "Promote after review.",
    };
    const promoted = await composition.review.promote(promoteInput, ACTOR, {
      requestId: promoteRequest,
    });
    expect(row(root, "SELECT count(*) AS value FROM pending_jobs")).toEqual({ value: 0 });

    clock.current = LATER;
    const rolledBack = await composition.review.rollback(
      {
        subjectId: candidate.subjectId,
        targetVersionId: candidate.currentId,
        reason: "Restore the earlier profile.",
      },
      ACTOR,
      { requestId: request() },
    );
    expect(rolledBack).toMatchObject({
      status: "current",
      parentId: candidate.candidateId,
      creation: { kind: "rollback", targetVersionId: candidate.currentId },
      actor: ACTOR,
      createdAt: LATER,
    });
    expect(rolledBack.id).not.toBe(candidate.currentId);
    expect(
      row(root, "SELECT * FROM pending_jobs WHERE subject_id = ?", candidate.subjectId),
    ).toMatchObject({
      base_version_id: rolledBack.id,
      added_material_count: 1,
      total_material_count: 2,
      queued_at: LATER,
    });
    await expect(
      composition.review.promote(promoteInput, ACTOR, { requestId: promoteRequest }),
    ).resolves.toEqual(promoted);
    expect(
      row(root, "SELECT status AS value FROM version_statuses WHERE version_id = ?", promoted.id),
    ).toEqual({ value: "historical" });
    const rollbackEvent = rows(
      root,
      "SELECT event_json FROM events WHERE request_id = (SELECT request_id FROM operations WHERE method = 'versions.rollback') ORDER BY sequence",
    );
    expect(JSON.parse(rollbackEvent[0]!.event_json as string)).toMatchObject({
      event: { kind: "version.rolled_back", versionId: rolledBack.id },
      reason: "Restore the earlier profile.",
      relatedVersionId: candidate.currentId,
    });
  });

  it("returns narrow errors for active, current, rejected, missing, and cross-subject targets", async () => {
    const active = await open();
    const activeCandidate = await createCurrentCandidate(active.composition, "active");
    await expectCode(
      active.composition.review.rollback(
        {
          subjectId: activeCandidate.subjectId,
          targetVersionId: activeCandidate.candidateId,
          reason: "Blocked while active.",
        },
        ACTOR,
        { requestId: request() },
      ),
      "review_conflict",
    );

    await active.composition.review.reject(
      {
        subjectId: activeCandidate.subjectId,
        candidateVersionId: activeCandidate.candidateId,
      },
      ACTOR,
      { requestId: request() },
    );
    await expectCode(
      active.composition.review.rollback(
        {
          subjectId: activeCandidate.subjectId,
          targetVersionId: activeCandidate.candidateId,
          reason: "Rejected target.",
        },
        ACTOR,
        { requestId: request() },
      ),
      "invalid_input",
    );
    await expectCode(
      active.composition.review.rollback(
        {
          subjectId: activeCandidate.subjectId,
          targetVersionId: activeCandidate.currentId,
          reason: "Current target.",
        },
        ACTOR,
        { requestId: request() },
      ),
      "invalid_input",
    );
    await expectCode(
      active.composition.review.rollback(
        {
          subjectId: activeCandidate.subjectId,
          targetVersionId: `version_${"f".repeat(64)}` as VersionId,
          reason: "Missing target.",
        },
        ACTOR,
        { requestId: request() },
      ),
      "not_found",
    );

    const foreign = await createFirstVersion(active.composition, "foreign");
    await expectCode(
      active.composition.review.rollback(
        {
          subjectId: activeCandidate.subjectId,
          targetVersionId: foreign.versionId,
          reason: "Cross-subject target.",
        },
        ACTOR,
        { requestId: request() },
      ),
      "invalid_input",
    );
  });
});
