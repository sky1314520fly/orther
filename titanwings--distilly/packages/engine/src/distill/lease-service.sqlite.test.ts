import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  DistillyError,
  requestIdSchema,
  type ActorContext,
  type ClientSessionContext,
  type EventId,
  type IngestInput,
  type IsoDateTime,
  type JobId,
  type LeaseId,
  type LeaseOwnerId,
  type MaterialRecord,
  type RequestId,
  type SpaceId,
  type SubjectId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { computeFactChecksum } from "../facts/checksum.js";
import type { InternalEngineComposition } from "../ingest/composition.js";
import { createInternalEngineComposition } from "../ingest/composition.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { PromptCatalog } from "./prompt-catalog.js";

const AT = "2026-08-31T10:30:00.000Z" as IsoDateTime;
const ACTOR: ActorContext = { kind: "sdk", id: "sqlite-lease-test" };

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

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-sqlite-lease-"));
  roots.push(root);
  return root;
};

const request = (digit: number): RequestId =>
  requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

const session = (owner = 1, maximum = 4_194_304): ClientSessionContext => ({
  actor: ACTOR,
  leaseOwner: `lease_owner_${owner.toString(16).padStart(32, "0")}` as LeaseOwnerId,
  capacity: {
    maximumInputTokens: maximum,
    maximumToolResultBytes: maximum,
    source: "sdk_explicit",
  },
});

const createInput = (name = "Ada Lovelace", suffix = "ada"): IngestInput => ({
  subject: {
    kind: "create",
    input: {
      displayName: name,
      aliases: [name.split(" ")[0]!],
      identityHints: [{ kind: "url", value: `https://example.test/${suffix}` }],
    },
  },
  materials: [
    {
      clientRef: `source-${suffix}`,
      kind: "web",
      content: `${name} has a documented working method for ${suffix}.`,
      source: {
        uri: `https://example.test/${suffix}`,
        medium: "article",
        access: "public",
        role: "reference",
        capturedAt: AT,
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
});

const additionalInput = (subjectId: SubjectId, suffix: string): IngestInput => ({
  subject: { kind: "existing", subjectId },
  materials: [
    {
      clientRef: `additional-${suffix}`,
      kind: "document",
      content: `Additional verified material for ${suffix}.`,
      source: {
        uri: `https://example.test/${suffix}/additional`,
        medium: "document",
        access: "private",
        role: "reference",
        capturedAt: AT,
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
});

const open = async (
  root: string,
  ids: SequenceIds,
  clock: FakeClock,
  options: Parameters<typeof createInternalEngineComposition>[0] = { root },
): Promise<InternalEngineComposition> => {
  const composition = await createInternalEngineComposition({
    ...options,
    root,
    ids,
    clock,
  });
  compositions.push(composition);
  return composition;
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

const execute = (root: string, sql: string, ...values: (string | number)[]): void => {
  const database = new DatabaseSync(join(root, "store.sqlite3"));
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
};

const storedMaterial = (
  root: string,
): { readonly record: MaterialRecord; readonly identity: Record<string, unknown> } => {
  const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
  try {
    const row = database
      .prepare("SELECT record_json, identity_json FROM materials LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("expected a stored material");
    return {
      record: JSON.parse(String(row.record_json)) as MaterialRecord,
      identity: JSON.parse(String(row.identity_json)) as Record<string, unknown>,
    };
  } finally {
    database.close();
  }
};

const resealRecord = (record: MaterialRecord): MaterialRecord => {
  const payload = { ...record } as Record<string, unknown>;
  delete payload.checksum;
  return { ...payload, checksum: computeFactChecksum(payload) } as unknown as MaterialRecord;
};

const rejectCode = async (promise: Promise<unknown>, code: string): Promise<DistillyError> => {
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

describe("SQLite distillation leases", () => {
  it("stores a blob-backed brief atomically and replays it after exact expiry", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    expect(ingest.job).toBeDefined();

    await expect(composition.leases.pending({})).resolves.toMatchObject([
      { id: ingest.job!.id, state: "pending" },
    ]);
    const briefing = await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });
    expect(briefing).toMatchObject({
      job: { id: ingest.job!.id, state: "leased" },
      subject: { id: ingest.subject.id },
      materials: [{ ref: "m001" }],
      limits: { maximumOutputBytes: 65_536 },
    });
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(1);
    expect(scalar(root, "SELECT count(*) AS value FROM operation_result_blobs")).toBe(1);
    expect(
      scalar(
        root,
        `SELECT count(*) AS value
         FROM operation_result_blobs
         JOIN blobs ON blobs.digest = operation_result_blobs.blob_digest
         WHERE operation_result_blobs.request_id = ?`,
        request(2),
      ),
    ).toBe(1);

    clock.current = briefing.lease.expiresAt;
    await expect(composition.leases.pending({ state: "pending" })).resolves.toMatchObject([
      { id: ingest.job!.id, state: "pending" },
    ]);
    await expect(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
    ).resolves.toEqual(briefing);
    expect(scalar(root, "SELECT count(*) AS value FROM operations")).toBe(2);
    expect(scalar(root, "SELECT count(*) AS value FROM events")).toBe(4);
  });

  it("starts a full lease lifetime from fresh time inside the write transaction", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const transactionAt = "2026-08-31T12:15:00.000Z" as IsoDateTime;
    const composition = await open(root, ids, clock, {
      root,
      leaseHooks: {
        beforeBriefTransaction: () => {
          clock.current = transactionAt;
        },
      },
    });
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });

    const briefing = await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    expect(briefing.lease).toMatchObject({
      acquiredAt: transactionAt,
      expiresAt: "2026-08-31T12:45:00.000Z",
    });
    expect(briefing.job.leaseExpiresAt).toBe(briefing.lease.expiresAt);
    expect(briefing.limits.estimatedInputTokens).toBe(
      new TextEncoder().encode(canonicalJson(briefing)).byteLength,
    );
  });

  it("replays exactly without consulting the current pending row or prompt catalog", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const briefing = await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });
    composition.close();
    compositions.splice(compositions.indexOf(composition), 1);
    execute(root, "DELETE FROM pending_jobs WHERE job_id = ?", ingest.job!.id);

    const reopened = await open(root, new SequenceIds(), clock, {
      root,
      promptCatalog: new PromptCatalog(pathToFileURL(join(root, "missing-prompt.md"))),
    });
    await expect(
      reopened.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
    ).resolves.toEqual(briefing);
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(0);
  });

  it("treats exact expiry as inactive and lets a new owner replace the expired lease", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const first = await composition.leases.brief({ jobId: ingest.job!.id }, session(1), {
      requestId: request(2),
    });

    clock.current = first.lease.expiresAt;
    await rejectCode(
      composition.leases.renew({ jobId: ingest.job!.id, leaseId: first.lease.id }, session(1), {
        requestId: request(3),
      }),
      "lease_expired",
    );
    await rejectCode(
      composition.leases.release(
        { jobId: ingest.job!.id, leaseId: first.lease.id, reason: "yield" },
        session(1),
        { requestId: request(4) },
      ),
      "lease_expired",
    );

    const replacement = await composition.leases.brief({ jobId: ingest.job!.id }, session(2), {
      requestId: request(5),
    });
    expect(replacement.lease).toMatchObject({
      owner: session(2).leaseOwner,
      acquiredAt: first.lease.expiresAt,
    });
    expect(replacement.lease.id).not.toBe(first.lease.id);
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(1);
  });

  it("rejects a replay whose result-blob authority has been tampered with", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    execute(
      root,
      `UPDATE operation_result_blobs
       SET byte_length = byte_length + 1
       WHERE request_id = ?`,
      request(2),
    );
    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
      "storage_corrupt",
    );
  });

  it("fails closed when legal brief template pointers or envelopes are swapped across rows", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const first = await composition.ingest.ingest(createInput("Ada One", "one"), ACTOR, {
      requestId: request(1),
    });
    const second = await composition.ingest.ingest(createInput("Ada Two", "two"), ACTOR, {
      requestId: request(2),
    });
    await composition.leases.brief({ jobId: first.job!.id }, session(), {
      requestId: request(3),
    });
    await composition.leases.brief({ jobId: second.job!.id }, session(), {
      requestId: request(4),
    });
    const firstDigest = String(
      scalar(
        root,
        "SELECT blob_digest AS value FROM operation_result_blobs WHERE request_id = ?",
        request(3),
      ),
    );
    const secondDigest = String(
      scalar(
        root,
        "SELECT blob_digest AS value FROM operation_result_blobs WHERE request_id = ?",
        request(4),
      ),
    );
    const firstLength = Number(
      scalar(
        root,
        "SELECT byte_length AS value FROM operation_result_blobs WHERE request_id = ?",
        request(3),
      ),
    );
    const secondLength = Number(
      scalar(
        root,
        "SELECT byte_length AS value FROM operation_result_blobs WHERE request_id = ?",
        request(4),
      ),
    );
    const firstEnvelope = String(
      scalar(root, "SELECT result_json AS value FROM operations WHERE request_id = ?", request(3)),
    );
    const secondEnvelope = String(
      scalar(root, "SELECT result_json AS value FROM operations WHERE request_id = ?", request(4)),
    );

    execute(
      root,
      "UPDATE operation_result_blobs SET blob_digest = ?, byte_length = ? WHERE request_id = ?",
      secondDigest,
      secondLength,
      request(3),
    );
    await rejectCode(
      composition.leases.brief({ jobId: first.job!.id }, session(), { requestId: request(3) }),
      "storage_corrupt",
    );
    execute(
      root,
      "UPDATE operation_result_blobs SET blob_digest = ?, byte_length = ? WHERE request_id = ?",
      firstDigest,
      firstLength,
      request(3),
    );

    execute(
      root,
      "UPDATE operations SET result_json = ? WHERE request_id = ?",
      secondEnvelope,
      request(3),
    );
    execute(
      root,
      "UPDATE operations SET result_json = ? WHERE request_id = ?",
      firstEnvelope,
      request(4),
    );
    execute(
      root,
      "UPDATE operation_result_blobs SET blob_digest = ?, byte_length = ? WHERE request_id = ?",
      secondDigest,
      secondLength,
      request(3),
    );
    execute(
      root,
      "UPDATE operation_result_blobs SET blob_digest = ?, byte_length = ? WHERE request_id = ?",
      firstDigest,
      firstLength,
      request(4),
    );
    await rejectCode(
      composition.leases.brief({ jobId: first.job!.id }, session(), { requestId: request(3) }),
      "storage_corrupt",
    );
    await rejectCode(
      composition.leases.brief({ jobId: second.job!.id }, session(), { requestId: request(4) }),
      "storage_corrupt",
    );
  });

  it("rejects a canonically encoded material record with an invalid fact checksum", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const { record } = storedMaterial(root);
    const tampered = {
      ...record,
      checksum: `fact_sha256_${"0".repeat(64)}`,
    };
    execute(root, "UPDATE materials SET record_json = ?", canonicalJson(tampered));

    const error = await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
      "storage_corrupt",
    );
    expect(error.message).toContain("Fact checksum");
  });

  it.each([
    ["kind", "UPDATE materials SET kind = 'document'"],
    ["source identity", "UPDATE materials SET source_identity = CAST('changed' AS BLOB)"],
    ["identity JSON", "UPDATE materials SET identity_json = '{}'"],
    ["stored timestamp", "UPDATE materials SET stored_at = '2026-09-01T10:30:00.000Z'"],
  ])("rejects a material whose canonical %s column was tampered with", async (_label, sql) => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    execute(root, sql);

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
      "storage_corrupt",
    );
  });

  it("rejects a resealed record whose deterministic provenance identity was tampered with", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const stored = storedMaterial(root);
    const source = { ...stored.record.source, access: "private" as const };
    const record = resealRecord({ ...stored.record, source });
    const identity = {
      ...stored.identity,
      source: { ...(stored.identity.source as Record<string, unknown>), access: "private" },
    };
    execute(
      root,
      "UPDATE materials SET record_json = ?, identity_json = ?",
      canonicalJson(record),
      canonicalJson(identity),
    );

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
      "storage_corrupt",
    );
  });

  it("rejects a resealed record whose deterministic material id was tampered with", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const stored = storedMaterial(root);
    const sourceIdentity = "source-uri-v1\0https://example.test/changed";
    const record = resealRecord({ ...stored.record, sourceIdentity });
    const identity = { ...stored.identity, sourceIdentity };
    execute(
      root,
      `UPDATE materials
       SET source_identity = CAST(? AS BLOB), record_json = ?, identity_json = ?`,
      sourceIdentity,
      canonicalJson(record),
      canonicalJson(identity),
    );

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
      "storage_corrupt",
    );
  });

  it("rejects material content whose bytes disagree with the deterministic content digest", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const digest = ingest.items[0]!.contentDigest;
    const hexadecimal = digest.slice("sha256_".length);
    await writeFile(join(root, "blobs", "sha256", hexadecimal.slice(0, 2), digest), "corrupt");

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
      "storage_corrupt",
    );
  });

  it("recomputes the complete material-set hash before building a briefing", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const tamperedHash = `set_sha256_${"f".repeat(64)}`;
    execute(root, "UPDATE subject_states SET material_set_hash = ?", tamperedHash);
    execute(root, "UPDATE pending_jobs SET material_set_hash = ?", tamperedHash);

    const error = await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
      "storage_corrupt",
    );
    expect(error.message).toContain("material-set hash");
  });

  it("fails capacity checks without writing lease, operation, event, or result reference", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const operationsBefore = scalar(root, "SELECT count(*) AS value FROM operations");
    const eventsBefore = scalar(root, "SELECT count(*) AS value FROM events");

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(1, 1), {
        requestId: request(2),
      }),
      "briefing_too_large",
    );
    await rejectCode(
      composition.leases.brief(
        { jobId: ingest.job!.id },
        { actor: ACTOR, leaseOwner: session().leaseOwner },
        { requestId: request(3) },
      ),
      "host_unsupported",
    );
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(0);
    expect(scalar(root, "SELECT count(*) AS value FROM operation_result_blobs")).toBe(0);
    expect(scalar(root, "SELECT count(*) AS value FROM operations")).toBe(operationsBefore);
    expect(scalar(root, "SELECT count(*) AS value FROM events")).toBe(eventsBefore);
  });

  it("allows only one concurrent owner and binds RequestId to owner, capacity, actor, and method", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });

    const attempts = await Promise.allSettled([
      composition.leases.brief({ jobId: ingest.job!.id }, session(1), {
        requestId: request(2),
      }),
      composition.leases.brief({ jobId: ingest.job!.id }, session(2), {
        requestId: request(3),
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "lease_conflict" });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("expected one accepted briefing");

    const firstOwnerWon = accepted.value.lease.owner === session(1).leaseOwner;
    const acceptedRequest = firstOwnerWon ? request(2) : request(3);
    const acceptedSession = firstOwnerWon ? session(1) : session(2);
    if (acceptedSession.capacity === undefined) throw new Error("expected accepted capacity");
    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(firstOwnerWon ? 2 : 1), {
        requestId: acceptedRequest,
      }),
      "idempotency_conflict",
    );
    await rejectCode(
      composition.leases.brief(
        { jobId: ingest.job!.id },
        {
          ...acceptedSession,
          capacity: { ...acceptedSession.capacity, maximumInputTokens: 4_000_000 },
        },
        { requestId: acceptedRequest },
      ),
      "idempotency_conflict",
    );
    await rejectCode(
      composition.leases.brief(
        { jobId: ingest.job!.id },
        { ...acceptedSession, actor: { kind: "sdk", id: "other" } },
        { requestId: acceptedRequest },
      ),
      "idempotency_conflict",
    );
    await rejectCode(
      composition.leases.renew(
        { jobId: ingest.job!.id, leaseId: accepted.value.lease.id },
        acceptedSession,
        { requestId: acceptedRequest },
      ),
      "idempotency_conflict",
    );
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(1);
    expect(scalar(root, "SELECT count(*) AS value FROM operation_result_blobs")).toBe(1);
  });

  it("renews and releases by active owner with stable replay", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const briefing = await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    await rejectCode(
      composition.leases.renew({ jobId: ingest.job!.id, leaseId: briefing.lease.id }, session(2), {
        requestId: request(3),
      }),
      "lease_conflict",
    );
    clock.current = "2026-08-31T10:45:00.000Z" as IsoDateTime;
    const renewed = await composition.leases.renew(
      { jobId: ingest.job!.id, leaseId: briefing.lease.id },
      session(),
      { requestId: request(4) },
    );
    expect(renewed).toMatchObject({
      id: briefing.lease.id,
      acquiredAt: briefing.lease.acquiredAt,
      expiresAt: "2026-08-31T11:15:00.000Z",
    });
    clock.current = "2026-08-31T10:46:00.000Z" as IsoDateTime;
    await expect(
      composition.leases.renew({ jobId: ingest.job!.id, leaseId: briefing.lease.id }, session(), {
        requestId: request(4),
      }),
    ).resolves.toEqual(renewed);
    clock.current = "2026-08-31T10:50:00.000Z" as IsoDateTime;
    await expect(
      composition.leases.release(
        { jobId: ingest.job!.id, leaseId: briefing.lease.id, reason: "yield" },
        session(),
        { requestId: request(5) },
      ),
    ).resolves.toBeNull();
    clock.current = "2026-08-31T12:00:00.000Z" as IsoDateTime;
    await expect(
      composition.leases.release(
        { jobId: ingest.job!.id, leaseId: briefing.lease.id, reason: "yield" },
        session(),
        { requestId: request(5) },
      ),
    ).resolves.toBeNull();
    await expect(composition.leases.pending({})).resolves.toMatchObject([
      { id: ingest.job!.id, state: "pending" },
    ]);
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(0);
    expect(scalar(root, "SELECT count(*) AS value FROM operations")).toBe(4);
    expect(scalar(root, "SELECT count(*) AS value FROM events")).toBe(6);
  });

  it("preserves a lease across duplicate ingest and cascades it when generation changes", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const original = createInput();
    const ingest = await composition.ingest.ingest(original, ACTOR, { requestId: request(1) });
    const briefing = await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    const duplicate = await composition.ingest.ingest(
      { ...original, subject: { kind: "existing", subjectId: ingest.subject.id } },
      ACTOR,
      { requestId: request(3) },
    );
    expect(duplicate.job?.id).toBe(ingest.job!.id);
    await expect(composition.leases.pending({ state: "leased" })).resolves.toMatchObject([
      { id: ingest.job!.id, leaseExpiresAt: briefing.lease.expiresAt },
    ]);

    const changed = await composition.ingest.ingest(
      additionalInput(ingest.subject.id, "ada-2"),
      ACTOR,
      { requestId: request(4) },
    );
    expect(changed.job?.id).not.toBe(ingest.job!.id);
    expect(changed.generation).toBe(ingest.generation + 1);
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(0);
    await rejectCode(
      composition.leases.renew({ jobId: ingest.job!.id, leaseId: briefing.lease.id }, session(), {
        requestId: request(5),
      }),
      "nothing_pending",
    );
  });

  it("rejects a brief whose generation changes during precomputation", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    let prepared: (() => void) | undefined;
    let resume: (() => void) | undefined;
    const preparedPromise = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const resumePromise = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const composition = await open(root, ids, clock, {
      root,
      leaseHooks: {
        beforeBriefTransaction: async () => {
          prepared?.();
          await resumePromise;
        },
      },
    });
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const briefPromise = composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });
    await preparedPromise;
    const changed = await composition.ingest.ingest(
      additionalInput(ingest.subject.id, "race"),
      ACTOR,
      { requestId: request(3) },
    );
    resume?.();
    await rejectCode(briefPromise, "stale_job");
    expect(changed.job).toBeDefined();
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(0);
    expect(
      scalar(
        root,
        "SELECT count(*) AS value FROM operation_result_blobs WHERE request_id = ?",
        request(2),
      ),
    ).toBe(0);
  });

  it("rolls back every authority row when the brief transaction fails before COMMIT", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock, {
      root,
      leaseHooks: {
        beforeTransactionCommit: (method) => {
          if (method === "distill.brief") throw new Error("simulated crash before commit");
        },
      },
    });
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    await expect(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), { requestId: request(2) }),
    ).rejects.toThrow("simulated crash before commit");
    expect(scalar(root, "SELECT count(*) AS value FROM job_leases")).toBe(0);
    expect(
      scalar(root, "SELECT count(*) AS value FROM operations WHERE request_id = ?", request(2)),
    ).toBe(0);
    expect(
      scalar(
        root,
        "SELECT count(*) AS value FROM operation_result_blobs WHERE request_id = ?",
        request(2),
      ),
    ).toBe(0);
    expect(
      scalar(root, "SELECT count(*) AS value FROM events WHERE request_id = ?", request(2)),
    ).toBe(0);
  });

  it("filters before limit and orders by queue time then binary JobId", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    clock.current = "2026-08-31T10:32:00.000Z" as IsoDateTime;
    const first = await composition.ingest.ingest(createInput("Ada One", "one"), ACTOR, {
      requestId: request(1),
    });
    clock.current = "2026-08-31T10:31:00.000Z" as IsoDateTime;
    const second = await composition.ingest.ingest(createInput("Ada Two", "two"), ACTOR, {
      requestId: request(2),
    });
    const third = await composition.ingest.ingest(createInput("Ada Three", "three"), ACTOR, {
      requestId: request(3),
    });
    expect((await composition.leases.pending({})).map((job) => job.id)).toEqual([
      second.job!.id,
      third.job!.id,
      first.job!.id,
    ]);
    await composition.leases.brief({ jobId: second.job!.id }, session(), { requestId: request(4) });
    await expect(composition.leases.pending({ state: "pending", limit: 1 })).resolves.toMatchObject(
      [{ id: third.job!.id, state: "pending" }],
    );
    await expect(
      composition.leases.pending({ subjectId: first.subject.id, limit: 1 }),
    ).resolves.toMatchObject([{ id: first.job!.id }]);
  });

  it("does not validate unrelated pending rows excluded by the SQL filter", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const first = await composition.ingest.ingest(createInput("Ada One", "one"), ACTOR, {
      requestId: request(1),
    });
    const second = await composition.ingest.ingest(createInput("Ada Two", "two"), ACTOR, {
      requestId: request(2),
    });
    execute(
      root,
      "UPDATE pending_jobs SET queued_at = 'not-an-iso-date' WHERE job_id = ?",
      second.job!.id,
    );

    await expect(
      composition.leases.pending({ subjectId: first.subject.id }),
    ).resolves.toMatchObject([{ id: first.job!.id }]);
    await expect(composition.leases.pending({ state: "failed", limit: 1 })).resolves.toEqual([]);
    await rejectCode(composition.leases.pending({}), "storage_corrupt");
  });

  it("returns boundary and storage failures from pending as rejected promises", async () => {
    const root = await temporaryRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });

    const invalid = composition.leases.pending({ limit: 0 });
    expect(invalid).toBeInstanceOf(Promise);
    await rejectCode(invalid, "invalid_input");

    execute(
      root,
      "UPDATE pending_jobs SET queued_at = 'not-an-iso-date' WHERE job_id = ?",
      ingest.job!.id,
    );
    const corrupt = composition.leases.pending({});
    expect(corrupt).toBeInstanceOf(Promise);
    await rejectCode(corrupt, "storage_corrupt");
  });
});
