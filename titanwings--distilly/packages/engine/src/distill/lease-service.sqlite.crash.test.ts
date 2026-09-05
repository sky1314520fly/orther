import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  isoDateTimeSchema,
  jobIdSchema,
  leaseOwnerIdSchema,
  requestIdSchema,
  type ActorContext,
  type ClientSessionContext,
  type IngestInput,
  type JobId,
  type RequestId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createInternalEngineComposition } from "../ingest/composition.js";

const ACTOR: ActorContext = { kind: "sdk", id: "sqlite-brief-crash" };
const SESSION: ClientSessionContext = {
  actor: ACTOR,
  leaseOwner: leaseOwnerIdSchema.parse("lease_owner_00000000000000000000000000000001"),
  capacity: {
    maximumInputTokens: 4_194_304,
    maximumToolResultBytes: 4_194_304,
    source: "sdk_explicit",
  },
};

interface ChildPayload {
  readonly root: string;
  readonly phase: "before_commit" | "after_commit";
  readonly requestId: RequestId;
  readonly jobId: JobId;
}

const childPayload = (): ChildPayload | undefined => {
  const serialized = process.env.DISTILLY_BRIEF_CRASH_CHILD;
  if (serialized === undefined) return undefined;
  const raw = JSON.parse(serialized) as Record<string, unknown>;
  if (raw.phase !== "before_commit" && raw.phase !== "after_commit") {
    throw new Error("Invalid brief crash phase.");
  }
  if (typeof raw.root !== "string") throw new Error("Invalid brief crash root.");
  return {
    root: raw.root,
    phase: raw.phase,
    requestId: requestIdSchema.parse(raw.requestId),
    jobId: jobIdSchema.parse(raw.jobId),
  };
};

const child = childPayload();

if (child !== undefined) {
  describe("SQLite brief crash child", () => {
    it("blocks at the selected durable boundary until the process is killed", async () => {
      const stop = (phase: ChildPayload["phase"]): void => {
        writeSync(1, `phase:${phase}\n`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      const composition = await createInternalEngineComposition({
        root: child.root,
        leaseHooks: {
          beforeTransactionCommit: (method, requestId) => {
            if (
              child.phase === "before_commit" &&
              method === "distill.brief" &&
              requestId === child.requestId
            ) {
              stop("before_commit");
            }
          },
          afterTransactionCommit: (method, requestId) => {
            if (
              child.phase === "after_commit" &&
              method === "distill.brief" &&
              requestId === child.requestId
            ) {
              stop("after_commit");
            }
          },
        },
      });
      try {
        await composition.leases.brief({ jobId: child.jobId }, SESSION, {
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

  interface BriefAuthoritySnapshot {
    readonly blobs: number;
    readonly leases: number;
    readonly operations: number;
    readonly resultBlobs: number;
    readonly events: number;
    readonly quickCheck: string;
  }

  interface StoredBriefAuthority {
    readonly template: {
      readonly lease: { readonly id: string };
      readonly job: { readonly leaseExpiresAt: string };
    };
    readonly envelope: {
      readonly kind: string;
      readonly requestId: string;
      readonly resultBlob: { readonly digest: string; readonly byteLength: number };
      readonly lease: unknown;
    };
  }

  const roots: string[] = [];
  const liveChildren = new Set<ChildState>();
  const childScript = fileURLToPath(
    new URL("../../scripts/brief-crash-child.mjs", import.meta.url),
  );

  const request = (digit: number): RequestId =>
    requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

  const input: IngestInput = {
    subject: {
      kind: "create",
      input: {
        displayName: "Ada Lovelace",
        aliases: ["Ada"],
        identityHints: [{ kind: "url", value: "https://example.test/brief-crash" }],
      },
    },
    materials: [
      {
        clientRef: "brief-crash-source",
        kind: "web",
        content: "Verified evidence for a real distill.brief process-crash test.",
        source: {
          uri: "https://example.test/brief-crash",
          medium: "article",
          access: "public",
          role: "reference",
          capturedAt: isoDateTimeSchema.parse("2026-08-31T00:00:00.000Z"),
        },
        derivation: { kind: "native_text" },
      },
    ],
    enqueue: "now",
  };

  const temporaryRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "distilly-brief-crash-"));
    roots.push(root);
    return root;
  };

  const seedPendingJob = async (root: string): Promise<JobId> => {
    const composition = await createInternalEngineComposition({ root });
    try {
      const result = await composition.ingest.ingest(input, ACTOR, { requestId: request(1) });
      if (result.job === undefined) throw new Error("Expected ingest to enqueue a pending job.");
      return result.job.id;
    } finally {
      composition.close();
    }
  };

  const inspectAuthority = (root: string, briefRequest: RequestId): BriefAuthoritySnapshot => {
    const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
    try {
      const count = (sql: string, ...values: string[]): number => {
        const row = database.prepare(sql).get(...values) as { readonly count: number };
        return row.count;
      };
      const quickCheck = database.prepare("PRAGMA quick_check(1)").get() as {
        readonly quick_check: string;
      };
      return {
        blobs: count("SELECT count(*) AS count FROM blobs"),
        leases: count("SELECT count(*) AS count FROM job_leases"),
        operations: count(
          "SELECT count(*) AS count FROM operations WHERE request_id = ?",
          briefRequest,
        ),
        resultBlobs: count(
          "SELECT count(*) AS count FROM operation_result_blobs WHERE request_id = ?",
          briefRequest,
        ),
        events: count("SELECT count(*) AS count FROM events WHERE request_id = ?", briefRequest),
        quickCheck: quickCheck.quick_check,
      };
    } finally {
      database.close();
    }
  };

  const readStoredBrief = async (
    root: string,
    briefRequest: RequestId,
  ): Promise<StoredBriefAuthority> => {
    const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
    let digest: string;
    let expectedLength: number;
    let envelope: StoredBriefAuthority["envelope"];
    try {
      const row = database
        .prepare(
          `SELECT operation_result_blobs.blob_digest,
                  operation_result_blobs.byte_length,
                  operations.result_json
           FROM operation_result_blobs
           JOIN operations ON operations.request_id = operation_result_blobs.request_id
           WHERE operation_result_blobs.request_id = ?`,
        )
        .get(briefRequest) as {
        readonly blob_digest: string;
        readonly byte_length: number;
        readonly result_json: string;
      };
      digest = row.blob_digest;
      expectedLength = row.byte_length;
      envelope = JSON.parse(row.result_json) as StoredBriefAuthority["envelope"];
    } finally {
      database.close();
    }
    const bytes = await readFile(
      join(root, "blobs", "sha256", digest.slice("sha256_".length, "sha256_".length + 2), digest),
    );
    expect(bytes.byteLength).toBe(expectedLength);
    return {
      template: JSON.parse(bytes.toString("utf8")) as StoredBriefAuthority["template"],
      envelope,
    };
  };

  const startChild = (
    root: string,
    phase: ChildPayload["phase"],
    briefRequest: RequestId,
    jobId: JobId,
  ): ChildState => {
    const processChild = spawn(process.execPath, [childScript, root, phase, briefRequest, jobId], {
      cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

  const waitForPhase = async (state: ChildState, phase: ChildPayload["phase"]): Promise<void> => {
    const expected = `phase:${phase}`;
    const deadline = Date.now() + 10_000;
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
  };

  const killAt = async (
    root: string,
    phase: ChildPayload["phase"],
    briefRequest: RequestId,
    jobId: JobId,
  ): Promise<void> => {
    const state = startChild(root, phase, briefRequest, jobId);
    try {
      await waitForPhase(state, phase);
      expect(state.child.kill("SIGKILL")).toBe(true);
      const exit = await state.exited;
      expect(exit).toEqual({ code: null, signal: "SIGKILL" });
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

  describe.skipIf(process.platform === "win32")("SQLite brief real process crashes", () => {
    it("rolls back every brief authority row when SIGKILL lands before COMMIT", async () => {
      const root = await temporaryRoot();
      const jobId = await seedPendingJob(root);
      const briefRequest = request(2);

      await killAt(root, "before_commit", briefRequest, jobId);

      expect(inspectAuthority(root, briefRequest)).toEqual({
        blobs: 1,
        leases: 0,
        operations: 0,
        resultBlobs: 0,
        events: 0,
        quickCheck: "ok",
      });
      const reopened = await createInternalEngineComposition({ root });
      try {
        await expect(
          reopened.leases.brief({ jobId }, SESSION, { requestId: briefRequest }),
        ).resolves.toMatchObject({ job: { id: jobId, state: "leased" } });
      } finally {
        reopened.close();
      }
    }, 20_000);

    it("replays the exact blob-backed brief after SIGKILL lands after COMMIT", async () => {
      const root = await temporaryRoot();
      const jobId = await seedPendingJob(root);
      const briefRequest = request(2);

      await killAt(root, "after_commit", briefRequest, jobId);

      expect(inspectAuthority(root, briefRequest)).toEqual({
        blobs: 2,
        leases: 1,
        operations: 1,
        resultBlobs: 1,
        events: 1,
        quickCheck: "ok",
      });
      const stored = await readStoredBrief(root, briefRequest);
      expect(stored).toMatchObject({
        template: {
          lease: { id: "lease_00000000000000000000000000000000" },
          job: { leaseExpiresAt: "2000-01-01T00:30:00.000Z" },
        },
        envelope: {
          kind: "brief_template_v1",
          requestId: briefRequest,
        },
      });
      const reopened = await createInternalEngineComposition({ root });
      try {
        const replayed = await reopened.leases.brief({ jobId }, SESSION, {
          requestId: briefRequest,
        });
        expect(replayed.lease).toEqual(stored.envelope.lease);
        expect(replayed.lease.id).not.toBe(stored.template.lease.id);
        expect(replayed.job.leaseExpiresAt).toBe(replayed.lease.expiresAt);
        await expect(
          reopened.leases.brief({ jobId }, SESSION, { requestId: briefRequest }),
        ).resolves.toEqual(replayed);
        expect(inspectAuthority(root, briefRequest)).toEqual({
          blobs: 2,
          leases: 1,
          operations: 1,
          resultBlobs: 1,
          events: 1,
          quickCheck: "ok",
        });
      } finally {
        reopened.close();
      }
    }, 20_000);
  });
}
