import { lstat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  DistillyError,
  factChecksumSchema,
  isoDateTimeSchema,
  libraryEntrySchema,
  subjectIdSchema,
  WIRE_LIMITS,
} from "@distilly/protocol";
import type {
  IsoDateTime,
  JsonObject,
  LibraryEntry,
  LibraryPage,
  LibraryQuery,
  RebuildResult,
  RuntimeSchema,
  SubjectId,
} from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { SystemClock } from "../defaults/system-clock.js";
import { atomicReplaceFile, ensurePrivateDirectory, syncDirectory } from "../facts/atomic-write.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { sealFact } from "../facts/checksum.js";
import { readFactFile } from "../facts/fact-file.js";
import { assertNoSymlinkPath, isMissing, readRegularFile } from "../facts/safe-fs.js";
import { indexUnavailable, invalidInput, storageCorrupt } from "../internal-errors.js";
import type { Layout } from "../layout.js";
import { compareUtf8 } from "../profile/claim-id.js";
import { decodeCursor, encodeCursor } from "../read/cursor.js";
import { FileLock } from "../transaction/file-lock.js";
import type { FileLockLease } from "../transaction/file-lock.js";
import type {
  CoordinatedLibraryProjection,
  LibraryApplyStatus,
  LibraryProjectionRecord,
  LibraryWriterKind,
} from "./library-projection.js";
import { LibraryIntentPendingError } from "./library-projection.js";

const DIRTY_BYTES = "distilly-library-dirty-v1\n";
const INTENT_PREFIX = "distilly-library-intent-v1 ";
const INTENT_PATTERN = /^distilly-library-intent-v1 ([0-9a-f]{32})\n$/u;
const MARKER_MAXIMUM_BYTES = 1_024;
const LOCK_RETRY_MS = 10;
const DEFAULT_PAGE_LIMIT = 50;

/** Durability hooks used by crash-order tests. */
export interface JsonLibraryProjectionHooks {
  /** Runs immediately before a query takes the projection lock. */
  readonly beforeQueryLock?: () => void | Promise<void>;
  /** Runs after the exact writer-intent marker and parent entry are durable. */
  readonly afterIntentMarker?: () => void | Promise<void>;
  /** Runs after intent unlink and before the parent directory is synchronized. */
  readonly afterIntentMarkerUnlink?: () => void | Promise<void>;
  /** Runs after the exact dirty marker and its parent entry are durable. */
  readonly afterDirtyMarker?: () => void | Promise<void>;
  /** Runs after the replacement record and its parent entry are durable. */
  readonly afterRecordReplaceSync?: () => void | Promise<void>;
  /** Runs after marker unlink and before the parent directory is synchronized. */
  readonly afterDirtyMarkerUnlink?: () => void | Promise<void>;
  /** Test-only wrapper that can fail before or after invoking the real lock release. */
  readonly releaseLock?: (release: () => Promise<void>) => Promise<void>;
}

/**
 * Checks one foreign error code without trusting its shape.
 *
 * @param error - Unknown caught value.
 * @param code - Exact code to compare.
 * @returns Whether the value carries the requested code.
 */
const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const compareEntries = (left: LibraryEntry, right: LibraryEntry): number =>
  compareUtf8(left.subject.displayName, right.subject.displayName) ||
  compareUtf8(left.subject.id, right.subject.id);

const assertCanonicalEntries = (entries: readonly LibraryEntry[]): void => {
  const subjects = new Set<SubjectId>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (subjects.has(entry.subject.id)) {
      throw new TypeError("Library entries contain a duplicate SubjectId.");
    }
    subjects.add(entry.subject.id);
    if (index > 0 && compareEntries(entries[index - 1]!, entry) >= 0) {
      throw new TypeError("Library entries are not in canonical sort order.");
    }
  }
};

const recordSchema: RuntimeSchema<LibraryProjectionRecord> = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Library projection record must be an object.");
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (keys.join(",") !== "checksum,entries,recordKind,schemaVersion") {
      throw new TypeError("Library projection record has unknown or missing fields.");
    }
    if (object.schemaVersion !== 1 || object.recordKind !== "library") {
      throw new TypeError("Library projection record kind or schema is unsupported.");
    }
    if (!Array.isArray(object.entries)) {
      throw new TypeError("Library projection entries must be an array.");
    }
    const entries = object.entries.map((entry) => libraryEntrySchema.parse(entry) as LibraryEntry);
    assertCanonicalEntries(entries);
    return {
      schemaVersion: 1,
      checksum: factChecksumSchema.parse(object.checksum),
      recordKind: "library",
      entries,
    };
  },
};

const normalizedFilters = (input: LibraryQuery): JsonObject => ({
  ...(input.text === undefined ? {} : { text: input.text }),
  ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
  ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  ...(input.hasPending === undefined ? {} : { hasPending: input.hasPending }),
  ...(input.hasSuspended === undefined ? {} : { hasSuspended: input.hasSuspended }),
});

const textMatches = (entry: LibraryEntry, text: string): boolean => {
  const needle = text.normalize("NFC").toLowerCase();
  const identityValues = entry.subject.identityHints.flatMap((hint): readonly string[] => {
    switch (hint.kind) {
      case "url":
      case "description":
        return [hint.value];
      case "account":
        return [hint.provider, hint.handle];
      case "external_id":
        return [hint.provider, hint.value];
      default: {
        const exhaustive: never = hint;
        return exhaustive;
      }
    }
  });
  return [
    entry.subject.displayName,
    ...entry.subject.aliases,
    entry.subject.space.displayName,
    ...identityValues,
    ...entry.searchTerms,
  ].some((value) => value.normalize("NFC").toLowerCase().includes(needle));
};

const matches = (entry: LibraryEntry, input: LibraryQuery): boolean =>
  (input.text === undefined || textMatches(entry, input.text)) &&
  (input.spaceId === undefined || entry.subject.space.id === input.spaceId) &&
  (input.lifecycle === undefined || entry.subject.lifecycle === input.lifecycle) &&
  (input.hasPending === undefined || (entry.pendingJobs === 1) === input.hasPending) &&
  (input.hasSuspended === undefined || (entry.suspendedVersions === 1) === input.hasSuspended);

const compareToCursor = (entry: LibraryEntry, sort: readonly string[]): number => {
  if (sort.length !== 2) {
    throw invalidInput("The Library cursor has an invalid sort tuple.", "cursor");
  }
  const [displayName, subjectId] = sort;
  if (displayName === undefined || subjectId === undefined) {
    throw invalidInput("The Library cursor has an invalid sort tuple.", "cursor");
  }
  if (displayName.length === 0 || Buffer.byteLength(displayName, "utf8") > WIRE_LIMITS.labelBytes) {
    throw invalidInput("The Library cursor has an invalid sort tuple.", "cursor");
  }
  let parsedSubjectId: SubjectId;
  try {
    parsedSubjectId = subjectIdSchema.parse(subjectId);
  } catch {
    throw invalidInput("The Library cursor has an invalid sort tuple.", "cursor");
  }
  return (
    compareUtf8(entry.subject.displayName, displayName) ||
    compareUtf8(entry.subject.id, parsedSubjectId)
  );
};

/** Durable checksum-protected JSON implementation of the package-internal Library projection. */
export class JsonLibraryProjection implements CoordinatedLibraryProjection {
  readonly #layout: Layout;
  readonly #clock: Clock;
  readonly #lock: FileLock;
  readonly #hooks: JsonLibraryProjectionHooks;
  readonly #writerReservations = new Map<
    SubjectId,
    {
      readonly lease: FileLockLease;
      readonly intentToken: string;
      readonly kind: LibraryWriterKind;
    }
  >();

  /**
   * Creates one projection at the canonical paths of a confined fact layout.
   *
   * @param layout - Trusted fact-root layout.
   * @param clock - Clock used for lock ownership and rebuild completion.
   * @param hooks - Optional deterministic crash hooks.
   */
  constructor(
    layout: Layout,
    clock: Clock = new SystemClock(),
    hooks: JsonLibraryProjectionHooks = {},
  ) {
    this.#layout = layout;
    this.#clock = clock;
    this.#hooks = hooks;
    this.#lock = new FileLock(layout.root, layout.libraryLock(), clock);
  }

  /**
   * Applies one exact fact-derived aggregate to an already available projection.
   *
   * @param entry - Complete verified aggregate to replace by SubjectId.
   * @returns Completion after a durable clean replacement.
   */
  async upsert(entry: LibraryEntry): Promise<void> {
    if ((await this.apply(entry.subject.id, () => Promise.resolve(entry))) === "dirty") {
      throw indexUnavailable("Library projection update left a durable dirty marker.");
    }
  }

  /**
   * Removes one subject aggregate from an already available projection.
   *
   * @param subjectId - Subject whose aggregate is removed.
   * @returns Completion after a durable clean replacement.
   */
  async remove(subjectId: SubjectId): Promise<void> {
    if ((await this.apply(subjectId, () => Promise.resolve(undefined))) === "dirty") {
      throw indexUnavailable("Library projection update left a durable dirty marker.");
    }
  }

  /**
   * Reserves the projection lock for one caller-held subject writer lock.
   *
   * The returned lease is released together with the subject lease after recovery
   * has applied the exact aggregate and marked its journal terminal.
   *
   * @param subjectId - Subject whose mutation owns the coordinated reservation.
   * @param kind - New mutation or prepared-journal recovery ownership.
   * @returns A Library lease held until the enclosing subject lease releases.
   */
  async reserveWriter(subjectId: SubjectId, kind: LibraryWriterKind): Promise<FileLockLease> {
    if (this.#writerReservations.has(subjectId)) {
      throw storageCorrupt("A subject already owns a Library writer reservation.");
    }
    const lease = await this.acquireLock();
    let intentToken: string;
    try {
      await this.prepareIndexDirectory();
      const previousIntent = await this.readIntentToken();
      if (previousIntent !== undefined && kind === "mutation") {
        throw new LibraryIntentPendingError(previousIntent);
      }
      intentToken = previousIntent ?? lease.ownerToken;
      if (previousIntent === undefined) await this.writeIntentMarker(intentToken);
    } catch (error) {
      try {
        await this.releaseLock(lease);
      } catch (releaseError) {
        throw this.asUnavailable(
          "Library writer reservation could not release its failed lock acquisition.",
          new AggregateError([error, releaseError]),
        );
      }
      throw error;
    }
    if (this.#writerReservations.has(subjectId)) {
      await this.releaseLock(lease);
      throw storageCorrupt("A subject acquired duplicate Library writer reservations.");
    }
    const reservation = {
      lease,
      intentToken,
      kind,
    };
    this.#writerReservations.set(subjectId, reservation);
    return {
      ownerToken: lease.ownerToken,
      heartbeat: () => lease.heartbeat(),
      release: async () => {
        if (this.#writerReservations.get(subjectId) !== reservation) {
          throw storageCorrupt("A Library writer reservation lost its local ownership.");
        }
        this.#writerReservations.delete(subjectId);
        await this.releaseLock(lease);
      },
    };
  }

  /**
   * Computes and publishes one post-commit aggregate under the projection lock.
   *
   * The dirty marker is durable before the supplier observes verified facts, so a
   * failed aggregate cannot expose a clean-but-stale record.
   *
   * @param subjectId - Subject whose exact aggregate is replaced or removed.
   * @param supplyEntry - Verified-fact supplier invoked under the projection lock.
   * @returns Completion after a durable clean replacement.
   */
  async apply(
    subjectId: SubjectId,
    supplyEntry: () => Promise<LibraryEntry | undefined>,
  ): Promise<LibraryApplyStatus> {
    return this.withAvailableLock(async () => {
      await this.prepareIndexDirectory();
      if ((await this.markerState()) === "dirty") return "dirty";
      let record: LibraryProjectionRecord;
      try {
        record = await this.readRecord();
      } catch (error) {
        await this.writeDirtyMarker();
        void error;
        return "dirty";
      }
      await this.writeDirtyMarker();
      try {
        await this.#hooks.afterDirtyMarker?.();
        const supplied = await supplyEntry();
        if (supplied !== undefined && supplied.subject.id !== subjectId) {
          throw storageCorrupt("A Library apply supplier returned a different subject.");
        }
        const entries = record.entries.filter((entry) => entry.subject.id !== subjectId);
        if (supplied !== undefined) entries.push(supplied);
        entries.sort(compareEntries);
        assertCanonicalEntries(entries);
        await this.writeRecord(entries);
        await this.#hooks.afterRecordReplaceSync?.();
        await this.clearDirtyMarker();
        return "clean";
      } catch (error) {
        try {
          if ((await this.markerState()) === "dirty") return "dirty";
        } catch (markerError) {
          throw this.asUnavailable(
            "Library projection update failed and its dirty marker cannot be verified.",
            new AggregateError([error, markerError]),
          );
        }
        throw this.asUnavailable(
          "Library projection update failed before a durable dirty marker remained.",
          error,
        );
      }
    }, subjectId);
  }

  /**
   * Queries only the validated disposable projection; it never scans fact stores.
   *
   * @param input - Typed filters, cursor, and page bound.
   * @returns The canonical filtered projection page.
   */
  async query(input: LibraryQuery): Promise<LibraryPage> {
    await this.#hooks.beforeQueryLock?.();
    return this.withAvailableLock(() => this.queryLocked(input));
  }

  /**
   * Rebuilds the complete record from verified entries collected only after lock acquisition.
   *
   * @param entries - Lazy verified-fact supplier started under the projection lock.
   * @returns Exact Library-phase counts and the injected-clock completion time.
   */
  async rebuild(entries: () => AsyncIterable<LibraryEntry>): Promise<RebuildResult> {
    return this.rebuildLocked(entries);
  }

  /**
   * Checks for a durable writer intent under the Library lock.
   *
   * The clean hot path uses this O(1) probe before deciding whether transaction
   * recovery is necessary.
   *
   * @returns Whether a fact writer may have crossed or be approaching its commit point.
   */
  async hasWriterIntent(): Promise<boolean> {
    let lease: FileLockLease;
    try {
      lease = await this.#lock.acquire();
    } catch (error) {
      if (hasCode(error, "busy")) return true;
      throw this.asUnavailable("Library writer intent could not be inspected.", error);
    }
    let present: boolean;
    try {
      present = (await this.readIntentToken()) !== undefined;
    } catch (error) {
      try {
        await this.releaseLock(lease);
      } catch (releaseError) {
        throw this.asUnavailable(
          "Library writer-intent inspection could not release its lock.",
          new AggregateError([error, releaseError]),
        );
      }
      throw error;
    }
    try {
      await this.releaseLock(lease);
    } catch (error) {
      throw this.asUnavailable(
        "Library writer-intent inspection could not release its lock.",
        error,
      );
    }
    return present;
  }

  /**
   * Clears a normal writer's intent only after its journal is durably terminal.
   *
   * Recovery reservations intentionally leave the inherited intent for the final
   * no-prepared-journal settlement proof.
   *
   * @param subjectId - Subject whose still-held reservation completed terminalization.
   */
  async completeWriter(subjectId: SubjectId): Promise<void> {
    await this.withAvailableLock(() => this.clearWriterIntent(subjectId), subjectId);
  }

  /**
   * Clears an abandoned intent only after reconciliation proves no prepared journal remains.
   *
   * @param hasPreparedJournal - Verified transaction-store predicate executed under the lock.
   * @returns Whether the intent was safely settled or recovery must continue.
   */
  async settleReconciledIntent(
    hasPreparedJournal: () => Promise<boolean>,
  ): Promise<"pending" | "settled"> {
    let lease: FileLockLease;
    try {
      lease = await this.#lock.acquire();
    } catch (error) {
      if (hasCode(error, "busy")) {
        throw new DistillyError({
          code: "busy",
          message: "A Library fact writer is still active.",
          retryable: true,
        });
      }
      throw this.asUnavailable("Library writer intent could not be settled.", error);
    }
    let result: "pending" | "settled";
    try {
      const intentToken = await this.readIntentToken();
      if (intentToken === undefined) {
        result = "settled";
      } else if (await hasPreparedJournal()) {
        result = "pending";
      } else {
        await this.clearIntentMarker(intentToken);
        result = "settled";
      }
    } catch (error) {
      try {
        await this.releaseLock(lease);
      } catch (releaseError) {
        throw this.asUnavailable(
          "Library intent settlement could not release its failed lock.",
          new AggregateError([error, releaseError]),
        );
      }
      throw error;
    }
    try {
      await this.releaseLock(lease);
    } catch (error) {
      throw this.asUnavailable("Library intent settlement could not release its lock.", error);
    }
    return result;
  }

  private rebuildLocked(entries: () => AsyncIterable<LibraryEntry>): Promise<RebuildResult> {
    return this.withAvailableLock(() => this.rebuildOperation(entries));
  }

  private async rebuildOperation(
    entries: () => AsyncIterable<LibraryEntry>,
  ): Promise<RebuildResult> {
    const intentToken = await this.readIntentToken();
    if (intentToken !== undefined) throw new LibraryIntentPendingError(intentToken);
    await this.prepareIndexDirectory();
    await this.writeDirtyMarker();
    try {
      await this.#hooks.afterDirtyMarker?.();
      const verifiedEntries = await this.collectEntries(entries());
      let rebuiltAt: IsoDateTime;
      try {
        rebuiltAt = isoDateTimeSchema.parse(this.#clock.now());
      } catch (error) {
        throw storageCorrupt("Library rebuild clock is invalid.", error);
      }
      await this.writeRecord(verifiedEntries);
      await this.#hooks.afterRecordReplaceSync?.();
      await this.clearDirtyMarker();
      return {
        subjects: verifiedEntries.length,
        jobs: verifiedEntries.reduce((count, entry) => count + entry.pendingJobs, 0),
        relations: 0,
        rebuiltAt,
      };
    } catch (error) {
      throw this.asUnavailable("Library projection rebuild failed.", error);
    }
  }

  private async queryLocked(input: LibraryQuery): Promise<LibraryPage> {
    const intentToken = await this.readIntentToken();
    if (intentToken !== undefined) throw new LibraryIntentPendingError(intentToken);
    await this.prepareIndexDirectory();
    await this.assertMarkerAbsent();
    let record: LibraryProjectionRecord;
    try {
      record = await this.readRecord();
    } catch (error) {
      throw this.asUnavailable("Library projection is unavailable.", error);
    }

    const filters = normalizedFilters(input);
    const after =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor, "library.list", filters);
    const filtered = record.entries.filter(
      (entry) =>
        matches(entry, input) && (after === undefined || compareToCursor(entry, after) > 0),
    );
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const items = filtered.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(filtered.length <= limit || last === undefined
        ? {}
        : {
            nextCursor: encodeCursor("library.list", filters, [
              last.subject.displayName,
              last.subject.id,
            ]),
          }),
    };
  }

  private async clearWriterIntent(subjectId: SubjectId): Promise<void> {
    const reservation = this.#writerReservations.get(subjectId);
    if (reservation === undefined) return;
    const current = await this.readIntentToken();
    if (current !== reservation.intentToken) {
      throw this.asUnavailable(
        "Library writer intent ownership changed during apply.",
        new Error("Intent owner mismatch."),
      );
    }
    if (reservation.kind === "mutation") {
      await this.clearIntentMarker(reservation.intentToken);
    }
  }

  private async collectEntries(
    entries: AsyncIterable<LibraryEntry>,
  ): Promise<readonly LibraryEntry[]> {
    const collected: LibraryEntry[] = [];
    const subjects = new Set<SubjectId>();
    for await (const entry of entries) {
      if (subjects.has(entry.subject.id)) {
        throw storageCorrupt("Verified Library rebuild entries contain a duplicate subject.");
      }
      subjects.add(entry.subject.id);
      collected.push(entry);
    }
    collected.sort(compareEntries);
    assertCanonicalEntries(collected);
    return collected;
  }

  private async readRecord(): Promise<LibraryProjectionRecord> {
    const record = await readFactFile(this.#layout.root, this.#layout.libraryFile(), recordSchema);
    const bytes = await readRegularFile(this.#layout.root, this.#layout.libraryFile());
    if (!bytes.equals(Buffer.from(`${canonicalJson(record)}\n`, "utf8"))) {
      throw storageCorrupt("Library projection record does not use canonical bytes.");
    }
    return record;
  }

  private async writeRecord(entries: readonly LibraryEntry[]): Promise<void> {
    const record = sealFact<LibraryProjectionRecord>({
      schemaVersion: 1,
      recordKind: "library",
      entries,
    });
    try {
      recordSchema.parse(record);
      await atomicReplaceFile(
        this.#layout.root,
        this.#layout.libraryFile(),
        `${canonicalJson(record)}\n`,
      );
    } catch (error) {
      throw this.asUnavailable("Library projection record could not be replaced durably.", error);
    }
  }

  private async withAvailableLock<T>(
    operation: () => Promise<T>,
    reservedSubjectId?: SubjectId,
  ): Promise<T> {
    if (reservedSubjectId !== undefined && this.#writerReservations.has(reservedSubjectId)) {
      return operation();
    }
    let lease: FileLockLease;
    try {
      lease = await this.acquireLock();
    } catch (error) {
      throw this.asUnavailable("Library projection lock is unavailable.", error);
    }
    let result: T;
    try {
      result = await operation();
    } catch (operationError) {
      try {
        await this.releaseLock(lease);
      } catch (releaseError) {
        throw this.asUnavailable(
          "Library projection lock could not be released after a failed operation.",
          new AggregateError([operationError, releaseError]),
        );
      }
      throw operationError;
    }
    try {
      await this.releaseLock(lease);
    } catch (error) {
      throw this.asUnavailable("Library projection lock could not be released safely.", error);
    }
    return result;
  }

  private releaseLock(lease: FileLockLease): Promise<void> {
    const release = () => lease.release();
    return this.#hooks.releaseLock?.(release) ?? release();
  }

  private async acquireLock(): Promise<FileLockLease> {
    while (true) {
      try {
        return await this.#lock.acquire();
      } catch (error) {
        if (!hasCode(error, "busy")) throw error;
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async prepareIndexDirectory(): Promise<void> {
    try {
      await assertNoSymlinkPath(this.#layout.root, this.#layout.indexDirectory());
      await ensurePrivateDirectory(this.#layout.indexDirectory());
      await assertNoSymlinkPath(this.#layout.root, this.#layout.indexDirectory());
    } catch (error) {
      throw this.asUnavailable("Library projection directory is unavailable.", error);
    }
  }

  private async assertMarkerAbsent(): Promise<void> {
    if ((await this.markerState()) === "dirty") {
      throw indexUnavailable("Library projection is marked dirty.");
    }
  }

  private async readIntentToken(): Promise<string | undefined> {
    let status;
    try {
      status = await lstat(this.#layout.libraryIntentFile());
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw this.asUnavailable("Library writer intent cannot be inspected.", error);
    }
    if (status.isSymbolicLink() || !status.isFile()) {
      throw indexUnavailable("Library writer intent is not a regular file.");
    }
    let data: Buffer;
    try {
      data = await readRegularFile(
        this.#layout.root,
        this.#layout.libraryIntentFile(),
        MARKER_MAXIMUM_BYTES,
      );
    } catch (error) {
      throw this.asUnavailable("Library writer intent cannot be read.", error);
    }
    const match = INTENT_PATTERN.exec(data.toString("utf8"));
    if (match === null) throw indexUnavailable("Library writer intent is malformed.");
    return match[1]!;
  }

  private async writeIntentMarker(ownerToken: string): Promise<void> {
    const bytes = `${INTENT_PREFIX}${ownerToken}\n`;
    if (!INTENT_PATTERN.test(bytes)) {
      throw storageCorrupt("Library writer lock produced an invalid owner token.");
    }
    try {
      await atomicReplaceFile(this.#layout.root, this.#layout.libraryIntentFile(), bytes);
    } catch (error) {
      throw this.asUnavailable("Library writer intent could not be made durable.", error);
    }
    await this.#hooks.afterIntentMarker?.();
  }

  private async clearIntentMarker(expectedToken: string): Promise<void> {
    const current = await this.readIntentToken();
    if (current !== expectedToken) {
      throw indexUnavailable("Library writer intent changed before clearing.");
    }
    const bytes = `${INTENT_PREFIX}${expectedToken}\n`;
    let unlinked = false;
    try {
      await unlink(this.#layout.libraryIntentFile());
      unlinked = true;
      await this.#hooks.afterIntentMarkerUnlink?.();
      await syncDirectory(this.#layout.indexDirectory());
    } catch (error) {
      if (unlinked) {
        await atomicReplaceFile(this.#layout.root, this.#layout.libraryIntentFile(), bytes).catch(
          () => undefined,
        );
      }
      throw this.asUnavailable("Library writer intent could not be cleared durably.", error);
    }
  }

  private async markerState(): Promise<"absent" | "dirty"> {
    let status;
    try {
      status = await lstat(this.#layout.libraryDirtyFile());
    } catch (error) {
      if (isMissing(error)) return "absent";
      throw this.asUnavailable("Library projection dirty marker cannot be inspected.", error);
    }
    if (status.isSymbolicLink() || !status.isFile()) {
      throw indexUnavailable("Library projection dirty marker is not a regular file.");
    }
    let data: Buffer;
    try {
      data = await readRegularFile(
        this.#layout.root,
        this.#layout.libraryDirtyFile(),
        MARKER_MAXIMUM_BYTES,
      );
    } catch (error) {
      throw this.asUnavailable("Library projection dirty marker cannot be read.", error);
    }
    if (!data.equals(Buffer.from(DIRTY_BYTES))) {
      throw indexUnavailable("Library projection dirty marker is malformed.");
    }
    return "dirty";
  }

  private async writeDirtyMarker(): Promise<void> {
    try {
      await atomicReplaceFile(this.#layout.root, this.#layout.libraryDirtyFile(), DIRTY_BYTES);
    } catch (error) {
      throw this.asUnavailable("Library projection dirty marker could not be made durable.", error);
    }
  }

  private async clearDirtyMarker(): Promise<void> {
    let data: Buffer;
    try {
      data = await readRegularFile(
        this.#layout.root,
        this.#layout.libraryDirtyFile(),
        MARKER_MAXIMUM_BYTES,
      );
    } catch (error) {
      throw this.asUnavailable(
        "Library projection dirty marker disappeared before clearing.",
        error,
      );
    }
    if (!data.equals(Buffer.from(DIRTY_BYTES))) {
      throw indexUnavailable("Library projection dirty marker changed before clearing.");
    }

    let unlinked = false;
    try {
      await unlink(this.#layout.libraryDirtyFile());
      unlinked = true;
      await this.#hooks.afterDirtyMarkerUnlink?.();
      await syncDirectory(this.#layout.indexDirectory());
    } catch (error) {
      if (unlinked) {
        await atomicReplaceFile(
          this.#layout.root,
          this.#layout.libraryDirtyFile(),
          DIRTY_BYTES,
        ).catch(() => undefined);
      }
      throw this.asUnavailable(
        "Library projection dirty marker could not be cleared durably.",
        error,
      );
    }
  }

  private asUnavailable(message: string, error: unknown): Error {
    if (error instanceof DistillyError && error.code === "index_unavailable") return error;
    return indexUnavailable(message, error);
  }
}

export { DIRTY_BYTES as LIBRARY_DIRTY_BYTES };
