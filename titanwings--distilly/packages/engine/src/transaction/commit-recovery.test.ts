import {
  briefContractDigestSchema,
  briefMaterialRefSchema,
  distillCommitTransactionRecordSchema,
  DistillyError,
  factChecksumSchema,
  facetPathSchema,
  isoDateTimeSchema,
  operationRecordSchema,
  requestIdSchema,
  type ActorContext,
  type ClientSessionContext,
  type CommitInput,
  type DistillCommitTransactionRecord,
  type EventId,
  type EventRecord,
  type IngestInput,
  type IsoDateTime,
  type JobId,
  type LeaseId,
  type LeaseOwnerId,
  type OperationRecord,
  type Profile,
  type RequestId,
  type RuntimeSchema,
  type SpaceId,
  type SubjectId,
  type SubjectStateRecord,
  type VersionClaimsSnapshot,
  type VersionRecord,
} from "@distilly/protocol";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import { computeFactChecksum, sealFact } from "../facts/checksum.js";
import { FileEventStore } from "../facts/event-store.js";
import { replaceFactFile } from "../facts/fact-file.js";
import { FileMaterialStore } from "../facts/material-store.js";
import { FileOperationStore } from "../facts/operation-store.js";
import { FileSpaceStore } from "../facts/space-store.js";
import { FileStateStore } from "../facts/state-store.js";
import { FileSubjectStore } from "../facts/subject-store.js";
import { FileTransactionStore } from "../testing/legacy-file-transaction-store.test.fixture.js";
import type { VersionArtifactSet } from "../facts/version-store.js";
import { FileVersionStore } from "../facts/version-store.js";
import type {
  LegacyFileEngineTestSupport,
  LegacyFileEngineTestSupportOptions,
} from "../testing/legacy-file-engine.test.fixture.js";
import { createLegacyFileEngineTestSupport } from "../testing/legacy-file-engine.test.fixture.js";
import { Layout } from "../layout.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { renderProfile, renderPrompt } from "../profile/render.js";
import type { VersionIdentityPayload } from "../profile/version-id.js";
import { deriveVersionId } from "../profile/version-id.js";
import {
  FileVersionStaging,
  legacyVersionDeletingDirectory,
} from "../testing/legacy-file-version-staging.test.fixture.js";

const ACQUIRED_AT = isoDateTimeSchema.parse("2026-08-21T08:00:00.000Z");
const COMMIT_AT = isoDateTimeSchema.parse("2026-08-21T08:01:00.000Z");
const ROLLED_ACQUIRED_AT = isoDateTimeSchema.parse("2026-08-21T08:02:00.000Z");
const THIRD_QUEUED_AT = isoDateTimeSchema.parse("2026-08-21T07:59:00.000Z");
const BAD_CHECKSUM = factChecksumSchema.parse(`fact_sha256_${"f".repeat(64)}`);
const BAD_BRIEF_DIGEST = briefContractDigestSchema.parse(`brief_contract_${"f".repeat(64)}`);
const ACTOR: ActorContext = { kind: "sdk", id: "commit-recovery-test" };
const roots: string[] = [];

const commitTransactionSchema: RuntimeSchema<DistillCommitTransactionRecord> = {
  parse(value) {
    return distillCommitTransactionRecordSchema.parse(value) as DistillCommitTransactionRecord;
  },
};

const briefOperationSchema: RuntimeSchema<OperationRecord<"distill.brief">> = {
  parse(value) {
    const operation = operationRecordSchema.parse(value) as OperationRecord;
    if (operation.method !== "distill.brief") throw new Error("Expected a brief operation.");
    return operation;
  },
};

class FakeClock implements Clock {
  current: IsoDateTime = ACQUIRED_AT;

  now(): IsoDateTime {
    return this.current;
  }
}

class SequenceIds implements IdGenerator {
  private subject = 1;
  private space = 2;
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

const request = (digit: number): RequestId =>
  requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

const session = (): ClientSessionContext => ({
  actor: ACTOR,
  leaseOwner: `lease_owner_${"1".padStart(32, "0")}` as LeaseOwnerId,
  capacity: {
    maximumInputTokens: 1_000_000,
    maximumToolResultBytes: 1_000_000,
    source: "sdk_explicit",
  },
});

const createInput = (): IngestInput => ({
  subject: {
    kind: "create",
    input: {
      displayName: "Recovery Subject",
      aliases: [],
      identityHints: [{ kind: "url", value: "https://example.com/recovery-subject" }],
    },
  },
  materials: [
    {
      clientRef: "source",
      kind: "web",
      content: "Recovery Subject designs exact local transaction recovery.",
      source: {
        uri: "https://example.com/recovery-subject",
        medium: "article",
        access: "public",
        role: "reference",
        capturedAt: ACQUIRED_AT,
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
});

const validPatch = (suspended: boolean): CommitInput["patch"] => ({
  operations: [
    {
      op: "add",
      claim: {
        facet: facetPathSchema.parse("identity.recovery"),
        text: "Recovery Subject designs exact local transaction recovery.",
        evidence: [
          {
            kind: "brief_material",
            materialRef: briefMaterialRefSchema.parse("m001"),
            quote: "Recovery Subject designs exact local transaction recovery.",
          },
        ],
      },
    },
  ],
  ...(suspended ? { reviewRequest: { note: "Keep this candidate suspended." } } : {}),
});

const commitInput = (
  briefing: Awaited<ReturnType<LegacyFileEngineTestSupport["leases"]["brief"]>>,
  suspended: boolean,
): CommitInput => ({
  jobId: briefing.job.id,
  generation: briefing.job.generation,
  leaseId: briefing.lease.id,
  briefContractDigest: briefing.contract.digest,
  materialSetHash: briefing.job.materialSetHash,
  ...(briefing.job.baseVersionId === undefined
    ? {}
    : { baseVersionId: briefing.job.baseVersionId }),
  patch: validPatch(suspended),
});

const open = async (
  root: string,
  ids: SequenceIds,
  clock: FakeClock,
  options: Omit<LegacyFileEngineTestSupportOptions, "root" | "ids" | "clock"> = {},
): Promise<LegacyFileEngineTestSupport> =>
  createLegacyFileEngineTestSupport({ root, ids, clock, ...options });

const stores = (root: string) => {
  const layout = new Layout(root);
  const spaces = new FileSpaceStore(layout);
  const subjects = new FileSubjectStore(layout, spaces);
  const materials = new FileMaterialStore(layout, subjects);
  const versions = new FileVersionStore(layout, materials);
  return {
    layout,
    subjects,
    states: new FileStateStore(layout, subjects, materials),
    events: new FileEventStore(layout, subjects),
    operations: new FileOperationStore(layout, subjects),
    transactions: new FileTransactionStore(layout),
    versions,
    versionStaging: new FileVersionStaging(layout, versions),
  };
};

type PreparedPoint = "afterPrepared" | "afterVersionPublished";

const setupPrepared = async (input: {
  readonly point?: PreparedPoint;
  readonly suspended?: boolean;
}) => {
  const root = await mkdtemp(join(tmpdir(), "distilly-commit-recovery-"));
  roots.push(root);
  const ids = new SequenceIds();
  const clock = new FakeClock();
  const point = input.point ?? "afterVersionPublished";
  const crash = () => {
    throw new Error(`crash at ${point}`);
  };
  const composition = await open(root, ids, clock, {
    commitHooks:
      point === "afterPrepared" ? { afterPrepared: crash } : { afterVersionPublished: crash },
  });
  const ingest = await composition.ingest.ingest(createInput(), ACTOR, {
    requestId: request(1),
  });
  if (ingest.job === undefined) throw new Error("Expected an ingest job.");
  const briefing = await composition.leases.brief({ jobId: ingest.job.id }, session(), {
    requestId: request(2),
  });
  clock.current = COMMIT_AT;
  await expect(
    composition.commits.commit(commitInput(briefing, input.suspended ?? false), session(), {
      requestId: request(3),
    }),
  ).rejects.toThrow(`crash at ${point}`);

  const facts = stores(root);
  const transaction = await facts.transactions.read(request(3));
  if (transaction.transactionKind !== "distill_commit" || transaction.state !== "prepared") {
    throw new Error("Expected a prepared commit journal.");
  }
  const previousState = await facts.states.read(ingest.subject.id);
  return {
    root,
    ids,
    clock,
    composition,
    facts,
    subjectId: ingest.subject.id,
    transaction,
    previousState,
  };
};

type PreparedFixture = Awaited<ReturnType<typeof setupPrepared>>;

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    },
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

const withoutChecksum = (value: object): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== "checksum"));

const resealJournal = (
  transaction: DistillCommitTransactionRecord,
  changes: Readonly<Record<string, unknown>>,
): DistillCommitTransactionRecord => {
  const payload = { ...withoutChecksum(transaction), ...changes };
  return commitTransactionSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  });
};

const replaceJournal = async (
  fixture: PreparedFixture,
  transaction: DistillCommitTransactionRecord,
): Promise<void> => {
  await replaceFactFile(
    fixture.root,
    fixture.facts.layout.transactionFile(transaction.requestId),
    transaction,
    commitTransactionSchema,
  );
};

const versionTarget = (fixture: PreparedFixture): string =>
  fixture.facts.layout.versionDirectory(fixture.subjectId, fixture.transaction.version.id);

const publishLineageReference = async (
  fixture: PreparedFixture,
  reference: "parent" | "derived" | "renderer source" | "carried claim",
): Promise<void> => {
  const candidate = fixture.transaction;
  const makeArtifacts = (
    identity: VersionIdentityPayload,
    sourceClaims: VersionClaimsSnapshot["claims"],
    selfCreateClaims = false,
  ): VersionArtifactSet => {
    const versionId = deriveVersionId(identity, sourceClaims);
    const finalizedClaims = selfCreateClaims
      ? sourceClaims.map((claim) => ({ ...claim, createdIn: versionId }))
      : sourceClaims;
    const version = sealFact<VersionRecord>({
      schemaVersion: 1,
      id: versionId,
      ...identity,
      materialCount: candidate.materialManifest.items.length,
      createdAt: COMMIT_AT,
    });
    const claims = sealFact<VersionClaimsSnapshot>({
      schemaVersion: 1,
      subjectId: candidate.subjectId,
      versionId,
      claims: finalizedClaims,
    });
    const rendered = renderProfile({
      subjectId: candidate.subjectId,
      displayName: candidate.version.subjectDisplayName,
      versionId,
      claims: claims.claims,
      quality: version.quality,
    });
    const profile: Profile = {
      subjectId: candidate.subjectId,
      displayName: candidate.version.subjectDisplayName,
      versionId,
      claims: claims.claims,
      core: rendered.core,
      domains: rendered.domains,
      rendered: rendered.markdown,
      quality: version.quality,
    };
    return {
      version,
      manifest: candidate.materialManifest,
      claims,
      profile,
      prompt: renderPrompt(profile),
    };
  };

  let parentId = candidate.version.id;
  let carriedClaims = candidate.claims.claims;
  if (reference !== "parent") {
    const independentParent = makeArtifacts(
      {
        subjectId: candidate.subjectId,
        subjectDisplayName: candidate.version.subjectDisplayName,
        generation: candidate.version.generation,
        materialSetHash: candidate.version.materialSetHash,
        creation: candidate.version.creation,
        actor: { ...candidate.version.actor, id: "lineage-parent" },
        createdDisposition: "current",
        rendererVersion: candidate.version.rendererVersion,
        quality: candidate.version.quality,
      },
      carriedClaims,
      true,
    );
    await fixture.facts.versionStaging.prepare(request(7), independentParent);
    await fixture.facts.versionStaging.publish(request(7), independentParent);
    parentId = independentParent.version.id;
    carriedClaims = independentParent.claims.claims;
  }

  const identity: VersionIdentityPayload = {
    subjectId: candidate.subjectId,
    subjectDisplayName: candidate.version.subjectDisplayName,
    generation: candidate.version.generation,
    materialSetHash: candidate.version.materialSetHash,
    parentId,
    ...(reference === "derived" ? { derivedFromCandidateVersionId: candidate.version.id } : {}),
    creation: {
      kind: "renderer_only",
      sourceVersionId: reference === "renderer source" ? candidate.version.id : parentId,
    },
    actor: candidate.version.actor,
    createdDisposition: "current",
    rendererVersion: candidate.version.rendererVersion,
    quality: candidate.version.quality,
  };
  const artifacts = makeArtifacts(
    identity,
    reference === "carried claim" ? candidate.claims.claims : carriedClaims,
  );
  await fixture.facts.versionStaging.prepare(request(8), artifacts);
  await fixture.facts.versionStaging.publish(request(8), artifacts);
};

const cloneOperation = (
  transaction: DistillCommitTransactionRecord,
  requestId: RequestId,
): OperationRecord<"distill.commit"> =>
  sealFact<OperationRecord<"distill.commit">>({ ...transaction.operation, requestId });

const cloneJournal = (
  transaction: DistillCommitTransactionRecord,
  requestId: RequestId,
): DistillCommitTransactionRecord => {
  const operation = cloneOperation(transaction, requestId);
  const events = transaction.events.map((event) =>
    sealFact<EventRecord>({ ...event, requestId }),
  ) as unknown as readonly [EventRecord, EventRecord];
  return resealJournal(transaction, { requestId, operation, events });
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("distill commit transaction recovery", { timeout: 30_000 }, () => {
  it("commits an exact visible target", async () => {
    const fixture = await setupPrepared({});
    await fixture.facts.states.write(fixture.transaction.targetState);

    await fixture.composition.recovery.reconcile(fixture.transaction.requestId);

    await expect(
      fixture.facts.transactions.read(fixture.transaction.requestId),
    ).resolves.toMatchObject({ state: "committed" });
    await expect(fixture.facts.operations.read(fixture.transaction.requestId)).resolves.toEqual(
      fixture.transaction.operation,
    );
    expect(await exists(versionTarget(fixture))).toBe(true);
  });

  it("aborts an exact visible previous state", async () => {
    const fixture = await setupPrepared({ point: "afterPrepared" });

    await fixture.composition.recovery.reconcile(fixture.transaction.requestId);

    await expect(
      fixture.facts.transactions.read(fixture.transaction.requestId),
    ).resolves.toMatchObject({ state: "aborted" });
    await expect(
      fixture.facts.operations.readOptional(fixture.transaction.requestId),
    ).resolves.toBeUndefined();
  });

  it("rejects a third authoritative state without guessing a commit side", async () => {
    const fixture = await setupPrepared({});
    const pending = fixture.previousState.pending;
    if (pending === undefined) throw new Error("Expected a pending previous state.");
    const thirdState = sealFact<SubjectStateRecord>({
      ...fixture.previousState,
      pending: { ...pending, queuedAt: THIRD_QUEUED_AT },
    });
    await fixture.facts.states.write(thirdState);

    await expectCode(
      fixture.composition.recovery.reconcile(fixture.transaction.requestId),
      "storage_corrupt",
    );

    await expect(fixture.facts.transactions.read(fixture.transaction.requestId)).resolves.toEqual(
      fixture.transaction,
    );
    expect(await exists(versionTarget(fixture))).toBe(true);
  });

  it.each(["operation", "first event", "second event"] as const)(
    "rejects a previous state with a ghost owner %s",
    async (fact) => {
      const fixture = await setupPrepared({});
      if (fact === "operation") {
        await fixture.facts.operations.write(fixture.transaction.operation);
      } else {
        const index = fact === "first event" ? 0 : 1;
        await fixture.facts.events.write(fixture.subjectId, fixture.transaction.events[index]);
      }

      await expectCode(
        fixture.composition.recovery.reconcile(fixture.transaction.requestId),
        "storage_corrupt",
      );

      await expect(fixture.facts.transactions.read(fixture.transaction.requestId)).resolves.toEqual(
        fixture.transaction,
      );
      expect(await exists(versionTarget(fixture))).toBe(true);
    },
  );

  it("deletes an exact unreferenced pre-state publication and aborts", async () => {
    const fixture = await setupPrepared({});
    expect(await exists(versionTarget(fixture))).toBe(true);

    await fixture.composition.recovery.reconcile(fixture.transaction.requestId);

    expect(await exists(versionTarget(fixture))).toBe(false);
    await expect(
      fixture.facts.transactions.read(fixture.transaction.requestId),
    ).resolves.toMatchObject({ state: "aborted" });
  });

  it("ignores candidate-shaped free text in an unrelated completed operation", async () => {
    const fixture = await setupPrepared({});
    const brief = await fixture.facts.operations.read(request(2));
    if (brief.recordKind !== "completed" || brief.method !== "distill.brief") {
      throw new Error("Expected the completed briefing operation.");
    }
    const coincidental = sealFact<OperationRecord<"distill.brief">>({
      schemaVersion: 1,
      recordKind: "completed",
      requestId: brief.requestId,
      method: brief.method,
      scope: brief.scope,
      actor: brief.actor,
      inputChecksum: brief.inputChecksum,
      result: {
        ...brief.result,
        contract: {
          ...brief.result.contract,
          instructions: fixture.transaction.version.id,
        },
      },
      completedAt: brief.completedAt,
    });
    await replaceFactFile(
      fixture.root,
      fixture.facts.layout.operationFile(brief.requestId),
      coincidental,
      briefOperationSchema,
    );

    await fixture.composition.recovery.reconcile(fixture.transaction.requestId);

    expect(await exists(versionTarget(fixture))).toBe(false);
    await expect(
      fixture.facts.transactions.read(fixture.transaction.requestId),
    ).resolves.toMatchObject({ state: "aborted" });
  });

  it("finishes a partially removed journal-owned deleting path after restart", async () => {
    const fixture = await setupPrepared({});
    const deleting = legacyVersionDeletingDirectory(
      fixture.facts.layout,
      fixture.transaction.requestId,
      fixture.subjectId,
      fixture.transaction.version.id,
    );
    await rename(versionTarget(fixture), deleting);
    await rm(`${deleting}/profile/domains`, { recursive: true, force: false });

    await open(fixture.root, fixture.ids, fixture.clock);

    expect(await exists(versionTarget(fixture))).toBe(false);
    expect(await exists(deleting)).toBe(false);
    await expect(
      fixture.facts.transactions.read(fixture.transaction.requestId),
    ).resolves.toMatchObject({ state: "aborted" });
    await expect(
      fixture.facts.operations.readOptional(fixture.transaction.requestId),
    ).resolves.toBeUndefined();
  });

  it("preserves a byte-mismatched pre-state publication", async () => {
    const fixture = await setupPrepared({});
    const prompt = fixture.facts.layout.versionPromptFile(
      fixture.subjectId,
      fixture.transaction.version.id,
    );
    await writeFile(prompt, "tampered prompt\n");

    await expectCode(
      fixture.composition.recovery.reconcile(fixture.transaction.requestId),
      "storage_corrupt",
    );

    expect(await readFile(prompt, "utf8")).toBe("tampered prompt\n");
    expect(await exists(versionTarget(fixture))).toBe(true);
    await expect(fixture.facts.transactions.read(fixture.transaction.requestId)).resolves.toEqual(
      fixture.transaction,
    );
  });

  it.each([
    "state current",
    "state suspended",
    "parent",
    "derived",
    "renderer source",
    "carried claim",
    "other terminal journal",
    "completed operation",
  ] as const)("preserves a pre-state publication referenced by %s", async (reference) => {
    const fixture = await setupPrepared({ suspended: reference === "state suspended" });
    if (reference === "state current" || reference === "state suspended") {
      await fixture.facts.states.write(fixture.transaction.targetState);
    } else if (
      reference === "parent" ||
      reference === "derived" ||
      reference === "renderer source" ||
      reference === "carried claim"
    ) {
      await publishLineageReference(fixture, reference);
    } else if (reference === "other terminal journal") {
      const prepared = cloneJournal(fixture.transaction, request(9));
      const terminal = resealJournal(prepared, {
        state: "aborted",
        finishedAt: COMMIT_AT,
      });
      await fixture.facts.transactions.write(prepared);
      await fixture.facts.transactions.write(terminal);
    } else {
      await fixture.facts.operations.write(cloneOperation(fixture.transaction, request(10)));
    }

    await expectCode(
      reference === "state current" || reference === "state suspended"
        ? fixture.composition.recovery.verifyVersionUnreferencedForCleanup(
            fixture.transaction.requestId,
            fixture.subjectId,
            fixture.transaction.version.id,
          )
        : fixture.composition.recovery.reconcile(fixture.transaction.requestId),
      "storage_corrupt",
    );

    expect(await exists(versionTarget(fixture))).toBe(true);
    await expect(
      fixture.facts.transactions.read(fixture.transaction.requestId),
    ).resolves.toMatchObject({ state: "prepared" });
    await expect(
      fixture.facts.operations.readOptional(fixture.transaction.requestId),
    ).resolves.toBeUndefined();
    for (const event of fixture.transaction.events) {
      expect(await exists(fixture.facts.layout.eventFile(fixture.subjectId, event.eventId))).toBe(
        false,
      );
    }
  });

  const hostileCases: readonly {
    readonly label: string;
    readonly alignPreviousPending?: boolean;
    readonly mutate: (
      transaction: DistillCommitTransactionRecord,
    ) => DistillCommitTransactionRecord;
  }[] = [
    {
      label: "nested target checksum drift",
      mutate: (transaction) =>
        resealJournal(transaction, {
          targetState: { ...transaction.targetState, checksum: BAD_CHECKSUM },
        }),
    },
    {
      label: "BriefContract digest drift",
      mutate: (transaction) => {
        const lease = transaction.previousPending.lease;
        if (lease === undefined) throw new Error("Expected a commit lease.");
        if (transaction.version.creation.kind !== "host_distill") {
          throw new Error("Expected a host-distill version.");
        }
        if (transaction.operation.result.kind !== "current") {
          throw new Error("Expected a current commit result.");
        }
        const creation = {
          ...transaction.version.creation,
          briefContractDigest: BAD_BRIEF_DIGEST,
        };
        return resealJournal(transaction, {
          previousPending: {
            ...transaction.previousPending,
            lease: {
              ...lease,
              contract: { ...lease.contract, digest: BAD_BRIEF_DIGEST },
            },
          },
          version: sealFact<VersionRecord>({ ...transaction.version, creation }),
          operation: sealFact<OperationRecord<"distill.commit">>({
            ...transaction.operation,
            result: {
              ...transaction.operation.result,
              version: { ...transaction.operation.result.version, creation },
            },
          }),
        });
      },
    },
    {
      label: "preparedAt equal to lease expiry",
      alignPreviousPending: true,
      mutate: (transaction) => {
        const lease = transaction.previousPending.lease;
        if (lease === undefined) throw new Error("Expected a commit lease.");
        return resealJournal(transaction, {
          previousPending: {
            ...transaction.previousPending,
            lease: { ...lease, expiresAt: transaction.preparedAt },
          },
        });
      },
    },
    {
      label: "trusted input checksum drift",
      mutate: (transaction) =>
        resealJournal(transaction, {
          operation: sealFact<OperationRecord<"distill.commit">>({
            ...transaction.operation,
            inputChecksum: BAD_CHECKSUM,
          }),
        }),
    },
  ];

  for (const hostile of hostileCases) {
    it.each(["previous", "target"] as const)(
      `fails closed on ${hostile.label} from a visible %s state`,
      async (visible) => {
        const fixture = await setupPrepared({});
        let transaction = hostile.mutate(fixture.transaction);
        if (visible === "previous" && hostile.alignPreviousPending) {
          const previousState = sealFact<SubjectStateRecord>({
            ...fixture.previousState,
            pending: transaction.previousPending,
          });
          await fixture.facts.states.write(previousState);
          transaction = resealJournal(transaction, {
            previousStateChecksum: previousState.checksum,
          });
        } else if (visible === "target") {
          await fixture.facts.states.write(fixture.transaction.targetState);
        }
        await replaceJournal(fixture, transaction);

        await expectCode(
          fixture.composition.recovery.reconcile(fixture.transaction.requestId),
          "storage_corrupt",
        );

        expect(await exists(versionTarget(fixture))).toBe(true);
        await expect(
          fixture.facts.operations.readOptional(fixture.transaction.requestId),
        ).resolves.toBeUndefined();
      },
    );
  }

  it.each(["previous", "target"] as const)(
    "accepts a clock rollback with preparedAt before acquiredAt from a visible %s state",
    async (visible) => {
      const fixture = await setupPrepared({});
      const lease = fixture.transaction.previousPending.lease;
      if (lease === undefined) throw new Error("Expected a commit lease.");
      let transaction = resealJournal(fixture.transaction, {
        previousPending: {
          ...fixture.transaction.previousPending,
          lease: { ...lease, acquiredAt: ROLLED_ACQUIRED_AT },
        },
      });
      if (visible === "previous") {
        const previousState = sealFact<SubjectStateRecord>({
          ...fixture.previousState,
          pending: transaction.previousPending,
        });
        await fixture.facts.states.write(previousState);
        transaction = resealJournal(transaction, {
          previousStateChecksum: previousState.checksum,
        });
      } else {
        await fixture.facts.states.write(fixture.transaction.targetState);
      }
      await replaceJournal(fixture, transaction);

      await fixture.composition.recovery.reconcile(fixture.transaction.requestId);

      await expect(
        fixture.facts.transactions.read(fixture.transaction.requestId),
      ).resolves.toMatchObject({ state: visible === "target" ? "committed" : "aborted" });
      expect(await exists(versionTarget(fixture))).toBe(visible === "target");
    },
  );

  it.each(["previous", "target"] as const)(
    "makes a second %s-side recovery an exact no-op",
    async (visible) => {
      const fixture = await setupPrepared({});
      if (visible === "target") {
        await fixture.facts.states.write(fixture.transaction.targetState);
      }
      await fixture.composition.recovery.reconcile(fixture.transaction.requestId);
      const firstTerminal = await fixture.facts.transactions.read(fixture.transaction.requestId);
      const firstOperation = await fixture.facts.operations.readOptional(
        fixture.transaction.requestId,
      );
      const firstVersionExists = await exists(versionTarget(fixture));

      await fixture.composition.recovery.reconcile(fixture.transaction.requestId);

      await expect(fixture.facts.transactions.read(fixture.transaction.requestId)).resolves.toEqual(
        firstTerminal,
      );
      await expect(
        fixture.facts.operations.readOptional(fixture.transaction.requestId),
      ).resolves.toEqual(firstOperation);
      expect(await exists(versionTarget(fixture))).toBe(firstVersionExists);
    },
  );
});
