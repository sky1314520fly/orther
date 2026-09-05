import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  briefMaterialRefSchema,
  DistillyError,
  engineMethodSchemas,
  facetPathSchema,
  isoDateTimeSchema,
  leaseOwnerIdSchema,
  requestIdSchema,
  type ActorContext,
  type ClientSessionContext,
  type CommitInput,
  type IngestInput,
  type RequestId,
  type ReviewActionInput,
  type RollbackInput,
  type SubjectId,
  type VersionId,
  type VersionSummary,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CryptoIdGenerator } from "../defaults/crypto-id-generator.js";
import { InProcessEventBus } from "../defaults/in-process-event-bus.js";
import { SystemClock } from "../defaults/system-clock.js";
import { createInternalEngineComposition } from "../ingest/composition.js";
import { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import { ReviewService, type ReviewServiceHooks } from "./service.js";

const ACTOR: ActorContext = { kind: "sdk", id: "sqlite-review-crash" };
const OTHER_ACTOR: ActorContext = { kind: "sdk", id: "sqlite-review-other" };
const AT = isoDateTimeSchema.parse("2026-08-31T15:00:00.000Z");
const FIRST_REF = briefMaterialRefSchema.parse("m001");
const IDENTITY_FACET = facetPathSchema.parse("identity");
const VOICE_FACET = facetPathSchema.parse("voice");
const PSYCHE_FACET = facetPathSchema.parse("psyche");
const SESSION: ClientSessionContext = {
  actor: ACTOR,
  leaseOwner: leaseOwnerIdSchema.parse("lease_owner_00000000000000000000000000000001"),
  capacity: {
    maximumInputTokens: 4_194_304,
    maximumToolResultBytes: 4_194_304,
    source: "sdk_explicit",
  },
};

type ReviewAction = "promote" | "reject" | "rollback";
type ReviewInput = ReviewActionInput | RollbackInput;
type CrashPhase = "before_commit" | "after_commit";

interface ChildPayload {
  readonly root: string;
  readonly action: ReviewAction;
  readonly phase: CrashPhase;
  readonly requestId: RequestId;
  readonly input: ReviewInput;
}

const parseActionInput = (action: ReviewAction, value: unknown): ReviewInput => {
  switch (action) {
    case "promote":
      return engineMethodSchemas["versions.promote"].params.parse(value);
    case "reject":
      return engineMethodSchemas["versions.reject"].params.parse(value);
    case "rollback":
      return engineMethodSchemas["versions.rollback"].params.parse(value);
  }
};

const execute = (
  service: ReviewService,
  action: ReviewAction,
  input: ReviewInput,
  actor: ActorContext,
  requestId: RequestId,
): Promise<VersionSummary> => {
  switch (action) {
    case "promote":
      return service.promote(input as ReviewActionInput, actor, { requestId });
    case "reject":
      return service.reject(input as ReviewActionInput, actor, { requestId });
    case "rollback":
      return service.rollback(input as RollbackInput, actor, { requestId });
  }
};

const childPayload = (): ChildPayload | undefined => {
  const serialized = process.env.DISTILLY_REVIEW_CRASH_CHILD;
  if (serialized === undefined) return undefined;
  const raw = JSON.parse(serialized) as Record<string, unknown>;
  if (raw.action !== "promote" && raw.action !== "reject" && raw.action !== "rollback") {
    throw new Error("Invalid review crash action.");
  }
  if (raw.phase !== "before_commit" && raw.phase !== "after_commit") {
    throw new Error("Invalid review crash phase.");
  }
  if (typeof raw.root !== "string") throw new Error("Invalid review crash root.");
  return {
    root: raw.root,
    action: raw.action,
    phase: raw.phase,
    requestId: requestIdSchema.parse(raw.requestId),
    input: parseActionInput(raw.action, raw.input),
  };
};

const child = childPayload();

if (child !== undefined) {
  describe("SQLite review crash child", () => {
    it("blocks at the selected SQLite transaction boundary until killed", async () => {
      const stop = (phase: CrashPhase): void => {
        writeSync(1, `phase:${phase}\n`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      const store = await SqliteEngineStore.open(child.root);
      const hooks: ReviewServiceHooks = {
        beforeTransactionCommit: (requestId) => {
          if (child.phase === "before_commit" && requestId === child.requestId) {
            stop("before_commit");
          }
        },
        afterTransactionCommit: (requestId) => {
          if (child.phase === "after_commit" && requestId === child.requestId) {
            stop("after_commit");
          }
        },
      };
      const service = new ReviewService({
        store,
        ids: new CryptoIdGenerator(),
        clock: new SystemClock(),
        eventBus: new InProcessEventBus(),
        hooks,
      });
      try {
        await execute(service, child.action, child.input, ACTOR, child.requestId);
      } finally {
        store.close();
      }
    });
  });
} else {
  interface ChildState {
    readonly child: ReturnType<typeof spawn>;
    readonly exited: Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>;
    stdout: string;
    stderr: string;
  }

  interface SeededReview {
    readonly input: ReviewInput;
    readonly subjectId: SubjectId;
    readonly previousCurrentId: VersionId;
    readonly candidateId?: VersionId;
    readonly targetId?: VersionId;
  }

  interface AuthoritySnapshot {
    readonly integrity: string;
    readonly states: readonly Record<string, unknown>[];
    readonly versions: readonly Record<string, unknown>[];
    readonly statuses: readonly Record<string, unknown>[];
    readonly materials: readonly Record<string, unknown>[];
    readonly claims: readonly Record<string, unknown>[];
    readonly evidence: readonly Record<string, unknown>[];
    readonly pending: readonly Record<string, unknown>[];
    readonly leases: readonly Record<string, unknown>[];
    readonly operations: readonly Record<string, unknown>[];
    readonly events: readonly Record<string, unknown>[];
  }

  const roots: string[] = [];
  const liveChildren = new Set<ChildState>();
  const childScript = fileURLToPath(
    new URL("../../scripts/review-crash-child.mjs", import.meta.url),
  );

  const request = (digit: number): RequestId =>
    requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

  const firstInput = (): IngestInput => ({
    subject: {
      kind: "create",
      input: {
        displayName: "Review Crash Subject",
        identityHints: [{ kind: "url", value: "https://example.test/review-crash" }],
      },
    },
    materials: [
      {
        clientRef: "review-crash-profile",
        kind: "web",
        content: "Review Crash Subject designs reliable local-first systems and speaks precisely.",
        source: {
          uri: "https://example.test/review-crash",
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

  const additionalInput = (subjectId: SubjectId, suffix: string): IngestInput => ({
    subject: { kind: "existing", subjectId },
    materials: [
      {
        clientRef: `review-crash-${suffix}`,
        kind: "document",
        content: `Review Crash Subject records ${suffix} with explicit tradeoffs and concise examples.`,
        source: {
          uri: `https://example.test/review-crash/${suffix}`,
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

  const firstPatch = (): CommitInput["patch"] => ({
    operations: [
      {
        op: "add",
        claim: {
          facet: IDENTITY_FACET,
          text: "The subject designs reliable local-first systems.",
          evidence: [
            {
              kind: "brief_material",
              materialRef: FIRST_REF,
              quote: "designs reliable local-first systems",
            },
          ],
        },
      },
      {
        op: "add",
        claim: {
          facet: VOICE_FACET,
          text: "The subject speaks precisely.",
          evidence: [
            {
              kind: "brief_material",
              materialRef: FIRST_REF,
              quote: "speaks precisely",
            },
          ],
        },
      },
    ],
  });

  const incrementalPatch = (manualReview: boolean): CommitInput["patch"] => ({
    operations: [
      {
        op: "add",
        claim: {
          facet: PSYCHE_FACET,
          text: "The subject makes tradeoffs explicit and grounds them in examples.",
          evidence: [
            {
              kind: "brief_material",
              materialRef: FIRST_REF,
              quote: "explicit tradeoffs and concise examples",
            },
          ],
        },
      },
    ],
    ...(manualReview ? { reviewRequest: { note: "Review the incremental claim." } } : {}),
  });

  const commitInput = (
    briefing: Awaited<
      ReturnType<Awaited<ReturnType<typeof createInternalEngineComposition>>["leases"]["brief"]>
    >,
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

  const temporaryRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "distilly-review-crash-"));
    roots.push(root);
    return root;
  };

  const seedFirstCurrent = async (
    composition: Awaited<ReturnType<typeof createInternalEngineComposition>>,
  ): Promise<{ readonly subjectId: SubjectId; readonly versionId: VersionId }> => {
    const ingested = await composition.ingest.ingest(firstInput(), ACTOR, {
      requestId: request(1),
    });
    if (ingested.job === undefined) throw new Error("Expected the first pending job.");
    const briefing = await composition.leases.brief({ jobId: ingested.job.id }, SESSION, {
      requestId: request(2),
    });
    const committed = await composition.commits.commit(
      commitInput(briefing, firstPatch()),
      SESSION,
      { requestId: request(3) },
    );
    if (committed.kind !== "current") throw new Error("Expected the first current version.");
    return { subjectId: ingested.subject.id, versionId: committed.version.id };
  };

  const attachCandidateBlockedLease = (
    root: string,
    jobId: string,
    briefing: Awaited<
      ReturnType<Awaited<ReturnType<typeof createInternalEngineComposition>>["leases"]["brief"]>
    >,
  ): void => {
    const database = new DatabaseSync(join(root, "store.sqlite3"));
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database
        .prepare(
          `INSERT INTO job_leases (
             job_id, lease_id, lease_owner, acquired_at, expires_at,
             brief_contract_digest, source_grouping_version, prompt_version,
             draft_schema_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          briefing.lease.id,
          briefing.lease.owner,
          briefing.lease.acquiredAt,
          briefing.lease.expiresAt,
          briefing.contract.digest,
          briefing.contract.sourceGroupingVersion,
          briefing.contract.promptVersion,
          briefing.contract.draftSchemaVersion,
        );
    } finally {
      database.close();
    }
  };

  const seedCandidate = async (root: string, action: "promote" | "reject") => {
    const composition = await createInternalEngineComposition({ root });
    try {
      const first = await seedFirstCurrent(composition);
      const second = await composition.ingest.ingest(
        additionalInput(first.subjectId, "candidate"),
        ACTOR,
        { requestId: request(4) },
      );
      if (second.job === undefined) throw new Error("Expected the candidate pending job.");
      const briefing = await composition.leases.brief({ jobId: second.job.id }, SESSION, {
        requestId: request(5),
      });
      const committed = await composition.commits.commit(
        commitInput(briefing, incrementalPatch(true)),
        SESSION,
        { requestId: request(6) },
      );
      if (committed.kind !== "suspended") throw new Error("Expected a suspended candidate.");
      const third = await composition.ingest.ingest(
        additionalInput(first.subjectId, "pending-after-candidate"),
        ACTOR,
        { requestId: request(7) },
      );
      if (third.job === undefined) throw new Error("Expected pending work behind the candidate.");
      // An active candidate intentionally blocks public brief. Seed the same valid lease
      // shape produced by the immediately preceding real brief to exercise the review
      // transaction's design-required handling of a pre-existing leased pending row.
      attachCandidateBlockedLease(root, third.job.id, briefing);
      return {
        input: {
          subjectId: first.subjectId,
          candidateVersionId: committed.candidate.id,
          reason: action === "promote" ? "Evidence reviewed." : "Evidence rejected.",
        },
        subjectId: first.subjectId,
        previousCurrentId: first.versionId,
        candidateId: committed.candidate.id,
      } satisfies SeededReview;
    } finally {
      composition.close();
    }
  };

  const seedRollback = async (root: string, withPending = true): Promise<SeededReview> => {
    const composition = await createInternalEngineComposition({ root });
    try {
      const first = await seedFirstCurrent(composition);
      const second = await composition.ingest.ingest(
        additionalInput(first.subjectId, "new-current"),
        ACTOR,
        { requestId: request(4) },
      );
      if (second.job === undefined) throw new Error("Expected the next current pending job.");
      const briefing = await composition.leases.brief({ jobId: second.job.id }, SESSION, {
        requestId: request(5),
      });
      const committed = await composition.commits.commit(
        commitInput(briefing, incrementalPatch(false)),
        SESSION,
        { requestId: request(6) },
      );
      if (committed.kind !== "current") throw new Error("Expected the second current version.");
      if (withPending) {
        const third = await composition.ingest.ingest(
          additionalInput(first.subjectId, "pending-before-rollback"),
          ACTOR,
          { requestId: request(7) },
        );
        if (third.job === undefined) throw new Error("Expected pending work before rollback.");
        await composition.leases.brief({ jobId: third.job.id }, SESSION, {
          requestId: request(8),
        });
      }
      return {
        input: {
          subjectId: first.subjectId,
          targetVersionId: first.versionId,
          reason: "Restore the verified historical profile.",
        },
        subjectId: first.subjectId,
        previousCurrentId: committed.version.id,
        targetId: first.versionId,
      };
    } finally {
      composition.close();
    }
  };

  const seed = (root: string, action: ReviewAction): Promise<SeededReview> =>
    action === "rollback" ? seedRollback(root) : seedCandidate(root, action);

  const rows = (database: DatabaseSync, sql: string): readonly Record<string, unknown>[] =>
    database.prepare(sql).all();

  const inspectAuthority = (root: string): AuthoritySnapshot => {
    const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
    try {
      const check = database.prepare("PRAGMA quick_check(1)").get() as {
        readonly quick_check: string;
      };
      return {
        integrity: check.quick_check,
        states: rows(
          database,
          `SELECT subject_id, generation, material_set_hash, current_version_id,
                  suspended_version_id
             FROM subject_states ORDER BY subject_id`,
        ),
        versions: rows(
          database,
          `SELECT id, subject_id, parent_id, derived_from_candidate_version_id,
                  generation, material_set_hash, material_count, creation_json,
                  created_disposition, actor_json, quality_json, renderer_version,
                  review_reasons_json, accepted_patch_digest, created_at, record_json
             FROM versions ORDER BY id`,
        ),
        statuses: rows(
          database,
          "SELECT version_id, subject_id, status FROM version_statuses ORDER BY version_id",
        ),
        materials: rows(
          database,
          `SELECT version_id, subject_id, ordinal, material_id, content_digest,
                  provenance_digest
             FROM version_materials ORDER BY version_id, ordinal`,
        ),
        claims: rows(
          database,
          `SELECT version_id, subject_id, ordinal, claim_id, facet, text, status,
                  strength, observed_in_json, valid_from, valid_to,
                  created_in_version_id, superseded_by_claim_id
             FROM version_claims ORDER BY version_id, ordinal`,
        ),
        evidence: rows(
          database,
          `SELECT version_id, claim_id, ordinal, material_id, quote,
                  locator_start, locator_end
             FROM version_claim_evidence ORDER BY version_id, claim_id, ordinal`,
        ),
        pending: rows(database, "SELECT * FROM pending_jobs ORDER BY subject_id"),
        leases: rows(database, "SELECT * FROM job_leases ORDER BY job_id"),
        operations: rows(database, "SELECT * FROM operations ORDER BY request_id"),
        events: rows(database, "SELECT * FROM events ORDER BY sequence"),
      };
    } finally {
      database.close();
    }
  };

  const storedResult = (
    snapshot: AuthoritySnapshot,
    requestId: RequestId,
    action: ReviewAction,
  ): VersionSummary => {
    const operation = snapshot.operations.find((row) => row.request_id === requestId);
    if (typeof operation?.result_json !== "string") {
      throw new Error("Expected a stored review operation result.");
    }
    switch (action) {
      case "promote":
        return engineMethodSchemas["versions.promote"].result.parse(
          JSON.parse(operation.result_json),
        );
      case "reject":
        return engineMethodSchemas["versions.reject"].result.parse(
          JSON.parse(operation.result_json),
        );
      case "rollback":
        return engineMethodSchemas["versions.rollback"].result.parse(
          JSON.parse(operation.result_json),
        );
    }
  };

  const statusOf = (snapshot: AuthoritySnapshot, versionId: VersionId): unknown =>
    snapshot.statuses.find((row) => row.version_id === versionId)?.status;

  const versionRowsWithoutId = (
    rows: readonly Record<string, unknown>[],
    versionId: VersionId,
  ): readonly Record<string, unknown>[] =>
    rows
      .filter((row) => row.version_id === versionId)
      .map(({ version_id: removedVersionId, ...row }) => {
        void removedVersionId;
        return row;
      });

  const requestEvents = (
    snapshot: AuthoritySnapshot,
    requestId: RequestId,
  ): readonly Record<string, unknown>[] =>
    snapshot.events.filter((row) => row.request_id === requestId);

  const eventDetails = (
    snapshot: AuthoritySnapshot,
    requestId: RequestId,
  ): readonly Record<string, unknown>[] =>
    requestEvents(snapshot, requestId).map((row) => {
      if (typeof row.event_json !== "string") throw new Error("Expected stored event JSON.");
      const record = JSON.parse(row.event_json) as Record<string, unknown>;
      if (typeof record.event !== "object" || record.event === null) {
        throw new Error("Expected a stored event record payload.");
      }
      return {
        ...(record.event as Record<string, unknown>),
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        ...(record.relatedVersionId === undefined
          ? {}
          : { relatedVersionId: record.relatedVersionId }),
      };
    });

  const openReview = async (
    root: string,
    hooks?: ReviewServiceHooks,
  ): Promise<{ readonly service: ReviewService; close(): void }> => {
    const store = await SqliteEngineStore.open(root);
    return {
      service: new ReviewService({
        store,
        ids: new CryptoIdGenerator(),
        clock: new SystemClock(),
        eventBus: new InProcessEventBus(),
        ...(hooks === undefined ? {} : { hooks }),
      }),
      close: () => store.close(),
    };
  };

  const assertTarget = (
    action: ReviewAction,
    seeded: SeededReview,
    before: AuthoritySnapshot,
    after: AuthoritySnapshot,
    requestId: RequestId,
  ): VersionSummary => {
    expect(after.integrity).toBe("ok");
    const operation = after.operations.filter((row) => row.request_id === requestId);
    expect(operation).toHaveLength(1);
    expect(operation[0]?.method).toBe(`versions.${action}`);
    const result = storedResult(after, requestId, action);
    const state = after.states.find((row) => row.subject_id === seeded.subjectId);
    const beforePending = before.pending.find((row) => row.subject_id === seeded.subjectId);
    const afterPending = after.pending.find((row) => row.subject_id === seeded.subjectId);

    if (action === "promote") {
      expect(result).toMatchObject({ id: seeded.candidateId, status: "current" });
      expect(state).toMatchObject({
        current_version_id: seeded.candidateId,
        suspended_version_id: null,
      });
      expect(statusOf(after, seeded.previousCurrentId)).toBe("historical");
      expect(statusOf(after, seeded.candidateId!)).toBe("current");
      expect(after.versions).toEqual(before.versions);
      expect(afterPending).toMatchObject({
        base_version_id: seeded.candidateId,
        generation: beforePending?.generation,
        added_material_count: 1,
        total_material_count: beforePending?.total_material_count,
      });
      expect(afterPending?.job_id).not.toBe(beforePending?.job_id);
      expect(before.leases).toHaveLength(1);
      expect(after.leases).toHaveLength(0);
      expect(eventDetails(after, requestId)).toEqual([
        expect.objectContaining({
          kind: "version.promoted",
          subjectId: seeded.subjectId,
          versionId: seeded.candidateId,
          reason: (seeded.input as ReviewActionInput).reason,
        }),
        expect.objectContaining({ kind: "job.changed", subjectId: seeded.subjectId }),
      ]);
    } else if (action === "reject") {
      expect(result).toMatchObject({ id: seeded.candidateId, status: "rejected" });
      expect(state).toMatchObject({
        current_version_id: seeded.previousCurrentId,
        suspended_version_id: null,
      });
      expect(statusOf(after, seeded.previousCurrentId)).toBe("current");
      expect(statusOf(after, seeded.candidateId!)).toBe("rejected");
      expect(after.versions).toEqual(before.versions);
      expect(afterPending).toEqual(beforePending);
      expect(before.leases).toHaveLength(1);
      expect(after.leases).toEqual(before.leases);
      expect(eventDetails(after, requestId)).toEqual([
        expect.objectContaining({
          kind: "version.rejected",
          subjectId: seeded.subjectId,
          versionId: seeded.candidateId,
          reason: (seeded.input as ReviewActionInput).reason,
        }),
      ]);
    } else {
      expect(result).toMatchObject({
        parentId: seeded.previousCurrentId,
        creation: { kind: "rollback", targetVersionId: seeded.targetId },
        status: "current",
      });
      expect(result.id).not.toBe(seeded.previousCurrentId);
      expect(result.id).not.toBe(seeded.targetId);
      expect(state).toMatchObject({
        current_version_id: result.id,
        suspended_version_id: null,
      });
      expect(statusOf(after, seeded.previousCurrentId)).toBe("historical");
      expect(statusOf(after, seeded.targetId!)).toBe("historical");
      expect(statusOf(after, result.id)).toBe("current");
      expect(after.versions).toHaveLength(before.versions.length + 1);
      const targetVersion = before.versions.find((row) => row.id === seeded.targetId);
      const rollbackVersion = after.versions.find((row) => row.id === result.id);
      expect(rollbackVersion).toMatchObject({
        subject_id: targetVersion?.subject_id,
        material_set_hash: targetVersion?.material_set_hash,
        material_count: targetVersion?.material_count,
        quality_json: targetVersion?.quality_json,
        renderer_version: targetVersion?.renderer_version,
        accepted_patch_digest: targetVersion?.accepted_patch_digest,
      });
      expect(versionRowsWithoutId(after.materials, result.id)).toEqual(
        versionRowsWithoutId(before.materials, seeded.targetId!),
      );
      expect(versionRowsWithoutId(after.claims, result.id)).toEqual(
        versionRowsWithoutId(before.claims, seeded.targetId!),
      );
      expect(versionRowsWithoutId(after.evidence, result.id)).toEqual(
        versionRowsWithoutId(before.evidence, seeded.targetId!),
      );
      expect(afterPending).toMatchObject({
        base_version_id: result.id,
        generation: beforePending?.generation,
        added_material_count: 2,
        total_material_count: beforePending?.total_material_count,
      });
      expect(afterPending?.job_id).not.toBe(beforePending?.job_id);
      expect(before.leases).toHaveLength(1);
      expect(after.leases).toHaveLength(0);
      expect(eventDetails(after, requestId)).toEqual([
        expect.objectContaining({
          kind: "version.rolled_back",
          subjectId: seeded.subjectId,
          versionId: result.id,
          reason: (seeded.input as RollbackInput).reason,
          relatedVersionId: seeded.targetId,
        }),
        expect.objectContaining({ kind: "job.changed", subjectId: seeded.subjectId }),
      ]);
    }
    return result;
  };

  const startChild = (
    root: string,
    action: ReviewAction,
    phase: CrashPhase,
    requestId: RequestId,
    input: ReviewInput,
  ): ChildState => {
    const encodedInput = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
    const processChild = spawn(
      process.execPath,
      [childScript, root, action, phase, requestId, encodedInput],
      {
        cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const state: ChildState = {
      child: processChild,
      stdout: "",
      stderr: "",
      exited: new Promise((resolve) => {
        processChild.once("close", (code, signal) => resolve({ code, signal }));
      }),
    };
    processChild.stdout?.setEncoding("utf8");
    processChild.stderr?.setEncoding("utf8");
    processChild.stdout?.on("data", (chunk: string) => {
      state.stdout += chunk;
    });
    processChild.stderr?.on("data", (chunk: string) => {
      state.stderr += chunk;
    });
    liveChildren.add(state);
    return state;
  };

  const killAt = async (
    root: string,
    action: ReviewAction,
    phase: CrashPhase,
    requestId: RequestId,
    input: ReviewInput,
  ): Promise<void> => {
    const state = startChild(root, action, phase, requestId, input);
    const expected = `phase:${phase}`;
    const deadline = Date.now() + 10_000;
    try {
      while (!state.stdout.includes(expected)) {
        if (
          state.child.exitCode !== null ||
          state.child.signalCode !== null ||
          Date.now() >= deadline
        ) {
          throw new Error(
            `child did not print ${JSON.stringify(expected)}; stdout=${JSON.stringify(state.stdout)} stderr=${JSON.stringify(state.stderr)}`,
          );
        }
        await delay(10);
      }
      expect(state.child.kill("SIGKILL")).toBe(true);
      await expect(state.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    } finally {
      if (state.child.exitCode === null && state.child.signalCode === null) {
        state.child.kill("SIGKILL");
        await state.exited;
      }
      liveChildren.delete(state);
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
    await Promise.all(
      [...liveChildren].map(async (state) => {
        if (state.child.exitCode === null && state.child.signalCode === null) {
          state.child.kill("SIGKILL");
        }
        await state.exited;
      }),
    );
    liveChildren.clear();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  describe.skipIf(process.platform === "win32")("SQLite review real process crashes", () => {
    for (const action of ["promote", "reject", "rollback"] as const) {
      it(`shows only the previous ${action} world when SIGKILL lands before COMMIT`, async () => {
        const root = await temporaryRoot();
        const seeded = await seed(root, action);
        const reviewRequest = request(20);
        const before = inspectAuthority(root);

        await killAt(root, action, "before_commit", reviewRequest, seeded.input);

        expect(inspectAuthority(root)).toEqual(before);
        const reopened = await openReview(root);
        try {
          await expect(
            execute(reopened.service, action, seeded.input, ACTOR, reviewRequest),
          ).resolves.toBeDefined();
        } finally {
          reopened.close();
        }
      }, 20_000);

      it(`reopens the complete ${action} target when SIGKILL lands after COMMIT`, async () => {
        const root = await temporaryRoot();
        const seeded = await seed(root, action);
        const reviewRequest = request(20);
        const before = inspectAuthority(root);

        await killAt(root, action, "after_commit", reviewRequest, seeded.input);

        const after = inspectAuthority(root);
        const expected = assertTarget(action, seeded, before, after, reviewRequest);
        const reopened = await openReview(root);
        try {
          await expect(
            execute(reopened.service, action, seeded.input, ACTOR, reviewRequest),
          ).resolves.toEqual(expected);
          expect(inspectAuthority(root)).toEqual(after);
        } finally {
          reopened.close();
        }
      }, 20_000);
    }
  });

  describe("SQLite review idempotency and concurrency", () => {
    it("replays one exact decision without new ids, rows, events, or pending changes", async () => {
      for (const action of ["promote", "reject", "rollback"] as const) {
        const root = await temporaryRoot();
        const seeded = await seed(root, action);
        const before = inspectAuthority(root);
        const reviewRequest = request(20);
        const review = await openReview(root);
        try {
          const result = await execute(review.service, action, seeded.input, ACTOR, reviewRequest);
          const after = inspectAuthority(root);
          expect(result).toEqual(assertTarget(action, seeded, before, after, reviewRequest));
          await expect(
            execute(review.service, action, seeded.input, ACTOR, reviewRequest),
          ).resolves.toEqual(result);
          expect(inspectAuthority(root)).toEqual(after);
        } finally {
          review.close();
        }
      }
    });

    it("binds RequestId to exact input, actor, and review method", async () => {
      const root = await temporaryRoot();
      const seeded = await seedCandidate(root, "promote");
      const input = seeded.input as ReviewActionInput;
      const reviewRequest = request(20);
      const review = await openReview(root);
      try {
        await review.service.promote(input, ACTOR, { requestId: reviewRequest });
        const completed = inspectAuthority(root);
        await expectCode(
          review.service.promote({ ...input, reason: "Changed review decision." }, ACTOR, {
            requestId: reviewRequest,
          }),
          "idempotency_conflict",
        );
        await expectCode(
          review.service.promote(input, OTHER_ACTOR, { requestId: reviewRequest }),
          "idempotency_conflict",
        );
        await expectCode(
          review.service.reject(input, ACTOR, { requestId: reviewRequest }),
          "idempotency_conflict",
        );
        expect(inspectAuthority(root)).toEqual(completed);
      } finally {
        review.close();
      }
    });

    it("creates fresh unleased pending when rollback exposes a delta without an old job", async () => {
      const root = await temporaryRoot();
      const seeded = await seedRollback(root, false);
      const input = seeded.input as RollbackInput;
      const before = inspectAuthority(root);
      expect(before.pending).toHaveLength(0);
      expect(before.leases).toHaveLength(0);
      const reviewRequest = request(20);
      const review = await openReview(root);
      try {
        const result = await review.service.rollback(input, ACTOR, {
          requestId: reviewRequest,
        });
        const after = inspectAuthority(root);
        expect(result).toMatchObject({
          parentId: seeded.previousCurrentId,
          creation: { kind: "rollback", targetVersionId: seeded.targetId },
          status: "current",
        });
        expect(after.pending).toEqual([
          expect.objectContaining({
            subject_id: seeded.subjectId,
            base_version_id: result.id,
            generation: before.states[0]?.generation,
            added_material_count: 1,
            total_material_count: 2,
          }),
        ]);
        expect(after.leases).toHaveLength(0);
        expect(after.operations.filter((row) => row.request_id === reviewRequest)).toHaveLength(1);
        expect(eventDetails(after, reviewRequest)).toEqual([
          expect.objectContaining({
            kind: "version.rolled_back",
            subjectId: seeded.subjectId,
            versionId: result.id,
            reason: input.reason,
            relatedVersionId: seeded.targetId,
          }),
          expect.objectContaining({ kind: "job.changed", subjectId: seeded.subjectId }),
        ]);
      } finally {
        review.close();
      }
    });

    it("serializes competing promote/reject decisions into one legal world", async () => {
      const root = await temporaryRoot();
      const seeded = await seedCandidate(root, "promote");
      const input = seeded.input as ReviewActionInput;
      let preparedResolve: (() => void) | undefined;
      let releaseResolve: (() => void) | undefined;
      const prepared = new Promise<void>((resolve) => {
        preparedResolve = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      let first = true;
      const review = await openReview(root, {
        beforeReviewTransaction() {
          if (!first) return;
          first = false;
          preparedResolve?.();
          return release;
        },
      });
      try {
        const promote = review.service.promote(input, ACTOR, { requestId: request(20) });
        await prepared;
        const reject = review.service.reject({ ...input, reason: "Competing rejection." }, ACTOR, {
          requestId: request(21),
        });
        releaseResolve?.();
        const settled = await Promise.allSettled([promote, reject]);
        expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(settled.find((outcome) => outcome.status === "rejected")).toMatchObject({
          reason: { code: "review_conflict" },
        });
        const after = inspectAuthority(root);
        const state = after.states.find((row) => row.subject_id === seeded.subjectId);
        expect(state?.suspended_version_id).toBeNull();
        expect(
          after.operations.filter(
            (row) => row.request_id === request(20) || row.request_id === request(21),
          ),
        ).toHaveLength(1);
        expect(["current", "rejected"].includes(String(statusOf(after, seeded.candidateId)))).toBe(
          true,
        );
      } finally {
        releaseResolve?.();
        review.close();
      }
    });

    it("rejects rollback while review is active and rejects non-historical targets with zero writes", async () => {
      const candidateRoot = await temporaryRoot();
      const candidate = await seedCandidate(candidateRoot, "promote");
      const candidateBefore = inspectAuthority(candidateRoot);
      const candidateReview = await openReview(candidateRoot);
      try {
        await expectCode(
          candidateReview.service.rollback(
            {
              subjectId: candidate.subjectId,
              targetVersionId: candidate.previousCurrentId,
              reason: "Blocked by active review.",
            },
            ACTOR,
            { requestId: request(20) },
          ),
          "review_conflict",
        );
        expect(inspectAuthority(candidateRoot)).toEqual(candidateBefore);
      } finally {
        candidateReview.close();
      }

      const rollbackRoot = await temporaryRoot();
      const rollback = await seedRollback(rollbackRoot);
      const rollbackBefore = inspectAuthority(rollbackRoot);
      const rollbackReview = await openReview(rollbackRoot);
      try {
        await expectCode(
          rollbackReview.service.rollback(
            {
              subjectId: rollback.subjectId,
              targetVersionId: rollback.previousCurrentId,
              reason: "Current is not a historical target.",
            },
            ACTOR,
            { requestId: request(20) },
          ),
          "invalid_input",
        );
        expect(inspectAuthority(rollbackRoot)).toEqual(rollbackBefore);
      } finally {
        rollbackReview.close();
      }
    });
  });
}
