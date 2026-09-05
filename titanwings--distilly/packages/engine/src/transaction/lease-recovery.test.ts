import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DistillyError,
  contentDigestSchema,
  eventIdSchema,
  factChecksumSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialIdSchema,
  materialSetHashSchema,
  provenanceDigestSchema,
  requestIdSchema,
  spaceIdSchema,
  subjectIdSchema,
  transactionRecordSchema,
  type ActorContext,
  type DistillLeaseTransactionMethod,
  type DistillLeaseTransactionRecord,
  type EngineEvent,
  type EventRecord,
  type IsoDateTime,
  type MaterialRecord,
  type OperationRecord,
  type PendingJobMarker,
  type RuntimeSchema,
  type SpaceRecord,
  type SubjectRecord,
  type SubjectStateRecord,
  type TransactionRecord,
  type VersionMaterialEntry,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { InProcessEventBus } from "../defaults/in-process-event-bus.js";
import type { Clock } from "../defaults/system-clock.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { computeFactChecksum, sealFact } from "../facts/checksum.js";
import {
  deriveMaterialId,
  digestContent,
  digestMaterialProvenance,
  hashMaterialSet,
} from "../facts/digests.js";
import { FileEventStore } from "../facts/event-store.js";
import { FileCurrentProfileProjection } from "../facts/current-profile-projection.js";
import { replaceFactFile } from "../facts/fact-file.js";
import { FileMaterialStore } from "../facts/material-store.js";
import { FileOperationStore } from "../facts/operation-store.js";
import { FileSpaceStore } from "../facts/space-store.js";
import { FileStateStore } from "../facts/state-store.js";
import { FileSubjectStore } from "../facts/subject-store.js";
import { FileTransactionStore } from "../testing/legacy-file-transaction-store.test.fixture.js";
import { FileVersionStore } from "../facts/version-store.js";
import { Layout } from "../layout.js";
import { SqliteQueueRepository } from "../testing/legacy-sqlite-queue-projection.test.fixture.js";
import { createBriefContract } from "../distill/prompt-catalog.js";
import {
  RecoveryService,
  type RecoveryHooks,
} from "../testing/legacy-file-recovery.test.fixture.js";
import { FileRequestLock } from "./request-lock.js";
import { FileSubjectLock } from "./subject-lock.js";
import { FileVersionStaging } from "../testing/legacy-file-version-staging.test.fixture.js";

const SPACE_ID = spaceIdSchema.parse(`space_${"1".repeat(32)}`);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${"2".repeat(32)}`);
const JOB_ID = jobIdSchema.parse(`job_${"3".repeat(32)}`);
const LEASE_ID = leaseIdSchema.parse(`lease_${"4".repeat(32)}`);
const OWNER_ID = leaseOwnerIdSchema.parse(`lease_owner_${"5".repeat(32)}`);
const MATERIAL_ID_SEED = materialIdSchema.parse(`mat_${"6".repeat(64)}`);
const PROVENANCE_SEED = provenanceDigestSchema.parse(`provenance_sha256_${"7".repeat(64)}`);
const ACQUIRED_AT = isoDateTimeSchema.parse("2026-08-20T00:00:00.000Z");
const MUTATED_AT = isoDateTimeSchema.parse("2026-08-20T00:10:00.000Z");
const RECOVERED_AT = isoDateTimeSchema.parse("2026-08-20T00:20:00.000Z");
const EXPIRES_AT = isoDateTimeSchema.parse("2026-08-20T00:30:00.000Z");
const RENEWED_EXPIRES_AT = isoDateTimeSchema.parse("2026-08-20T00:40:00.000Z");
const ACTOR: ActorContext = { kind: "sdk", id: "lease-recovery-test" };
const PROMPT_VERSION = `host-distill-v1-sha256_${"8".repeat(64)}` as const;
const CONTRACT = createBriefContract({
  sourceGroupingVersion: "source-groups-v1",
  promptVersion: PROMPT_VERSION,
  draftSchemaVersion: 1,
});
const CONTENT = "Lease recovery evidence.\n";
const roots: string[] = [];

const TRANSACTION_SCHEMA: RuntimeSchema<TransactionRecord> = {
  parse(value) {
    return transactionRecordSchema.parse(value) as TransactionRecord;
  },
};

class FixedClock implements Clock {
  current = RECOVERED_AT;

  now(): IsoDateTime {
    return this.current;
  }
}

interface Fixture {
  readonly root: string;
  readonly layout: Layout;
  readonly clock: FixedClock;
  readonly subjects: FileSubjectStore;
  readonly states: FileStateStore;
  readonly operations: FileOperationStore;
  readonly events: FileEventStore;
  readonly transactions: FileTransactionStore;
  readonly queue: SqliteQueueRepository;
  readonly previousState: SubjectStateRecord;
  readonly targetState: SubjectStateRecord;
  readonly transaction: DistillLeaseTransactionRecord;
  readonly published: EngineEvent[];
  readonly recovery: (hooks?: RecoveryHooks) => RecoveryService;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const requestId = (method: DistillLeaseTransactionMethod) =>
  requestIdSchema.parse(
    `req_${({ brief: "a", renew: "b", release: "c" } as const)[method].repeat(32)}`,
  );

const eventId = (method: DistillLeaseTransactionMethod) =>
  eventIdSchema.parse(
    `event_${({ brief: "d", renew: "e", release: "f" } as const)[method].repeat(32)}`,
  );

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

const makeMaterial = (): MaterialRecord => {
  const provisional = sealFact<MaterialRecord>({
    schemaVersion: 1,
    id: MATERIAL_ID_SEED,
    subjectId: SUBJECT_ID,
    kind: "web",
    contentDigest: digestContent(CONTENT),
    provenanceDigest: PROVENANCE_SEED,
    sourceIdentity: "source-uri-v1\0https://example.com/lease-recovery",
    source: {
      uri: "https://example.com/lease-recovery",
      medium: "article",
      access: "public",
      capturedAt: ACQUIRED_AT,
      authors: [],
    },
    derivation: { kind: "native_text" },
    participants: [],
    sensitivity: "private",
    flags: [],
    storedAt: ACQUIRED_AT,
  });
  const provenanceDigest = digestMaterialProvenance(provisional);
  return sealFact<MaterialRecord>({
    ...provisional,
    id: deriveMaterialId(provisional.sourceIdentity, provenanceDigest, provisional.contentDigest),
    provenanceDigest,
  });
};

const makePending = (lease: boolean): PendingJobMarker => ({
  jobId: JOB_ID,
  generation: 1,
  materialSetHash: materialSetHashSchema.parse(`set_sha256_${"9".repeat(64)}`),
  addedMaterialCount: 1,
  totalMaterialCount: 1,
  queuedAt: ACQUIRED_AT,
  ...(lease
    ? {
        lease: {
          id: LEASE_ID,
          owner: OWNER_ID,
          acquiredAt: ACQUIRED_AT,
          expiresAt: EXPIRES_AT,
          contract: CONTRACT,
        },
      }
    : {}),
});

const stateWithPending = (
  stable: Omit<SubjectStateRecord, "checksum" | "pending">,
  pending: PendingJobMarker,
): SubjectStateRecord => sealFact<SubjectStateRecord>({ ...stable, pending });

const stableState = (
  state: SubjectStateRecord,
): Omit<SubjectStateRecord, "checksum" | "pending"> => ({
  schemaVersion: 2,
  subjectId: state.subjectId,
  generation: state.generation,
  ...(state.materialSetHash === undefined ? {} : { materialSetHash: state.materialSetHash }),
  materialManifest: state.materialManifest,
  ...(state.currentVersionId === undefined ? {} : { currentVersionId: state.currentVersionId }),
  ...(state.suspendedVersionId === undefined
    ? {}
    : { suspendedVersionId: state.suspendedVersionId }),
});

const targetPendingFor = (
  method: DistillLeaseTransactionMethod,
  previous: PendingJobMarker,
): PendingJobMarker => {
  if (method === "release") {
    return {
      jobId: previous.jobId,
      generation: previous.generation,
      ...(previous.baseVersionId === undefined ? {} : { baseVersionId: previous.baseVersionId }),
      materialSetHash: previous.materialSetHash,
      addedMaterialCount: previous.addedMaterialCount,
      totalMaterialCount: previous.totalMaterialCount,
      queuedAt: previous.queuedAt,
    };
  }
  if (method === "brief") {
    const acquired = makePending(true).lease;
    if (acquired === undefined) throw new Error("Brief fixture requires a lease.");
    return { ...previous, lease: acquired };
  }
  if (previous.lease === undefined) throw new Error("Renew fixture requires a lease.");
  return {
    ...previous,
    lease: { ...previous.lease, expiresAt: RENEWED_EXPIRES_AT },
  };
};

const jobFrom = (pending: PendingJobMarker) => {
  if (pending.lease === undefined) throw new Error("Leased job fixture requires a lease.");
  return {
    id: pending.jobId,
    subjectId: SUBJECT_ID,
    generation: pending.generation,
    materialSetHash: pending.materialSetHash,
    addedMaterialCount: pending.addedMaterialCount,
    totalMaterialCount: pending.totalMaterialCount,
    queuedAt: pending.queuedAt,
    state: "leased" as const,
    leaseExpiresAt: pending.lease.expiresAt,
  };
};

const jobLeaseFrom = (pending: PendingJobMarker) => {
  if (pending.lease === undefined) throw new Error("JobLease fixture requires a lease.");
  return {
    id: pending.lease.id,
    jobId: pending.jobId,
    generation: pending.generation,
    briefContractDigest: pending.lease.contract.digest,
    owner: pending.lease.owner,
    acquiredAt: pending.lease.acquiredAt,
    expiresAt: pending.lease.expiresAt,
  };
};

const subjectSummary = () => ({
  id: SUBJECT_ID,
  displayName: "Lease Recovery",
  aliases: [],
  identityHints: [],
  space: { id: SPACE_ID, displayName: "People", kind: "people" as const },
  lifecycle: "active" as const,
});

const makeOperation = (
  method: DistillLeaseTransactionMethod,
  targetPending: PendingJobMarker,
): DistillLeaseTransactionRecord["operation"] => {
  const common = {
    schemaVersion: 1 as const,
    recordKind: "completed" as const,
    requestId: requestId(method),
    scope: { kind: "subject" as const, subjectId: SUBJECT_ID },
    actor: ACTOR,
    inputChecksum: computeFactChecksum({ method: `distill.${method}`, owner: OWNER_ID }),
    completedAt: method === "brief" ? ACQUIRED_AT : MUTATED_AT,
  };
  if (method === "brief") {
    const lease = jobLeaseFrom(targetPending);
    return sealFact<OperationRecord<"distill.brief">>({
      ...common,
      method: "distill.brief",
      result: {
        job: jobFrom(targetPending),
        lease,
        subject: subjectSummary(),
        materials: [],
        contract: {
          ...CONTRACT,
          instructions: "Produce a claim-only patch.",
          evidenceRules: [],
        },
        limits: {
          estimatedInputTokens: 1,
          maximumInputTokens: 1,
          maximumOutputBytes: 1,
        },
      },
    });
  }
  if (method === "renew") {
    return sealFact<OperationRecord<"distill.renew">>({
      ...common,
      method: "distill.renew",
      result: jobLeaseFrom(targetPending),
    });
  }
  return sealFact<OperationRecord<"distill.release">>({
    ...common,
    method: "distill.release",
    result: null,
  });
};

const makeEvent = (method: DistillLeaseTransactionMethod): EventRecord =>
  sealFact<EventRecord>({
    schemaVersion: 1,
    eventId: eventId(method),
    event: {
      kind: "job.changed",
      subjectId: SUBJECT_ID,
      at: method === "brief" ? ACQUIRED_AT : MUTATED_AT,
    },
    actor: ACTOR,
    requestId: requestId(method),
  });

const parseLeaseTransaction = (payload: Readonly<Record<string, unknown>>) => {
  const parsed = transactionRecordSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  }) as TransactionRecord;
  if (parsed.transactionKind !== "distill_lease") throw new Error("Expected lease journal.");
  return parsed;
};

const makeTransaction = (
  method: DistillLeaseTransactionMethod,
  previousState: SubjectStateRecord,
  targetState: SubjectStateRecord,
): DistillLeaseTransactionRecord => {
  if (previousState.pending === undefined || targetState.pending === undefined) {
    throw new Error("Lease transaction fixture requires pending markers.");
  }
  return parseLeaseTransaction({
    schemaVersion: 1,
    transactionKind: "distill_lease",
    method,
    requestId: requestId(method),
    subjectId: SUBJECT_ID,
    jobId: JOB_ID,
    previousStateChecksum: previousState.checksum,
    targetStateChecksum: targetState.checksum,
    previousPending: previousState.pending,
    targetPending: targetState.pending,
    operation: makeOperation(method, targetState.pending),
    event: makeEvent(method),
    preparedAt: method === "brief" ? ACQUIRED_AT : MUTATED_AT,
    state: "prepared",
  });
};

const terminal = (
  transaction: DistillLeaseTransactionRecord,
  state: "committed" | "aborted",
): DistillLeaseTransactionRecord => {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(transaction)) {
    if (key !== "checksum" && key !== "state" && key !== "finishedAt") payload[key] = value;
  }
  return parseLeaseTransaction({ ...payload, state, finishedAt: RECOVERED_AT });
};

const createFixture = async (
  method: DistillLeaseTransactionMethod,
  hooks?: RecoveryHooks,
): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-lease-recovery-"));
  roots.push(root);
  const layout = new Layout(root);
  const clock = new FixedClock();
  const spaces = new FileSpaceStore(layout);
  const subjects = new FileSubjectStore(layout, spaces);
  const materials = new FileMaterialStore(layout, subjects);
  const versions = new FileVersionStore(layout, materials);
  const versionStaging = new FileVersionStaging(layout, versions);
  const currentProfiles = new FileCurrentProfileProjection(layout, versions);
  const states = new FileStateStore(layout, subjects, materials);
  const operations = new FileOperationStore(layout, subjects);
  const events = new FileEventStore(layout, subjects);
  const transactions = new FileTransactionStore(layout);
  const queue = new SqliteQueueRepository({
    root: layout.root,
    indexDirectory: layout.indexDirectory(),
    databaseFile: join(layout.indexDirectory(), "queue.db"),
    dirtyFile: join(layout.indexDirectory(), "queue.dirty"),
  });
  const space = sealFact<SpaceRecord>({
    schemaVersion: 1,
    id: SPACE_ID,
    displayName: "People",
    kind: "people",
  });
  const subject = sealFact<SubjectRecord>({
    schemaVersion: 1,
    id: SUBJECT_ID,
    spaceId: SPACE_ID,
    displayName: "Lease Recovery",
    aliases: [],
    identityHints: [],
    lifecycle: "active",
  });
  await spaces.write(space);
  await subjects.write(subject);
  const material = makeMaterial();
  await materials.write(material, CONTENT);
  const entry: VersionMaterialEntry = {
    materialId: material.id,
    contentDigest: contentDigestSchema.parse(material.contentDigest),
    provenanceDigest: provenanceDigestSchema.parse(material.provenanceDigest),
  };
  const previousPending = makePending(method !== "brief");
  const stable = {
    schemaVersion: 2 as const,
    subjectId: SUBJECT_ID,
    generation: 1,
    materialSetHash: hashMaterialSet([entry]),
    materialManifest: [entry],
  };
  const normalizedPreviousPending = {
    ...previousPending,
    materialSetHash: stable.materialSetHash,
  };
  const previousState = stateWithPending(stable, normalizedPreviousPending);
  const targetPending = targetPendingFor(method, normalizedPreviousPending);
  const targetState = stateWithPending(stable, targetPending);
  await states.write(previousState);
  await queue.rebuild(async function* () {
    yield await Promise.resolve({
      subjectId: SUBJECT_ID,
      stateChecksum: previousState.checksum,
      pending: normalizedPreviousPending,
    });
  }, clock.now());
  const transaction = makeTransaction(method, previousState, targetState);
  await transactions.write(transaction);
  const published: EngineEvent[] = [];
  const eventBus = new InProcessEventBus();
  eventBus.subscribe((event) => {
    published.push(event);
  });
  const recovery = (recoveryHooks = hooks) =>
    new RecoveryService({
      transactions,
      operations,
      subjects,
      states,
      versions,
      versionStaging,
      currentProfiles,
      events,
      requestLocks: new FileRequestLock(layout, clock),
      subjectLocks: new FileSubjectLock(layout, clock),
      queue,
      eventBus,
      clock,
      ...(recoveryHooks === undefined ? {} : { hooks: recoveryHooks }),
    });
  return {
    root,
    layout,
    clock,
    subjects,
    states,
    operations,
    events,
    transactions,
    queue,
    previousState,
    targetState,
    transaction,
    published,
    recovery,
  };
};

describe("distill lease transaction recovery", { timeout: 15_000 }, () => {
  it.each(["brief", "renew", "release"] as const)(
    "completes a visible %s target and replays it without duplicate side effects",
    async (method) => {
      const fixture = await createFixture(method);
      await fixture.states.write(fixture.targetState);

      await fixture.recovery().reconcile(fixture.transaction.requestId);

      expect(await fixture.transactions.read(fixture.transaction.requestId)).toEqual(
        terminal(fixture.transaction, "committed"),
      );
      await expect(fixture.operations.read(fixture.transaction.requestId)).resolves.toEqual(
        fixture.transaction.operation,
      );
      await expect(
        fixture.events.read(SUBJECT_ID, fixture.transaction.event.eventId),
      ).resolves.toEqual(fixture.transaction.event);
      const queued = await fixture.queue.read(JOB_ID, fixture.clock.now());
      expect(queued?.job.state).toBe(method === "release" ? "pending" : "leased");
      expect(fixture.published).toEqual([fixture.transaction.event.event]);

      await expectCode(fixture.transactions.write(fixture.transaction), "storage_corrupt");
      await fixture.recovery().reconcile(fixture.transaction.requestId);
      expect(fixture.published).toHaveLength(1);
    },
  );

  it.each(["target", "previous"] as const)(
    "clamps a recovered %s terminal timestamp to preparedAt after wall-clock rollback",
    async (visible) => {
      const fixture = await createFixture("brief");
      fixture.clock.current = isoDateTimeSchema.parse("2026-08-19T23:59:59.000Z");
      if (visible === "target") await fixture.states.write(fixture.targetState);

      await fixture.recovery().reconcile(fixture.transaction.requestId);

      await expect(fixture.transactions.read(fixture.transaction.requestId)).resolves.toMatchObject(
        {
          state: visible === "target" ? "committed" : "aborted",
          finishedAt: fixture.transaction.preparedAt,
        },
      );
    },
  );

  it.each(["brief", "renew", "release"] as const)(
    "aborts a %s journal when the exact previous state remains visible",
    async (method) => {
      const fixture = await createFixture(method);

      await fixture.recovery().reconcile(fixture.transaction.requestId);

      expect(await fixture.transactions.read(fixture.transaction.requestId)).toEqual(
        terminal(fixture.transaction, "aborted"),
      );
      await expect(fixture.operations.readOptional(fixture.transaction.requestId)).resolves.toBe(
        undefined,
      );
      expect(fixture.published).toEqual([]);
    },
  );

  it.each(["operation", "event"] as const)(
    "rejects a previous-state journal with a ghost post-commit %s fact",
    async (factKind) => {
      const fixture = await createFixture("brief");
      const queueBefore = await fixture.queue.read(JOB_ID, fixture.clock.now());
      if (factKind === "operation") {
        await fixture.operations.write(fixture.transaction.operation);
      } else {
        await fixture.events.write(SUBJECT_ID, fixture.transaction.event);
      }

      await expectCode(
        fixture.recovery().reconcile(fixture.transaction.requestId),
        "storage_corrupt",
      );

      await expect(fixture.transactions.read(fixture.transaction.requestId)).resolves.toEqual(
        fixture.transaction,
      );
      await expect(fixture.queue.read(JOB_ID, fixture.clock.now())).resolves.toEqual(queueBefore);
      expect(fixture.published).toEqual([]);
    },
  );

  it.each(["afterOperation", "afterEvent", "afterQueue"] as const)(
    "idempotently completes a target after a crash at %s",
    async (point) => {
      let failed = false;
      const fixture = await createFixture("brief", {
        [point]() {
          if (failed) return;
          failed = true;
          throw new Error(`crash at ${point}`);
        },
      });
      await fixture.states.write(fixture.targetState);

      await expect(fixture.recovery().reconcile(fixture.transaction.requestId)).rejects.toThrow(
        `crash at ${point}`,
      );
      expect(await fixture.transactions.read(fixture.transaction.requestId)).toEqual(
        fixture.transaction,
      );

      await fixture.recovery({}).reconcile(fixture.transaction.requestId);
      expect(await fixture.transactions.read(fixture.transaction.requestId)).toEqual(
        terminal(fixture.transaction, "committed"),
      );
      expect(fixture.published).toEqual([fixture.transaction.event.event]);
    },
  );

  it("rejects a third visible state without guessing which side committed", async () => {
    const fixture = await createFixture("brief");
    const pending = fixture.targetState.pending;
    if (pending?.lease === undefined) throw new Error("Expected target lease.");
    const thirdPending = {
      ...pending,
      lease: {
        ...pending.lease,
        id: leaseIdSchema.parse(`lease_${"0".repeat(32)}`),
      },
    };
    await fixture.states.write(stateWithPending(stableState(fixture.targetState), thirdPending));

    await expectCode(
      fixture.recovery().reconcile(fixture.transaction.requestId),
      "storage_corrupt",
    );
    expect(await fixture.transactions.read(fixture.transaction.requestId)).toEqual(
      fixture.transaction,
    );
  });

  it("rejects a schema-valid journal that forges the counterpart state checksum", async () => {
    const fixture = await createFixture("brief");
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fixture.transaction)) {
      if (key !== "checksum" && key !== "previousStateChecksum") payload[key] = value;
    }
    const hostile = parseLeaseTransaction({
      ...payload,
      previousStateChecksum: factChecksumSchema.parse(`fact_sha256_${"0".repeat(64)}`),
    });
    await replaceFactFile(
      fixture.root,
      fixture.layout.transactionFile(hostile.requestId),
      hostile,
      TRANSACTION_SCHEMA,
    );
    await fixture.states.write(fixture.targetState);

    await expectCode(fixture.recovery().reconcile(hostile.requestId), "storage_corrupt");
    await expect(fixture.operations.readOptional(hostile.requestId)).resolves.toBeUndefined();
  });

  it.each(["operation", "event"] as const)(
    "rejects a previous-state journal with a forged nested %s checksum",
    async (nestedFact) => {
      const fixture = await createFixture("renew");
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fixture.transaction)) {
        if (key !== "checksum") payload[key] = value;
      }
      payload[nestedFact] = {
        ...fixture.transaction[nestedFact],
        checksum: factChecksumSchema.parse(`fact_sha256_${"0".repeat(64)}`),
      };
      const hostile = parseLeaseTransaction(payload);
      await replaceFactFile(
        fixture.root,
        fixture.layout.transactionFile(hostile.requestId),
        hostile,
        TRANSACTION_SCHEMA,
      );

      await expectCode(fixture.recovery().reconcile(hostile.requestId), "storage_corrupt");
      await expectCode(fixture.transactions.read(hostile.requestId), "storage_corrupt");
    },
  );

  it("allows an aborted lease journal to reprepare only its exact payload", async () => {
    const fixture = await createFixture("brief");
    const aborted = terminal(fixture.transaction, "aborted");
    await fixture.transactions.write(aborted);
    await fixture.transactions.write(fixture.transaction);
    await fixture.transactions.write(aborted);

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fixture.transaction)) {
      if (key !== "checksum" && key !== "targetStateChecksum") payload[key] = value;
    }
    const changed = parseLeaseTransaction({
      ...payload,
      targetStateChecksum: factChecksumSchema.parse(`fact_sha256_${"f".repeat(64)}`),
    });
    await expectCode(fixture.transactions.write(changed), "storage_corrupt");
    expect(canonicalJson(await fixture.transactions.read(changed.requestId))).toBe(
      canonicalJson(aborted),
    );
  });
});
