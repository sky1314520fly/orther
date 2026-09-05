import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { IsoDateTime } from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { SystemClock } from "../defaults/system-clock.js";
import {
  atomicCreateDirectory,
  atomicCreateFile,
  atomicReplaceFile,
  ensurePrivateDirectory,
  syncDirectory,
} from "../facts/atomic-write.js";
import {
  assertNoSymlinkPath,
  decodeUtf8,
  isMissing,
  isRegularFileReplacement,
  readRegularFile,
} from "../facts/safe-fs.js";
import { lockBusy, storageCorrupt } from "../internal-errors.js";

const LOCK_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const STALE_CONFIRMATION_MS = 1_100;
const TRANSITION_TTL_MS = 60_000;
const TRANSITION_WAIT_MS = 5_000;
const TRANSITION_RETRY_MS = 10;
const LOCK_RECORD_MAXIMUM_BYTES = 4_096;
const OWNER_FILE = "owner.json";
const HEARTBEAT_FILE = "heartbeat.json";
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

interface OwnerRecord {
  readonly schemaVersion: 1;
  readonly ownerToken: string;
  readonly acquiredAt: IsoDateTime;
  readonly pid: number;
}

interface HeartbeatRecord {
  readonly schemaVersion: 1;
  readonly ownerToken: string;
  readonly sequence: number;
  readonly at: IsoDateTime;
}

interface LockSnapshot {
  readonly ownerToken?: string;
  readonly ownerPid?: number;
  readonly retirementKey: string;
  readonly revision: string;
  readonly heartbeatAt: number;
}

type RetireReason = "release" | "stale";
type LockDirectoryKind = "main" | "transition";
type LockChildKind = "owner" | "heartbeat";

/** Fault-injection hooks used only by file-lock concurrency tests. */
export interface FileLockHooks {
  /** Runs before either initial record is written into a private staging directory. */
  readonly beforeInitialRecords?: (kind: LockDirectoryKind) => void | Promise<void>;
  /** Runs after both initial records are durable but before the staging directory is published. */
  readonly beforeInitialPublish?: (kind: LockDirectoryKind) => void | Promise<void>;
  /** Runs after a transition candidate loses the atomic publication race. */
  readonly afterTransitionPublishCollision?: () => void | Promise<void>;
  /** Runs immediately before a dead-owner lock directory is fenced. */
  readonly beforeStaleFence?: (
    kind: LockDirectoryKind,
    retirementKey: string,
  ) => void | Promise<void>;
  /** Runs after snapshotting a lock directory and before opening its child records. */
  readonly afterSnapshotDirectoryStat?: (kind: LockDirectoryKind) => void | Promise<void>;
  /** Runs after a child-record lstat and immediately before opening that child. */
  readonly afterSnapshotChildStat?: (
    kind: LockDirectoryKind,
    child: LockChildKind,
  ) => void | Promise<void>;
  /** Runs after listing a retired entry and before inspecting that disconnected path. */
  readonly beforeRetiredEntryStat?: (path: string) => void | Promise<void>;
  /** Runs while the transition guard is held after final owner validation. */
  readonly beforeMainRetire?: (reason: RetireReason) => void | Promise<void>;
}

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const isDirectoryPublishCollision = (error: unknown): boolean =>
  hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY") || hasCode(error, "EISDIR");

const parseTimestamp = (value: unknown): number => {
  if (typeof value !== "string") throw storageCorrupt("File-lock timestamp is invalid.");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw storageCorrupt("File-lock timestamp is invalid.");
  }
  return milliseconds;
};

const parseJson = (data: Buffer, label: string): unknown => {
  try {
    return JSON.parse(decodeUtf8(data, label)) as unknown;
  } catch (error) {
    if (hasCode(error, "storage_corrupt")) throw error;
    throw storageCorrupt(`${label} is not valid JSON.`, error);
  }
};

const parseOwnerRecord = (data: Buffer): OwnerRecord => {
  const value = parseJson(data, "File-lock owner record");
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("ownerToken" in value) ||
    typeof value.ownerToken !== "string" ||
    !OWNER_TOKEN_PATTERN.test(value.ownerToken) ||
    !("acquiredAt" in value) ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    throw storageCorrupt("File-lock owner record has an invalid shape.");
  }
  parseTimestamp(value.acquiredAt);
  return value as OwnerRecord;
};

const parseHeartbeatRecord = (data: Buffer): HeartbeatRecord => {
  const value = parseJson(data, "File-lock heartbeat");
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("ownerToken" in value) ||
    typeof value.ownerToken !== "string" ||
    !OWNER_TOKEN_PATTERN.test(value.ownerToken) ||
    !("sequence" in value) ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !("at" in value)
  ) {
    throw storageCorrupt("File-lock heartbeat has an invalid shape.");
  }
  parseTimestamp(value.at);
  return value as HeartbeatRecord;
};

const serializeRecord = (value: OwnerRecord | HeartbeatRecord): string =>
  `${JSON.stringify(value)}\n`;

const transitionHeartbeatFile = (ownerToken: string): string => `heartbeat.${ownerToken}.json`;

const atomicReplaceExistingFile = async (target: string, data: string): Promise<void> => {
  const parent = dirname(target);
  const temporary = resolve(
    parent,
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(parent);
  } catch (error) {
    if (isMissing(error)) throw lockBusy("File-lock transition is no longer held.");
    throw error;
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
};

/** One held cross-process directory lock. */
export interface FileLockLease {
  readonly ownerToken: string;

  /**
   * Publishes one monotonic owner heartbeat.
   *
   * @returns A promise that resolves after the heartbeat is durable.
   */
  heartbeat(): Promise<void>;

  /** Releases the lock if this lease still owns it. */
  release(): Promise<void>;
}

class OwnedFileLockLease implements FileLockLease {
  readonly ownerToken: string;
  private readonly lock: FileLock;
  private readonly timer: NodeJS.Timeout;
  private sequence = 0;
  private heartbeatTail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(lock: FileLock, ownerToken: string) {
    this.lock = lock;
    this.ownerToken = ownerToken;
    this.timer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  /**
   * Publishes one monotonic owner heartbeat.
   *
   * @returns A promise that resolves after the heartbeat is durable.
   */
  heartbeat(): Promise<void> {
    if (this.stopped) return Promise.reject(lockBusy("File lock is no longer held."));
    const operation = this.heartbeatTail.then(async () => {
      const nextSequence = this.sequence + 1;
      await this.lock.writeHeartbeat(this.ownerToken, nextSequence);
      this.sequence = nextSequence;
    });
    this.heartbeatTail = operation.catch(() => undefined);
    return operation;
  }

  /** Releases the lock if this lease still owns it. */
  async release(): Promise<void> {
    this.stop();
    await this.heartbeatTail;
    await this.lock.release(this.ownerToken);
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
  }
}

interface TransitionLease {
  readonly ownerToken: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

class OwnedTransitionLease implements TransitionLease {
  readonly ownerToken: string;
  private readonly lock: FileLock;
  private readonly timer: NodeJS.Timeout;
  private sequence = 0;
  private heartbeatTail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(lock: FileLock, ownerToken: string) {
    this.lock = lock;
    this.ownerToken = ownerToken;
    this.timer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async assertOwned(): Promise<void> {
    await this.lock.assertTransitionOwner(this.ownerToken);
  }

  async release(): Promise<void> {
    this.stop();
    await this.heartbeatTail;
    await this.lock.releaseTransition(this.ownerToken);
  }

  private heartbeat(): Promise<void> {
    if (this.stopped) return Promise.reject(lockBusy("File-lock transition is no longer held."));
    const operation = this.heartbeatTail.then(async () => {
      const nextSequence = this.sequence + 1;
      await this.lock.writeTransitionHeartbeat(this.ownerToken, nextSequence);
      this.sequence = nextSequence;
    });
    this.heartbeatTail = operation.catch(() => undefined);
    return operation;
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
  }
}

/** Cross-process lock backed by an exclusively created directory. */
export class FileLock {
  private readonly root: string;
  private readonly path: string;
  private readonly clock: Clock;
  private readonly hooks: FileLockHooks;

  /**
   * Creates a file lock at one confined path.
   *
   * @param root - Absolute Distilly fact root.
   * @param path - Lock-directory path below the fact root.
   * @param clock - Clock used for heartbeat and stale-age decisions.
   * @param hooks - Optional fault-injection hooks for concurrency tests.
   */
  constructor(
    root: string,
    path: string,
    clock: Clock = new SystemClock(),
    hooks: FileLockHooks = {},
  ) {
    this.root = resolve(root);
    this.path = resolve(path);
    this.clock = clock;
    this.hooks = hooks;
    const fromRoot = relative(this.root, this.path);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      fromRoot.startsWith(sep)
    ) {
      throw storageCorrupt("File-lock path escapes DISTILLY_ROOT.");
    }
  }

  /**
   * Acquires the directory lock or reports retryable contention.
   *
   * @returns A lease bound to the newly generated owner token.
   */
  async acquire(): Promise<FileLockLease> {
    await this.prepareParent();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const created = await this.withTransition(async (transition) => {
        await transition.assertOwned();
        if ((await this.readSnapshot(this.path)) !== undefined) return undefined;
        return this.createOwnedDirectory();
      });
      if (created !== undefined) return created;

      const first = await this.readSnapshot(this.path);
      if (first === undefined || !this.isExpired(first, LOCK_TTL_MS)) {
        throw lockBusy("File lock is held by another process.");
      }
      await delay(STALE_CONFIRMATION_MS);
      const second = await this.readSnapshot(this.path);
      if (
        second === undefined ||
        second.revision !== first.revision ||
        !this.isExpired(second, LOCK_TTL_MS)
      ) {
        throw lockBusy("File-lock heartbeat is still advancing.");
      }
      if (!this.ownerIsDead(second)) {
        throw lockBusy("File-lock owner process is still alive.");
      }

      const reclaimed = await this.withTransition(async (transition) => {
        const final = await this.readSnapshot(this.path);
        if (
          final === undefined ||
          final.revision !== second.revision ||
          !this.isExpired(final, LOCK_TTL_MS) ||
          !this.ownerIsDead(final)
        ) {
          return false;
        }
        await this.hooks.beforeMainRetire?.("stale");
        await transition.assertOwned();
        const confirmed = await this.readSnapshot(this.path);
        if (confirmed?.revision !== final.revision || !this.ownerIsDead(confirmed)) return false;
        return this.fenceStale(this.path, confirmed);
      });
      if (!reclaimed) throw lockBusy("File lock changed during stale recovery.");
    }
    throw lockBusy("File lock was acquired by another process during stale recovery.");
  }

  /**
   * Releases the directory only when the supplied token is still its owner.
   *
   * @param ownerToken - Token returned by the successful acquisition.
   */
  async release(ownerToken: string): Promise<void> {
    await this.withTransition(async (transition) => {
      const snapshot = await this.readSnapshot(this.path);
      if (snapshot?.ownerToken !== ownerToken) {
        throw lockBusy("File lock is owned by another process.");
      }
      await this.hooks.beforeMainRetire?.("release");
      await transition.assertOwned();
      const confirmed = await this.readSnapshot(this.path);
      if (confirmed?.revision !== snapshot.revision) {
        throw lockBusy("File lock ownership changed before release.");
      }
      if (!(await this.retireAndClean(this.path))) {
        throw lockBusy("File lock ownership changed before release.");
      }
    });
  }

  /**
   * Atomically replaces the single heartbeat while holding the transition guard.
   *
   * @param ownerToken - Token of the lease publishing the heartbeat.
   * @param sequence - Monotonic sequence owned by that lease.
   */
  async writeHeartbeat(ownerToken: string, sequence: number): Promise<void> {
    await this.withTransition(async (transition) => {
      const snapshot = await this.readSnapshot(this.path);
      if (snapshot?.ownerToken !== ownerToken) {
        throw lockBusy("File lock is owned by another process.");
      }
      const at = this.clock.now();
      parseTimestamp(at);
      await transition.assertOwned();
      await atomicReplaceFile(
        this.root,
        resolve(this.path, HEARTBEAT_FILE),
        serializeRecord({
          schemaVersion: 1,
          ownerToken,
          sequence,
          at,
        }),
      );
    });
  }

  private async prepareParent(): Promise<void> {
    const parent = dirname(this.path);
    await assertNoSymlinkPath(this.root, parent);
    await ensurePrivateDirectory(parent);
    await assertNoSymlinkPath(this.root, parent);
  }

  private async createOwnedDirectory(): Promise<FileLockLease> {
    const ownerToken = randomBytes(16).toString("hex");
    const acquiredAt = this.clock.now();
    parseTimestamp(acquiredAt);
    try {
      await atomicCreateDirectory(
        this.root,
        this.path,
        async (temporaryDirectory) => {
          await this.hooks.beforeInitialRecords?.("main");
          await this.writeInitialRecords(temporaryDirectory, ownerToken, acquiredAt);
        },
        { beforeCommit: () => this.hooks.beforeInitialPublish?.("main") },
      );
    } catch (error) {
      if (isDirectoryPublishCollision(error)) {
        throw lockBusy("File lock was acquired by another process.");
      }
      throw error;
    }
    return new OwnedFileLockLease(this, ownerToken);
  }

  private async writeInitialRecords(
    path: string,
    ownerToken: string,
    acquiredAt: IsoDateTime,
    heartbeatFile = HEARTBEAT_FILE,
  ): Promise<void> {
    await atomicCreateFile(
      this.root,
      resolve(path, OWNER_FILE),
      serializeRecord({ schemaVersion: 1, ownerToken, acquiredAt, pid: process.pid }),
    );
    await atomicCreateFile(
      this.root,
      resolve(path, heartbeatFile),
      serializeRecord({
        schemaVersion: 1,
        ownerToken,
        sequence: 0,
        at: acquiredAt,
      }),
    );
  }

  private async withTransition<T>(
    operation: (transition: TransitionLease) => Promise<T>,
  ): Promise<T> {
    const transition = await this.acquireTransition();
    try {
      await this.cleanupRetired(this.path);
      return await operation(transition);
    } finally {
      await transition.release();
    }
  }

  private async acquireTransition(): Promise<TransitionLease> {
    const path = this.transitionPath();
    const deadline = Date.now() + TRANSITION_WAIT_MS;
    while (true) {
      await this.cleanupRetired(path);
      const ownerToken = randomBytes(16).toString("hex");
      const acquiredAt = this.clock.now();
      parseTimestamp(acquiredAt);
      let created: TransitionLease | undefined;
      try {
        await atomicCreateDirectory(
          this.root,
          path,
          async (temporaryDirectory) => {
            await this.hooks.beforeInitialRecords?.("transition");
            await this.writeInitialRecords(
              temporaryDirectory,
              ownerToken,
              acquiredAt,
              transitionHeartbeatFile(ownerToken),
            );
          },
          { beforeCommit: () => this.hooks.beforeInitialPublish?.("transition") },
        );
        created = new OwnedTransitionLease(this, ownerToken);
      } catch (error) {
        if (!isDirectoryPublishCollision(error)) throw error;
        await this.hooks.afterTransitionPublishCollision?.();
      }
      if (created !== undefined) return created;

      const first = await this.readSnapshot(path);
      if (first !== undefined && this.isExpired(first, TRANSITION_TTL_MS)) {
        await delay(STALE_CONFIRMATION_MS);
        const second = await this.readSnapshot(path);
        const unchanged =
          second !== undefined &&
          second.revision === first.revision &&
          this.isExpired(second, TRANSITION_TTL_MS);
        if (unchanged) {
          if (!this.ownerIsDead(second)) {
            throw lockBusy("File-lock transition owner process is still alive.");
          }
          if (await this.fenceStale(path, second)) continue;
        }
      }
      if (Date.now() >= deadline) {
        throw lockBusy("File-lock transition is owned by another process.");
      }
      await delay(TRANSITION_RETRY_MS);
    }
  }

  /**
   * Verifies that one transition lease still owns the guard.
   *
   * @param ownerToken - Transition owner token.
   */
  async assertTransitionOwner(ownerToken: string): Promise<void> {
    const snapshot = await this.readSnapshot(this.transitionPath());
    if (snapshot?.ownerToken !== ownerToken) {
      throw lockBusy("File-lock transition is owned by another process.");
    }
  }

  /**
   * Advances the transition guard heartbeat.
   *
   * @param ownerToken - Transition owner token.
   * @param sequence - Monotonic heartbeat sequence.
   */
  async writeTransitionHeartbeat(ownerToken: string, sequence: number): Promise<void> {
    const snapshot = await this.readSnapshot(this.transitionPath());
    if (snapshot?.ownerToken !== ownerToken) {
      throw lockBusy("File-lock transition is owned by another process.");
    }
    const at = this.clock.now();
    parseTimestamp(at);
    await atomicReplaceExistingFile(
      resolve(this.transitionPath(), transitionHeartbeatFile(ownerToken)),
      serializeRecord({
        schemaVersion: 1,
        ownerToken,
        sequence,
        at,
      }),
    );
  }

  /**
   * Releases a live transition guard through a temporary retired path.
   *
   * @param ownerToken - Transition owner token.
   */
  async releaseTransition(ownerToken: string): Promise<void> {
    const snapshot = await this.readSnapshot(this.transitionPath());
    if (snapshot?.ownerToken !== ownerToken) {
      throw lockBusy("File-lock transition is owned by another process.");
    }
    if (!(await this.retireAndClean(this.transitionPath()))) {
      throw lockBusy("File-lock transition changed before release.");
    }
  }

  private async fenceStale(path: string, snapshot: LockSnapshot): Promise<boolean> {
    await this.hooks.beforeStaleFence?.(
      path === this.transitionPath() ? "transition" : "main",
      snapshot.retirementKey,
    );
    const fencedPath = `${path}.fence.${snapshot.retirementKey}`;
    try {
      await rename(path, fencedPath);
    } catch (error) {
      if (
        isMissing(error) ||
        hasCode(error, "EEXIST") ||
        hasCode(error, "ENOTEMPTY") ||
        hasCode(error, "EISDIR")
      ) {
        return false;
      }
      throw error;
    }
    await syncDirectory(dirname(path));
    return true;
  }

  private async retireAndClean(path: string): Promise<boolean> {
    const retiredPath = `${path}.retired.${randomBytes(16).toString("hex")}`;
    try {
      await rename(path, retiredPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    await syncDirectory(dirname(path));
    await rm(retiredPath, { recursive: true, force: true });
    await syncDirectory(dirname(path));
    return true;
  }

  private async cleanupRetired(path: string): Promise<void> {
    const parent = dirname(path);
    const prefix = `${basename(path)}.retired.`;
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const retiredPath = resolve(parent, entry.name);
      await this.hooks.beforeRetiredEntryStat?.(retiredPath);
      let status;
      try {
        status = await lstat(retiredPath);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw storageCorrupt("File-lock retired path is not a real directory.");
      }
      await rm(retiredPath, { recursive: true, force: true });
    }
    await syncDirectory(parent);
  }

  private async readSnapshot(path: string): Promise<LockSnapshot | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await this.readSnapshotAttempt(path);
      if (snapshot !== "changed") return snapshot;
    }
    throw lockBusy("File-lock path changed repeatedly while it was read.");
  }

  private async readSnapshotAttempt(path: string): Promise<LockSnapshot | "changed" | undefined> {
    const status = await this.readLockDirectoryStatus(path);
    if (status === undefined) return undefined;
    const kind = path === this.transitionPath() ? "transition" : "main";
    await this.hooks.afterSnapshotDirectoryStat?.(kind);

    let owner: OwnerRecord;
    try {
      owner = parseOwnerRecord(
        await readRegularFile(this.root, resolve(path, OWNER_FILE), LOCK_RECORD_MAXIMUM_BYTES, {
          afterTargetStat: () => this.hooks.afterSnapshotChildStat?.(kind, "owner"),
        }),
      );
    } catch (error) {
      return this.resolveSnapshotReadError(
        path,
        status,
        error,
        "File-lock owner record is missing.",
      );
    }

    let heartbeat: HeartbeatRecord;
    try {
      const heartbeatFile =
        path === this.transitionPath() ? transitionHeartbeatFile(owner.ownerToken) : HEARTBEAT_FILE;
      heartbeat = parseHeartbeatRecord(
        await readRegularFile(this.root, resolve(path, heartbeatFile), LOCK_RECORD_MAXIMUM_BYTES, {
          afterTargetStat: () => this.hooks.afterSnapshotChildStat?.(kind, "heartbeat"),
        }),
      );
    } catch (error) {
      return this.resolveSnapshotReadError(path, status, error, "File-lock heartbeat is missing.");
    }
    const current = await this.readLockDirectoryStatus(path);
    if (current === undefined) return undefined;
    if (current.dev !== status.dev || current.ino !== status.ino) return "changed";
    if (heartbeat.ownerToken !== owner.ownerToken) {
      throw storageCorrupt("File-lock heartbeat does not match its owner.");
    }
    const heartbeatAt = parseTimestamp(heartbeat.at);
    return {
      ownerToken: owner.ownerToken,
      ownerPid: owner.pid,
      retirementKey: `${status.dev}-${status.ino}-${owner.ownerToken}`,
      revision: `${status.dev}:${status.ino}:${owner.ownerToken}:${owner.pid}:${heartbeat.sequence}:${heartbeatAt}`,
      heartbeatAt,
    };
  }

  private async readLockDirectoryStatus(path: string) {
    let status;
    try {
      status = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw storageCorrupt("File-lock path is not a real directory.");
    }
    return status;
  }

  private async resolveSnapshotReadError(
    path: string,
    original: Stats,
    error: unknown,
    missingMessage: string,
  ): Promise<"changed" | undefined> {
    const current = await this.readLockDirectoryStatus(path);
    if (current === undefined) return undefined;
    if (current.dev !== original.dev || current.ino !== original.ino) return "changed";
    if (isRegularFileReplacement(error)) return "changed";
    if (hasCode(error, "not_found") || isMissing(error)) {
      throw storageCorrupt(missingMessage, error);
    }
    throw error;
  }

  private ownerIsDead(snapshot: LockSnapshot): boolean {
    if (snapshot.ownerPid === undefined) {
      throw storageCorrupt("File-lock owner PID is unavailable; stale recovery is unsafe.");
    }
    try {
      process.kill(snapshot.ownerPid, 0);
      return false;
    } catch (error) {
      if (hasCode(error, "ESRCH")) return true;
      if (hasCode(error, "EPERM")) return false;
      throw storageCorrupt("File-lock owner liveness could not be verified.", error);
    }
  }

  private isExpired(snapshot: LockSnapshot, ttlMilliseconds: number): boolean {
    const now = parseTimestamp(this.clock.now());
    return now - snapshot.heartbeatAt > ttlMilliseconds;
  }

  private transitionPath(): string {
    return `${this.path}.transition`;
  }
}
