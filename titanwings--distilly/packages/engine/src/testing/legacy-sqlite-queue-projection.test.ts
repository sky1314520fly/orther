import { DatabaseSync } from "node:sqlite";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  briefContractDigestSchema,
  factChecksumSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialSetHashSchema,
  subjectIdSchema,
  versionIdSchema,
  type PendingJobMarker,
  type PendingLeaseMarker,
  type SubjectId,
} from "@distilly/protocol";

import {
  SqliteQueueRepository,
  type SqliteQueueRepositoryHooks,
  type SqliteQueueRepositoryPaths,
} from "./legacy-sqlite-queue-projection.test.fixture.js";
import type { VerifiedQueueStateSeed } from "./legacy-queue-repository.test.fixture.js";

const DIRTY_BYTES = '{"projection":"queue","schemaVersion":2}\n';
const NOW = isoDateTimeSchema.parse("2026-08-20T00:10:00.000Z");
const roots: string[] = [];

type SeedWithPending = VerifiedQueueStateSeed & { readonly pending: PendingJobMarker };

interface QueueRow {
  readonly subject_id: string;
  readonly state_checksum: string;
  readonly job_id: string;
  readonly generation: number;
  readonly base_version_id: string | null;
  readonly material_set_hash: string;
  readonly added_material_count: number;
  readonly total_material_count: number;
  readonly queued_at: string;
  readonly lease_id: string | null;
  readonly lease_owner: string | null;
  readonly lease_acquired_at: string | null;
  readonly lease_expires_at: string | null;
  readonly brief_contract_digest: string | null;
  readonly source_grouping_version: string | null;
  readonly prompt_version: string | null;
  readonly draft_schema_version: number | null;
  readonly attempt: number;
  readonly failure_code: string | null;
  readonly failure_retryable: number | null;
  readonly failure_remediation: string | null;
  readonly last_sequence: number;
}

const makePaths = async (): Promise<SqliteQueueRepositoryPaths> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-queue-projection-"));
  roots.push(root);
  const indexDirectory = join(root, ".index");
  return {
    root,
    indexDirectory,
    databaseFile: join(indexDirectory, "queue.db"),
    dirtyFile: join(indexDirectory, "queue.dirty"),
  };
};

const subject = (digit: string): SubjectId => subjectIdSchema.parse(`subject_${digit.repeat(32)}`);

const pending = (
  digit: string,
  generation: number,
  options: { readonly base?: string; readonly added?: number; readonly total?: number } = {},
): PendingJobMarker => ({
  jobId: jobIdSchema.parse(`job_${digit.repeat(32)}`),
  generation,
  ...(options.base === undefined
    ? {}
    : { baseVersionId: versionIdSchema.parse(`version_${options.base.repeat(64)}`) }),
  materialSetHash: materialSetHashSchema.parse(`set_sha256_${digit.repeat(64)}`),
  addedMaterialCount: options.added ?? 1,
  totalMaterialCount: options.total ?? generation + 1,
  queuedAt: `2026-08-20T00:00:0${generation}.000Z` as PendingJobMarker["queuedAt"],
});

const lease = (digit: string, expiresAt = "2026-08-20T00:30:00.000Z"): PendingLeaseMarker => ({
  id: leaseIdSchema.parse(`lease_${digit.repeat(32)}`),
  owner: leaseOwnerIdSchema.parse(`lease_owner_${digit.repeat(32)}`),
  acquiredAt: isoDateTimeSchema.parse("2026-08-20T00:00:00.000Z"),
  expiresAt: isoDateTimeSchema.parse(expiresAt),
  contract: {
    digest: briefContractDigestSchema.parse(`brief_contract_${digit.repeat(64)}`),
    sourceGroupingVersion: "source-groups-v1",
    promptVersion: `host-distill-v1-sha256_${digit.repeat(64)}`,
    draftSchemaVersion: 1,
  },
});

const stateChecksum = (digit: string) =>
  factChecksumSchema.parse(`fact_sha256_${digit.repeat(64)}`);

const hexadecimal = (value: number, width: number): string =>
  value.toString(16).padStart(width, "0");

const indexedSeed = (index: number): SeedWithPending => ({
  subjectId: subjectIdSchema.parse(`subject_${hexadecimal(1_000 - index, 32)}`),
  stateChecksum: factChecksumSchema.parse(`fact_sha256_${hexadecimal(index + 1, 64)}`),
  pending: {
    jobId: jobIdSchema.parse(`job_${hexadecimal(index, 32)}`),
    generation: 1,
    materialSetHash: materialSetHashSchema.parse(`set_sha256_${hexadecimal(index + 1, 64)}`),
    addedMaterialCount: 1,
    totalMaterialCount: 1,
    queuedAt: isoDateTimeSchema.parse("2026-08-20T00:00:00.000Z"),
  },
});

function queueSeed(
  subjectId: SubjectId,
  marker: PendingJobMarker,
  checksumDigit?: string,
): SeedWithPending;
function queueSeed(
  subjectId: SubjectId,
  marker?: undefined,
  checksumDigit?: string,
): VerifiedQueueStateSeed;
function queueSeed(
  subjectId: SubjectId,
  marker?: PendingJobMarker,
  checksumDigit = "c",
): VerifiedQueueStateSeed {
  return {
    subjectId,
    stateChecksum: stateChecksum(checksumDigit),
    ...(marker === undefined ? {} : { pending: marker }),
  };
}

const asAsyncSeeds = (
  seeds: readonly VerifiedQueueStateSeed[],
): AsyncIterable<VerifiedQueueStateSeed> => ({
  [Symbol.asyncIterator]() {
    const iterator = seeds[Symbol.iterator]();
    return { next: () => Promise.resolve(iterator.next()) };
  },
});

const rebuild = (repository: SqliteQueueRepository, seeds: readonly VerifiedQueueStateSeed[]) =>
  repository.rebuild(() => asAsyncSeeds(seeds), NOW);

const readRows = (databaseFile: string): readonly QueueRow[] => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT
          subject_id,
          state_checksum,
          job_id,
          generation,
          base_version_id,
          material_set_hash,
          added_material_count,
          total_material_count,
          queued_at,
          lease_id,
          lease_owner,
          lease_acquired_at,
          lease_expires_at,
          brief_contract_digest,
          source_grouping_version,
          prompt_version,
          draft_schema_version,
          attempt,
          failure_code,
          failure_retryable,
          failure_remediation,
          last_sequence
        FROM queue_jobs
        ORDER BY subject_id`,
      )
      .all() as unknown as readonly QueueRow[];
  } finally {
    database.close();
  }
};

const readScalar = (databaseFile: string, sql: string): Record<string, unknown> | undefined => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database.prepare(sql).get();
  } finally {
    database.close();
  }
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

describe("SQLite queue projection", { timeout: 30_000 }, () => {
  it("creates the frozen schema and validates exact fact-owned marker fields", async () => {
    const paths = await makePaths();
    const seed = queueSeed(subject("1"), pending("2", 1, { base: "3" }));
    const projection = new SqliteQueueRepository(paths);

    await rebuild(projection, [seed]);

    expect(readScalar(paths.databaseFile, "PRAGMA user_version")).toEqual({ user_version: 2 });
    expect(readScalar(paths.databaseFile, "PRAGMA synchronous")).toEqual({ synchronous: 2 });
    expect(readScalar(paths.databaseFile, "PRAGMA journal_mode")).toEqual({
      journal_mode: "delete",
    });
    expect(
      readScalar(
        paths.databaseFile,
        "SELECT strict FROM pragma_table_list WHERE name = 'queue_jobs'",
      ),
    ).toEqual({ strict: 1 });
    expect(readRows(paths.databaseFile)).toEqual([
      {
        subject_id: seed.subjectId,
        state_checksum: seed.stateChecksum,
        job_id: seed.pending.jobId,
        generation: seed.pending.generation,
        base_version_id: seed.pending.baseVersionId,
        material_set_hash: seed.pending.materialSetHash,
        added_material_count: seed.pending.addedMaterialCount,
        total_material_count: seed.pending.totalMaterialCount,
        queued_at: seed.pending.queuedAt,
        lease_id: null,
        lease_owner: null,
        lease_acquired_at: null,
        lease_expires_at: null,
        brief_contract_digest: null,
        source_grouping_version: null,
        prompt_version: null,
        draft_schema_version: null,
        attempt: 0,
        failure_code: null,
        failure_retryable: null,
        failure_remediation: null,
        last_sequence: 0,
      },
    ]);
    await expect(projection.verifyAvailable()).resolves.toBeUndefined();

    const database = new DatabaseSync(paths.databaseFile);
    database.exec("CREATE TABLE unexpected (value TEXT) STRICT");
    database.close();
    await expect(projection.verifyAvailable()).rejects.toMatchObject({
      code: "index_unavailable",
    });

    const malformed = {
      ...seed.pending,
      unexpected: true,
    } as unknown as PendingJobMarker;
    const otherPaths = await makePaths();
    await expect(
      rebuild(new SqliteQueueRepository(otherPaths), [queueSeed(subject("4"), malformed)]),
    ).rejects.toMatchObject({ code: "storage_corrupt" });
    await expect(exists(otherPaths.databaseFile)).resolves.toBe(false);
    await expect(exists(otherPaths.dirtyFile)).resolves.toBe(false);

    const unexpectedSeed = {
      ...queueSeed(subject("5"), pending("6", 1)),
      unexpected: true,
    } as unknown as VerifiedQueueStateSeed;
    await expect(
      rebuild(new SqliteQueueRepository(await makePaths()), [unexpectedSeed]),
    ).rejects.toMatchObject({ code: "storage_corrupt" });
  });

  it("projects fact-owned leases and derives expiry, filters, and stable list order", async () => {
    const paths = await makePaths();
    const repository = new SqliteQueueRepository(paths);
    const first = {
      ...pending("2", 1),
      queuedAt: isoDateTimeSchema.parse("2026-08-20T00:00:02.000Z"),
      lease: lease("4"),
    };
    const second = {
      ...pending("3", 1),
      queuedAt: isoDateTimeSchema.parse("2026-08-20T00:00:01.000Z"),
    };
    const expired = {
      ...pending("5", 1),
      queuedAt: isoDateTimeSchema.parse("2026-08-20T00:00:03.000Z"),
      lease: lease("6", "2026-08-20T00:05:00.000Z"),
    };
    await rebuild(repository, [
      queueSeed(subject("1"), first),
      queueSeed(subject("2"), second, "d"),
      queueSeed(subject("3"), expired, "e"),
    ]);

    await expect(repository.read(first.jobId, NOW)).resolves.toMatchObject({
      job: { id: first.jobId, state: "leased", leaseExpiresAt: first.lease.expiresAt },
      leaseOwner: first.lease.owner,
      attempt: 0,
      lastSequence: 0,
    });
    const atExpiry = await repository.read(first.jobId, first.lease.expiresAt);
    expect(atExpiry).toMatchObject({
      job: { id: first.jobId, state: "pending" },
      attempt: 0,
      lastSequence: 0,
    });
    expect(atExpiry).not.toHaveProperty("leaseOwner");
    const expiredAfterRebuild = await repository.read(expired.jobId, NOW);
    expect(expiredAfterRebuild?.job.state).toBe("pending");
    expect(expiredAfterRebuild).not.toHaveProperty("leaseOwner");
    expect(readRows(paths.databaseFile).find((row) => row.job_id === expired.jobId)).toMatchObject({
      lease_id: expired.lease.id,
      lease_owner: expired.lease.owner,
    });
    expect((await repository.list({}, NOW)).map((record) => record.job.id)).toEqual([
      second.jobId,
      first.jobId,
      expired.jobId,
    ]);
    expect(await repository.list({ state: "leased" }, NOW)).toHaveLength(1);
    expect(await repository.list({ state: "pending" }, NOW)).toHaveLength(2);
    expect(
      (await repository.list({ subjectId: subject("2"), limit: 1 }, NOW)).map(
        (record) => record.job.id,
      ),
    ).toEqual([second.jobId]);
  });

  it("projects failure metadata and clears every ephemeral field on fact apply and rebuild", async () => {
    const paths = await makePaths();
    const repository = new SqliteQueueRepository(paths);
    const marker = pending("2", 1);
    const leasedMarker = { ...marker, lease: lease("4") };
    const seed = queueSeed(subject("1"), marker);
    const leasedSeed = queueSeed(seed.subjectId, leasedMarker, "d");
    await rebuild(repository, [seed]);

    let database = new DatabaseSync(paths.databaseFile);
    database
      .prepare(
        `UPDATE queue_jobs
         SET attempt = 3,
             failure_code = 'adapter_failed',
             failure_retryable = 1,
             failure_remediation = 'Retry the adapter.',
             last_sequence = 9
         WHERE subject_id = ?`,
      )
      .run(seed.subjectId);
    database.close();

    await expect(repository.read(marker.jobId, NOW)).resolves.toEqual({
      job: {
        id: marker.jobId,
        subjectId: seed.subjectId,
        generation: marker.generation,
        materialSetHash: marker.materialSetHash,
        addedMaterialCount: marker.addedMaterialCount,
        totalMaterialCount: marker.totalMaterialCount,
        queuedAt: marker.queuedAt,
        state: "failed",
        failure: {
          code: "adapter_failed",
          retryable: true,
          remediation: "Retry the adapter.",
        },
      },
      attempt: 3,
      lastSequence: 9,
    });
    await expect(repository.list({ state: "failed" }, NOW)).resolves.toHaveLength(1);

    await repository.apply(leasedSeed);
    await expect(repository.read(marker.jobId, NOW)).resolves.toMatchObject({
      job: { state: "leased", leaseExpiresAt: leasedMarker.lease.expiresAt },
      leaseOwner: leasedMarker.lease.owner,
      attempt: 0,
      lastSequence: 0,
    });
    expect(readRows(paths.databaseFile)[0]).toMatchObject({
      state_checksum: leasedSeed.stateChecksum,
      lease_id: leasedMarker.lease.id,
      lease_owner: leasedMarker.lease.owner,
      brief_contract_digest: leasedMarker.lease.contract.digest,
      attempt: 0,
      failure_code: null,
      failure_retryable: null,
      failure_remediation: null,
      last_sequence: 0,
    });

    database = new DatabaseSync(paths.databaseFile);
    database
      .prepare(
        `UPDATE queue_jobs
         SET attempt = 2,
             failure_code = 'busy',
             failure_retryable = 1,
             last_sequence = 7
         WHERE subject_id = ?`,
      )
      .run(seed.subjectId);
    database.close();

    await rebuild(repository, [leasedSeed]);
    expect(readRows(paths.databaseFile)[0]).toMatchObject({
      lease_id: leasedMarker.lease.id,
      lease_owner: leasedMarker.lease.owner,
      attempt: 0,
      failure_code: null,
      last_sequence: 0,
    });
  });

  it("filters before limiting, defaults and caps limit at 200, and sorts by queuedAt then JobId", async () => {
    const paths = await makePaths();
    const repository = new SqliteQueueRepository(paths);
    const seeds = Array.from({ length: 201 }, (_, index) => indexedSeed(index));
    await rebuild(repository, seeds.toReversed());

    const defaultPage = await repository.list({}, NOW);
    expect(defaultPage).toHaveLength(200);
    expect(defaultPage.map((record) => record.job.id)).toEqual(
      seeds.slice(0, 200).map((seed) => seed.pending.jobId),
    );
    await expect(repository.list({ limit: 200 }, NOW)).resolves.toEqual(defaultPage);
    const lastSeed = seeds[200];
    expect(lastSeed).toBeDefined();
    if (lastSeed === undefined) throw new Error("missing final queue seed");
    expect(
      (await repository.list({ subjectId: lastSeed.subjectId, limit: 1 }, NOW)).map(
        (record) => record.job.id,
      ),
    ).toEqual([lastSeed.pending.jobId]);
    await expect(repository.list({ limit: 201 }, NOW)).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });

  it("uses the exact durable marker and fails closed for exact or malformed dirty state", async () => {
    const paths = await makePaths();
    await rebuild(new SqliteQueueRepository(paths), []);
    let observedMarker: string | undefined;
    let rowsBeforeApply: readonly QueueRow[] | undefined;
    const projection = new SqliteQueueRepository(paths, {
      async afterDirtyMarker() {
        observedMarker = await readFile(paths.dirtyFile, "utf8");
        rowsBeforeApply = readRows(paths.databaseFile);
      },
    });

    await projection.apply(queueSeed(subject("1"), pending("2", 1)));
    expect(observedMarker).toBe(DIRTY_BYTES);
    expect(rowsBeforeApply).toEqual([]);
    await expect(exists(paths.dirtyFile)).resolves.toBe(false);

    await writeFile(paths.dirtyFile, DIRTY_BYTES, { mode: 0o600 });
    await expect(projection.verifyAvailable()).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await writeFile(paths.dirtyFile, '{"projection":"queue","schemaVersion":1}\n', {
      mode: 0o600,
    });
    await expect(projection.verifyAvailable()).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await writeFile(paths.dirtyFile, '{"projection":"queue"}\n', { mode: 0o600 });
    await expect(projection.verifyAvailable()).rejects.toMatchObject({
      code: "index_unavailable",
    });
  });

  it("applies idempotent upserts, replaces generations, and deletes absent pending state", async () => {
    const paths = await makePaths();
    const projection = new SqliteQueueRepository(paths);
    const subjectId = subject("1");
    const first = pending("2", 1);
    const second = pending("3", 2, { added: 2, total: 3 });
    await rebuild(projection, []);

    await projection.apply(queueSeed(subjectId, first));
    await projection.apply(queueSeed(subjectId, first));
    expect(readRows(paths.databaseFile)).toHaveLength(1);
    expect(readRows(paths.databaseFile)[0]).toMatchObject({
      subject_id: subjectId,
      job_id: first.jobId,
      generation: 1,
    });

    await projection.apply(queueSeed(subjectId, second, "d"));
    expect(readRows(paths.databaseFile)).toHaveLength(1);
    expect(readRows(paths.databaseFile)[0]).toMatchObject({
      subject_id: subjectId,
      job_id: second.jobId,
      generation: 2,
      material_set_hash: second.materialSetHash,
    });

    await projection.apply(queueSeed(subjectId, undefined, "e"));
    expect(readRows(paths.databaseFile)).toEqual([]);
  });

  it("serializes concurrent subjects across the complete dirty-marker lifetime", async () => {
    const paths = await makePaths();
    await rebuild(new SqliteQueueRepository(paths), []);
    let markerCount = 0;
    let enterFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const projection = new SqliteQueueRepository(paths, {
      async afterDirtyMarker() {
        markerCount += 1;
        if (markerCount === 1) {
          enterFirst?.();
          await firstMayContinue;
        }
      },
    });

    const first = projection.apply(queueSeed(subject("1"), pending("2", 1)));
    await firstEntered;
    let secondSettled = false;
    const second = projection.apply(queueSeed(subject("3"), pending("4", 1), "d")).then(() => {
      secondSettled = true;
    });
    await delay(50);
    expect(secondSettled).toBe(false);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(readRows(paths.databaseFile).map((row) => row.subject_id)).toEqual([
      subject("1"),
      subject("3"),
    ]);
    await expect(exists(paths.dirtyFile)).resolves.toBe(false);
  });

  it("does not invoke the rebuild supplier until the projection lock is held", async () => {
    const paths = await makePaths();
    await rebuild(new SqliteQueueRepository(paths), []);
    let enterApply: (() => void) | undefined;
    let releaseApply: (() => void) | undefined;
    const applyEntered = new Promise<void>((resolve) => {
      enterApply = resolve;
    });
    const applyMayContinue = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const repository = new SqliteQueueRepository(paths, {
      async afterDirtyMarker() {
        enterApply?.();
        await applyMayContinue;
      },
    });
    const seed = queueSeed(subject("1"), pending("2", 1));
    const applying = repository.apply(seed);
    await applyEntered;

    let supplierCalled = false;
    const rebuilding = repository.rebuild(() => {
      supplierCalled = true;
      return asAsyncSeeds([seed]);
    }, NOW);
    await delay(50);
    expect(supplierCalled).toBe(false);

    releaseApply?.();
    await applying;
    await rebuilding;
    expect(supplierCalled).toBe(true);
  });

  it("collects rebuild facts under the projection lock so a waiting apply stays newest", async () => {
    const paths = await makePaths();
    const projection = new SqliteQueueRepository(paths);
    const oldSeed = queueSeed(subject("1"), pending("2", 1));
    const newSeed = queueSeed(subject("1"), pending("3", 2), "d");
    await rebuild(projection, [oldSeed]);
    let enterCollection: (() => void) | undefined;
    let releaseCollection: (() => void) | undefined;
    const collectionEntered = new Promise<void>((resolve) => {
      enterCollection = resolve;
    });
    const collectionMayContinue = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    const staleSnapshot = async function* (): AsyncGenerator<VerifiedQueueStateSeed> {
      yield oldSeed;
      enterCollection?.();
      await collectionMayContinue;
    };

    const rebuilding = projection.rebuild(() => staleSnapshot(), NOW);
    await collectionEntered;
    let applySettled = false;
    const apply = projection.apply(newSeed).then(() => {
      applySettled = true;
    });
    await delay(50);
    expect(applySettled).toBe(false);
    releaseCollection?.();
    await Promise.all([rebuilding, apply]);

    expect(readRows(paths.databaseFile)).toEqual([
      expect.objectContaining({
        subject_id: newSeed.subjectId,
        job_id: newSeed.pending.jobId,
        generation: newSeed.pending.generation,
      }),
    ]);
  });

  it("leaves the projection dirty when failure is injected after SQLite commit", async () => {
    const paths = await makePaths();
    await rebuild(new SqliteQueueRepository(paths), []);
    const projection = new SqliteQueueRepository(paths, {
      afterApplyCommit() {
        throw new Error("injected after SQL commit");
      },
    });

    await expect(projection.apply(queueSeed(subject("1"), pending("2", 1)))).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(readFile(paths.dirtyFile, "utf8")).resolves.toBe(DIRTY_BYTES);
    expect(readRows(paths.databaseFile)).toHaveLength(1);
    await expect(projection.verifyAvailable()).rejects.toMatchObject({
      code: "index_unavailable",
    });
  });

  it("leaves the old projection dirty when failure is injected immediately after the marker", async () => {
    const paths = await makePaths();
    await rebuild(new SqliteQueueRepository(paths), []);
    const projection = new SqliteQueueRepository(paths, {
      afterDirtyMarker() {
        throw new Error("injected after dirty marker");
      },
    });

    await expect(projection.apply(queueSeed(subject("1"), pending("2", 1)))).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(readFile(paths.dirtyFile, "utf8")).resolves.toBe(DIRTY_BYTES);
    expect(readRows(paths.databaseFile)).toEqual([]);
  });

  it("leaves the committed projection dirty when failure is injected after database fsync", async () => {
    const paths = await makePaths();
    await rebuild(new SqliteQueueRepository(paths), []);
    const projection = new SqliteQueueRepository(paths, {
      afterApplyDatabaseSync() {
        throw new Error("injected after database fsync");
      },
    });

    await expect(projection.apply(queueSeed(subject("1"), pending("2", 1)))).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(readFile(paths.dirtyFile, "utf8")).resolves.toBe(DIRTY_BYTES);
    expect(readRows(paths.databaseFile)).toHaveLength(1);
  });

  it("restores the exact marker when clearing fails after unlink and before parent sync", async () => {
    const paths = await makePaths();
    await rebuild(new SqliteQueueRepository(paths), []);
    const projection = new SqliteQueueRepository(paths, {
      afterDirtyMarkerUnlink() {
        throw new Error("injected after marker unlink");
      },
    });

    await expect(projection.apply(queueSeed(subject("1"), pending("2", 1)))).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(readFile(paths.dirtyFile, "utf8")).resolves.toBe(DIRTY_BYTES);
    expect(readRows(paths.databaseFile)).toEqual([
      expect.objectContaining({ subject_id: subject("1"), job_id: pending("2", 1).jobId }),
    ]);
  });

  it("leaves an atomically replaced rebuild dirty when final marker clearing is interrupted", async () => {
    const paths = await makePaths();
    await rebuild(new SqliteQueueRepository(paths), [queueSeed(subject("1"), pending("2", 1))]);
    const replacement = queueSeed(subject("3"), pending("4", 2), "d");
    const projection = new SqliteQueueRepository(paths, {
      afterRebuildReplaceSync() {
        throw new Error("injected after rebuild replacement");
      },
    });

    await expect(rebuild(projection, [replacement])).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(readFile(paths.dirtyFile, "utf8")).resolves.toBe(DIRTY_BYTES);
    expect(readRows(paths.databaseFile)).toEqual([
      expect.objectContaining({
        subject_id: replacement.subjectId,
        job_id: replacement.pending.jobId,
      }),
    ]);
  });

  it("never turns missing, corrupt, row-invalid, or version-mismatched storage into empty", async () => {
    const missingPaths = await makePaths();
    const missing = new SqliteQueueRepository(missingPaths);
    await expect(missing.verifyAvailable()).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(exists(missingPaths.databaseFile)).resolves.toBe(false);

    const corruptPaths = await makePaths();
    await mkdir(corruptPaths.indexDirectory, { mode: 0o700 });
    await writeFile(corruptPaths.databaseFile, "not sqlite", { mode: 0o600 });
    const corrupt = new SqliteQueueRepository(corruptPaths);
    await expect(corrupt.verifyAvailable()).rejects.toMatchObject({ code: "index_unavailable" });
    await expect(corrupt.apply(queueSeed(subject("1"), pending("2", 1)))).rejects.toMatchObject({
      code: "index_unavailable",
    });
    await expect(readFile(corruptPaths.dirtyFile, "utf8")).resolves.toBe(DIRTY_BYTES);

    const versionPaths = await makePaths();
    const projection = new SqliteQueueRepository(versionPaths);
    await rebuild(projection, [queueSeed(subject("1"), pending("2", 1))]);
    let database = new DatabaseSync(versionPaths.databaseFile);
    database.exec("PRAGMA user_version = 1");
    database.close();
    await expect(projection.verifyAvailable()).rejects.toMatchObject({
      code: "index_unavailable",
    });

    await rebuild(projection, [queueSeed(subject("1"), pending("2", 1))]);
    database = new DatabaseSync(versionPaths.databaseFile);
    database.prepare("UPDATE queue_jobs SET job_id = 'bad'").run();
    database.close();
    await expect(projection.verifyAvailable()).rejects.toMatchObject({
      code: "index_unavailable",
    });
  });

  it("rebuilds a lost projection from verified seeds without changing JobId", async () => {
    const paths = await makePaths();
    const seed: VerifiedQueueStateSeed = queueSeed(
      subject("1"),
      pending("2", 4, { added: 2, total: 5 }),
    );
    const projection = new SqliteQueueRepository(paths);
    await rebuild(projection, [seed]);
    const originalJobId = readRows(paths.databaseFile)[0]?.job_id;

    await rm(paths.databaseFile);
    await writeFile(paths.dirtyFile, DIRTY_BYTES, { mode: 0o600 });
    await rebuild(projection, [seed]);

    expect(readRows(paths.databaseFile)).toHaveLength(1);
    expect(readRows(paths.databaseFile)[0]?.job_id).toBe(originalJobId);
    expect(readRows(paths.databaseFile)[0]?.job_id).toBe(seed.pending?.jobId);
    await expect(exists(paths.dirtyFile)).resolves.toBe(false);
  });

  it("keeps the marker through DB fsync and rebuild replace-parent-sync", async () => {
    const paths = await makePaths();
    const initial = queueSeed(subject("1"), pending("2", 1));
    await rebuild(new SqliteQueueRepository(paths), [initial]);
    const replacement = queueSeed(subject("3"), pending("4", 2), "d");
    const observations: string[] = [];
    const hooks: SqliteQueueRepositoryHooks = {
      async afterRebuildReplaceSync() {
        observations.push(await readFile(paths.dirtyFile, "utf8"));
        expect(readRows(paths.databaseFile)[0]?.job_id).toBe(replacement.pending.jobId);
      },
      async afterApplyDatabaseSync() {
        observations.push(await readFile(paths.dirtyFile, "utf8"));
        expect(readRows(paths.databaseFile)[0]?.generation).toBe(3);
      },
    };
    const projection = new SqliteQueueRepository(paths, hooks);

    await rebuild(projection, [replacement]);
    await projection.apply({
      subjectId: replacement.subjectId,
      stateChecksum: stateChecksum("e"),
      pending: pending("5", 3, { added: 3, total: 4 }),
    });

    expect(observations).toEqual([DIRTY_BYTES, DIRTY_BYTES]);
    await expect(exists(paths.dirtyFile)).resolves.toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlink database target and leaves the exact dirty marker",
    async () => {
      const paths = await makePaths();
      const outsideRoot = await mkdtemp(join(tmpdir(), "distilly-queue-outside-"));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, "outside.db");
      await mkdir(paths.indexDirectory, { mode: 0o700 });
      await writeFile(outside, "outside", { mode: 0o600 });
      await symlink(outside, paths.databaseFile);

      await expect(
        rebuild(new SqliteQueueRepository(paths), [queueSeed(subject("1"), pending("2", 1))]),
      ).rejects.toMatchObject({ code: "index_unavailable" });

      await expect(readFile(outside, "utf8")).resolves.toBe("outside");
      await expect(readFile(paths.dirtyFile, "utf8")).resolves.toBe(DIRTY_BYTES);
      expect((await readdir(paths.indexDirectory)).some((name) => name.endsWith(".rebuild"))).toBe(
        false,
      );
    },
  );
});
