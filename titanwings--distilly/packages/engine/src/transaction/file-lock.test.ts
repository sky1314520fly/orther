import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { subjectIdSchema } from "@distilly/protocol";
import type { IsoDateTime } from "@distilly/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import { atomicReplaceFile } from "../facts/atomic-write.js";
import { Layout } from "../layout.js";
import { FileLock } from "./file-lock.js";
import type { FileLockLease } from "./file-lock.js";
import { FileSubjectLock } from "./subject-lock.js";

const roots: string[] = [];
let deadPid: number;

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-engine-lock-"));
  roots.push(root);
  return root;
};

const makeClock = (): { readonly clock: Clock; advance(milliseconds: number): void } => {
  let milliseconds = Date.parse("2026-08-20T00:00:00.000Z");
  return {
    clock: {
      now: () => new Date(milliseconds).toISOString() as IsoDateTime,
    },
    advance(amount: number) {
      milliseconds += amount;
    },
  };
};

const seedStaleLock = async (path: string, pid: number): Promise<string> => {
  const ownerToken = "f".repeat(32);
  const at = "2026-08-18T00:00:00.000Z";
  await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(
    join(path, "owner.json"),
    `${JSON.stringify({ schemaVersion: 1, ownerToken, acquiredAt: at, pid })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(path, path.endsWith(".transition") ? `heartbeat.${ownerToken}.json` : "heartbeat.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      ownerToken,
      sequence: 0,
      at,
    })}\n`,
    { mode: 0o600 },
  );
  return ownerToken;
};

beforeAll(async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("failed to start dead-PID fixture process");
  deadPid = child.pid;
  await once(child, "exit");
});

const publishHeartbeatEventually = async (lease: FileLockLease): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      await lease.heartbeat();
      return;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "busy" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await delay(10);
    }
  }
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cross-process file locks", () => {
  it("does not reclaim an expired lock whose heartbeat advances between samples", async () => {
    const root = await makeRoot();
    const controlled = makeClock();
    const lock = new FileLock(root, join(root, "locks", "writer.lock"), controlled.clock);
    const owner = await lock.acquire();
    controlled.advance(86_400_000);

    const contender = lock.acquire();
    const contenderAssertion = expect(contender).rejects.toMatchObject({
      code: "busy",
      retryable: true,
    });
    await publishHeartbeatEventually(owner);

    await contenderAssertion;
    await owner.heartbeat();
    expect((await readdir(join(root, "locks", "writer.lock"))).sort()).toEqual([
      "heartbeat.json",
      "owner.json",
    ]);
    await owner.release();
  });

  it("does not reclaim an unchanged expired lock while its owner PID is alive", async () => {
    const root = await makeRoot();
    const controlled = makeClock();
    const path = join(root, "locks", "writer.lock");
    await seedStaleLock(path, process.pid);
    const lock = new FileLock(root, path, controlled.clock);

    await expect(lock.acquire()).rejects.toMatchObject({ code: "busy", retryable: true });
    expect((await readdir(join(root, "locks"))).some((name) => name.includes(".fence."))).toBe(
      false,
    );
  });

  it("recovers only after an expired heartbeat remains unchanged twice", async () => {
    const root = await makeRoot();
    const controlled = makeClock();
    const path = join(root, "locks", "writer.lock");
    const staleOwnerToken = await seedStaleLock(path, deadPid);
    const lock = new FileLock(root, path, controlled.clock);

    const recoveredOwner = await lock.acquire();

    expect(recoveredOwner.ownerToken).not.toBe(staleOwnerToken);
    expect(
      (await readdir(join(root, "locks"))).filter((name) => name.startsWith("writer.lock.fence.")),
    ).toHaveLength(1);
    await recoveredOwner.release();
  });

  it("allows only one of two concurrent stale-lock reclaimers to acquire", async () => {
    const root = await makeRoot();
    const controlled = makeClock();
    const path = join(root, "locks", "writer.lock");
    await seedStaleLock(path, deadPid);
    const lock = new FileLock(root, path, controlled.clock);

    const results = await Promise.allSettled([lock.acquire(), lock.acquire()]);
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<FileLockLease> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "busy", retryable: true });
    expect(
      (await readdir(join(root, "locks"))).filter((name) => name.startsWith("writer.lock.fence.")),
    ).toHaveLength(1);
    await acquired[0]?.value.release();
  });

  it("fences a stale transition so a delayed reclaimer cannot remove its successor", async () => {
    const root = await makeRoot();
    const controlled = makeClock();
    const path = join(root, "locks", "writer.lock");
    await seedStaleLock(`${path}.transition`, deadPid);
    const lock = new FileLock(root, path, controlled.clock);

    const results = await Promise.allSettled([lock.acquire(), lock.acquire()]);
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<FileLockLease> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "busy" });
    expect(
      (await readdir(join(root, "locks"))).filter((name) =>
        name.startsWith("writer.lock.transition.fence."),
      ),
    ).toHaveLength(1);
    await acquired[0]?.value.release();
  });

  it("keeps a successor transition when an older stale reclaimer resumes late", async () => {
    const root = await makeRoot();
    const controlled = makeClock();
    const path = join(root, "locks", "writer.lock");
    const transitionPath = `${path}.transition`;
    await seedStaleLock(transitionPath, deadPid);

    let allowFirstFence: (() => void) | undefined;
    let firstFenceEntered: (() => void) | undefined;
    const firstMayFence = new Promise<void>((resolve) => {
      allowFirstFence = resolve;
    });
    const firstAtFence = new Promise<void>((resolve) => {
      firstFenceEntered = resolve;
    });
    let firstPaused = false;
    let stopAfterSuccessorCollision = false;
    const delayed = new FileLock(root, path, controlled.clock, {
      afterTransitionPublishCollision() {
        if (stopAfterSuccessorCollision) {
          throw new Error("delayed reclaimer reached the successor transition");
        }
      },
      async beforeStaleFence(kind) {
        if (kind !== "transition" || firstPaused) return;
        firstPaused = true;
        firstFenceEntered?.();
        await firstMayFence;
      },
    });

    let allowSuccessorMain: (() => void) | undefined;
    let successorMainEntered: (() => void) | undefined;
    const successorMayInitializeMain = new Promise<void>((resolve) => {
      allowSuccessorMain = resolve;
    });
    const successorAtMain = new Promise<void>((resolve) => {
      successorMainEntered = resolve;
    });
    let successorPaused = false;
    const successor = new FileLock(root, path, controlled.clock, {
      async beforeInitialRecords(kind) {
        if (kind !== "main" || successorPaused) return;
        successorPaused = true;
        successorMainEntered?.();
        await successorMayInitializeMain;
      },
    });

    const delayedAcquire = delayed.acquire();
    await firstAtFence;
    const successorAcquire = successor.acquire();
    await successorAtMain;
    const successorStatus = await lstat(transitionPath);
    const successorOwner = await readFile(join(transitionPath, "owner.json"), "utf8");

    stopAfterSuccessorCollision = true;
    allowFirstFence?.();
    await expect(delayedAcquire).rejects.toThrow(
      "delayed reclaimer reached the successor transition",
    );
    const afterDelayedStatus = await lstat(transitionPath);
    expect([afterDelayedStatus.dev, afterDelayedStatus.ino]).toEqual([
      successorStatus.dev,
      successorStatus.ino,
    ]);
    await expect(readFile(join(transitionPath, "owner.json"), "utf8")).resolves.toBe(
      successorOwner,
    );

    allowSuccessorMain?.();
    const lease = await successorAcquire;
    await lease.release();
  });

  it("does not fence an expired transition while its owner PID is alive", async () => {
    const root = await makeRoot();
    const controlled = makeClock();
    const path = join(root, "locks", "writer.lock");
    await seedStaleLock(`${path}.transition`, process.pid);
    const lock = new FileLock(root, path, controlled.clock);

    await expect(lock.acquire()).rejects.toMatchObject({ code: "busy", retryable: true });
    expect(
      (await readdir(join(root, "locks"))).some((name) =>
        name.startsWith("writer.lock.transition.fence."),
      ),
    ).toBe(false);
  });

  it("never lets a different owner token remove the lock", async () => {
    const root = await makeRoot();
    const path = join(root, "locks", "writer.lock");
    const lock = new FileLock(root, path);
    const owner = await lock.acquire();

    await expect(lock.release("0".repeat(32))).rejects.toMatchObject({ code: "busy" });
    await expect(lstat(path)).resolves.toMatchObject({});
    await expect(lock.acquire()).rejects.toMatchObject({ code: "busy" });

    await owner.release();
  });

  it("rejects owner records with a missing, invalid, or unknown PID field", async () => {
    const ownerToken = "f".repeat(32);
    const acquiredAt = "2026-08-18T00:00:00.000Z";
    const invalidOwners = [
      { schemaVersion: 1, ownerToken, acquiredAt },
      { schemaVersion: 1, ownerToken, acquiredAt, pid: 0 },
      { schemaVersion: 1, ownerToken, acquiredAt, pid: deadPid, unknown: true },
    ];

    for (const invalidOwner of invalidOwners) {
      const root = await makeRoot();
      const path = join(root, "locks", "writer.lock");
      await seedStaleLock(path, deadPid);
      await writeFile(join(path, "owner.json"), `${JSON.stringify(invalidOwner)}\n`, {
        mode: 0o600,
      });

      await expect(new FileLock(root, path, makeClock().clock).acquire()).rejects.toMatchObject({
        code: "storage_corrupt",
      });
      await expect(lstat(path)).resolves.toMatchObject({});
    }
  });

  it("treats an externally published lock with missing initial records as corrupt", async () => {
    for (const missingRecord of ["owner", "heartbeat"] as const) {
      const root = await makeRoot();
      const path = join(root, "locks", "writer.lock");
      await mkdir(path, { recursive: true, mode: 0o700 });
      if (missingRecord === "heartbeat") {
        await writeFile(
          join(path, "owner.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            ownerToken: "f".repeat(32),
            acquiredAt: "2026-08-18T00:00:00.000Z",
            pid: deadPid,
          })}\n`,
          { mode: 0o600 },
        );
      }

      await expect(new FileLock(root, path, makeClock().clock).acquire()).rejects.toMatchObject({
        code: "storage_corrupt",
      });
      await expect(lstat(path)).resolves.toMatchObject({});
    }
  });

  it("never publishes a main or transition lock before its initial records are complete", async () => {
    for (const failedKind of ["main", "transition"] as const) {
      const root = await makeRoot();
      const path = join(root, "locks", "writer.lock");
      let shouldFail = true;
      const lock = new FileLock(root, path, undefined, {
        beforeInitialRecords(kind) {
          if (kind !== failedKind || !shouldFail) return;
          shouldFail = false;
          throw new Error(`injected ${kind} initialization failure`);
        },
      });

      await expect(lock.acquire()).rejects.toThrow(`injected ${failedKind} initialization failure`);
      const failedPath = failedKind === "main" ? path : `${path}.transition`;
      await expect(lstat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(join(root, "locks"))).some((name) => name.includes(".tmp"))).toBe(
        false,
      );

      const recovered = await lock.acquire();
      await recovered.release();
    }
  });

  it("publishes only one of two concurrently prepared transition candidates", async () => {
    const root = await makeRoot();
    const path = join(root, "locks", "writer.lock");
    let releaseCandidates: (() => void) | undefined;
    let candidatesPrepared: (() => void) | undefined;
    let releaseMainInitializer: (() => void) | undefined;
    let mainInitializerEntered: (() => void) | undefined;
    const mayPublishCandidates = new Promise<void>((resolve) => {
      releaseCandidates = resolve;
    });
    const bothCandidatesPrepared = new Promise<void>((resolve) => {
      candidatesPrepared = resolve;
    });
    const mayInitializeMain = new Promise<void>((resolve) => {
      releaseMainInitializer = resolve;
    });
    const firstMainInitializerEntered = new Promise<void>((resolve) => {
      mainInitializerEntered = resolve;
    });
    let transitionCandidateCount = 0;
    let mainInitializerCount = 0;
    const hooks = {
      async beforeInitialPublish(kind: "main" | "transition") {
        if (kind !== "transition" || transitionCandidateCount >= 2) return;
        transitionCandidateCount += 1;
        if (transitionCandidateCount === 2) candidatesPrepared?.();
        await mayPublishCandidates;
      },
      async beforeInitialRecords(kind: "main" | "transition") {
        if (kind !== "main") return;
        mainInitializerCount += 1;
        if (mainInitializerCount !== 1) return;
        mainInitializerEntered?.();
        await mayInitializeMain;
      },
    };
    const firstLock = new FileLock(root, path, undefined, hooks);
    const secondLock = new FileLock(root, path, undefined, hooks);

    const contenders = [firstLock.acquire(), secondLock.acquire()];
    await bothCandidatesPrepared;
    releaseCandidates?.();
    await firstMainInitializerEntered;
    await delay(50);

    expect(transitionCandidateCount).toBe(2);
    expect(mainInitializerCount).toBe(1);
    expect((await readdir(`${path}.transition`)).sort()).toEqual([
      expect.stringMatching(/^heartbeat\.[0-9a-f]{32}\.json$/u),
      "owner.json",
    ]);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });

    releaseMainInitializer?.();
    const results = await Promise.allSettled(contenders);
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<FileLockLease> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "busy", retryable: true });
    await acquired[0]?.value.release();
    expect(
      (await readdir(join(root, "locks"))).filter(
        (name) => name.includes(".tmp") || name.includes(".retired."),
      ),
    ).toEqual([]);
  });

  it("retries when a lock directory moves between its snapshot and child reads", async () => {
    const root = await makeRoot();
    const path = join(root, "locks", "writer.lock");
    const transitionPath = `${path}.transition`;
    const movedPath = `${transitionPath}.moved`;
    await seedStaleLock(transitionPath, process.pid);
    let moved = false;
    const lock = new FileLock(root, path, undefined, {
      async afterSnapshotDirectoryStat(kind) {
        if (kind !== "transition" || moved) return;
        moved = true;
        await rename(transitionPath, movedPath);
      },
    });

    const lease = await lock.acquire();

    expect(moved).toBe(true);
    await expect(lstat(movedPath)).resolves.toMatchObject({});
    await lease.release();
  });

  it("retries when a heartbeat is replaced between its lstat and open", async () => {
    const root = await makeRoot();
    const path = join(root, "locks", "writer.lock");
    const lease = await new FileLock(root, path).acquire();
    let mainHeartbeatReads = 0;
    let replaced = false;
    const contender = new FileLock(root, path, undefined, {
      async afterSnapshotChildStat(kind, child) {
        if (kind !== "main" || child !== "heartbeat") return;
        mainHeartbeatReads += 1;
        if (mainHeartbeatReads !== 2) return;
        replaced = true;
        await atomicReplaceFile(
          root,
          join(path, "heartbeat.json"),
          Buffer.from(
            `${JSON.stringify({
              schemaVersion: 1,
              ownerToken: lease.ownerToken,
              sequence: 1,
              at: new Date().toISOString(),
            })}\n`,
          ),
        );
      },
    });

    await expect(contender.acquire()).rejects.toMatchObject({ code: "busy", retryable: true });
    expect(replaced).toBe(true);
    await lease.release();
  });

  it("ignores a retired entry removed by another cleanup before lstat", async () => {
    const root = await makeRoot();
    const path = join(root, "locks", "writer.lock");
    const retiredPath = `${path}.transition.retired.fixture`;
    await mkdir(retiredPath, { recursive: true, mode: 0o700 });
    let removed = false;
    const lock = new FileLock(root, path, undefined, {
      async beforeRetiredEntryStat(candidate) {
        if (candidate !== retiredPath || removed) return;
        removed = true;
        await rm(candidate, { recursive: true });
      },
    });

    const lease = await lock.acquire();
    await lease.release();

    expect(removed).toBe(true);
    expect(
      (await readdir(join(root, "locks"))).filter(
        (name) => name.includes(".transition") || name.includes(".retired."),
      ),
    ).toEqual([]);
  });

  it("serializes final release against reacquisition and cleans retired paths", async () => {
    const root = await makeRoot();
    let releaseRetire: (() => void) | undefined;
    let enteredRetire: (() => void) | undefined;
    const mayRetire = new Promise<void>((resolve) => {
      releaseRetire = resolve;
    });
    const retireEntered = new Promise<void>((resolve) => {
      enteredRetire = resolve;
    });
    let pauseRelease = true;
    let contenderBlocked: (() => void) | undefined;
    const contenderObservedTransition = new Promise<void>((resolve) => {
      contenderBlocked = resolve;
    });
    const path = join(root, "locks", "writer.lock");
    const lock = new FileLock(root, path, undefined, {
      afterTransitionPublishCollision() {
        contenderBlocked?.();
      },
      async beforeMainRetire(reason) {
        if (reason !== "release" || !pauseRelease) return;
        pauseRelease = false;
        enteredRetire?.();
        await mayRetire;
      },
    });
    const firstOwner = await lock.acquire();

    const releasing = firstOwner.release();
    await retireEntered;
    const contender = lock.acquire();
    await contenderObservedTransition;
    releaseRetire?.();
    await releasing;

    const secondOwner = await contender;
    await expect(lock.release(firstOwner.ownerToken)).rejects.toMatchObject({ code: "busy" });
    await secondOwner.release();
    expect(
      (await readdir(join(root, "locks"))).filter(
        (name) => name.includes(".retired.") || name.includes(".fence."),
      ),
    ).toEqual([]);
  });

  it("uses the candidate-safe subject path from Layout", async () => {
    const root = await makeRoot();
    const layout = new Layout(root);
    const subjectId = subjectIdSchema.parse(`subject_${"2".repeat(32)}`);
    const subjectLock = new FileSubjectLock(layout);

    const subjectLease = await subjectLock.acquire(subjectId);

    expect((await lstat(layout.subjectLock(subjectId))).isDirectory()).toBe(true);
    await expect(lstat(layout.subjectDirectory(subjectId))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await subjectLease.release();
  });
});
