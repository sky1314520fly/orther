import type { DatabaseSync } from "node:sqlite";

import {
  jobIdSchema,
  materialSetHashSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type { MaterialSetHash, SubjectId, VersionId } from "@distilly/protocol";

import {
  readSqlitePendingAuthorityInTransaction,
  type SqlitePendingAuthority,
} from "../distill/sqlite-pending-authority.js";
import { factNotFound, storageCorrupt } from "../internal-errors.js";
import {
  readSqliteVersionInTransaction,
  type SqliteStoredVersion,
} from "../version/sqlite-authority.js";

/** Directly verified active version pointers used by review reads and mutations. */
export interface SqliteActiveReviewAuthority {
  readonly subjectId: SubjectId;
  readonly current?: SqliteStoredVersion;
  readonly suspended?: SqliteStoredVersion;
}

/** Mutation-only generation and pending authority used by review state transitions. */
export interface SqliteReviewAuthority extends SqliteActiveReviewAuthority {
  readonly generation: number;
  readonly materialSetHash?: MaterialSetHash;
  readonly pending?: SqlitePendingAuthority;
}

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${label} is invalid.`);
  return value;
};

const optionalText = (value: unknown, label: string): string | undefined => {
  if (value === null) return undefined;
  return text(value, label);
};

const safeInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageCorrupt(`SQLite ${label} is invalid.`);
  }
  return value;
};

const readPending = (
  database: DatabaseSync,
  subjectId: SubjectId,
): SqlitePendingAuthority | undefined => {
  let row: { readonly job_id?: unknown } | undefined;
  try {
    row = database.prepare("SELECT job_id FROM pending_jobs WHERE subject_id = ?").get(subjectId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read review pending authority.", error);
  }
  if (row === undefined) return undefined;
  const jobId = parseStored(
    () => jobIdSchema.parse(text(row.job_id, "review pending job id")),
    "review pending job id",
  );
  const pending = readSqlitePendingAuthorityInTransaction(database, jobId);
  if (pending === undefined || pending.subjectId !== subjectId) {
    throw storageCorrupt("SQLite review pending authority disappeared from its snapshot.");
  }
  return pending;
};

const assertStatusPointers = (
  database: DatabaseSync,
  authority: SqliteActiveReviewAuthority,
): void => {
  let rows: readonly Readonly<Record<string, unknown>>[];
  try {
    rows = database
      .prepare(
        `SELECT version_id, status
         FROM version_statuses
         WHERE subject_id = ? AND status IN ('current', 'suspended')
         ORDER BY status`,
      )
      .all(authority.subjectId);
  } catch (error) {
    throw storageCorrupt("SQLite could not verify active review version statuses.", error);
  }
  const expected = new Map<string, VersionId>();
  if (authority.current !== undefined) expected.set("current", authority.current.version.id);
  if (authority.suspended !== undefined) expected.set("suspended", authority.suspended.version.id);
  if (
    rows.length !== expected.size ||
    rows.some((row) => {
      const status = text(row.status, "active version status");
      const versionId = parseStored(
        () => versionIdSchema.parse(text(row.version_id, "active version id")),
        "active version id",
      );
      return expected.get(status) !== versionId;
    })
  ) {
    throw storageCorrupt("SQLite active version statuses disagree with subject pointers.");
  }
};

/**
 * Reads only active pointers and directly used immutable versions for one review query.
 *
 * @param database - Connection inside one consistent read or write transaction.
 * @param subjectId - Exact subject whose active review state is required.
 * @returns Verified active pointers and immutable versions.
 */
export const readSqliteActiveReviewAuthorityInTransaction = (
  database: DatabaseSync,
  subjectId: SubjectId,
): SqliteActiveReviewAuthority => {
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = database
      .prepare(
        `SELECT subjects.id AS subject_id,
                subject_states.subject_id AS state_subject_id,
                subject_states.current_version_id,
                subject_states.suspended_version_id
         FROM subjects
         LEFT JOIN subject_states ON subject_states.subject_id = subjects.id
         WHERE subjects.id = ?`,
      )
      .get(subjectId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read review subject authority.", error);
  }
  if (row === undefined) throw factNotFound("The review subject does not exist.");
  const storedSubjectId = parseStored(
    () => subjectIdSchema.parse(text(row.subject_id, "review subject id")),
    "review subject id",
  );
  if (
    storedSubjectId !== subjectId ||
    optionalText(row.state_subject_id, "review state subject") !== subjectId
  ) {
    throw storageCorrupt("SQLite review subject is missing its state authority.");
  }
  const currentIdText = optionalText(row.current_version_id, "review current version id");
  const suspendedIdText = optionalText(row.suspended_version_id, "review suspended version id");
  const currentId =
    currentIdText === undefined
      ? undefined
      : parseStored(() => versionIdSchema.parse(currentIdText), "review current version id");
  const suspendedId =
    suspendedIdText === undefined
      ? undefined
      : parseStored(() => versionIdSchema.parse(suspendedIdText), "review suspended version id");
  if (currentId !== undefined && currentId === suspendedId) {
    throw storageCorrupt("SQLite review pointers identify the same version twice.");
  }
  const current =
    currentId === undefined
      ? undefined
      : readSqliteVersionInTransaction(database, subjectId, currentId);
  const suspended =
    suspendedId === undefined
      ? undefined
      : readSqliteVersionInTransaction(database, subjectId, suspendedId);
  if (
    (currentId === undefined) !== (current === undefined) ||
    (current !== undefined && current.status !== "current") ||
    (suspendedId === undefined) !== (suspended === undefined) ||
    (suspended !== undefined && suspended.status !== "suspended")
  ) {
    throw storageCorrupt("SQLite review pointers have no matching verified version authority.");
  }
  if (
    suspended !== undefined &&
    (suspended.version.createdDisposition !== "suspended" ||
      suspended.version.reviewReasons === undefined ||
      suspended.version.parentId !== current?.version.id)
  ) {
    throw storageCorrupt("SQLite active review candidate does not match its current parent.");
  }
  const authority: SqliteActiveReviewAuthority = {
    subjectId,
    ...(current === undefined ? {} : { current }),
    ...(suspended === undefined ? {} : { suspended }),
  };
  assertStatusPointers(database, authority);
  return authority;
};

/**
 * Reads active pointers plus mutation-only generation and pending authority.
 *
 * @param database - Connection inside the active review write transaction.
 * @param subjectId - Exact subject whose mutation authority is required.
 * @returns Verified active, generation, material-set, and pending authority.
 */
export const readSqliteReviewAuthorityInTransaction = (
  database: DatabaseSync,
  subjectId: SubjectId,
): SqliteReviewAuthority => {
  const active = readSqliteActiveReviewAuthorityInTransaction(database, subjectId);
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = database
      .prepare(
        `SELECT generation, material_set_hash
         FROM subject_states WHERE subject_id = ?`,
      )
      .get(subjectId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read review mutation state.", error);
  }
  if (row === undefined) {
    throw storageCorrupt("SQLite review subject is missing its mutation state.");
  }
  const generation = safeInteger(row.generation, "review subject generation");
  const materialSetHashText = optionalText(row.material_set_hash, "review material-set hash");
  const materialSetHash =
    materialSetHashText === undefined
      ? undefined
      : parseStored(
          () => materialSetHashSchema.parse(materialSetHashText),
          "review material-set hash",
        );
  if ((generation === 0) !== (materialSetHash === undefined)) {
    throw storageCorrupt("SQLite review generation disagrees with its material-set hash.");
  }
  const pending = readPending(database, subjectId);
  return {
    ...active,
    generation,
    ...(materialSetHash === undefined ? {} : { materialSetHash }),
    ...(pending === undefined ? {} : { pending }),
  };
};

/**
 * Lists subject ids whose state or status authority claims an active suspended review.
 *
 * @param database - Connection inside one consistent review-list snapshot.
 * @returns Canonically ordered subject ids requiring direct verification.
 */
export const listSqliteReviewSubjectIdsInTransaction = (
  database: DatabaseSync,
): readonly SubjectId[] => {
  let rows: readonly Readonly<Record<string, unknown>>[];
  try {
    rows = database
      .prepare(
        `SELECT subject_id
         FROM (
           SELECT subject_id FROM subject_states WHERE suspended_version_id IS NOT NULL
           UNION
           SELECT subject_id FROM version_statuses WHERE status = 'suspended'
         )
         ORDER BY subject_id COLLATE BINARY`,
      )
      .all();
  } catch (error) {
    throw storageCorrupt("SQLite could not list active review subjects.", error);
  }
  return rows.map((row) =>
    parseStored(
      () => subjectIdSchema.parse(text(row.subject_id, "active review subject id")),
      "active review subject id",
    ),
  );
};
