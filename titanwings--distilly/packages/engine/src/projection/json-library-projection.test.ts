import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  factChecksumSchema,
  isoDateTimeSchema,
  jobIdSchema,
  materialSetHashSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type { IsoDateTime, LibraryEntry, QualitySummary, SubjectSummary } from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { sealFact, verifyFactChecksum } from "../facts/checksum.js";
import { Layout } from "../layout.js";
import { encodeCursor } from "../read/cursor.js";
import {
  JsonLibraryProjection,
  LIBRARY_DIRTY_BYTES,
  type JsonLibraryProjectionHooks,
} from "./json-library-projection.js";
import type { LibraryProjectionRecord } from "./library-projection.js";

const NOW = isoDateTimeSchema.parse("2026-08-21T12:00:00.000Z");
const roots: string[] = [];

const QUALITY: QualitySummary = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 1,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 1,
  diversityEligibleSourceGroupCount: 1,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: ["identity"],
  uncoveredCoreFacets: ["voice", "psyche", "relations", "boundaries", "texture", "timeline"],
  maturity: "stable",
};

class FixedClock implements Clock {
  now(): IsoDateTime {
    return NOW;
  }
}

const hexadecimal = (value: number, width: number): string =>
  value.toString(16).padStart(width, "0");

const makeEntry = (
  index: number,
  displayName: string,
  options: {
    readonly pending?: boolean;
    readonly suspended?: boolean;
    readonly lifecycle?: SubjectSummary["lifecycle"];
    readonly space?: number;
    readonly aliases?: readonly string[];
    readonly privacy?: LibraryEntry["privacy"];
  } = {},
): LibraryEntry => {
  const subjectId = subjectIdSchema.parse(`subject_${hexadecimal(index, 32)}`);
  const currentVersionId = versionIdSchema.parse(`version_${hexadecimal(index + 100, 64)}`);
  const suspendedVersionId = versionIdSchema.parse(`version_${hexadecimal(index + 200, 64)}`);
  const subject: SubjectSummary = {
    id: subjectId,
    displayName,
    aliases: options.aliases ?? [],
    identityHints: [{ kind: "description", value: `Biography ${index}` }],
    space: {
      id: spaceIdSchema.parse(`space_${hexadecimal(options.space ?? 1, 32)}`),
      displayName: options.space === 2 ? "Fiction" : "People",
      kind: options.space === 2 ? "fictional" : "people",
    },
    lifecycle: options.lifecycle ?? "active",
    currentVersionId,
  };
  return {
    subject,
    status: {
      subject,
      generation: index,
      materialSetHash: materialSetHashSchema.parse(`set_sha256_${hexadecimal(index, 64)}`),
      ...(options.pending
        ? { pendingJobId: jobIdSchema.parse(`job_${hexadecimal(index, 32)}`) }
        : {}),
      ...(options.suspended ? { suspendedVersionId } : {}),
      maturity: QUALITY.maturity,
    },
    privacy: options.privacy ?? "shareable",
    searchTerms: [
      options.lifecycle ?? "active",
      ...(options.pending ? ["pending"] : []),
      options.privacy ?? "shareable",
      QUALITY.maturity,
      ...(options.suspended ? ["suspended"] : []),
    ].sort(),
    currentQuality: QUALITY,
    ...(options.suspended ? { suspendedQuality: QUALITY } : {}),
    pendingJobs: options.pending ? 1 : 0,
    suspendedVersions: options.suspended ? 1 : 0,
    newMaterialCount: options.pending ? index : 0,
    lastChangedAt: isoDateTimeSchema.parse(
      new Date(Date.UTC(2026, 7, 21, 0, 0, index)).toISOString(),
    ),
  };
};

const asEntries = (entries: readonly LibraryEntry[]): AsyncIterable<LibraryEntry> => ({
  [Symbol.asyncIterator]() {
    const iterator = entries[Symbol.iterator]();
    return { next: () => Promise.resolve(iterator.next()) };
  },
});

const createProjection = async (
  hooks: JsonLibraryProjectionHooks = {},
): Promise<{ readonly layout: Layout; readonly projection: JsonLibraryProjection }> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-library-projection-"));
  roots.push(root);
  const layout = new Layout(root);
  return {
    layout,
    projection: new JsonLibraryProjection(layout, new FixedClock(), hooks),
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JSON Library projection", { timeout: 30_000 }, () => {
  it("writes one canonical checksum record and returns exact rebuild aggregates", async () => {
    const { layout, projection } = await createProjection();
    const entries = [
      makeEntry(3, "Zoe", { suspended: true }),
      makeEntry(1, "Ada", { pending: true, aliases: ["Countess"] }),
      makeEntry(2, "Ada", { space: 2, lifecycle: "archived", privacy: "private" }),
    ];

    await expect(projection.rebuild(() => asEntries(entries))).resolves.toEqual({
      subjects: 3,
      jobs: 1,
      relations: 0,
      rebuiltAt: NOW,
    });

    const bytes = await readFile(layout.libraryFile());
    const record = JSON.parse(bytes.toString("utf8")) as LibraryProjectionRecord;
    verifyFactChecksum(record);
    expect(record).toMatchObject({ schemaVersion: 1, recordKind: "library" });
    expect(record.entries.map((entry) => entry.subject.id)).toEqual(
      [entries[0]!.subject.id, entries[1]!.subject.id, entries[2]!.subject.id].sort(
        (left, right) => {
          const leftEntry = entries.find((entry) => entry.subject.id === left)!;
          const rightEntry = entries.find((entry) => entry.subject.id === right)!;
          return (
            Buffer.compare(
              Buffer.from(leftEntry.subject.displayName),
              Buffer.from(rightEntry.subject.displayName),
            ) || Buffer.compare(Buffer.from(left), Buffer.from(right))
          );
        },
      ),
    );
    expect(bytes.toString("utf8")).toBe(`${canonicalJson(record)}\n`);
    expect(await exists(layout.libraryDirtyFile())).toBe(false);

    const reopened = new JsonLibraryProjection(layout, new FixedClock());
    const first = await reopened.query({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error("Expected the first Library page to have a cursor.");
    const rest = await reopened.query({ cursor, limit: 2 });
    expect([...first.items, ...rest.items]).toEqual(record.entries);
    const aliasMatch = await reopened.query({ text: "countess" });
    expect(aliasMatch.items.map((entry) => entry.subject.displayName)).toEqual(["Ada"]);
    for (const [text, expected] of [
      ["archived", [entries[2]!.subject.id]],
      ["private", [entries[2]!.subject.id]],
      ["pending", [entries[1]!.subject.id]],
      ["suspended", [entries[0]!.subject.id]],
      ["stable", record.entries.map((entry) => entry.subject.id)],
    ] as const) {
      await expect(reopened.query({ text })).resolves.toMatchObject({
        items: expected.map((subjectId) => ({ subject: { id: subjectId } })),
      });
    }
    await expect(reopened.query({ text: "private", hasPending: true })).resolves.toEqual({
      items: [],
    });
    await expect(
      reopened.query({ spaceId: entries[2]!.subject.space.id, lifecycle: "archived" }),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ privacy: "private" })] });
    await expect(reopened.query({ hasPending: true })).resolves.toMatchObject({
      items: [expect.objectContaining({ pendingJobs: 1 })],
    });
    await expect(reopened.query({ hasSuspended: true })).resolves.toMatchObject({
      items: [expect.objectContaining({ suspendedVersions: 1 })],
    });
    await expect(reopened.query({ cursor, hasPending: true })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("fails closed for missing, dirty, malformed, noncanonical, corrupt, duplicate, and symlink state", async () => {
    const { layout, projection } = await createProjection();
    const entry = makeEntry(1, "Ada");
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });

    await projection.rebuild(() => asEntries([entry]));
    await writeFile(layout.libraryDirtyFile(), LIBRARY_DIRTY_BYTES, { mode: 0o600 });
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });
    await writeFile(layout.libraryDirtyFile(), "wrong\n", { mode: 0o600 });
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });
    await unlink(layout.libraryDirtyFile());

    await writeFile(layout.libraryIntentFile(), "wrong\n", { mode: 0o600 });
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });
    await unlink(layout.libraryIntentFile());
    const outsideIntent = join(layout.root, "outside-intent");
    await writeFile(outsideIntent, `distilly-library-intent-v1 ${"0".repeat(32)}\n`, {
      mode: 0o600,
    });
    await symlink(outsideIntent, layout.libraryIntentFile());
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });
    await unlink(layout.libraryIntentFile());

    const canonical = JSON.parse(
      await readFile(layout.libraryFile(), "utf8"),
    ) as LibraryProjectionRecord;
    await writeFile(layout.libraryFile(), `${JSON.stringify(canonical, null, 2)}\n`, {
      mode: 0o600,
    });
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });
    await writeFile(layout.libraryFile(), "{\n", { mode: 0o600 });
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });

    await projection.rebuild(() => asEntries([entry]));
    const corrupt = {
      ...canonical,
      checksum: factChecksumSchema.parse(`fact_sha256_${"0".repeat(64)}`),
    };
    await writeFile(layout.libraryFile(), `${canonicalJson(corrupt)}\n`, { mode: 0o600 });
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });

    const duplicate = sealFact<LibraryProjectionRecord>({
      schemaVersion: 1,
      recordKind: "library",
      entries: [entry, entry],
    });
    await writeFile(layout.libraryFile(), `${canonicalJson(duplicate)}\n`, { mode: 0o600 });
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });

    await unlink(layout.libraryFile());
    const outside = join(layout.root, "outside.json");
    await writeFile(outside, `${canonicalJson(canonical)}\n`, { mode: 0o600 });
    await symlink(outside, layout.libraryFile());
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });
  });

  it("uses the shared 50/200 page bounds and returns a cursor only when more entries exist", async () => {
    const { projection } = await createProjection();
    const entries = Array.from({ length: 201 }, (_, index) =>
      makeEntry(index + 1, `Person ${index.toString().padStart(3, "0")}`),
    );
    await projection.rebuild(() => asEntries(entries.toReversed()));

    const defaultPage = await projection.query({});
    expect(defaultPage.items).toHaveLength(50);
    expect(defaultPage.nextCursor).toBeDefined();
    const maximumPage = await projection.query({ limit: 200 });
    expect(maximumPage.items).toHaveLength(200);
    expect(maximumPage.nextCursor).toBeDefined();
    const cursor = maximumPage.nextCursor;
    if (cursor === undefined) throw new Error("Expected a cursor before the final Library item.");
    await expect(projection.query({ limit: 200, cursor })).resolves.toMatchObject({
      items: [{ subject: { id: entries[200]!.subject.id } }],
    });
    await expect(
      projection.query({
        cursor: encodeCursor("library.list", {}, ["Ada", "not-a-subject"]),
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "cursor" });
    await expect(
      projection.query({
        cursor: encodeCursor("library.list", {}, [
          "x".repeat(1_025),
          makeEntry(1, "Ada").subject.id,
        ]),
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "cursor" });
  });

  it("applies idempotent upserts and exact SubjectId removals", async () => {
    const { layout, projection } = await createProjection();
    const first = makeEntry(1, "Zoe");
    const second = makeEntry(2, "Ada");
    await projection.rebuild(() => asEntries([first, second]));

    await projection.remove(first.subject.id);
    await projection.remove(first.subject.id);
    await expect(projection.query({})).resolves.toEqual({ items: [second] });

    const renamed = makeEntry(1, "Aaron", { pending: true });
    await projection.upsert(renamed);
    await projection.upsert(renamed);
    await expect(projection.query({})).resolves.toEqual({ items: [renamed, second] });
    expect(await exists(layout.libraryDirtyFile())).toBe(false);
  });

  it("reuses a subject writer reservation for apply and keeps queries behind it", async () => {
    const { layout, projection } = await createProjection();
    const oldEntry = makeEntry(1, "Ada");
    const newEntry = makeEntry(1, "Ada Updated", { pending: true });
    await projection.rebuild(() => asEntries([oldEntry]));
    await expect(projection.hasWriterIntent()).resolves.toBe(false);

    const reservation = await projection.reserveWriter(oldEntry.subject.id, "mutation");
    await expect(projection.hasWriterIntent()).resolves.toBe(true);
    await expect(
      projection.settleReconciledIntent(() => Promise.resolve(false)),
    ).rejects.toMatchObject({ code: "busy", retryable: true });
    await expect(readFile(layout.libraryIntentFile(), "utf8")).resolves.toMatch(
      /^distilly-library-intent-v1 [0-9a-f]{32}\n$/u,
    );
    let querySettled = false;
    const querying = projection.query({}).then((page) => {
      querySettled = true;
      return page;
    });
    await delay(50);
    expect(querySettled).toBe(false);
    await expect(
      projection.apply(oldEntry.subject.id, () => Promise.resolve(newEntry)),
    ).resolves.toBe("clean");
    expect(await exists(layout.libraryIntentFile())).toBe(true);
    expect(querySettled).toBe(false);
    await projection.completeWriter(oldEntry.subject.id);
    expect(await exists(layout.libraryIntentFile())).toBe(false);

    await reservation.release();
    await expect(querying).resolves.toEqual({ items: [newEntry] });
    await expect(projection.hasWriterIntent()).resolves.toBe(false);
  });

  it("keeps an abandoned writer intent until recovery finishes every prepared journal", async () => {
    const { layout, projection } = await createProjection();
    const oldEntry = makeEntry(1, "Ada");
    const newEntry = makeEntry(1, "Ada Recovered", { pending: true });
    await projection.rebuild(() => asEntries([oldEntry]));

    const abandoned = await projection.reserveWriter(oldEntry.subject.id, "mutation");
    const intentBytes = await readFile(layout.libraryIntentFile(), "utf8");
    await abandoned.release();

    await expect(projection.reserveWriter(oldEntry.subject.id, "mutation")).rejects.toMatchObject({
      code: "busy",
      retryable: true,
    });
    await expect(readFile(layout.libraryIntentFile(), "utf8")).resolves.toBe(intentBytes);

    const recovery = await projection.reserveWriter(oldEntry.subject.id, "recovery");
    await expect(
      projection.apply(oldEntry.subject.id, () => Promise.resolve(newEntry)),
    ).resolves.toBe("clean");
    await projection.completeWriter(oldEntry.subject.id);
    await recovery.release();
    await expect(readFile(layout.libraryIntentFile(), "utf8")).resolves.toBe(intentBytes);

    await expect(projection.settleReconciledIntent(() => Promise.resolve(true))).resolves.toBe(
      "pending",
    );
    await expect(readFile(layout.libraryIntentFile(), "utf8")).resolves.toBe(intentBytes);
    await expect(projection.settleReconciledIntent(() => Promise.resolve(false))).resolves.toBe(
      "settled",
    );
    expect(await exists(layout.libraryIntentFile())).toBe(false);
    await expect(projection.query({})).resolves.toEqual({ items: [newEntry] });
  });

  it("leaves a durable intent when a writer crashes immediately after reserving Library", async () => {
    const { layout, projection: initial } = await createProjection();
    const entry = makeEntry(1, "Ada");
    await initial.rebuild(() => asEntries([entry]));
    const crashing = new JsonLibraryProjection(layout, new FixedClock(), {
      afterIntentMarker() {
        throw new Error("crash after durable intent");
      },
    });

    await expect(crashing.reserveWriter(entry.subject.id, "mutation")).rejects.toThrow(
      "crash after durable intent",
    );
    await expect(readFile(layout.libraryIntentFile(), "utf8")).resolves.toMatch(
      /^distilly-library-intent-v1 [0-9a-f]{32}\n$/u,
    );
    await expect(initial.query({})).rejects.toMatchObject({ code: "busy", retryable: true });
    const clearingCrash = new JsonLibraryProjection(layout, new FixedClock(), {
      afterIntentMarkerUnlink() {
        throw new Error("crash before intent parent sync");
      },
    });
    await expect(
      clearingCrash.settleReconciledIntent(() => Promise.resolve(false)),
    ).rejects.toMatchObject({ code: "index_unavailable" });
    await expect(readFile(layout.libraryIntentFile(), "utf8")).resolves.toMatch(
      /^distilly-library-intent-v1 [0-9a-f]{32}\n$/u,
    );
    await expect(initial.settleReconciledIntent(() => Promise.resolve(false))).resolves.toBe(
      "settled",
    );
    await expect(initial.query({})).resolves.toEqual({ items: [entry] });
  });

  it("retains an exact dirty marker at every injected incremental crash point", async () => {
    for (const hookName of [
      "afterDirtyMarker",
      "afterRecordReplaceSync",
      "afterDirtyMarkerUnlink",
    ] as const) {
      const { layout, projection: initial } = await createProjection();
      const oldEntry = makeEntry(1, "Ada");
      const newEntry = makeEntry(1, "Ada Lovelace", { pending: true });
      await initial.rebuild(() => asEntries([oldEntry]));
      const crashing = new JsonLibraryProjection(layout, new FixedClock(), {
        [hookName]: () => {
          throw new Error(`crash at ${hookName}`);
        },
      });

      await expect(crashing.upsert(newEntry)).rejects.toMatchObject({
        code: "index_unavailable",
      });
      await expect(readFile(layout.libraryDirtyFile(), "utf8")).resolves.toBe(LIBRARY_DIRTY_BYTES);
      await expect(
        new JsonLibraryProjection(layout, new FixedClock()).query({}),
      ).rejects.toMatchObject({ code: "index_unavailable" });
    }
  });

  it("distinguishes a durable dirty apply from a failure before marker creation", async () => {
    const { layout, projection: initial } = await createProjection();
    const oldEntry = makeEntry(1, "Ada");
    const newEntry = makeEntry(1, "Ada Updated", { pending: true });
    await initial.rebuild(() => asEntries([oldEntry]));

    const afterMarker = new JsonLibraryProjection(layout, new FixedClock(), {
      afterDirtyMarker() {
        throw new Error("crash after durable marker");
      },
    });
    await expect(
      afterMarker.apply(newEntry.subject.id, () => Promise.resolve(newEntry)),
    ).resolves.toBe("dirty");
    await expect(readFile(layout.libraryDirtyFile(), "utf8")).resolves.toBe(LIBRARY_DIRTY_BYTES);

    await initial.rebuild(() => asEntries([oldEntry]));
    await mkdir(join(layout.root, "unsafe-apply-lock"));
    await symlink(join(layout.root, "unsafe-apply-lock"), layout.libraryLock());
    const beforeMarker = new JsonLibraryProjection(layout, new FixedClock());
    await expect(
      beforeMarker.apply(newEntry.subject.id, () => Promise.resolve(newEntry)),
    ).rejects.toMatchObject({ code: "index_unavailable" });
    expect(await exists(layout.libraryDirtyFile())).toBe(false);
  });

  it("marks missing-record apply and failed rebuild suppliers dirty before returning", async () => {
    const { layout, projection } = await createProjection();
    await expect(projection.upsert(makeEntry(1, "Ada"))).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(readFile(layout.libraryDirtyFile(), "utf8")).resolves.toBe(LIBRARY_DIRTY_BYTES);

    await projection.rebuild(() => asEntries([makeEntry(1, "Ada")]));
    await expect(
      projection.rebuild(() => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(new Error("verified seed collection failed")),
          };
        },
      })),
    ).rejects.toMatchObject({ code: "index_unavailable" });
    await expect(readFile(layout.libraryDirtyFile(), "utf8")).resolves.toBe(LIBRARY_DIRTY_BYTES);
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });
  });

  it("starts rebuild seed collection under the lock and lets a waiting writer win after replace", async () => {
    const { layout, projection: initial } = await createProjection();
    const oldEntry = makeEntry(1, "Ada");
    const newEntry = makeEntry(1, "Ada Updated", { pending: true });
    await initial.rebuild(() => asEntries([oldEntry]));

    let releaseRebuild: (() => void) | undefined;
    let enterRebuild: (() => void) | undefined;
    const rebuildEntered = new Promise<void>((resolve) => {
      enterRebuild = resolve;
    });
    const rebuildMayContinue = new Promise<void>((resolve) => {
      releaseRebuild = resolve;
    });
    let markerCount = 0;
    const projection = new JsonLibraryProjection(layout, new FixedClock(), {
      async afterDirtyMarker() {
        markerCount += 1;
        if (markerCount === 1) {
          enterRebuild?.();
          await rebuildMayContinue;
        }
      },
    });
    let supplierCalled = false;
    const rebuilding = projection.rebuild(() => {
      supplierCalled = true;
      return asEntries([oldEntry]);
    });
    await rebuildEntered;
    expect(supplierCalled).toBe(false);

    let writerSettled = false;
    const writing = projection.upsert(newEntry).then(() => {
      writerSettled = true;
    });
    await delay(50);
    expect(writerSettled).toBe(false);
    releaseRebuild?.();
    await Promise.all([rebuilding, writing]);

    expect(supplierCalled).toBe(true);
    const final = await projection.query({});
    expect(final.items.map((entry) => entry.subject.displayName)).toEqual(["Ada Updated"]);
  });

  it("fails closed when the lock path itself is a symlink", async () => {
    const { layout, projection } = await createProjection();
    await projection.rebuild(() => asEntries([makeEntry(1, "Ada")]));
    await mkdir(join(layout.root, "unsafe-lock"));
    await symlink(join(layout.root, "unsafe-lock"), layout.libraryLock());
    await expect(projection.query({})).rejects.toMatchObject({ code: "index_unavailable" });
  });

  it("surfaces release failure as index_unavailable even when the operation also fails", async () => {
    const { layout, projection } = await createProjection();
    await projection.rebuild(() => asEntries([makeEntry(1, "Ada")]));
    const releaseFailing = new JsonLibraryProjection(layout, new FixedClock(), {
      async releaseLock(release) {
        await release();
        throw new Error("simulated ambiguous release failure");
      },
    });

    await expect(releaseFailing.query({ cursor: "invalid" })).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(releaseFailing.query({})).rejects.toMatchObject({
      code: "index_unavailable",
    });
  });
});
