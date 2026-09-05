import type { DatabaseSync } from "node:sqlite";

import {
  briefContractSchema,
  isoDateTimeSchema,
  jobIdSchema,
  jobLeaseSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialSetHashSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  BriefContract,
  IsoDateTime,
  JobId,
  JobLease,
  PendingJob,
  SubjectId,
  VersionId,
} from "@distilly/protocol";

import { createBriefContract } from "./prompt-catalog.js";
import { storageCorrupt } from "../internal-errors.js";

/** Exact persisted lease fields joined to one pending job. */
export interface SqlitePersistedLease {
  readonly id: JobLease["id"];
  readonly owner: JobLease["owner"];
  readonly acquiredAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly contract: BriefContract;
}

/** Verified pending job, subject-state pointers, and optional active-or-expired lease row. */
export interface SqlitePendingAuthority {
  readonly subjectId: SubjectId;
  readonly jobId: JobId;
  readonly generation: number;
  readonly baseVersionId?: VersionId;
  readonly currentVersionId?: VersionId;
  readonly suspendedVersionId?: VersionId;
  readonly materialSetHash: PendingJob["materialSetHash"];
  readonly addedMaterialCount: number;
  readonly totalMaterialCount: number;
  readonly queuedAt: IsoDateTime;
  readonly lease?: SqlitePersistedLease;
}

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const text = (row: Readonly<Record<string, unknown>>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${key} is invalid.`);
  return value;
};

const nullableText = (row: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${key} is invalid.`);
  return value;
};

const integer = (row: Readonly<Record<string, unknown>>, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageCorrupt(`SQLite ${key} is invalid.`);
  }
  return value;
};

const selectSql = (where: string): string => `
  SELECT pending_jobs.subject_id, pending_jobs.job_id, pending_jobs.generation,
         pending_jobs.base_version_id, pending_jobs.material_set_hash,
         pending_jobs.added_material_count, pending_jobs.total_material_count,
         pending_jobs.queued_at,
         subjects.id AS existing_subject_id,
         subject_states.subject_id AS state_subject_id,
         subject_states.generation AS state_generation,
         subject_states.material_set_hash AS state_material_set_hash,
         subject_states.current_version_id AS state_current_version_id,
         subject_states.suspended_version_id AS state_suspended_version_id,
         current_versions.id AS existing_current_version_id,
         current_status.status AS current_version_status,
         current_status.subject_id AS current_status_subject_id,
         suspended_versions.id AS existing_suspended_version_id,
         suspended_status.status AS suspended_version_status,
         suspended_status.subject_id AS suspended_status_subject_id,
         job_leases.job_id AS lease_job_id,
         job_leases.lease_id, job_leases.lease_owner,
         job_leases.acquired_at, job_leases.expires_at,
         job_leases.brief_contract_digest,
         job_leases.source_grouping_version,
         job_leases.prompt_version,
         job_leases.draft_schema_version
  FROM pending_jobs
  LEFT JOIN subjects ON subjects.id = pending_jobs.subject_id
  LEFT JOIN subject_states ON subject_states.subject_id = pending_jobs.subject_id
  LEFT JOIN versions AS current_versions
    ON current_versions.id = subject_states.current_version_id
   AND current_versions.subject_id = pending_jobs.subject_id
  LEFT JOIN version_statuses AS current_status
    ON current_status.version_id = current_versions.id
  LEFT JOIN versions AS suspended_versions
    ON suspended_versions.id = subject_states.suspended_version_id
   AND suspended_versions.subject_id = pending_jobs.subject_id
  LEFT JOIN version_statuses AS suspended_status
    ON suspended_status.version_id = suspended_versions.id
  LEFT JOIN job_leases ON job_leases.job_id = pending_jobs.job_id
  ${where}`;

const parseLease = (row: Readonly<Record<string, unknown>>): SqlitePersistedLease | undefined => {
  const leaseJobId = nullableText(row, "lease_job_id");
  const leaseFields = [
    "lease_id",
    "lease_owner",
    "acquired_at",
    "expires_at",
    "brief_contract_digest",
    "source_grouping_version",
    "prompt_version",
  ] as const;
  if (leaseJobId === undefined) {
    if (leaseFields.some((field) => row[field] !== null) || row.draft_schema_version !== null) {
      throw storageCorrupt("SQLite pending job has incomplete lease columns.");
    }
    return undefined;
  }
  if (leaseJobId !== text(row, "job_id")) {
    throw storageCorrupt("SQLite lease points to a different pending job.");
  }
  const contract = parseStored(
    () =>
      briefContractSchema.parse({
        digest: text(row, "brief_contract_digest"),
        sourceGroupingVersion: text(row, "source_grouping_version"),
        promptVersion: text(row, "prompt_version"),
        draftSchemaVersion: integer(row, "draft_schema_version"),
      }) as BriefContract,
    "lease brief contract",
  );
  if (createBriefContract(contract).digest !== contract.digest) {
    throw storageCorrupt("SQLite lease brief contract digest is inconsistent.");
  }
  const lease = parseStored(
    () =>
      jobLeaseSchema.parse({
        id: leaseIdSchema.parse(text(row, "lease_id")),
        jobId: jobIdSchema.parse(leaseJobId),
        generation: integer(row, "generation"),
        briefContractDigest: contract.digest,
        owner: leaseOwnerIdSchema.parse(text(row, "lease_owner")),
        acquiredAt: isoDateTimeSchema.parse(text(row, "acquired_at")),
        expiresAt: isoDateTimeSchema.parse(text(row, "expires_at")),
      }) as JobLease,
    "pending lease",
  );
  return {
    id: lease.id,
    owner: lease.owner,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    contract,
  };
};

const parseAuthority = (row: Readonly<Record<string, unknown>>): SqlitePendingAuthority => {
  const subjectId = parseStored(
    () => subjectIdSchema.parse(text(row, "subject_id")),
    "pending subject id",
  );
  if (
    nullableText(row, "existing_subject_id") !== subjectId ||
    nullableText(row, "state_subject_id") !== subjectId
  ) {
    throw storageCorrupt("SQLite pending job is missing its subject authority.");
  }
  const generation = integer(row, "generation");
  const materialSetHash = parseStored(
    () => materialSetHashSchema.parse(text(row, "material_set_hash")),
    "pending material-set hash",
  );
  const stateMaterialSetHash = parseStored(
    () => materialSetHashSchema.parse(text(row, "state_material_set_hash")),
    "subject-state material-set hash",
  );
  const baseVersionText = nullableText(row, "base_version_id");
  const currentVersionText = nullableText(row, "state_current_version_id");
  const suspendedVersionText = nullableText(row, "state_suspended_version_id");
  if (
    generation !== integer(row, "state_generation") ||
    materialSetHash !== stateMaterialSetHash ||
    baseVersionText !== currentVersionText
  ) {
    throw storageCorrupt("SQLite pending job disagrees with current subject state.");
  }
  if (currentVersionText === undefined) {
    if (
      nullableText(row, "existing_current_version_id") !== undefined ||
      nullableText(row, "current_version_status") !== undefined ||
      nullableText(row, "current_status_subject_id") !== undefined
    ) {
      throw storageCorrupt("SQLite pending state has an unexpected current version join.");
    }
  } else if (
    nullableText(row, "existing_current_version_id") !== currentVersionText ||
    nullableText(row, "current_version_status") !== "current" ||
    nullableText(row, "current_status_subject_id") !== subjectId
  ) {
    throw storageCorrupt("SQLite pending state has an invalid current version pointer.");
  }
  if (suspendedVersionText === undefined) {
    if (
      nullableText(row, "existing_suspended_version_id") !== undefined ||
      nullableText(row, "suspended_version_status") !== undefined ||
      nullableText(row, "suspended_status_subject_id") !== undefined
    ) {
      throw storageCorrupt("SQLite pending state has an unexpected suspended version join.");
    }
  } else if (
    nullableText(row, "existing_suspended_version_id") !== suspendedVersionText ||
    nullableText(row, "suspended_version_status") !== "suspended" ||
    nullableText(row, "suspended_status_subject_id") !== subjectId
  ) {
    throw storageCorrupt("SQLite pending state has an invalid suspended version pointer.");
  }
  const baseVersionId =
    baseVersionText === undefined
      ? undefined
      : parseStored(() => versionIdSchema.parse(baseVersionText), "pending base version id");
  const currentVersionId =
    currentVersionText === undefined
      ? undefined
      : parseStored(() => versionIdSchema.parse(currentVersionText), "current version id");
  const suspendedVersionId =
    suspendedVersionText === undefined
      ? undefined
      : parseStored(() => versionIdSchema.parse(suspendedVersionText), "suspended version id");
  const lease = parseLease(row);
  const authority: SqlitePendingAuthority = {
    subjectId,
    jobId: parseStored(() => jobIdSchema.parse(text(row, "job_id")), "pending job id"),
    generation,
    ...(baseVersionId === undefined ? {} : { baseVersionId }),
    ...(currentVersionId === undefined ? {} : { currentVersionId }),
    ...(suspendedVersionId === undefined ? {} : { suspendedVersionId }),
    materialSetHash,
    addedMaterialCount: integer(row, "added_material_count"),
    totalMaterialCount: integer(row, "total_material_count"),
    queuedAt: parseStored(
      () => isoDateTimeSchema.parse(text(row, "queued_at")),
      "pending queue time",
    ),
    ...(lease === undefined ? {} : { lease }),
  };
  if (authority.generation === 0 || authority.addedMaterialCount > authority.totalMaterialCount) {
    throw storageCorrupt("SQLite pending material counts or generation are invalid.");
  }
  return authority;
};

/**
 * Returns whether a persisted lease is active at the exact supplied instant.
 *
 * @param lease - Optional persisted lease row.
 * @param now - Exact comparison instant.
 * @returns Whether `now` is strictly before expiry.
 */
export const sqliteLeaseActiveAt = (
  lease: SqlitePersistedLease | undefined,
  now: IsoDateTime,
): boolean => lease !== undefined && now < lease.expiresAt;

/**
 * Reads one pending authority row by globally unique JobId.
 *
 * @param database - Connection inside an active transaction.
 * @param jobId - Exact pending job id.
 * @returns Verified authority or undefined when absent.
 */
export const readSqlitePendingAuthorityInTransaction = (
  database: DatabaseSync,
  jobId: JobId,
): SqlitePendingAuthority | undefined => {
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = database.prepare(`${selectSql("WHERE pending_jobs.job_id = ?")} LIMIT 1`).get(jobId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read a pending job.", error);
  }
  return row === undefined ? undefined : parseAuthority(row);
};

/**
 * Compares every immutable generation fact used by brief/commit optimistic reads.
 *
 * @param left - Prepared authority snapshot.
 * @param right - Transaction-time authority snapshot.
 * @returns Whether all generation and pointer facts match.
 */
export const sameSqlitePendingGeneration = (
  left: SqlitePendingAuthority,
  right: SqlitePendingAuthority,
): boolean =>
  left.subjectId === right.subjectId &&
  left.jobId === right.jobId &&
  left.generation === right.generation &&
  left.baseVersionId === right.baseVersionId &&
  left.currentVersionId === right.currentVersionId &&
  left.suspendedVersionId === right.suspendedVersionId &&
  left.materialSetHash === right.materialSetHash &&
  left.addedMaterialCount === right.addedMaterialCount &&
  left.totalMaterialCount === right.totalMaterialCount &&
  left.queuedAt === right.queuedAt;
