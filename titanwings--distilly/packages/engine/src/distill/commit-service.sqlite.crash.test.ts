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
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createInternalEngineComposition } from "../ingest/composition.js";

const ACTOR: ActorContext = { kind: "sdk", id: "sqlite-commit-crash" };
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
  readonly input: CommitInput;
}

const childPayload = (): ChildPayload | undefined => {
  const serialized = process.env.DISTILLY_COMMIT_CRASH_CHILD;
  if (serialized === undefined) return undefined;
  const raw = JSON.parse(serialized) as Record<string, unknown>;
  if (raw.phase !== "before_commit" && raw.phase !== "after_commit") {
    throw new Error("Invalid commit crash phase.");
  }
  if (typeof raw.root !== "string") throw new Error("Invalid commit crash root.");
  return {
    root: raw.root,
    phase: raw.phase,
    requestId: requestIdSchema.parse(raw.requestId),
    input: engineMethodSchemas["distill.commit"].params.parse(raw.input),
  };
};

const child = childPayload();

if (child !== undefined) {
  describe("SQLite commit crash child", () => {
    it("blocks at the selected SQLite boundary until the process is killed", async () => {
      const stop = (phase: ChildPayload["phase"]): void => {
        writeSync(1, `phase:${phase}\n`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      const composition = await createInternalEngineComposition({
        root: child.root,
        commitHooks: {
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
        await composition.commits.commit(child.input, SESSION, { requestId: child.requestId });
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

  interface AuthoritySnapshot {
    readonly versions: number;
    readonly statuses: number;
    readonly versionMaterials: number;
    readonly claims: number;
    readonly evidence: number;
    readonly pending: number;
    readonly leases: number;
    readonly operations: number;
    readonly events: number;
    readonly current: string | null;
    readonly quickCheck: string;
  }

  const roots: string[] = [];
  const liveChildren = new Set<ChildState>();
  const childScript = fileURLToPath(
    new URL("../../scripts/commit-crash-child.mjs", import.meta.url),
  );

  const request = (digit: number): RequestId =>
    requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

  const ingestInput: IngestInput = {
    subject: {
      kind: "create",
      input: {
        displayName: "Crash Boundary",
        identityHints: [{ kind: "url", value: "https://example.test/commit-crash" }],
      },
    },
    materials: [
      {
        clientRef: "commit-crash-source",
        kind: "web",
        content: "Crash Boundary preserves exact evidence across a SQLite commit.",
        source: {
          uri: "https://example.test/commit-crash",
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
    const root = await mkdtemp(join(tmpdir(), "distilly-commit-crash-"));
    roots.push(root);
    return root;
  };

  const seedLeasedCommit = async (root: string): Promise<CommitInput> => {
    const composition = await createInternalEngineComposition({ root });
    try {
      const ingested = await composition.ingest.ingest(ingestInput, ACTOR, {
        requestId: request(1),
      });
      if (ingested.job === undefined) throw new Error("Expected a pending job.");
      const briefing = await composition.leases.brief({ jobId: ingested.job.id }, SESSION, {
        requestId: request(2),
      });
      return {
        jobId: briefing.job.id,
        generation: briefing.job.generation,
        leaseId: briefing.lease.id,
        briefContractDigest: briefing.contract.digest,
        materialSetHash: briefing.job.materialSetHash,
        patch: {
          operations: [
            {
              op: "add",
              claim: {
                facet: facetPathSchema.parse("identity"),
                text: "The subject preserves exact evidence across a SQLite commit.",
                evidence: [
                  {
                    kind: "brief_material",
                    materialRef: briefMaterialRefSchema.parse("m001"),
                    quote: "preserves exact evidence across a SQLite commit",
                  },
                ],
              },
            },
          ],
        },
      };
    } finally {
      composition.close();
    }
  };

  const inspectAuthority = (root: string, commitRequest: RequestId): AuthoritySnapshot => {
    const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
    try {
      const count = (table: string): number => {
        const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
          readonly count: number;
        };
        return row.count;
      };
      const scopedCount = (table: "operations" | "events"): number => {
        const row = database
          .prepare(`SELECT count(*) AS count FROM ${table} WHERE request_id = ?`)
          .get(commitRequest) as { readonly count: number };
        return row.count;
      };
      const state = database.prepare("SELECT current_version_id FROM subject_states").get() as {
        readonly current_version_id: string | null;
      };
      const quick = database.prepare("PRAGMA quick_check(1)").get() as {
        readonly quick_check: string;
      };
      return {
        versions: count("versions"),
        statuses: count("version_statuses"),
        versionMaterials: count("version_materials"),
        claims: count("version_claims"),
        evidence: count("version_claim_evidence"),
        pending: count("pending_jobs"),
        leases: count("job_leases"),
        operations: scopedCount("operations"),
        events: scopedCount("events"),
        current: state.current_version_id,
        quickCheck: quick.quick_check,
      };
    } finally {
      database.close();
    }
  };

  const storedResult = (root: string, commitRequest: RequestId): unknown => {
    const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
    try {
      const row = database
        .prepare("SELECT result_json FROM operations WHERE request_id = ?")
        .get(commitRequest) as { readonly result_json: string };
      return JSON.parse(row.result_json);
    } finally {
      database.close();
    }
  };

  const startChild = (
    root: string,
    phase: ChildPayload["phase"],
    commitRequest: RequestId,
    input: CommitInput,
  ): ChildState => {
    const encodedInput = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
    const processChild = spawn(
      process.execPath,
      [childScript, root, phase, commitRequest, encodedInput],
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
    phase: ChildPayload["phase"],
    commitRequest: RequestId,
    input: CommitInput,
  ): Promise<void> => {
    const state = startChild(root, phase, commitRequest, input);
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

  describe.skipIf(process.platform === "win32")("SQLite commit real process crashes", () => {
    it("shows only previous authority when SIGKILL lands before COMMIT", async () => {
      const root = await temporaryRoot();
      const input = await seedLeasedCommit(root);
      const commitRequest = request(3);

      await killAt(root, "before_commit", commitRequest, input);

      expect(inspectAuthority(root, commitRequest)).toEqual({
        versions: 0,
        statuses: 0,
        versionMaterials: 0,
        claims: 0,
        evidence: 0,
        pending: 1,
        leases: 1,
        operations: 0,
        events: 0,
        current: null,
        quickCheck: "ok",
      });
      const reopened = await createInternalEngineComposition({ root });
      try {
        await expect(
          reopened.commits.commit(input, SESSION, { requestId: commitRequest }),
        ).resolves.toMatchObject({ kind: "current" });
      } finally {
        reopened.close();
      }
    }, 20_000);

    it("replays the complete target when SIGKILL lands after COMMIT", async () => {
      const root = await temporaryRoot();
      const input = await seedLeasedCommit(root);
      const commitRequest = request(3);

      await killAt(root, "after_commit", commitRequest, input);

      const authority = inspectAuthority(root, commitRequest);
      expect(authority).toMatchObject({
        versions: 1,
        statuses: 1,
        versionMaterials: 1,
        claims: 1,
        evidence: 1,
        pending: 0,
        leases: 0,
        operations: 1,
        events: 2,
        quickCheck: "ok",
      });
      expect(authority.current).toMatch(/^version_[0-9a-f]{64}$/);
      const expected = engineMethodSchemas["distill.commit"].result.parse(
        storedResult(root, commitRequest),
      );
      const reopened = await createInternalEngineComposition({ root });
      try {
        await expect(
          reopened.commits.commit(input, SESSION, { requestId: commitRequest }),
        ).resolves.toEqual(expected);
        expect(inspectAuthority(root, commitRequest)).toEqual(authority);
      } finally {
        reopened.close();
      }
    }, 20_000);
  });
}
