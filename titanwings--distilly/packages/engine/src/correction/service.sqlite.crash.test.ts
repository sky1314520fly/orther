import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  briefMaterialRefSchema,
  engineMethodSchemas,
  facetPathSchema,
  isoDateTimeSchema,
  leaseOwnerIdSchema,
  requestIdSchema,
  type ActorContext,
  type ClientSessionContext,
  type CommitInput,
  type CommitResult,
  type CorrectInput,
  type IngestInput,
  type RequestId,
  type SubjectId,
  type VersionId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createInternalEngineComposition } from "../ingest/composition.js";

const SEED_ACTOR: ActorContext = { kind: "sdk", id: "sqlite-correction-crash-seed" };
const CORRECTION_ACTOR: ActorContext = { kind: "user", id: "sqlite-correction-crash-user" };
const SESSION: ClientSessionContext = {
  actor: SEED_ACTOR,
  leaseOwner: leaseOwnerIdSchema.parse("lease_owner_00000000000000000000000000000001"),
  capacity: {
    maximumInputTokens: 4_194_304,
    maximumToolResultBytes: 4_194_304,
    source: "sdk_explicit",
  },
};
const AT = isoDateTimeSchema.parse("2026-08-31T15:00:00.000Z");
const FIRST_REF = briefMaterialRefSchema.parse("m001");
const IDENTITY = facetPathSchema.parse("identity");
const DECISION_STYLE = facetPathSchema.parse("psyche.decision_style");

type CrashPhase = "before_commit" | "after_commit";

interface ChildPayload {
  readonly root: string;
  readonly phase: CrashPhase;
  readonly requestId: RequestId;
  readonly input: CorrectInput;
}

const childPayload = (): ChildPayload | undefined => {
  const serialized = process.env.DISTILLY_CORRECTION_CRASH_CHILD;
  if (serialized === undefined) return undefined;
  const raw = JSON.parse(serialized) as Record<string, unknown>;
  if (raw.phase !== "before_commit" && raw.phase !== "after_commit") {
    throw new Error("Invalid correction crash phase.");
  }
  if (typeof raw.root !== "string") throw new Error("Invalid correction crash root.");
  return {
    root: raw.root,
    phase: raw.phase,
    requestId: requestIdSchema.parse(raw.requestId),
    input: engineMethodSchemas["profiles.correct"].params.parse(raw.input),
  };
};

const child = childPayload();

if (child !== undefined) {
  describe("SQLite correction crash child", () => {
    it("blocks at the selected SQLite transaction boundary until killed", async () => {
      const stop = (phase: CrashPhase): void => {
        writeSync(1, `phase:${phase}\n`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      const composition = await createInternalEngineComposition({
        root: child.root,
        correctionHooks: {
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
        },
      });
      try {
        await composition.corrections.correct(child.input, CORRECTION_ACTOR, {
          requestId: child.requestId,
        });
      } finally {
        composition.close();
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

  interface SeededCorrection {
    readonly subjectId: SubjectId;
    readonly currentVersionId: VersionId;
    readonly input: CorrectInput;
  }

  interface AuthoritySnapshot {
    readonly quickCheck: string;
    readonly journalMode: string;
    readonly blobs: readonly Record<string, unknown>[];
    readonly materials: readonly Record<string, unknown>[];
    readonly versions: readonly Record<string, unknown>[];
    readonly statuses: readonly Record<string, unknown>[];
    readonly versionMaterials: readonly Record<string, unknown>[];
    readonly claims: readonly Record<string, unknown>[];
    readonly evidence: readonly Record<string, unknown>[];
    readonly states: readonly Record<string, unknown>[];
    readonly pending: readonly Record<string, unknown>[];
    readonly leases: readonly Record<string, unknown>[];
    readonly operations: readonly Record<string, unknown>[];
    readonly resultBlobs: readonly Record<string, unknown>[];
    readonly events: readonly Record<string, unknown>[];
    readonly sqliteSequence: readonly Record<string, unknown>[];
  }

  const roots: string[] = [];
  const liveChildren = new Set<ChildState>();
  const childScript = fileURLToPath(
    new URL("../../scripts/correction-crash-child.mjs", import.meta.url),
  );

  const request = (digit: number): RequestId =>
    requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

  const seedInput = (): IngestInput => ({
    subject: {
      kind: "create",
      input: {
        displayName: "Correction Crash Subject",
        identityHints: [{ kind: "url", value: "https://example.test/correction-crash" }],
      },
    },
    materials: [
      {
        clientRef: "correction-crash-profile",
        kind: "web",
        content: "Correction Crash Subject designs reliable systems and explains evidence clearly.",
        source: {
          uri: "https://example.test/correction-crash",
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

  const seedPatch = (): CommitInput["patch"] => ({
    operations: [
      {
        op: "add",
        claim: {
          facet: IDENTITY,
          text: "The subject designs reliable systems.",
          evidence: [
            {
              kind: "brief_material",
              materialRef: FIRST_REF,
              quote: "designs reliable systems",
            },
          ],
        },
      },
    ],
  });

  const temporaryRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "distilly-correction-crash-"));
    roots.push(root);
    return root;
  };

  const seedCurrent = async (root: string): Promise<SeededCorrection> => {
    const composition = await createInternalEngineComposition({ root });
    try {
      const ingested = await composition.ingest.ingest(seedInput(), SEED_ACTOR, {
        requestId: request(1),
      });
      if (ingested.job === undefined) throw new Error("Expected the seed pending job.");
      const briefing = await composition.leases.brief({ jobId: ingested.job.id }, SESSION, {
        requestId: request(2),
      });
      const commitInput: CommitInput = {
        jobId: briefing.job.id,
        generation: briefing.job.generation,
        leaseId: briefing.lease.id,
        briefContractDigest: briefing.contract.digest,
        materialSetHash: briefing.job.materialSetHash,
        patch: seedPatch(),
      };
      const committed = await composition.commits.commit(commitInput, SESSION, {
        requestId: request(3),
      });
      if (committed.kind !== "current") throw new Error("Expected a current seed version.");
      return {
        subjectId: ingested.subject.id,
        currentVersionId: committed.version.id,
        input: {
          subjectId: ingested.subject.id,
          correction: {
            text: "The subject records assumptions before making decisions.",
            facet: DECISION_STYLE,
          },
        },
      };
    } finally {
      composition.close();
    }
  };

  const rows = (database: DatabaseSync, sql: string): readonly Record<string, unknown>[] =>
    database.prepare(sql).all();

  const inspectAuthority = (root: string): AuthoritySnapshot => {
    const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
    try {
      const quick = database.prepare("PRAGMA quick_check(1)").get() as {
        readonly quick_check: string;
      };
      const journal = database.prepare("PRAGMA journal_mode").get() as {
        readonly journal_mode: string;
      };
      return {
        quickCheck: quick.quick_check,
        journalMode: journal.journal_mode,
        blobs: rows(database, "SELECT * FROM blobs ORDER BY digest"),
        materials: rows(database, "SELECT * FROM materials ORDER BY subject_id, material_id"),
        versions: rows(database, "SELECT * FROM versions ORDER BY id"),
        statuses: rows(database, "SELECT * FROM version_statuses ORDER BY version_id"),
        versionMaterials: rows(
          database,
          "SELECT * FROM version_materials ORDER BY version_id, ordinal",
        ),
        claims: rows(database, "SELECT * FROM version_claims ORDER BY version_id, ordinal"),
        evidence: rows(
          database,
          "SELECT * FROM version_claim_evidence ORDER BY version_id, claim_id, ordinal",
        ),
        states: rows(database, "SELECT * FROM subject_states ORDER BY subject_id"),
        pending: rows(database, "SELECT * FROM pending_jobs ORDER BY subject_id"),
        leases: rows(database, "SELECT * FROM job_leases ORDER BY job_id"),
        operations: rows(database, "SELECT * FROM operations ORDER BY request_id"),
        resultBlobs: rows(database, "SELECT * FROM operation_result_blobs ORDER BY request_id"),
        events: rows(database, "SELECT * FROM events ORDER BY sequence"),
        sqliteSequence: rows(database, "SELECT * FROM sqlite_sequence ORDER BY name"),
      };
    } finally {
      database.close();
    }
  };

  const storedCorrectionResult = (
    snapshot: AuthoritySnapshot,
    correctionRequest: RequestId,
  ): CommitResult => {
    const operation = snapshot.operations.find(
      ({ request_id: requestId }) => requestId === correctionRequest,
    );
    if (typeof operation?.result_json !== "string") {
      throw new Error("Expected a stored correction operation result.");
    }
    return engineMethodSchemas["profiles.correct"].result.parse(JSON.parse(operation.result_json));
  };

  const requestEvents = (
    snapshot: AuthoritySnapshot,
    correctionRequest: RequestId,
  ): readonly Record<string, unknown>[] =>
    snapshot.events.filter(({ request_id: requestId }) => requestId === correctionRequest);

  const eventKinds = (
    snapshot: AuthoritySnapshot,
    correctionRequest: RequestId,
  ): readonly unknown[] =>
    requestEvents(snapshot, correctionRequest).map(({ event_json: eventJson }) => {
      if (typeof eventJson !== "string") throw new Error("Expected stored correction event JSON.");
      const record = JSON.parse(eventJson) as { readonly event?: { readonly kind?: unknown } };
      return record.event?.kind;
    });

  const assertCompleteTarget = (
    before: AuthoritySnapshot,
    after: AuthoritySnapshot,
    seeded: SeededCorrection,
    correctionRequest: RequestId,
  ): CommitResult => {
    expect(after.quickCheck).toBe("ok");
    expect(after.journalMode).toBe("wal");
    expect(after.blobs).toHaveLength(before.blobs.length + 1);
    expect(after.materials).toHaveLength(before.materials.length + 1);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.statuses).toHaveLength(before.statuses.length + 1);
    expect(after.operations).toHaveLength(before.operations.length + 1);
    expect(after.resultBlobs).toEqual(before.resultBlobs);
    expect(after.leases).toHaveLength(0);
    expect(requestEvents(after, correctionRequest)).toHaveLength(3);
    expect(eventKinds(after, correctionRequest)).toEqual([
      "material.ingested",
      "version.current",
      "job.changed",
    ]);

    const result = storedCorrectionResult(after, correctionRequest);
    if (result.kind !== "current") throw new Error("Expected a current correction result.");
    expect(result.version).toMatchObject({
      parentId: seeded.currentVersionId,
      generation: 2,
      status: "current",
      creation: { kind: "correction" },
    });
    expect(after.states).toEqual([
      expect.objectContaining({
        subject_id: seeded.subjectId,
        generation: 2,
        current_version_id: result.version.id,
        suspended_version_id: null,
      }),
    ]);
    expect(after.statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version_id: seeded.currentVersionId, status: "historical" }),
        expect.objectContaining({ version_id: result.version.id, status: "current" }),
      ]),
    );
    expect(after.pending).toEqual([
      expect.objectContaining({
        subject_id: seeded.subjectId,
        generation: 2,
        base_version_id: result.version.id,
        added_material_count: 0,
        total_material_count: 2,
      }),
    ]);
    expect(
      after.versionMaterials.filter(({ version_id: versionId }) => versionId === result.version.id),
    ).toHaveLength(2);
    expect(
      after.claims.filter(({ version_id: versionId }) => versionId === result.version.id),
    ).toHaveLength(2);
    expect(
      after.evidence.filter(({ version_id: versionId }) => versionId === result.version.id),
    ).toHaveLength(2);
    expect(after.materials.find(({ kind }) => kind === "correction")).toMatchObject({
      subject_id: seeded.subjectId,
    });
    return result;
  };

  const blobFileCount = async (root: string): Promise<number> => {
    const entries = await readdir(join(root, "blobs", "sha256"), { recursive: true });
    return entries.filter((entry) => basename(entry).startsWith("sha256_")).length;
  };

  const recoveryArtifacts = async (root: string): Promise<readonly string[]> => {
    const entries = await readdir(root, { recursive: true });
    return entries.filter((entry) =>
      /(^|[/\\])(?:correction[-_]?journals?|journals?|transactions?|\.?staging|recovery)(?:[/\\]|$)/iu.test(
        entry,
      ),
    );
  };

  const startChild = (
    root: string,
    phase: CrashPhase,
    correctionRequest: RequestId,
    input: CorrectInput,
  ): ChildState => {
    const encodedInput = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
    const processChild = spawn(
      process.execPath,
      [childScript, root, phase, correctionRequest, encodedInput],
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
    phase: CrashPhase,
    correctionRequest: RequestId,
    input: CorrectInput,
  ): Promise<void> => {
    const state = startChild(root, phase, correctionRequest, input);
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

  describe.skipIf(process.platform === "win32")("SQLite correction real process crashes", () => {
    it("reopens only the previous world when SIGKILL lands before COMMIT", async () => {
      const root = await temporaryRoot();
      const seeded = await seedCurrent(root);
      const correctionRequest = request(4);
      const before = inspectAuthority(root);
      const physicalBlobsBefore = await blobFileCount(root);

      await killAt(root, "before_commit", correctionRequest, seeded.input);

      expect(inspectAuthority(root)).toEqual(before);
      expect(await blobFileCount(root)).toBe(physicalBlobsBefore + 1);
      expect(await recoveryArtifacts(root)).toEqual([]);

      const reopened = await createInternalEngineComposition({ root });
      try {
        const result = await reopened.corrections.correct(seeded.input, CORRECTION_ACTOR, {
          requestId: correctionRequest,
        });
        const completed = inspectAuthority(root);
        expect(result).toEqual(assertCompleteTarget(before, completed, seeded, correctionRequest));
        await expect(
          reopened.corrections.correct(seeded.input, CORRECTION_ACTOR, {
            requestId: correctionRequest,
          }),
        ).resolves.toEqual(result);
        expect(inspectAuthority(root)).toEqual(completed);
      } finally {
        reopened.close();
      }
      expect(await recoveryArtifacts(root)).toEqual([]);
    }, 20_000);

    it("reopens the complete new world and replays exactly after COMMIT", async () => {
      const root = await temporaryRoot();
      const seeded = await seedCurrent(root);
      const correctionRequest = request(4);
      const before = inspectAuthority(root);

      await killAt(root, "after_commit", correctionRequest, seeded.input);

      const completed = inspectAuthority(root);
      const expected = assertCompleteTarget(before, completed, seeded, correctionRequest);
      expect(await recoveryArtifacts(root)).toEqual([]);
      const reopened = await createInternalEngineComposition({ root });
      try {
        await expect(
          reopened.corrections.correct(seeded.input, CORRECTION_ACTOR, {
            requestId: correctionRequest,
          }),
        ).resolves.toEqual(expected);
        expect(inspectAuthority(root)).toEqual(completed);
      } finally {
        reopened.close();
      }
      expect(await recoveryArtifacts(root)).toEqual([]);
    }, 20_000);
  });
}
