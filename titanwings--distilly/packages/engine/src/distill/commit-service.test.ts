import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  briefMaterialRefSchema,
  claimIdSchema,
  distillCommitTransactionRecordSchema,
  DistillyError,
  facetPathSchema,
  operationFactSchema,
  requestIdSchema,
  type ActorContext,
  type ClientSessionContext,
  type CommitInput,
  type DistillCommitTransactionRecord,
  type EventId,
  type IngestInput,
  type IsoDateTime,
  type JobId,
  type LeaseId,
  type LeaseOwnerId,
  type OperationFact,
  type OperationRecord,
  type OperationTombstoneRecord,
  type RequestId,
  type RuntimeSchema,
  type SpaceId,
  type SubjectId,
  type SubjectRecord,
  type SubjectStateRecord,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import { computeFactChecksum, sealFact } from "../facts/checksum.js";
import { digestBriefContract } from "../facts/digests.js";
import { FileEventStore } from "../facts/event-store.js";
import { createFactFile, replaceFactFile } from "../facts/fact-file.js";
import { FileMaterialStore } from "../facts/material-store.js";
import { FileOperationStore } from "../facts/operation-store.js";
import { FileSpaceStore } from "../facts/space-store.js";
import { FileStateStore } from "../facts/state-store.js";
import { FileSubjectStore } from "../facts/subject-store.js";
import { FileTransactionStore } from "../testing/legacy-file-transaction-store.test.fixture.js";
import { FileVersionStore } from "../facts/version-store.js";
import type {
  LegacyFileEngineTestSupport,
  LegacyFileEngineTestSupportOptions,
} from "../testing/legacy-file-engine.test.fixture.js";
import { createLegacyFileEngineTestSupport } from "../testing/legacy-file-engine.test.fixture.js";
import { Layout } from "../layout.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { legacyVersionStagingDirectory } from "../testing/legacy-file-version-staging.test.fixture.js";
import type { VersionStagingArtifactLabel } from "../testing/legacy-file-version-staging.test.fixture.js";

const AT = "2026-08-21T08:00:00.000Z" as IsoDateTime;
const ACTOR: ActorContext = { kind: "sdk", id: "step7-commit-test" };
const roots: string[] = [];

const operationFactRuntimeSchema: RuntimeSchema<OperationFact> = {
  parse(value) {
    return operationFactSchema.parse(value) as OperationFact;
  },
};

const commitTransactionRuntimeSchema: RuntimeSchema<DistillCommitTransactionRecord> = {
  parse(value) {
    return distillCommitTransactionRecordSchema.parse(value) as DistillCommitTransactionRecord;
  },
};

class FakeClock implements Clock {
  current = AT;

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

const session = (ownerDigit = 1): ClientSessionContext => ({
  actor: ACTOR,
  leaseOwner: `lease_owner_${ownerDigit.toString(16).padStart(32, "0")}` as LeaseOwnerId,
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
      displayName: "Mira Chen",
      aliases: ["Mira"],
      identityHints: [{ kind: "url", value: "https://example.com/mira" }],
    },
  },
  materials: [
    {
      clientRef: "biography",
      kind: "web",
      content: "Mira Chen designs reliable local-first research systems.",
      source: {
        uri: "https://example.com/mira",
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

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-commit-service-"));
  roots.push(root);
  return root;
};

const open = async (
  root: string,
  ids: SequenceIds,
  clock: FakeClock,
  options: Omit<LegacyFileEngineTestSupportOptions, "root" | "ids" | "clock"> = {},
): Promise<LegacyFileEngineTestSupport> =>
  createLegacyFileEngineTestSupport({ root, ids, clock, ...options });

const commitInput = (
  briefing: Awaited<ReturnType<LegacyFileEngineTestSupport["leases"]["brief"]>>,
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

const validPatch = (): CommitInput["patch"] => ({
  operations: [
    {
      op: "add",
      claim: {
        facet: facetPathSchema.parse("identity.biography"),
        text: "Mira designs reliable local-first research systems.",
        evidence: [
          {
            kind: "brief_material",
            materialRef: briefMaterialRefSchema.parse("m001"),
            quote: "Mira Chen designs reliable local-first research systems.",
          },
        ],
      },
    },
  ],
});

const incrementalMaterial = (): IngestInput["materials"][number] => ({
  clientRef: "studio-interview",
  kind: "web",
  content: "Mira starts explanations with a concrete recovery example.",
  source: {
    uri: "https://example.com/mira/interview",
    medium: "article",
    access: "public",
    role: "reference",
    capturedAt: AT,
  },
  derivation: { kind: "native_text" },
});

const incrementalPatch = (): CommitInput["patch"] => ({
  operations: [
    {
      op: "add",
      claim: {
        facet: facetPathSchema.parse("voice.explanation_style"),
        text: "Mira starts explanations with a concrete recovery example.",
        evidence: [
          {
            kind: "brief_material",
            materialRef: briefMaterialRefSchema.parse("m001"),
            quote: "Mira starts explanations with a concrete recovery example.",
          },
        ],
      },
    },
  ],
});

const invalidEvidencePatch = (): CommitInput["patch"] => {
  const patch = validPatch();
  const operation = patch.operations[0];
  if (operation?.op !== "add") throw new Error("Expected an add operation fixture.");
  return {
    operations: [
      {
        ...operation,
        claim: {
          ...operation.claim,
          evidence: [
            {
              kind: "brief_material",
              materialRef: briefMaterialRefSchema.parse("m001"),
              quote: "wrong",
            },
          ],
        },
      },
    ],
  };
};

const invalidTargetPatch = (invalidEvidence = false): CommitInput["patch"] => {
  const patch = invalidEvidence ? invalidEvidencePatch() : validPatch();
  const operation = patch.operations[0];
  if (operation?.op !== "add") throw new Error("Expected an add operation fixture.");
  return {
    operations: [
      {
        op: "revise",
        claimId: claimIdSchema.parse(`claim_${"f".repeat(64)}`),
        replacement: operation.claim,
        reason: "Replace an unavailable base claim.",
      },
    ],
  };
};

const invalidLocatorPatch = (): CommitInput["patch"] => {
  const patch = validPatch();
  const operation = patch.operations[0];
  if (operation?.op !== "add") throw new Error("Expected an add operation fixture.");
  const evidence = operation.claim.evidence[0];
  if (evidence?.kind !== "brief_material") {
    throw new Error("Expected a brief-material evidence fixture.");
  }
  return {
    operations: [
      {
        ...operation,
        claim: {
          ...operation.claim,
          evidence: [{ ...evidence, locator: { start: 0, end: 0 } }],
        },
      },
    ],
  };
};

const invalidDatePatch = (): CommitInput["patch"] => {
  const patch = validPatch();
  const operation = patch.operations[0];
  if (operation?.op !== "add") throw new Error("Expected an add operation fixture.");
  return {
    operations: [
      {
        ...operation,
        claim: {
          ...operation.claim,
          validFrom: AT,
          validTo: "2026-08-20T08:00:00.000Z" as IsoDateTime,
        },
      },
    ],
  };
};

const domainPatch = (): CommitInput["patch"] => {
  const patch = validPatch();
  const operation = patch.operations[0];
  if (operation?.op !== "add") throw new Error("Expected an add operation fixture.");
  return {
    operations: [
      {
        ...operation,
        claim: { ...operation.claim, facet: facetPathSchema.parse("career.history") },
      },
    ],
  };
};

const oversizedPatch = (): CommitInput["patch"] => {
  const patch = validPatch();
  const operation = patch.operations[0];
  if (operation?.op !== "add") throw new Error("Expected an add operation fixture.");
  const emptyQuotePatch: CommitInput["patch"] = {
    operations: [
      {
        ...operation,
        claim: {
          ...operation.claim,
          evidence: [
            {
              kind: "brief_material",
              materialRef: briefMaterialRefSchema.parse("m001"),
              quote: "",
            },
          ],
        },
      },
    ],
  };
  const fixedBytes = Buffer.byteLength(JSON.stringify(emptyQuotePatch), "utf8");
  const quote = "x".repeat(65_537 - fixedBytes);
  const oversized: CommitInput["patch"] = {
    operations: [
      {
        ...operation,
        claim: {
          ...operation.claim,
          evidence: [
            {
              kind: "brief_material",
              materialRef: briefMaterialRefSchema.parse("m001"),
              quote,
            },
          ],
        },
      },
    ],
  };
  if (Buffer.byteLength(JSON.stringify(oversized), "utf8") !== 65_537) {
    throw new Error("Oversized patch fixture is not exactly 65,537 bytes.");
  }
  return oversized;
};

const setupLease = async (composition: LegacyFileEngineTestSupport) => {
  const ingest = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
  if (ingest.job === undefined) throw new Error("Expected enqueue=now to create a job.");
  const briefing = await composition.leases.brief({ jobId: ingest.job.id }, session(), {
    requestId: request(2),
  });
  return { ingest, briefing };
};

const setupCommitFixture = async () => {
  const root = await makeRoot();
  const ids = new SequenceIds();
  const clock = new FakeClock();
  const composition = await open(root, ids, clock);
  const { ingest, briefing } = await setupLease(composition);
  return {
    root,
    ids,
    clock,
    composition,
    ingest,
    briefing,
    input: commitInput(briefing, validPatch()),
  };
};

type CommitFixture = Awaited<ReturnType<typeof setupCommitFixture>>;

const setupAbortedCommit = async () => {
  const root = await makeRoot();
  const ids = new SequenceIds();
  const clock = new FakeClock();
  const crashed = await open(root, ids, clock, {
    commitHooks: { afterPrepared: failOnce() },
  });
  const { ingest, briefing } = await setupLease(crashed);
  const input = commitInput(briefing, validPatch());
  await expect(crashed.commits.commit(input, session(), { requestId: request(3) })).rejects.toThrow(
    "simulated process crash",
  );
  const recovered = await open(root, ids, clock);
  const facts = stores(root);
  await expect(facts.transactions.read(request(3))).resolves.toMatchObject({
    transactionKind: "distill_commit",
    state: "aborted",
  });
  return { root, ids, clock, recovered, facts, ingest, briefing, input };
};

const setupIncrementalLease = async (fixture: CommitFixture) => {
  const baseline = await fixture.composition.commits.commit(fixture.input, session(), {
    requestId: request(3),
  });
  if (baseline.kind !== "current") throw new Error("Expected a current baseline version.");
  const ingest = await fixture.composition.ingest.ingest(
    {
      subject: { kind: "existing", subjectId: fixture.ingest.subject.id },
      materials: [incrementalMaterial()],
      enqueue: "now",
    },
    ACTOR,
    { requestId: request(4) },
  );
  if (ingest.job === undefined) throw new Error("Expected incremental ingest to create a job.");
  const briefing = await fixture.composition.leases.brief({ jobId: ingest.job.id }, session(), {
    requestId: request(5),
  });
  return { baseline, ingest, briefing };
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

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const snapshotTree = async (root: string): Promise<Readonly<Record<string, string>>> => {
  if (!(await exists(root))) return {};
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = "directory";
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        snapshot[relative] = (await readFile(absolute)).toString("base64");
      } else {
        snapshot[relative] = entry.isSymbolicLink() ? "symlink" : "other";
      }
    }
  };
  await visit(root, "");
  return snapshot;
};

const snapshotQueueDurableFiles = async (
  layout: Layout,
): Promise<Readonly<Record<string, string>>> => {
  const databaseFile = join(layout.indexDirectory(), "queue.db");
  const paths = [databaseFile, `${databaseFile}-wal`, join(layout.indexDirectory(), "queue.dirty")];
  const snapshot: Record<string, string> = {};
  for (const path of paths) {
    if (await exists(path)) snapshot[path] = (await readFile(path)).toString("base64");
  }
  return snapshot;
};

const stores = (root: string) => {
  const layout = new Layout(root);
  const spaces = new FileSpaceStore(layout);
  const subjects = new FileSubjectStore(layout, spaces);
  const materials = new FileMaterialStore(layout, subjects);
  return {
    layout,
    subjects,
    states: new FileStateStore(layout, subjects, materials),
    events: new FileEventStore(layout, subjects),
    operations: new FileOperationStore(layout, subjects),
    transactions: new FileTransactionStore(layout),
    versions: new FileVersionStore(layout, materials),
  };
};

const writeCommitTombstone = async (
  fixture: CommitFixture,
  input: CommitInput,
  clientSession: ClientSessionContext,
  requestId: RequestId,
): Promise<OperationTombstoneRecord> => {
  const facts = stores(fixture.root);
  const tombstone = sealFact<OperationTombstoneRecord>({
    schemaVersion: 1,
    recordKind: "tombstone",
    requestId,
    method: "distill.commit",
    scope: { kind: "subject", subjectId: fixture.ingest.subject.id },
    inputChecksum: computeFactChecksum({
      method: "distill.commit",
      params: input,
      actor: clientSession.actor,
      leaseOwner: clientSession.leaseOwner,
    }),
    removedAt: AT,
    reason: "subject_purged",
  });
  await createFactFile(
    fixture.root,
    facts.layout.operationFile(requestId),
    tombstone,
    operationFactRuntimeSchema,
  );
  return tombstone;
};

const assertHardRejectWorldUnchanged = async (input: {
  readonly fixture: CommitFixture;
  readonly requestId: RequestId;
  readonly expectedCode: string;
  readonly run: () => Promise<unknown>;
}): Promise<void> => {
  const facts = stores(input.fixture.root);
  const subjectId = input.fixture.ingest.subject.id;
  const statePath = facts.layout.stateFile(subjectId);
  const subjectPath = facts.layout.subjectDirectory(subjectId);
  const stateBefore = await readFile(statePath);
  const subjectBefore = await snapshotTree(subjectPath);
  const queueBefore = await input.fixture.composition.leases.pending({ subjectId });
  const queueFilesBefore = await snapshotQueueDurableFiles(facts.layout);
  await expect(facts.operations.readOptional(input.requestId)).resolves.toBeUndefined();
  await expect(facts.transactions.readOptional(input.requestId)).resolves.toBeUndefined();

  await rejectCode(input.run(), input.expectedCode);

  expect(await readFile(statePath)).toEqual(stateBefore);
  expect(await snapshotTree(subjectPath)).toEqual(subjectBefore);
  expect(await input.fixture.composition.leases.pending({ subjectId })).toEqual(queueBefore);
  expect(await snapshotQueueDurableFiles(facts.layout)).toEqual(queueFilesBefore);
  await expect(facts.operations.readOptional(input.requestId)).resolves.toBeUndefined();
  await expect(facts.transactions.readOptional(input.requestId)).resolves.toBeUndefined();
};

const withoutTransactionLifecycle = (
  transaction: DistillCommitTransactionRecord,
): Readonly<Record<string, unknown>> => {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(transaction)) {
    if (key !== "checksum" && key !== "state" && key !== "finishedAt") payload[key] = value;
  }
  return payload;
};

const resealCommitJournal = (
  transaction: DistillCommitTransactionRecord,
  changes: Readonly<Record<string, unknown>>,
): DistillCommitTransactionRecord => {
  const payload = Object.fromEntries(
    Object.entries({ ...transaction, ...changes }).filter(([key]) => key !== "checksum"),
  );
  return commitTransactionRuntimeSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  });
};

const failOnCall = (target: number): (() => void) => {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === target) throw new Error("simulated process crash");
  };
};

const postStateRecoveryCases: readonly {
  readonly label: string;
  readonly options: () => Omit<LegacyFileEngineTestSupportOptions, "root" | "ids" | "clock">;
}[] = [
  {
    label: "state commit point",
    options: () => ({ commitHooks: { afterFactCommit: failOnce() } }),
  },
  {
    label: "operation",
    options: () => ({ recoveryHooks: { afterOperation: failOnce() } }),
  },
  {
    label: "first event",
    options: () => ({ recoveryHooks: { afterEvent: failOnCall(1) } }),
  },
  {
    label: "second event",
    options: () => ({ recoveryHooks: { afterEvent: failOnCall(2) } }),
  },
  {
    label: "current profile",
    options: () => ({ recoveryHooks: { afterCurrentProfile: failOnce() } }),
  },
  { label: "queue", options: () => ({ recoveryHooks: { afterQueue: failOnce() } }) },
  {
    label: "terminal journal",
    options: () => ({ recoveryHooks: { afterCommitTerminal: failOnce() } }),
  },
];

const STAGED_ARTIFACT_LABELS = [
  "version.json",
  "materials.json",
  "claims.json",
  "profile/profile.md",
  "profile/identity.md",
  "profile/voice.md",
  "profile/psyche.md",
  "profile/relations.md",
  "profile/boundaries.md",
  "profile/texture.md",
  "profile/timeline.md",
  "profile/domains/career.md",
  "prompt.md",
] as const satisfies readonly VersionStagingArtifactLabel[];

interface HardRejectAttempt {
  readonly input: CommitInput;
  readonly clientSession: ClientSessionContext;
  readonly requestId: RequestId;
}

interface HardRejectCase {
  readonly label: string;
  readonly expectedCode: string;
  readonly arrange: (fixture: CommitFixture) => Promise<HardRejectAttempt>;
}

const hardRejectCases: readonly HardRejectCase[] = [
  {
    label: "boundary-sized patch before stale state",
    expectedCode: "invalid_input",
    arrange: (fixture) =>
      Promise.resolve({
        input: {
          ...fixture.input,
          generation: fixture.input.generation + 1,
          patch: oversizedPatch(),
        },
        clientSession: session(),
        requestId: request(3),
      }),
  },
  {
    label: "invalid locator boundary before stale state",
    expectedCode: "invalid_input",
    arrange: (fixture) =>
      Promise.resolve({
        input: {
          ...fixture.input,
          generation: fixture.input.generation + 1,
          patch: invalidLocatorPatch(),
        },
        clientSession: session(),
        requestId: request(3),
      }),
  },
  {
    label: "invalid date boundary before stale state",
    expectedCode: "invalid_input",
    arrange: (fixture) =>
      Promise.resolve({
        input: {
          ...fixture.input,
          generation: fixture.input.generation + 1,
          patch: invalidDatePatch(),
        },
        clientSession: session(),
        requestId: request(3),
      }),
  },
  {
    label: "active suspended before stale job",
    expectedCode: "review_conflict",
    arrange: async (fixture) => {
      await fixture.composition.commits.commit(
        { ...fixture.input, patch: { ...fixture.input.patch, reviewRequest: {} } },
        session(),
        { requestId: request(3) },
      );
      return {
        input: { ...fixture.input, generation: fixture.input.generation + 1 },
        clientSession: session(2),
        requestId: request(4),
      };
    },
  },
  {
    label: "stale generation before lease owner",
    expectedCode: "stale_job",
    arrange: (fixture) =>
      Promise.resolve({
        input: { ...fixture.input, generation: fixture.input.generation + 1 },
        clientSession: session(2),
        requestId: request(3),
      }),
  },
  {
    label: "missing lease before invalid target",
    expectedCode: "lease_conflict",
    arrange: async (fixture) => {
      await fixture.composition.leases.release(
        { jobId: fixture.input.jobId, leaseId: fixture.input.leaseId },
        session(),
        { requestId: request(3) },
      );
      return {
        input: { ...fixture.input, patch: invalidTargetPatch() },
        clientSession: session(),
        requestId: request(4),
      };
    },
  },
  {
    label: "wrong lease id before invalid target",
    expectedCode: "lease_conflict",
    arrange: (fixture) =>
      Promise.resolve({
        input: {
          ...fixture.input,
          leaseId: `lease_${"f".repeat(32)}` as LeaseId,
          patch: invalidTargetPatch(),
        },
        clientSession: session(),
        requestId: request(3),
      }),
  },
  {
    label: "wrong lease owner before invalid target",
    expectedCode: "lease_conflict",
    arrange: (fixture) =>
      Promise.resolve({
        input: { ...fixture.input, patch: invalidTargetPatch() },
        clientSession: session(2),
        requestId: request(3),
      }),
  },
  {
    label: "expired lease before invalid target",
    expectedCode: "lease_expired",
    arrange: (fixture) => {
      fixture.clock.current = fixture.briefing.lease.expiresAt;
      return Promise.resolve({
        input: { ...fixture.input, patch: invalidTargetPatch() },
        clientSession: session(),
        requestId: request(3),
      });
    },
  },
  {
    label: "unavailable pinned prompt before invalid target",
    expectedCode: "schema_unsupported",
    arrange: async (fixture) => {
      const facts = stores(fixture.root);
      const state = await facts.states.read(fixture.ingest.subject.id);
      const pending = state.pending;
      const lease = pending?.lease;
      if (pending === undefined || lease === undefined) {
        throw new Error("Expected an active lease before changing its pinned prompt.");
      }
      const contractFields = {
        sourceGroupingVersion: lease.contract.sourceGroupingVersion,
        promptVersion: `host-distill-v1-sha256_${"f".repeat(64)}` as const,
        draftSchemaVersion: lease.contract.draftSchemaVersion,
      };
      const contract = { ...contractFields, digest: digestBriefContract(contractFields) };
      await facts.states.write(
        sealFact<SubjectStateRecord>({
          ...state,
          pending: { ...pending, lease: { ...lease, contract } },
        }),
      );
      return {
        input: {
          ...fixture.input,
          briefContractDigest: contract.digest,
          patch: invalidTargetPatch(),
        },
        clientSession: session(),
        requestId: request(3),
      };
    },
  },
  {
    label: "invalid target before invalid evidence",
    expectedCode: "invalid_input",
    arrange: (fixture) =>
      Promise.resolve({
        input: { ...fixture.input, patch: invalidTargetPatch(true) },
        clientSession: session(),
        requestId: request(3),
      }),
  },
  {
    label: "invalid evidence after valid target preflight",
    expectedCode: "evidence_invalid",
    arrange: (fixture) =>
      Promise.resolve({
        input: { ...fixture.input, patch: invalidEvidencePatch() },
        clientSession: session(),
        requestId: request(3),
      }),
  },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CommitService", { timeout: 45_000 }, () => {
  it("commits a verified first-version claim patch and exact renderer artifacts", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const { ingest, briefing } = await setupLease(composition);

    const result = await composition.commits.commit(
      commitInput(briefing, validPatch()),
      session(),
      { requestId: request(3) },
    );
    expect(result.kind).toBe("current");
    if (result.kind !== "current") throw new Error("Expected a current version.");
    expect(result.profile).toMatchObject({
      subjectId: ingest.subject.id,
      displayName: "Mira Chen",
      versionId: result.version.id,
      quality: { maturity: "sparse", activeClaimCount: 1 },
    });
    expect(result.profile.rendered).toContain(
      '"text":"Mira designs reliable local-first research systems."',
    );
    expect(result.profile.rendered.endsWith("\n")).toBe(true);

    const facts = stores(root);
    const state = await facts.states.read(ingest.subject.id);
    expect(state).toMatchObject({ currentVersionId: result.version.id });
    expect(state.pending).toBeUndefined();
    await expect(facts.operations.read(request(3))).resolves.toMatchObject({
      method: "distill.commit",
      result,
    });
    await expect(facts.transactions.read(request(3))).resolves.toMatchObject({
      transactionKind: "distill_commit",
      state: "committed",
      version: { id: result.version.id },
    });
    const stored = await facts.versions.read(ingest.subject.id, result.version.id);
    expect(stored.profile).toEqual(result.profile);
    expect(await readFile(facts.layout.currentProfileFile(ingest.subject.id), "utf8")).toBe(
      result.profile.rendered,
    );
    expect(await composition.leases.pending({})).toEqual([]);
  });

  it("commits an incremental current version from the verified baseline", async () => {
    const fixture = await setupCommitFixture();
    const { baseline, briefing } = await setupIncrementalLease(fixture);
    const facts = stores(fixture.root);
    const subjectId = fixture.ingest.subject.id;
    const baselineVersionBefore = await snapshotTree(
      facts.layout.versionDirectory(subjectId, baseline.version.id),
    );
    const projectionBefore = await snapshotTree(facts.layout.currentProfileDirectory(subjectId));

    const result = await fixture.composition.commits.commit(
      commitInput(briefing, incrementalPatch()),
      session(),
      { requestId: request(6) },
    );

    expect(result.kind).toBe("current");
    if (result.kind !== "current") throw new Error("Expected an incremental current version.");
    expect(result.version.parentId).toBe(baseline.version.id);
    expect(result.profile.claims).toHaveLength(2);
    const state = await facts.states.read(subjectId);
    expect(state.currentVersionId).toBe(result.version.id);
    expect(state.suspendedVersionId).toBeUndefined();
    expect(state.pending).toBeUndefined();
    const stored = await facts.versions.read(subjectId, result.version.id);
    expect(stored.version.parentId).toBe(baseline.version.id);
    expect(stored.profile).toEqual(result.profile);
    expect(
      await snapshotTree(facts.layout.versionDirectory(subjectId, baseline.version.id)),
    ).toEqual(baselineVersionBefore);
    expect(await snapshotTree(facts.layout.currentProfileDirectory(subjectId))).not.toEqual(
      projectionBefore,
    );
    expect(await readFile(facts.layout.currentProfileFile(subjectId), "utf8")).toBe(
      result.profile.rendered,
    );
    expect(await readFile(facts.layout.currentPromptFile(subjectId), "utf8")).toBe(stored.prompt);

    const committedVersionBeforeRename = await snapshotTree(
      facts.layout.versionDirectory(subjectId, result.version.id),
    );
    const committedProjectionBeforeRename = await snapshotTree(
      facts.layout.currentProfileDirectory(subjectId),
    );
    const subject = await facts.subjects.read(subjectId);
    await facts.subjects.write(
      sealFact<SubjectRecord>({
        schemaVersion: 1,
        id: subject.id,
        spaceId: subject.spaceId,
        displayName: "Mira Chen Renamed",
        aliases: subject.aliases,
        identityHints: subject.identityHints,
        ...(subject.domainPack === undefined ? {} : { domainPack: subject.domainPack }),
        lifecycle: subject.lifecycle,
      }),
    );
    await expect(facts.versions.read(subjectId, result.version.id)).resolves.toEqual(stored);
    expect(await snapshotTree(facts.layout.versionDirectory(subjectId, result.version.id))).toEqual(
      committedVersionBeforeRename,
    );
    expect(await snapshotTree(facts.layout.currentProfileDirectory(subjectId))).toEqual(
      committedProjectionBeforeRename,
    );
  });

  it("suspends an incremental candidate without changing the existing current projection", async () => {
    const fixture = await setupCommitFixture();
    const { baseline, briefing } = await setupIncrementalLease(fixture);
    const patch = { ...incrementalPatch(), reviewRequest: { note: "Please review." } };
    const facts = stores(fixture.root);
    const subjectId = fixture.ingest.subject.id;
    const projectionBefore = await snapshotTree(facts.layout.currentProfileDirectory(subjectId));
    const eventsBefore = await snapshotTree(
      join(facts.layout.subjectDirectory(subjectId), "events"),
    );

    const result = await fixture.composition.commits.commit(
      commitInput(briefing, patch),
      session(),
      { requestId: request(6) },
    );
    expect(result.kind).toBe("suspended");
    if (result.kind !== "suspended") throw new Error("Expected a suspended version.");
    expect(result.reasons).toEqual([{ code: "manual_review_requested", note: "Please review." }]);
    expect(result.currentVersionId).toBe(baseline.version.id);
    const state = await facts.states.read(subjectId);
    expect(state.currentVersionId).toBe(baseline.version.id);
    expect(state.suspendedVersionId).toBe(result.candidate.id);
    expect(state.pending).toBeUndefined();
    expect(await snapshotTree(facts.layout.currentProfileDirectory(subjectId))).toEqual(
      projectionBefore,
    );
    const candidate = await facts.versions.read(subjectId, result.candidate.id);
    expect(candidate.version.parentId).toBe(baseline.version.id);
    expect(candidate.version.reviewReasons).toEqual(result.reasons);
    expect(await readFile(facts.layout.currentProfileFile(subjectId), "utf8")).toBe(
      baseline.profile.rendered,
    );
    const operation = await facts.operations.read(request(6));
    expect(operation).toMatchObject({ method: "distill.commit", result });
    const terminal = await facts.transactions.read(request(6));
    if (terminal.transactionKind !== "distill_commit" || terminal.state !== "committed") {
      throw new Error("Expected a committed suspended-version journal.");
    }
    expect(terminal.operation).toEqual(operation);
    expect(terminal.operation.result).toEqual(result);
    expect(terminal.version.reviewReasons).toEqual(result.reasons);
    expect(terminal.events.map((event) => event.event.kind)).toEqual([
      "version.suspended",
      "job.changed",
    ]);
    const eventsAfter = await snapshotTree(
      join(facts.layout.subjectDirectory(subjectId), "events"),
    );
    expect(
      Object.keys(eventsAfter)
        .filter((path) => !(path in eventsBefore))
        .sort(),
    ).toEqual(terminal.events.map((event) => `${event.eventId}.json`).sort());
    await expect(
      fixture.composition.commits.commit(commitInput(briefing, patch), session(), {
        requestId: request(6),
      }),
    ).resolves.toEqual(result);
  });

  it.each(hardRejectCases)(
    "hard rejects $label without changing the fact or projection world",
    async ({ expectedCode, arrange }) => {
      const fixture = await setupCommitFixture();
      const attempt = await arrange(fixture);
      await assertHardRejectWorldUnchanged({
        fixture,
        requestId: attempt.requestId,
        expectedCode,
        run: () =>
          fixture.composition.commits.commit(attempt.input, attempt.clientSession, {
            requestId: attempt.requestId,
          }),
      });
    },
  );

  it("rejects a repeated base-claim target without writing commit facts or projections", async () => {
    const fixture = await setupCommitFixture();
    const { baseline, briefing } = await setupIncrementalLease(fixture);
    const claim = baseline.profile.claims[0];
    if (claim === undefined) throw new Error("Expected a baseline claim.");
    const baselineEvidence = {
      kind: "baseline_evidence" as const,
      claimId: claim.id,
      evidenceIndex: 0,
    };
    const input = commitInput(briefing, {
      operations: [
        {
          op: "contest",
          claimId: claim.id,
          reason: "First target.",
          evidence: [baselineEvidence],
        },
        {
          op: "supersede",
          claimId: claim.id,
          reason: "Second target would create an ambiguous claim transition.",
          evidence: [baselineEvidence],
        },
      ],
    });

    await assertHardRejectWorldUnchanged({
      fixture,
      requestId: request(6),
      expectedCode: "invalid_input",
      run: () => fixture.composition.commits.commit(input, session(), { requestId: request(6) }),
    });
  });

  it("rejects a revise self-cycle without writing commit facts or projections", async () => {
    const fixture = await setupCommitFixture();
    const { baseline, briefing } = await setupIncrementalLease(fixture);
    const claim = baseline.profile.claims[0];
    if (claim === undefined) throw new Error("Expected a baseline claim.");
    const input = commitInput(briefing, {
      operations: [
        {
          op: "revise",
          claimId: claim.id,
          replacement: {
            facet: claim.facet,
            text: claim.text,
            evidence: [
              {
                kind: "baseline_evidence",
                claimId: claim.id,
                evidenceIndex: 0,
              },
            ],
            observedIn: claim.observedIn,
            ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
            ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
          },
          reason: "Same semantic claim would create a self-cycle.",
        },
      ],
    });

    await assertHardRejectWorldUnchanged({
      fixture,
      requestId: request(6),
      expectedCode: "invalid_input",
      run: () => fixture.composition.commits.commit(input, session(), { requestId: request(6) }),
    });
  });

  it("rejects an old worker after a real newer generation without changing the new job", async () => {
    const fixture = await setupCommitFixture();
    const newer = await fixture.composition.ingest.ingest(
      {
        subject: { kind: "existing", subjectId: fixture.ingest.subject.id },
        materials: [incrementalMaterial()],
        enqueue: "now",
      },
      ACTOR,
      { requestId: request(3) },
    );
    if (newer.job === undefined) throw new Error("Expected a newer pending generation.");

    await assertHardRejectWorldUnchanged({
      fixture,
      requestId: request(4),
      expectedCode: "stale_job",
      run: () =>
        fixture.composition.commits.commit(fixture.input, session(), {
          requestId: request(4),
        }),
    });
    expect(
      await fixture.composition.leases.pending({ subjectId: fixture.ingest.subject.id }),
    ).toEqual([newer.job]);
  });

  it("fails closed on corrupt authoritative state without writing commit or queue facts", async () => {
    const fixture = await setupCommitFixture();
    const facts = stores(fixture.root);
    const subjectId = fixture.ingest.subject.id;
    const queueBefore = await snapshotQueueDurableFiles(facts.layout);
    await writeFile(facts.layout.stateFile(subjectId), "{\n", { encoding: "utf8" });
    const subjectBefore = await snapshotTree(facts.layout.subjectDirectory(subjectId));

    await rejectCode(
      fixture.composition.commits.commit(fixture.input, session(), { requestId: request(3) }),
      "storage_corrupt",
    );

    expect(await snapshotTree(facts.layout.subjectDirectory(subjectId))).toEqual(subjectBefore);
    expect(await snapshotQueueDurableFiles(facts.layout)).toEqual(queueBefore);
    await expect(facts.operations.readOptional(request(3))).resolves.toBeUndefined();
    await expect(facts.transactions.readOptional(request(3))).resolves.toBeUndefined();
  });

  it("exactly replays a completed commit and conflicts on a changed patch or owner", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const clock = new FakeClock();
    const composition = await open(root, ids, clock);
    const { briefing } = await setupLease(composition);
    const input = commitInput(briefing, validPatch());
    const mutation = { requestId: request(3) };
    const first = await composition.commits.commit(input, session(), mutation);
    await expect(composition.commits.commit(input, session(), mutation)).resolves.toEqual(first);
    await rejectCode(
      composition.commits.commit(
        { ...input, patch: { ...input.patch, notes: "changed" } },
        session(),
        mutation,
      ),
      "idempotency_conflict",
    );
    await rejectCode(
      composition.commits.commit(input, session(2), mutation),
      "idempotency_conflict",
    );
  });

  it("rejects a semantically corrupt committed journal before exact replay or retained lookup", async () => {
    const fixture = await setupCommitFixture();
    const mutation = { requestId: request(3) };
    await fixture.composition.commits.commit(fixture.input, session(), mutation);
    const facts = stores(fixture.root);
    const terminal = await facts.transactions.read(mutation.requestId);
    if (terminal.transactionKind !== "distill_commit" || terminal.state !== "committed") {
      throw new Error("Expected a committed distill commit journal.");
    }
    const forged = resealCommitJournal(terminal, {
      acceptedPatch: { ...terminal.acceptedPatch, notes: "forged terminal payload" },
    });
    await replaceFactFile(
      fixture.root,
      facts.layout.transactionFile(mutation.requestId),
      forged,
      commitTransactionRuntimeSchema,
    );
    const journalBefore = await readFile(facts.layout.transactionFile(mutation.requestId));

    await rejectCode(
      fixture.composition.commits.commit(fixture.input, session(), mutation),
      "storage_corrupt",
    );
    await rejectCode(
      fixture.composition.commits.commit(fixture.input, session(), { requestId: request(4) }),
      "storage_corrupt",
    );
    expect(await readFile(facts.layout.transactionFile(mutation.requestId))).toEqual(journalBefore);
  });

  it("returns not_found for an exact commit replay whose operation is a tombstone", async () => {
    const fixture = await setupCommitFixture();
    const mutation = { requestId: request(3) };
    const tombstone = await writeCommitTombstone(
      fixture,
      fixture.input,
      session(),
      mutation.requestId,
    );

    await rejectCode(
      fixture.composition.commits.commit(fixture.input, session(), mutation),
      "not_found",
    );
    await expect(stores(fixture.root).operations.read(mutation.requestId)).resolves.toEqual(
      tombstone,
    );
    await expect(
      stores(fixture.root).transactions.readOptional(mutation.requestId),
    ).resolves.toBeUndefined();
  });

  it("conflicts before replaying a commit tombstone for changed input or owner", async () => {
    const fixture = await setupCommitFixture();
    const mutation = { requestId: request(3) };
    await writeCommitTombstone(fixture, fixture.input, session(), mutation.requestId);

    await rejectCode(
      fixture.composition.commits.commit(
        { ...fixture.input, patch: { ...fixture.input.patch, notes: "changed" } },
        session(),
        mutation,
      ),
      "idempotency_conflict",
    );
    await rejectCode(
      fixture.composition.commits.commit(fixture.input, session(2), mutation),
      "idempotency_conflict",
    );
  });

  it("serializes concurrent exact retries under one RequestId", async () => {
    const fixture = await setupCommitFixture();
    const facts = stores(fixture.root);
    const subjectId = fixture.ingest.subject.id;
    const eventsBefore = await snapshotTree(
      join(facts.layout.subjectDirectory(subjectId), "events"),
    );
    const mutation = { requestId: request(3) };

    const settled = await Promise.allSettled([
      fixture.composition.commits.commit(fixture.input, session(), mutation),
      fixture.composition.commits.commit(fixture.input, session(), mutation),
    ]);

    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const first = fulfilled[0]?.value;
    if (first === undefined) throw new Error("Expected one concurrent commit to succeed.");
    for (const result of fulfilled) expect(result.value).toEqual(first);
    if (rejected.length !== 0) {
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(DistillyError);
      expect(rejected[0]?.reason).toMatchObject({ code: "busy", retryable: true });
    }
    await expect(
      fixture.composition.commits.commit(fixture.input, session(), mutation),
    ).resolves.toEqual(first);
    const journal = await facts.transactions.read(mutation.requestId);
    if (journal.transactionKind !== "distill_commit") {
      throw new Error("Expected a distill commit journal.");
    }
    expect(journal.state).toBe("committed");
    const eventsAfter = await snapshotTree(
      join(facts.layout.subjectDirectory(subjectId), "events"),
    );
    const newEventFiles = Object.keys(eventsAfter)
      .filter((path) => !(path in eventsBefore))
      .sort();
    expect(newEventFiles).toEqual(journal.events.map((event) => `${event.eventId}.json`).sort());
    const versionEntries = await readdir(facts.layout.versionsDirectory(subjectId), {
      withFileTypes: true,
    });
    expect(
      versionEntries.filter((entry) => entry.isDirectory() && entry.name !== ".staging"),
    ).toHaveLength(1);
  });

  it("allows only one of two RequestIds to consume the same commit lease", async () => {
    const fixture = await setupCommitFixture();
    const facts = stores(fixture.root);
    const subjectId = fixture.ingest.subject.id;
    const eventsBefore = await snapshotTree(
      join(facts.layout.subjectDirectory(subjectId), "events"),
    );
    const firstRequest = request(3);
    const secondRequest = request(4);

    const settled = await Promise.allSettled([
      fixture.composition.commits.commit(fixture.input, session(), { requestId: firstRequest }),
      fixture.composition.commits.commit(fixture.input, session(), { requestId: secondRequest }),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.kind).toBe("current");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DistillyError);
    const rejectedCode = (rejected[0]?.reason as DistillyError).code;
    expect(["busy", "stale_job"]).toContain(rejectedCode);

    const journals = await facts.transactions.list();
    const commitJournals = journals.filter(
      (transaction) => transaction.transactionKind === "distill_commit",
    );
    expect(commitJournals).toHaveLength(1);
    expect(commitJournals[0]?.state).toBe("committed");
    const loserRequest =
      commitJournals[0]?.requestId === firstRequest ? secondRequest : firstRequest;
    if (rejectedCode === "busy") {
      await rejectCode(
        fixture.composition.commits.commit(fixture.input, session(), {
          requestId: loserRequest,
        }),
        "stale_job",
      );
    }
    await expect(facts.operations.readOptional(loserRequest)).resolves.toBeUndefined();
    await expect(facts.transactions.readOptional(loserRequest)).resolves.toBeUndefined();
    const versionEntries = await readdir(facts.layout.versionsDirectory(subjectId), {
      withFileTypes: true,
    });
    expect(
      versionEntries.filter((entry) => entry.isDirectory() && entry.name !== ".staging"),
    ).toHaveLength(1);
    const eventsAfter = await snapshotTree(
      join(facts.layout.subjectDirectory(subjectId), "events"),
    );
    expect(Object.keys(eventsAfter).filter((path) => !(path in eventsBefore))).toHaveLength(2);
  });

  it("reports an active suspended version before retrying an aborted commit", async () => {
    const { recovered, facts, ingest, input } = await setupAbortedCommit();
    await expect(
      recovered.commits.commit(
        { ...input, patch: { ...input.patch, reviewRequest: { note: "Hold for review." } } },
        session(),
        { requestId: request(4) },
      ),
    ).resolves.toMatchObject({ kind: "suspended" });

    const subjectBefore = await snapshotTree(facts.layout.subjectDirectory(ingest.subject.id));
    const journalBefore = await readFile(facts.layout.transactionFile(request(3)));
    await rejectCode(
      recovered.commits.commit(input, session(), { requestId: request(3) }),
      "review_conflict",
    );
    expect(await snapshotTree(facts.layout.subjectDirectory(ingest.subject.id))).toEqual(
      subjectBefore,
    );
    expect(await readFile(facts.layout.transactionFile(request(3)))).toEqual(journalBefore);
    await expect(facts.operations.readOptional(request(3))).resolves.toBeUndefined();
    expect(await recovered.leases.pending({ subjectId: ingest.subject.id })).toEqual([]);
  });

  it("validates an aborted journal before repreparing it for a changed input", async () => {
    const { root, recovered, facts, ingest, input } = await setupAbortedCommit();
    const terminal = await facts.transactions.read(request(3));
    if (terminal.transactionKind !== "distill_commit" || terminal.state !== "aborted") {
      throw new Error("Expected an aborted distill commit journal.");
    }
    const changedInput: CommitInput = {
      ...input,
      patch: { ...input.patch, notes: "A different accepted input." },
    };
    const forgedOperation = sealFact<OperationRecord<"distill.commit">>({
      ...terminal.operation,
      inputChecksum: computeFactChecksum({
        method: "distill.commit",
        params: changedInput,
        actor: session().actor,
        leaseOwner: session().leaseOwner,
      }),
    });
    const forged = resealCommitJournal(terminal, { operation: forgedOperation });
    await replaceFactFile(
      root,
      facts.layout.transactionFile(request(3)),
      forged,
      commitTransactionRuntimeSchema,
    );
    const subjectBefore = await snapshotTree(facts.layout.subjectDirectory(ingest.subject.id));
    const journalBefore = await readFile(facts.layout.transactionFile(request(3)));

    await rejectCode(
      recovered.commits.commit(changedInput, session(), { requestId: request(3) }),
      "storage_corrupt",
    );

    expect(await snapshotTree(facts.layout.subjectDirectory(ingest.subject.id))).toEqual(
      subjectBefore,
    );
    expect(await readFile(facts.layout.transactionFile(request(3)))).toEqual(journalBefore);
    await expect(facts.operations.readOptional(request(3))).resolves.toBeUndefined();
  });

  it.each(["released", "expired", "replaced", "changed contract"] as const)(
    "classifies an aborted retry against a %s lease before full-state staleness",
    async (change) => {
      const fixture = await setupAbortedCommit();
      if (change === "expired") {
        fixture.clock.current = fixture.briefing.lease.expiresAt;
      } else if (change === "changed contract") {
        const state = await fixture.facts.states.read(fixture.ingest.subject.id);
        const pending = state.pending;
        const lease = pending?.lease;
        if (pending === undefined || lease === undefined) {
          throw new Error("Expected an active lease before changing its contract.");
        }
        const contractFields = {
          sourceGroupingVersion: lease.contract.sourceGroupingVersion,
          promptVersion: `host-distill-v1-sha256_${"f".repeat(64)}` as const,
          draftSchemaVersion: lease.contract.draftSchemaVersion,
        };
        await fixture.facts.states.write(
          sealFact<SubjectStateRecord>({
            ...state,
            pending: {
              ...pending,
              lease: {
                ...lease,
                id: `lease_${"f".repeat(32)}` as LeaseId,
                owner: `lease_owner_${"f".repeat(32)}` as LeaseOwnerId,
                contract: { ...contractFields, digest: digestBriefContract(contractFields) },
              },
            },
          }),
        );
      } else {
        await fixture.recovered.leases.release(
          { jobId: fixture.input.jobId, leaseId: fixture.input.leaseId },
          session(),
          { requestId: request(4) },
        );
        if (change === "replaced") {
          await fixture.recovered.leases.brief({ jobId: fixture.input.jobId }, session(2), {
            requestId: request(5),
          });
        }
      }
      const subjectBefore = await snapshotTree(
        fixture.facts.layout.subjectDirectory(fixture.ingest.subject.id),
      );
      const journalBefore = await readFile(fixture.facts.layout.transactionFile(request(3)));

      await rejectCode(
        fixture.recovered.commits.commit(fixture.input, session(), { requestId: request(3) }),
        change === "expired"
          ? "lease_expired"
          : change === "changed contract"
            ? "stale_job"
            : "lease_conflict",
      );

      expect(
        await snapshotTree(fixture.facts.layout.subjectDirectory(fixture.ingest.subject.id)),
      ).toEqual(subjectBefore);
      expect(await readFile(fixture.facts.layout.transactionFile(request(3)))).toEqual(
        journalBefore,
      );
      await expect(fixture.facts.operations.readOptional(request(3))).resolves.toBeUndefined();
    },
  );

  for (const point of ["afterPrepared", "afterVersionPrepared", "afterVersionPublished"] as const) {
    it(`aborts and exactly retries a pre-state crash at ${point}`, async () => {
      const root = await makeRoot();
      const ids = new SequenceIds();
      const clock = new FakeClock();
      const crashed = await open(root, ids, clock, {
        commitHooks: { [point]: failOnce() },
      });
      const { ingest, briefing } = await setupLease(crashed);
      const input = commitInput(briefing, validPatch());
      await expect(
        crashed.commits.commit(input, session(), { requestId: request(3) }),
      ).rejects.toThrow("simulated process crash");

      const recovered = await open(root, ids, clock);
      const facts = stores(root);
      await expect(facts.transactions.read(request(3))).resolves.toMatchObject({
        transactionKind: "distill_commit",
        state: "aborted",
      });
      const previous = await facts.states.read(ingest.subject.id);
      expect(previous.pending?.lease?.id).toBe(briefing.lease.id);
      await expect(
        recovered.commits.commit(input, session(), { requestId: request(3) }),
      ).resolves.toMatchObject({ kind: "current" });
    });
  }

  it.each(STAGED_ARTIFACT_LABELS)(
    "aborts and exactly retries a crash after staging %s",
    async (label) => {
      const root = await makeRoot();
      const ids = new SequenceIds();
      const clock = new FakeClock();
      let failed = false;
      const crashed = await open(root, ids, clock, {
        versionStagingHooks: {
          afterArtifact(current) {
            if (!failed && current === label) {
              failed = true;
              throw new Error(`simulated staging crash after ${label}`);
            }
          },
        },
      });
      const { ingest, briefing } = await setupLease(crashed);
      const input = commitInput(briefing, domainPatch());
      await expect(
        crashed.commits.commit(input, session(), { requestId: request(3) }),
      ).rejects.toThrow(`simulated staging crash after ${label}`);

      const facts = stores(root);
      const prepared = await facts.transactions.read(request(3));
      if (prepared.transactionKind !== "distill_commit" || prepared.state !== "prepared") {
        throw new Error("Expected a prepared journal after a staged-artifact crash.");
      }
      const staging = legacyVersionStagingDirectory(
        facts.layout,
        request(3),
        ingest.subject.id,
        prepared.version.id,
      );
      expect(await exists(staging)).toBe(true);
      expect(
        await exists(facts.layout.versionDirectory(ingest.subject.id, prepared.version.id)),
      ).toBe(false);

      const recovered = await open(root, ids, clock);
      await expect(facts.transactions.read(request(3))).resolves.toMatchObject({
        transactionKind: "distill_commit",
        state: "aborted",
      });
      expect(await exists(staging)).toBe(false);
      await expect(
        recovered.commits.commit(input, session(), { requestId: request(3) }),
      ).resolves.toMatchObject({ kind: "current" });
    },
  );

  for (const { label, options } of postStateRecoveryCases) {
    it(`finishes exact target recovery after crashing after the ${label}`, async () => {
      const fixture = await setupCommitFixture();
      const facts = stores(fixture.root);
      const subjectId = fixture.ingest.subject.id;
      const eventsBefore = await snapshotTree(
        join(facts.layout.subjectDirectory(subjectId), "events"),
      );
      const crashed = await open(fixture.root, fixture.ids, fixture.clock, options());

      await expect(
        crashed.commits.commit(fixture.input, session(), { requestId: request(3) }),
      ).rejects.toThrow("simulated process crash");
      const prepared = await facts.transactions.read(request(3));
      const expectedCrashState = label === "terminal journal" ? "committed" : "prepared";
      if (prepared.transactionKind !== "distill_commit" || prepared.state !== expectedCrashState) {
        throw new Error(`Expected a ${expectedCrashState} distill commit journal after the crash.`);
      }
      expect(await facts.states.read(subjectId)).toEqual(prepared.targetState);

      const recovered = await open(fixture.root, fixture.ids, fixture.clock);
      const terminal = await facts.transactions.read(request(3));
      if (terminal.transactionKind !== "distill_commit" || terminal.state !== "committed") {
        throw new Error("Expected a committed distill commit journal after recovery.");
      }
      expect(withoutTransactionLifecycle(terminal)).toEqual(withoutTransactionLifecycle(prepared));
      expect(terminal.finishedAt).toBe(AT);
      await expect(facts.operations.read(request(3))).resolves.toEqual(prepared.operation);
      for (const event of prepared.events) {
        await expect(facts.events.read(subjectId, event.eventId)).resolves.toEqual(event);
      }
      await expect(facts.versions.read(subjectId, prepared.version.id)).resolves.toEqual({
        version: prepared.version,
        manifest: prepared.materialManifest,
        claims: prepared.claims,
        profile: prepared.profile,
        prompt: prepared.prompt,
      });
      expect(await readFile(facts.layout.currentProfileFile(subjectId), "utf8")).toBe(
        prepared.profile.rendered,
      );
      expect(await readFile(facts.layout.currentPromptFile(subjectId), "utf8")).toBe(
        prepared.prompt,
      );
      expect(await recovered.leases.pending({ subjectId })).toEqual([]);
      await expect(
        recovered.commits.commit(fixture.input, session(), { requestId: request(3) }),
      ).resolves.toEqual(prepared.operation.result);
      const eventsAfter = await snapshotTree(
        join(facts.layout.subjectDirectory(subjectId), "events"),
      );
      expect(
        Object.keys(eventsAfter)
          .filter((path) => !(path in eventsBefore))
          .sort(),
      ).toEqual(prepared.events.map((event) => `${event.eventId}.json`).sort());

      const subjectStable = await snapshotTree(facts.layout.subjectDirectory(subjectId));
      const operationStable = await readFile(facts.layout.operationFile(request(3)));
      const transactionStable = await readFile(facts.layout.transactionFile(request(3)));
      const reopened = await open(fixture.root, fixture.ids, fixture.clock);
      expect(await snapshotTree(facts.layout.subjectDirectory(subjectId))).toEqual(subjectStable);
      expect(await readFile(facts.layout.operationFile(request(3)))).toEqual(operationStable);
      expect(await readFile(facts.layout.transactionFile(request(3)))).toEqual(transactionStable);
      expect(await reopened.leases.pending({ subjectId })).toEqual([]);
    });
  }
});
