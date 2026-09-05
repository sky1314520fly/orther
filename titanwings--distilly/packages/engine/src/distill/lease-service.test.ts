import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DistillyError,
  operationFactSchema,
  requestIdSchema,
  type ActorContext,
  type ClientSessionContext,
  type EngineEvent,
  type EventId,
  type IngestInput,
  type IsoDateTime,
  type JobId,
  type LeaseId,
  type LeaseOwnerId,
  type OperationFact,
  type OperationRecord,
  type RequestId,
  type RuntimeSchema,
  type SpaceId,
  type SubjectId,
  type SubjectStateRecord,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { InProcessEventBus } from "../defaults/in-process-event-bus.js";
import type { Clock } from "../defaults/system-clock.js";
import { sealFact } from "../facts/checksum.js";
import { replaceFactFile } from "../facts/fact-file.js";
import { FileMaterialStore } from "../facts/material-store.js";
import { FileOperationStore } from "../facts/operation-store.js";
import { FileSpaceStore } from "../facts/space-store.js";
import { FileStateStore } from "../facts/state-store.js";
import { FileSubjectStore } from "../facts/subject-store.js";
import { FileTransactionStore } from "../testing/legacy-file-transaction-store.test.fixture.js";
import { Layout } from "../layout.js";
import type { IdGenerator } from "../ports/id-generator.js";
import {
  createLegacyFileEngineTestSupport,
  type LegacyFileEngineTestSupport,
} from "../testing/legacy-file-engine.test.fixture.js";
import type { RecoveryHooks } from "../testing/legacy-file-recovery.test.fixture.js";
import type { LegacyFileDistillLeaseServiceHooks } from "../testing/legacy-file-lease-service.test.fixture.js";

const AT = "2026-08-20T10:30:00.000Z" as IsoDateTime;
const ACTOR: ActorContext = { kind: "sdk", id: "step6-integration" };
const OPERATION_FACT_SCHEMA: RuntimeSchema<OperationFact> = {
  parse(value) {
    return operationFactSchema.parse(value) as OperationFact;
  },
};
const roots: string[] = [];

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
    return `space_${(this.space++ + 1).toString(16).padStart(32, "0")}` as SpaceId;
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

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-lease-service-"));
  roots.push(root);
  return root;
};

const request = (digit: number): RequestId =>
  requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

const session = (ownerDigit = 1, maximum = 1_000_000): ClientSessionContext => ({
  actor: ACTOR,
  leaseOwner: `lease_owner_${ownerDigit.toString(16).padStart(32, "0")}` as LeaseOwnerId,
  capacity: {
    maximumInputTokens: maximum,
    maximumToolResultBytes: maximum,
    source: "sdk_explicit",
  },
});

const createInput = (): IngestInput => ({
  subject: {
    kind: "create",
    input: {
      displayName: "Ada Lovelace",
      aliases: ["Ada"],
      identityHints: [{ kind: "url", value: "https://example.com/ada" }],
    },
  },
  materials: [
    {
      clientRef: "source-1",
      kind: "web",
      content: "Ada designed the Analytical Engine's first published algorithm.",
      source: {
        uri: "https://example.com/ada",
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

const stores = (root: string) => {
  const layout = new Layout(root);
  const spaces = new FileSpaceStore(layout);
  const subjects = new FileSubjectStore(layout, spaces);
  const materials = new FileMaterialStore(layout, subjects);
  return {
    layout,
    states: new FileStateStore(layout, subjects, materials),
    operations: new FileOperationStore(layout, subjects),
    transactions: new FileTransactionStore(layout),
  };
};

const open = async (
  root: string,
  ids: SequenceIds,
  clock: FakeClock,
  options: {
    readonly leaseHooks?: LegacyFileDistillLeaseServiceHooks;
    readonly recoveryHooks?: RecoveryHooks;
    readonly published?: EngineEvent[];
  } = {},
): Promise<LegacyFileEngineTestSupport> => {
  const eventBus = new InProcessEventBus();
  if (options.published !== undefined) {
    eventBus.subscribe((event) => {
      options.published?.push(event);
    });
  }
  return createLegacyFileEngineTestSupport({
    root,
    ids,
    clock,
    eventBus,
    ...(options.leaseHooks === undefined ? {} : { leaseHooks: options.leaseHooks }),
    ...(options.recoveryHooks === undefined ? {} : { recoveryHooks: options.recoveryHooks }),
  });
};

const rejectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

const failOnce = (): (() => void) => {
  let failed = false;
  return () => {
    if (failed) return;
    failed = true;
    throw new Error("simulated process crash");
  };
};

const createPending = async (composition: LegacyFileEngineTestSupport, requestId = request(1)) => {
  const result = await composition.ingest.ingest(createInput(), ACTOR, { requestId });
  if (result.job === undefined) throw new Error("expected enqueue=now to create a pending job");
  return result;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DistillLeaseService", () => {
  it("persists and exactly replays a complete first-version briefing lease", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const published: EngineEvent[] = [];
    const composition = await open(root, ids, clock, { published });
    const ingest = await createPending(composition);
    const briefing = await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    expect(briefing).toMatchObject({
      job: {
        id: ingest.job!.id,
        generation: ingest.generation,
        state: "leased",
        leaseExpiresAt: "2026-08-20T11:00:00.000Z",
      },
      lease: {
        jobId: ingest.job!.id,
        owner: session().leaseOwner,
        acquiredAt: AT,
        expiresAt: "2026-08-20T11:00:00.000Z",
      },
      materials: [{ ref: "m001" }],
    });
    expect(briefing.baseline).toBeUndefined();
    expect(briefing.limits.estimatedInputTokens).toBeGreaterThan(0);
    expect(await composition.leases.pending({})).toEqual([briefing.job]);

    const facts = stores(root);
    await expect(facts.states.read(ingest.subject.id)).resolves.toMatchObject({
      pending: {
        jobId: ingest.job!.id,
        lease: {
          id: briefing.lease.id,
          owner: session().leaseOwner,
          contract: { digest: briefing.contract.digest },
        },
      },
    });
    await expect(facts.operations.read(request(2))).resolves.toMatchObject({
      method: "distill.brief",
      result: briefing,
    });
    await expect(facts.transactions.read(request(2))).resolves.toMatchObject({
      transactionKind: "distill_lease",
      method: "brief",
      state: "committed",
    });
    expect(published.filter((event) => event.kind === "job.changed")).toHaveLength(2);

    await expect(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(2),
      }),
    ).resolves.toEqual(briefing);
    expect(published.filter((event) => event.kind === "job.changed")).toHaveLength(2);
  }, 45_000);

  it("rejects a committed journal whose completed operation has a different checksum", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await createPending(composition);
    await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    const facts = stores(root);
    const stored = await facts.operations.read(request(2));
    if (stored.recordKind !== "completed") throw new Error("Expected a completed operation.");
    const { checksum: _checksum, ...payload } = stored;
    void _checksum;
    const hostile = sealFact<OperationRecord>({
      ...payload,
      completedAt: "2026-08-20T10:31:00.000Z" as IsoDateTime,
    });
    await replaceFactFile(
      root,
      facts.layout.operationFile(request(2)),
      hostile,
      OPERATION_FACT_SCHEMA,
    );

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
    await expect(facts.transactions.read(request(2))).resolves.toMatchObject({
      state: "committed",
    });
  }, 45_000);

  it("reports missing briefing capacity before disclosing missing or active job state", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const published: EngineEvent[] = [];
    const composition = await open(root, ids, clock, { published });
    const noCapacity = { actor: ACTOR, leaseOwner: session().leaseOwner };
    const missingJobId = `job_${"f".repeat(32)}` as JobId;

    await rejectCode(
      composition.leases.brief({ jobId: missingJobId }, noCapacity, {
        requestId: request(1),
      }),
      "host_unsupported",
    );
    const facts = stores(root);
    await expect(facts.operations.readOptional(request(1))).resolves.toBeUndefined();
    await expect(facts.transactions.readOptional(request(1))).resolves.toBeUndefined();

    const ingest = await createPending(composition, request(2));
    await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(3),
    });
    const before = await facts.states.read(ingest.subject.id);
    const publishedCount = published.length;
    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, noCapacity, {
        requestId: request(4),
      }),
      "host_unsupported",
    );
    await expect(facts.operations.readOptional(request(4))).resolves.toBeUndefined();
    await expect(facts.transactions.readOptional(request(4))).resolves.toBeUndefined();
    await expect(facts.states.read(ingest.subject.id)).resolves.toEqual(before);
    expect(published).toHaveLength(publishedCount);
  }, 45_000);

  it("rejects missing or insufficient capacity before any lease fact is written", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await createPending(composition);
    const noCapacity = { actor: ACTOR, leaseOwner: session().leaseOwner };

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, noCapacity, {
        requestId: request(2),
      }),
      "host_unsupported",
    );
    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(1, 1), {
        requestId: request(3),
      }),
      "briefing_too_large",
    );

    const facts = stores(root);
    await expect(facts.operations.readOptional(request(2))).resolves.toBeUndefined();
    await expect(facts.operations.readOptional(request(3))).resolves.toBeUndefined();
    await expect(facts.transactions.readOptional(request(2))).resolves.toBeUndefined();
    await expect(facts.transactions.readOptional(request(3))).resolves.toBeUndefined();
    await expect(facts.states.read(ingest.subject.id)).resolves.toMatchObject({
      pending: { jobId: ingest.job!.id },
    });
    expect((await facts.states.read(ingest.subject.id)).pending).not.toHaveProperty("lease");
  }, 45_000);

  it("enforces active ownership, exact expiry, renewal, and release without replacing the job", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await createPending(composition);
    const briefing = await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(3),
      }),
      "lease_conflict",
    );
    await rejectCode(
      composition.leases.renew({ jobId: ingest.job!.id, leaseId: briefing.lease.id }, session(2), {
        requestId: request(4),
      }),
      "lease_conflict",
    );

    clock.current = "2026-08-20T10:45:00.000Z" as IsoDateTime;
    const renewed = await composition.leases.renew(
      { jobId: ingest.job!.id, leaseId: briefing.lease.id },
      session(),
      { requestId: request(5) },
    );
    expect(renewed).toMatchObject({
      id: briefing.lease.id,
      acquiredAt: AT,
      expiresAt: "2026-08-20T11:15:00.000Z",
    });

    await expect(
      composition.leases.release(
        { jobId: ingest.job!.id, leaseId: renewed.id, reason: "worker stopped" },
        session(),
        { requestId: request(6) },
      ),
    ).resolves.toBeNull();
    const pending = await composition.leases.pending({ subjectId: ingest.subject.id });
    expect(pending).toEqual([
      expect.objectContaining({
        id: ingest.job!.id,
        generation: ingest.generation,
        state: "pending",
      }),
    ]);

    await rejectCode(
      composition.leases.renew({ jobId: ingest.job!.id, leaseId: renewed.id }, session(), {
        requestId: request(7),
      }),
      "lease_expired",
    );
  }, 45_000);

  it("evaluates lease expiry with a fresh clock reading inside the subject lock", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const published: EngineEvent[] = [];
    const initial = await open(root, ids, clock, { published });
    const ingest = await createPending(initial);
    const briefing = await initial.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });
    const facts = stores(root);
    const activeState = await facts.states.read(ingest.subject.id);

    clock.current = "2026-08-20T10:59:59.999Z" as IsoDateTime;
    const crossedExpiry = await open(root, ids, clock, {
      published,
      leaseHooks: {
        beforeLockedMutation() {
          clock.current = briefing.lease.expiresAt;
        },
      },
    });
    const publishedBeforeRenew = published.length;
    await rejectCode(
      crossedExpiry.leases.renew({ jobId: ingest.job!.id, leaseId: briefing.lease.id }, session(), {
        requestId: request(3),
      }),
      "lease_expired",
    );
    await expect(facts.operations.readOptional(request(3))).resolves.toBeUndefined();
    await expect(facts.transactions.readOptional(request(3))).resolves.toBeUndefined();
    await expect(facts.states.read(ingest.subject.id)).resolves.toEqual(activeState);
    expect(published).toHaveLength(publishedBeforeRenew);

    clock.current = "2026-08-20T10:59:59.999Z" as IsoDateTime;
    const replacement = await crossedExpiry.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(4),
    });
    expect(replacement.lease.id).not.toBe(briefing.lease.id);
    expect(replacement.lease.acquiredAt).toBe(briefing.lease.expiresAt);
  }, 45_000);

  it("releases an active lease after wall-clock rollback before its acquisition time", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await createPending(composition);
    const briefing = await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    clock.current = "2026-08-20T10:00:00.000Z" as IsoDateTime;
    await expect(
      composition.leases.release({ jobId: ingest.job!.id, leaseId: briefing.lease.id }, session(), {
        requestId: request(3),
      }),
    ).resolves.toBeNull();

    const facts = stores(root);
    expect((await facts.states.read(ingest.subject.id)).pending).not.toHaveProperty("lease");
    await expect(facts.operations.read(request(3))).resolves.toMatchObject({
      method: "distill.release",
      completedAt: "2026-08-20T10:00:00.000Z",
    });
    await expect(facts.transactions.read(request(3))).resolves.toMatchObject({
      state: "committed",
      finishedAt: "2026-08-20T10:00:00.000Z",
    });
  }, 45_000);

  it("recovers prepared and post-commit crashes without regenerating the stored briefing", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const preparedCrash = await open(root, ids, clock, {
      leaseHooks: { afterPrepared: failOnce() },
    });
    const ingest = await createPending(preparedCrash);
    await expect(
      preparedCrash.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(2),
      }),
    ).rejects.toThrow("simulated process crash");
    await expect(stores(root).transactions.read(request(2))).resolves.toMatchObject({
      state: "prepared",
    });

    const afterAbortRecovery = await open(root, ids, clock);
    await expect(stores(root).transactions.read(request(2))).resolves.toMatchObject({
      state: "aborted",
    });
    const briefing = await afterAbortRecovery.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });
    await expect(stores(root).transactions.read(request(2))).resolves.toMatchObject({
      state: "committed",
    });

    await afterAbortRecovery.leases.release(
      { jobId: ingest.job!.id, leaseId: briefing.lease.id },
      session(),
      { requestId: request(3) },
    );
    const postCommitCrash = await open(root, ids, clock, {
      leaseHooks: { afterFactCommit: failOnce() },
    });
    await expect(
      postCommitCrash.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(4),
      }),
    ).rejects.toThrow("simulated process crash");

    const recovered = await open(root, ids, clock);
    const stored = await stores(root).operations.read(request(4));
    if (stored.recordKind !== "completed" || stored.method !== "distill.brief") {
      throw new Error("expected recovered briefing operation");
    }
    await expect(
      recovered.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(4),
      }),
    ).resolves.toEqual(stored.result);
  }, 45_000);

  it("reconciles a pre-queue crash before listing from an already-running composition", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const initial = await open(root, ids, clock);
    const ingest = await createPending(initial);
    const reader = await open(root, ids, clock);
    const crashed = await open(root, ids, clock, {
      recoveryHooks: { afterEvent: failOnce() },
    });

    await expect(
      crashed.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(2),
      }),
    ).rejects.toThrow("simulated process crash");
    await expect(stores(root).transactions.read(request(2))).resolves.toMatchObject({
      state: "prepared",
    });

    await expect(reader.leases.pending({})).resolves.toEqual([
      expect.objectContaining({
        id: ingest.job!.id,
        state: "leased",
        leaseExpiresAt: "2026-08-20T11:00:00.000Z",
      }),
    ]);
    await expect(stores(root).transactions.read(request(2))).resolves.toMatchObject({
      state: "committed",
    });
  }, 45_000);

  it("preserves a third authoritative state instead of overwriting it after prepare", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock, {
      leaseHooks: {
        afterPrepared: async (transaction) => {
          const facts = stores(root);
          const current = await facts.states.read(transaction.subjectId);
          if (current.pending === undefined) throw new Error("expected pending state");
          const { checksum: _checksum, pending: _pending, ...stable } = current;
          void _checksum;
          void _pending;
          const third = sealFact<SubjectStateRecord>({
            ...stable,
            pending: {
              ...current.pending,
              queuedAt: "2026-08-20T10:29:59.000Z" as IsoDateTime,
            },
          });
          await facts.states.write(third);
        },
      },
    });
    const ingest = await createPending(composition);

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
    const facts = stores(root);
    await expect(facts.states.read(ingest.subject.id)).resolves.toMatchObject({
      pending: { queuedAt: "2026-08-20T10:29:59.000Z" },
    });
    await expect(facts.operations.readOptional(request(2))).resolves.toBeUndefined();
    await expect(facts.transactions.read(request(2))).resolves.toMatchObject({
      state: "prepared",
    });
  }, 45_000);

  it("does not reprepare an aborted lease request at its exact expiry", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const crashed = await open(root, ids, clock, {
      leaseHooks: { afterPrepared: failOnce() },
    });
    const ingest = await createPending(crashed);
    await expect(
      crashed.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(2),
      }),
    ).rejects.toThrow("simulated process crash");

    const recovered = await open(root, ids, clock);
    await expect(stores(root).transactions.read(request(2))).resolves.toMatchObject({
      state: "aborted",
    });
    clock.current = "2026-08-20T11:00:00.000Z" as IsoDateTime;
    await rejectCode(
      recovered.leases.brief({ jobId: ingest.job!.id }, session(), {
        requestId: request(2),
      }),
      "lease_expired",
    );
    await expect(stores(root).transactions.read(request(2))).resolves.toMatchObject({
      state: "aborted",
    });
    await expect(stores(root).operations.readOptional(request(2))).resolves.toBeUndefined();
    expect((await stores(root).states.read(ingest.subject.id)).pending).not.toHaveProperty("lease");
  }, 45_000);

  it("allows only one concurrent owner to create the authoritative lease", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await createPending(composition);

    const attempts = await Promise.allSettled([
      composition.leases.brief({ jobId: ingest.job!.id }, session(1), {
        requestId: request(2),
      }),
      composition.leases.brief({ jobId: ingest.job!.id }, session(2), {
        requestId: request(3),
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const fulfilled = attempts.find((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    if (fulfilled === undefined || rejected === undefined) {
      throw new Error("expected one fulfilled and one rejected lease attempt");
    }
    expect(rejected.reason).toBeInstanceOf(DistillyError);
    expect(["busy", "lease_conflict"]).toContain((rejected.reason as DistillyError).code);
    const state = await stores(root).states.read(ingest.subject.id);
    expect(state.pending?.lease?.id).toBe(fulfilled.value.lease.id);
  }, 45_000);

  it("rejects request replay under a different lease owner or briefing capacity", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const ingest = await createPending(composition);
    await composition.leases.brief({ jobId: ingest.job!.id }, session(), {
      requestId: request(2),
    });

    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(2), {
        requestId: request(2),
      }),
      "idempotency_conflict",
    );
    await rejectCode(
      composition.leases.brief({ jobId: ingest.job!.id }, session(1, 2_000_000), {
        requestId: request(2),
      }),
      "idempotency_conflict",
    );
    await rejectCode(
      composition.leases.brief({ jobId: `job_${"f".repeat(32)}` as JobId }, session(), {
        requestId: request(2),
      }),
      "idempotency_conflict",
    );
    await rejectCode(
      composition.leases.brief(
        { jobId: ingest.job!.id },
        { ...session(), actor: { kind: "sdk", id: "different-actor" } },
        { requestId: request(2) },
      ),
      "idempotency_conflict",
    );
    const stored = await stores(root).operations.read(request(2));
    if (stored.recordKind !== "completed" || stored.method !== "distill.brief") {
      throw new Error("expected completed briefing operation");
    }
    await rejectCode(
      composition.leases.renew(
        { jobId: ingest.job!.id, leaseId: stored.result.lease.id },
        session(),
        { requestId: request(2) },
      ),
      "idempotency_conflict",
    );
    expect(
      (await readdir(stores(root).layout.operationsDirectory())).filter((entry) =>
        entry.endsWith(".json"),
      ),
    ).toHaveLength(2);
  }, 45_000);
});
