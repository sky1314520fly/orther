import type { DatabaseSync } from "node:sqlite";

import {
  DistillyError,
  briefContractSchema,
  clientSessionContextSchema,
  contentDigestSchema,
  engineMethodSchemas,
  hostDistillBriefingSchema,
  isoDateTimeSchema,
  jobIdSchema,
  jobLeaseSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialIdSchema,
  materialRecordSchema,
  materialSetHashSchema,
  mutationContextSchema,
  pendingJobSchema,
  provenanceDigestSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  BriefInput,
  BriefContract,
  ClientSessionContext,
  ContentDigest,
  EngineEvent,
  HostDistillBriefing,
  IsoDateTime,
  JobId,
  JobLease,
  MaterialRecord,
  MutationContext,
  PendingFilter,
  PendingJob,
  PendingJobMarker,
  ReleaseLeaseInput,
  RenewLeaseInput,
  SpaceRecord,
  SubjectId,
  SubjectRecord,
  SubjectStateRecord,
  VersionId,
  VersionMaterialEntry,
} from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { canonicalJson, canonicalJsonBytes } from "../facts/canonical-json.js";
import { sealFact, sha256Hex, verifyFactChecksum } from "../facts/checksum.js";
import {
  deriveMaterialId,
  digestMaterialProvenance,
  hashMaterialSet,
  verifyMaterialIdentity,
} from "../facts/digests.js";
import {
  briefingCapacityUnavailable,
  invalidInput,
  leaseConflict,
  leaseExpired,
  nothingPending,
  reviewConflict,
  staleJob,
  storageCorrupt,
} from "../internal-errors.js";
import type { EventBus } from "../ports/event-bus.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { ContentAddressedBlobStore } from "../storage/content-addressed-blob-store.js";
import {
  computeMutationInputChecksum,
  insertCompletedBlobOperationInTransaction,
  insertCompletedOperationInTransaction,
  insertEventInTransaction,
  replayCompletedBlobMutation,
  replayCompletedMutation,
} from "../storage/mutation-ledger.js";
import type { BlobOperationReplay } from "../storage/mutation-ledger.js";
import type { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import { readSqliteVersionInTransaction } from "../version/sqlite-authority.js";
import type { SqliteStoredVersion } from "../version/sqlite-authority.js";
import { loadSubjectSummaryInTransaction } from "../subject/transactional-identity.js";
import { buildBriefingCandidate, type BriefingStoredMaterial } from "./briefing-builder.js";
import { enforceBriefCapacity } from "./brief-capacity.js";
import { createBriefContract, type PromptCatalog } from "./prompt-catalog.js";

const LEASE_DURATION_MILLISECONDS = 30 * 60 * 1_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEMPLATE_LEASE_ID = leaseIdSchema.parse(`lease_${"0".repeat(32)}`);
const TEMPLATE_ACQUIRED_AT = isoDateTimeSchema.parse("2000-01-01T00:00:00.000Z");
const TEMPLATE_EXPIRES_AT = isoDateTimeSchema.parse("2000-01-01T00:30:00.000Z");

type SqlValue = string | number | bigint | Uint8Array | null;
type LeaseMutationMethod = "distill.renew" | "distill.release";
type LeaseMutationInput = RenewLeaseInput | ReleaseLeaseInput;
type LeaseMutationResult = JobLease | null;

/** Fault-injection seams for the SQLite brief and lease transaction matrix. */
export interface DistillLeaseServiceHooks {
  /** Runs after the complete briefing template is published, before the write transaction. */
  readonly beforeBriefTransaction?: (jobId: JobId) => void | Promise<void>;
  /** Runs synchronously after all SQL writes and immediately before COMMIT. */
  readonly beforeTransactionCommit?: (
    method: "distill.brief" | LeaseMutationMethod,
    requestId: MutationContext["requestId"],
  ) => void;
  /** Runs after COMMIT and before post-commit invalidation publication. */
  readonly afterTransactionCommit?: (
    method: "distill.brief" | LeaseMutationMethod,
    requestId: MutationContext["requestId"],
  ) => void | Promise<void>;
}

/** Concrete dependencies for the SQLite pending-job and lease authority. */
export interface DistillLeaseServiceDependencies {
  readonly store: SqliteEngineStore;
  readonly blobs: ContentAddressedBlobStore;
  readonly promptCatalog: PromptCatalog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly hooks?: DistillLeaseServiceHooks;
}

interface PersistedLease {
  readonly id: JobLease["id"];
  readonly owner: JobLease["owner"];
  readonly acquiredAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly contract: BriefContract;
}

interface PendingAuthority {
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
  readonly lease?: PersistedLease;
}

interface StoredMaterialDescriptor {
  readonly record: MaterialRecord;
  readonly blobDigest: ContentDigest;
  readonly blobByteLength: number;
}

interface BriefPreparationSnapshot {
  readonly authority: PendingAuthority;
  readonly subject: SubjectRecord;
  readonly space: SpaceRecord;
  readonly materialManifest: readonly VersionMaterialEntry[];
  readonly materials: readonly StoredMaterialDescriptor[];
  readonly baseline?: SqliteStoredVersion;
}

interface MutationOutcome<T> {
  readonly result: T;
  readonly events: readonly EngineEvent[];
  readonly committed: boolean;
}

type BriefTransactionOutcome =
  MutationOutcome<HostDistillBriefing> | { readonly replay: BlobOperationReplay };

const parseBoundary = <T>(parse: () => T, fieldPath: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw invalidInput("The distillation lease boundary input is invalid.", fieldPath);
  }
};

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
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

const utf8Blob = (row: Readonly<Record<string, unknown>>, key: string): string => {
  const value = row[key];
  if (!(value instanceof Uint8Array)) {
    throw storageCorrupt(`SQLite ${key} is invalid.`);
  }
  try {
    return UTF8_DECODER.decode(value);
  } catch (error) {
    throw storageCorrupt(`SQLite ${key} is not valid UTF-8.`, error);
  }
};

const queryOne = (
  database: DatabaseSync,
  sql: string,
  values: readonly SqlValue[],
  label: string,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    return database.prepare(sql).get(...values);
  } catch (error) {
    throw storageCorrupt(`SQLite could not read ${label}.`, error);
  }
};

const queryAll = (
  database: DatabaseSync,
  sql: string,
  values: readonly SqlValue[],
  label: string,
): readonly Readonly<Record<string, unknown>>[] => {
  try {
    return database.prepare(sql).all(...values);
  } catch (error) {
    throw storageCorrupt(`SQLite could not read ${label}.`, error);
  }
};

const parseJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is not valid JSON.`, error);
  }
};

const addLeaseDuration = (now: IsoDateTime): IsoDateTime =>
  new Date(Date.parse(now) + LEASE_DURATION_MILLISECONDS).toISOString() as IsoDateTime;

const activeAt = (lease: PersistedLease | undefined, now: IsoDateTime): boolean =>
  lease !== undefined && now < lease.expiresAt;

const pendingAuthoritySql = (where: string): string => `
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

const parseLease = (row: Readonly<Record<string, unknown>>): PersistedLease | undefined => {
  const leaseJobId = nullableText(row, "lease_job_id");
  const fields = [
    "lease_id",
    "lease_owner",
    "acquired_at",
    "expires_at",
    "brief_contract_digest",
    "source_grouping_version",
    "prompt_version",
  ] as const;
  if (leaseJobId === undefined) {
    if (fields.some((field) => row[field] !== null) || row.draft_schema_version !== null) {
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

const parsePendingAuthority = (row: Readonly<Record<string, unknown>>): PendingAuthority => {
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
  const stateGeneration = integer(row, "state_generation");
  const materialSetHash = parseStored(
    () => materialSetHashSchema.parse(text(row, "material_set_hash")),
    "pending material-set hash",
  );
  const stateMaterialSetHash = parseStored(
    () => materialSetHashSchema.parse(text(row, "state_material_set_hash")),
    "subject-state material-set hash",
  );
  const baseVersionId = nullableText(row, "base_version_id");
  const currentVersionId = nullableText(row, "state_current_version_id");
  const suspendedVersionId = nullableText(row, "state_suspended_version_id");
  if (
    generation !== stateGeneration ||
    materialSetHash !== stateMaterialSetHash ||
    baseVersionId !== currentVersionId
  ) {
    throw storageCorrupt("SQLite pending job disagrees with current subject state.");
  }
  if (
    (currentVersionId === undefined &&
      (nullableText(row, "existing_current_version_id") !== undefined ||
        nullableText(row, "current_version_status") !== undefined ||
        nullableText(row, "current_status_subject_id") !== undefined)) ||
    (currentVersionId !== undefined &&
      (nullableText(row, "existing_current_version_id") !== currentVersionId ||
        nullableText(row, "current_version_status") !== "current" ||
        nullableText(row, "current_status_subject_id") !== subjectId))
  ) {
    throw storageCorrupt("SQLite pending job has an invalid current version pointer.");
  }
  if (
    (suspendedVersionId === undefined &&
      (nullableText(row, "existing_suspended_version_id") !== undefined ||
        nullableText(row, "suspended_version_status") !== undefined ||
        nullableText(row, "suspended_status_subject_id") !== undefined)) ||
    (suspendedVersionId !== undefined &&
      (nullableText(row, "existing_suspended_version_id") !== suspendedVersionId ||
        nullableText(row, "suspended_version_status") !== "suspended" ||
        nullableText(row, "suspended_status_subject_id") !== subjectId))
  ) {
    throw storageCorrupt("SQLite pending job has an invalid suspended version pointer.");
  }
  const lease = parseLease(row);
  const authority: PendingAuthority = {
    subjectId,
    jobId: parseStored(() => jobIdSchema.parse(text(row, "job_id")), "pending job id"),
    generation,
    ...(baseVersionId === undefined
      ? {}
      : {
          baseVersionId: parseStored(
            () => versionIdSchema.parse(baseVersionId),
            "pending base version id",
          ),
        }),
    ...(currentVersionId === undefined
      ? {}
      : {
          currentVersionId: parseStored(
            () => versionIdSchema.parse(currentVersionId),
            "current version id",
          ),
        }),
    ...(suspendedVersionId === undefined
      ? {}
      : {
          suspendedVersionId: parseStored(
            () => versionIdSchema.parse(suspendedVersionId),
            "suspended version id",
          ),
        }),
    materialSetHash,
    addedMaterialCount: integer(row, "added_material_count"),
    totalMaterialCount: integer(row, "total_material_count"),
    queuedAt: parseStored(
      () => isoDateTimeSchema.parse(text(row, "queued_at")),
      "pending queue time",
    ),
    ...(lease === undefined ? {} : { lease }),
  };
  if (authority.addedMaterialCount > authority.totalMaterialCount) {
    throw storageCorrupt("SQLite pending material counts are invalid.");
  }
  return authority;
};

const readPendingAuthority = (
  database: DatabaseSync,
  jobId: JobId,
): PendingAuthority | undefined => {
  const row = queryOne(
    database,
    `${pendingAuthoritySql("WHERE pending_jobs.job_id = ?")} LIMIT 1`,
    [jobId],
    "a pending job",
  );
  return row === undefined ? undefined : parsePendingAuthority(row);
};

const projectPendingJob = (authority: PendingAuthority, now: IsoDateTime): PendingJob =>
  parseStored(
    () =>
      pendingJobSchema.parse({
        id: authority.jobId,
        subjectId: authority.subjectId,
        generation: authority.generation,
        ...(authority.baseVersionId === undefined
          ? {}
          : { baseVersionId: authority.baseVersionId }),
        materialSetHash: authority.materialSetHash,
        addedMaterialCount: authority.addedMaterialCount,
        totalMaterialCount: authority.totalMaterialCount,
        queuedAt: authority.queuedAt,
        ...(activeAt(authority.lease, now)
          ? { state: "leased", leaseExpiresAt: authority.lease!.expiresAt }
          : { state: "pending" }),
      }) as PendingJob,
    "pending job projection",
  );

const samePendingGeneration = (left: PendingAuthority, right: PendingAuthority): boolean =>
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

const materialIdentitySemantics = (record: MaterialRecord): unknown => {
  const source = Object.fromEntries(
    Object.entries(record.source).filter(([key]) => key !== "title" && key !== "capturedAt"),
  );
  return {
    id: record.id,
    subjectId: record.subjectId,
    kind: record.kind,
    contentDigest: record.contentDigest,
    provenanceDigest: record.provenanceDigest,
    sourceIdentity: record.sourceIdentity,
    source,
    derivation: record.derivation,
    participants: record.participants,
    sensitivity: record.sensitivity,
    ...(record.correctionProvenance === undefined
      ? {}
      : { correctionProvenance: record.correctionProvenance }),
    ...(record.captureAuditRef === undefined ? {} : { captureAuditRef: record.captureAuditRef }),
    ...(record.conversationSourceKey === undefined
      ? {}
      : { conversationSourceKey: record.conversationSourceKey }),
    flags: record.flags,
  };
};

const readBriefPreparation = (
  database: DatabaseSync,
  jobId: JobId,
  now: IsoDateTime,
): BriefPreparationSnapshot => {
  const authority = readPendingAuthority(database, jobId);
  if (authority === undefined) throw nothingPending();
  if (authority.suspendedVersionId !== undefined) throw reviewConflict();
  if (activeAt(authority.lease, now)) throw leaseConflict();
  const summary = loadSubjectSummaryInTransaction(database, authority.subjectId);
  if (summary.currentVersionId !== authority.currentVersionId) {
    throw storageCorrupt("SQLite briefing summary disagrees with current version authority.");
  }
  const subjectRow = queryOne(
    database,
    "SELECT domain_pack FROM subjects WHERE id = ?",
    [authority.subjectId],
    "briefing subject",
  );
  if (subjectRow === undefined) throw storageCorrupt("A pending subject disappeared.");
  const domainPack = nullableText(subjectRow, "domain_pack");
  const subject = sealFact<SubjectRecord>({
    schemaVersion: 1,
    id: summary.id,
    spaceId: summary.space.id,
    displayName: summary.displayName,
    aliases: summary.aliases,
    identityHints: summary.identityHints,
    ...(domainPack === undefined ? {} : { domainPack }),
    lifecycle: summary.lifecycle,
  });
  const space = sealFact<SpaceRecord>({
    schemaVersion: 1,
    id: summary.space.id,
    displayName: summary.space.displayName,
    kind: summary.space.kind,
  });
  const materialRows = queryAll(
    database,
    `SELECT materials.material_id, materials.kind, materials.content_digest,
            materials.provenance_digest, materials.source_identity,
            materials.record_json, materials.identity_json, materials.blob_digest,
            materials.stored_at,
            blobs.byte_length AS blob_byte_length
     FROM materials
     LEFT JOIN blobs ON blobs.digest = materials.blob_digest
     WHERE materials.subject_id = ?
     ORDER BY materials.material_id COLLATE BINARY`,
    [authority.subjectId],
    "briefing materials",
  );
  const materials = materialRows.map((row): StoredMaterialDescriptor => {
    const recordJson = text(row, "record_json");
    const record = parseStored(
      () => materialRecordSchema.parse(parseJson(recordJson, "material record")) as MaterialRecord,
      "material record",
    );
    if (canonicalJson(record) !== recordJson) {
      throw storageCorrupt("SQLite material record is not canonically encoded.");
    }
    verifyFactChecksum(record);
    const materialId = parseStored(
      () => materialIdSchema.parse(text(row, "material_id")),
      "material id",
    );
    const contentDigest = parseStored(
      () => contentDigestSchema.parse(text(row, "content_digest")),
      "material content digest",
    );
    const provenanceDigest = parseStored(
      () => provenanceDigestSchema.parse(text(row, "provenance_digest")),
      "material provenance digest",
    );
    const sourceIdentity = utf8Blob(row, "source_identity");
    const storedIdentityJson = text(row, "identity_json");
    const blobDigest = parseStored(
      () => contentDigestSchema.parse(text(row, "blob_digest")),
      "material blob digest",
    );
    const storedAt = parseStored(
      () => isoDateTimeSchema.parse(text(row, "stored_at")),
      "material stored timestamp",
    );
    if (
      record.subjectId !== authority.subjectId ||
      record.id !== materialId ||
      record.kind !== text(row, "kind") ||
      record.contentDigest !== contentDigest ||
      record.provenanceDigest !== provenanceDigest ||
      record.sourceIdentity !== sourceIdentity ||
      record.storedAt !== storedAt ||
      blobDigest !== contentDigest ||
      digestMaterialProvenance(record) !== provenanceDigest ||
      deriveMaterialId(sourceIdentity, provenanceDigest, contentDigest) !== materialId ||
      canonicalJson(materialIdentitySemantics(record)) !== storedIdentityJson
    ) {
      throw storageCorrupt("SQLite material columns disagree with their canonical record.");
    }
    return { record, blobDigest, blobByteLength: integer(row, "blob_byte_length") };
  });
  if (materials.length !== authority.totalMaterialCount) {
    throw storageCorrupt("SQLite pending counts disagree with material membership.");
  }
  const materialManifest = materials.map(({ record }): VersionMaterialEntry => ({
    materialId: record.id,
    contentDigest: record.contentDigest,
    provenanceDigest: record.provenanceDigest,
  }));
  if (hashMaterialSet(materialManifest) !== authority.materialSetHash) {
    throw storageCorrupt("SQLite pending material-set hash disagrees with verified membership.");
  }
  const baseline =
    authority.currentVersionId === undefined
      ? undefined
      : readSqliteVersionInTransaction(database, authority.subjectId, authority.currentVersionId);
  if (
    (authority.currentVersionId === undefined) !== (baseline === undefined) ||
    (baseline !== undefined && baseline.status !== "current")
  ) {
    throw storageCorrupt("SQLite briefing baseline has no verified current version.");
  }
  if (authority.addedMaterialCount !== materials.length - (baseline?.manifest.items.length ?? 0)) {
    throw storageCorrupt("SQLite pending delta disagrees with its version baseline.");
  }
  return {
    authority,
    subject,
    space,
    materialManifest,
    materials,
    ...(baseline === undefined ? {} : { baseline }),
  };
};

const bindBriefTemplate = (
  template: HostDistillBriefing,
  overlay: Pick<BlobOperationReplay, "subjectId" | "lease">,
): HostDistillBriefing => {
  if (
    template.subject.id !== overlay.subjectId ||
    template.job.subjectId !== overlay.subjectId ||
    template.lease.id !== TEMPLATE_LEASE_ID ||
    template.lease.acquiredAt !== TEMPLATE_ACQUIRED_AT ||
    template.lease.expiresAt !== TEMPLATE_EXPIRES_AT ||
    template.job.leaseExpiresAt !== TEMPLATE_EXPIRES_AT
  ) {
    throw storageCorrupt("The stored brief template has invalid placeholder authority.");
  }
  if (
    overlay.lease.jobId !== template.lease.jobId ||
    overlay.lease.generation !== template.lease.generation ||
    overlay.lease.briefContractDigest !== template.lease.briefContractDigest ||
    overlay.lease.owner !== template.lease.owner ||
    overlay.lease.expiresAt !== addLeaseDuration(overlay.lease.acquiredAt)
  ) {
    throw storageCorrupt("The final brief lease does not bind to its immutable template.");
  }
  const result = parseStored(
    () =>
      hostDistillBriefingSchema.parse({
        ...template,
        job: { ...template.job, leaseExpiresAt: overlay.lease.expiresAt },
        lease: overlay.lease,
      }) as HostDistillBriefing,
    "brief template overlay",
  );
  if (canonicalJsonBytes(result).byteLength !== canonicalJsonBytes(template).byteLength) {
    throw storageCorrupt("The final brief lease changes its template's canonical byte length.");
  }
  return result;
};

const parseBriefTemplateBytes = (
  bytes: Uint8Array,
  replay: BlobOperationReplay,
): HostDistillBriefing => {
  let json: string;
  try {
    json = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw storageCorrupt("The stored brief template is not valid UTF-8.", error);
  }
  const template = parseStored(
    () => hostDistillBriefingSchema.parse(parseJson(json, "brief template")) as HostDistillBriefing,
    "brief template",
  );
  if (canonicalJson(template) !== json) {
    throw storageCorrupt("The stored brief template is not canonically encoded.");
  }
  if (template.limits.estimatedInputTokens !== bytes.byteLength) {
    throw storageCorrupt("The stored brief template has an invalid capacity fixed point.");
  }
  return bindBriefTemplate(template, replay);
};

const ensureBlobAuthority = (
  database: DatabaseSync,
  digest: ContentDigest,
  byteLength: number,
): void => {
  const row = queryOne(
    database,
    "SELECT byte_length FROM blobs WHERE digest = ?",
    [digest],
    "a result blob authority row",
  );
  if (row === undefined) {
    database
      .prepare("INSERT INTO blobs(digest, byte_length) VALUES (?, ?)")
      .run(digest, byteLength);
    return;
  }
  if (integer(row, "byte_length") !== byteLength) {
    throw storageCorrupt("A result blob authority row conflicts with immutable bytes.");
  }
};

/** Package-private SQLite query and mutation coordinator for pending jobs and durable leases. */
export class DistillLeaseService {
  readonly #dependencies: DistillLeaseServiceDependencies;

  /**
   * Creates the SQLite-backed pending-job and lease coordinator.
   *
   * @param dependencies - SQLite, blob, prompt, identity, clock, and event seams.
   */
  constructor(dependencies: DistillLeaseServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Lists authoritative pending work with lease state derived at read time.
   *
   * @param rawFilter - Untrusted pending-job filter.
   * @returns Strict public jobs after filtering and ordering.
   */
  pending(rawFilter: PendingFilter): Promise<readonly PendingJob[]> {
    return Promise.resolve().then(() => {
      const filter = parseBoundary(
        () => engineMethodSchemas["distill.pending"].params.parse(rawFilter),
        "params",
      );
      const now = this.#dependencies.clock.now();
      const jobs = this.#dependencies.store.read((database) => {
        const conditions: string[] = [];
        const values: SqlValue[] = [];
        if (filter.subjectId !== undefined) {
          conditions.push("pending_jobs.subject_id = ?");
          values.push(filter.subjectId);
        }
        if (filter.state === "leased") {
          conditions.push("job_leases.job_id IS NOT NULL", "job_leases.expires_at > ?");
          values.push(now);
        } else if (filter.state === "pending") {
          conditions.push("(job_leases.job_id IS NULL OR job_leases.expires_at <= ?)");
          values.push(now);
        } else if (filter.state === "failed") {
          conditions.push("0 = 1");
        }
        const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
        const limit = filter.limit === undefined ? "" : " LIMIT ?";
        if (filter.limit !== undefined) values.push(filter.limit);
        return queryAll(
          database,
          `${pendingAuthoritySql(where)}
           ORDER BY pending_jobs.queued_at COLLATE BINARY, pending_jobs.job_id COLLATE BINARY${limit}`,
          values,
          "pending jobs",
        )
          .map(parsePendingAuthority)
          .map((authority) => projectPendingJob(authority, now));
      });
      return engineMethodSchemas["distill.pending"].result.parse(jobs);
    });
  }

  /**
   * Acquires a complete, capacity-checked first-version briefing lease.
   *
   * @param rawInput - Untrusted pending job selector.
   * @param rawSession - Trusted actor, lease owner, and host capacity.
   * @param rawMutation - Globally idempotent mutation context.
   * @returns The exact complete briefing reconstructed by the stable template and lease envelope.
   */
  async brief(
    rawInput: BriefInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<HostDistillBriefing> {
    const input = parseBoundary(
      () => engineMethodSchemas["distill.brief"].params.parse(rawInput),
      "params",
    );
    const session = parseBoundary(
      () => clientSessionContextSchema.parse(rawSession) as ClientSessionContext,
      "session",
    );
    const mutation = parseBoundary(
      () => mutationContextSchema.parse(rawMutation) as MutationContext,
      "requestId",
    );
    const inputChecksum = computeMutationInputChecksum("distill.brief", input, session.actor, {
      leaseOwnerId: session.leaseOwner,
      ...(session.capacity === undefined ? {} : { capacity: session.capacity }),
    });
    const replay = await this.readBriefReplay({
      requestId: mutation.requestId,
      method: "distill.brief",
      inputChecksum,
      actor: session.actor,
    });
    if (replay !== undefined) return replay;
    if (session.capacity === undefined) throw briefingCapacityUnavailable();

    const contract = await this.#dependencies.promptCatalog.load();
    const blobAccess = await this.#dependencies.blobs.acquireMutationAccess();
    let outcome: BriefTransactionOutcome | undefined;
    try {
      const snapshotAt = this.#dependencies.clock.now();
      const snapshot = this.#dependencies.store.read((database) =>
        readBriefPreparation(database, input.jobId, snapshotAt),
      );
      const materials: BriefingStoredMaterial[] = [];
      for (const descriptor of snapshot.materials) {
        const bytes = await blobAccess.read(descriptor.blobDigest, descriptor.blobByteLength);
        let content: string;
        try {
          content = UTF8_DECODER.decode(bytes);
        } catch (error) {
          throw storageCorrupt("A briefing material blob is not valid UTF-8.", error);
        }
        verifyMaterialIdentity(descriptor.record, content);
        materials.push({ record: descriptor.record, content });
      }
      const templateLease = jobLeaseSchema.parse({
        id: TEMPLATE_LEASE_ID,
        jobId: input.jobId,
        generation: snapshot.authority.generation,
        briefContractDigest: contract.digest,
        owner: session.leaseOwner,
        acquiredAt: TEMPLATE_ACQUIRED_AT,
        expiresAt: TEMPLATE_EXPIRES_AT,
      });
      const pending: PendingJobMarker = {
        jobId: snapshot.authority.jobId,
        generation: snapshot.authority.generation,
        ...(snapshot.authority.baseVersionId === undefined
          ? {}
          : { baseVersionId: snapshot.authority.baseVersionId }),
        materialSetHash: snapshot.authority.materialSetHash,
        addedMaterialCount: snapshot.authority.addedMaterialCount,
        totalMaterialCount: snapshot.authority.totalMaterialCount,
        queuedAt: snapshot.authority.queuedAt,
        lease: {
          id: templateLease.id,
          owner: templateLease.owner,
          acquiredAt: templateLease.acquiredAt,
          expiresAt: templateLease.expiresAt,
          contract: {
            digest: contract.digest,
            sourceGroupingVersion: contract.sourceGroupingVersion,
            promptVersion: contract.promptVersion,
            draftSchemaVersion: contract.draftSchemaVersion,
          },
        },
      };
      const state = sealFact<SubjectStateRecord>({
        schemaVersion: 2,
        subjectId: snapshot.authority.subjectId,
        generation: snapshot.authority.generation,
        materialSetHash: snapshot.authority.materialSetHash,
        materialManifest: snapshot.materialManifest,
        ...(snapshot.authority.currentVersionId === undefined
          ? {}
          : { currentVersionId: snapshot.authority.currentVersionId }),
        ...(snapshot.authority.suspendedVersionId === undefined
          ? {}
          : { suspendedVersionId: snapshot.authority.suspendedVersionId }),
        pending,
      });
      const candidate = buildBriefingCandidate({
        subject: snapshot.subject,
        space: snapshot.space,
        state,
        materials,
        ...(snapshot.baseline === undefined ? {} : { baseline: snapshot.baseline }),
        lease: templateLease,
        contract,
      });
      const template = enforceBriefCapacity(candidate, session.capacity);
      const templateBytes = canonicalJsonBytes(template);
      const templateDigest = `sha256_${sha256Hex(templateBytes)}` as ContentDigest;
      const published = await blobAccess.put(templateDigest, templateBytes);
      await this.#dependencies.hooks?.beforeBriefTransaction?.(input.jobId);

      outcome = this.#dependencies.store.write((database): BriefTransactionOutcome => {
        const transactionReplay = replayCompletedBlobMutation(database, {
          requestId: mutation.requestId,
          method: "distill.brief",
          inputChecksum,
          actor: session.actor,
        });
        if (transactionReplay !== undefined) return { replay: transactionReplay };
        const current = readPendingAuthority(database, input.jobId);
        if (current?.suspendedVersionId !== undefined) throw reviewConflict();
        if (current === undefined || !samePendingGeneration(snapshot.authority, current)) {
          throw staleJob();
        }
        const transactionNow = this.#dependencies.clock.now();
        if (activeAt(current.lease, transactionNow)) throw leaseConflict();
        const currentMaterialCount = queryOne(
          database,
          "SELECT count(*) AS count FROM materials WHERE subject_id = ?",
          [current.subjectId],
          "current briefing material membership",
        );
        if (
          currentMaterialCount === undefined ||
          integer(currentMaterialCount, "count") !== snapshot.materials.length
        ) {
          throw staleJob();
        }
        const finalLease = jobLeaseSchema.parse({
          id: this.#dependencies.ids.leaseId(),
          jobId: input.jobId,
          generation: snapshot.authority.generation,
          briefContractDigest: contract.digest,
          owner: session.leaseOwner,
          acquiredAt: transactionNow,
          expiresAt: addLeaseDuration(transactionNow),
        });
        const result = bindBriefTemplate(template, {
          subjectId: current.subjectId,
          lease: finalLease,
        });
        database.prepare("DELETE FROM job_leases WHERE job_id = ?").run(current.jobId);
        database
          .prepare(
            `INSERT INTO job_leases(
               job_id, lease_id, lease_owner, acquired_at, expires_at,
               brief_contract_digest, source_grouping_version,
               prompt_version, draft_schema_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            current.jobId,
            finalLease.id,
            finalLease.owner,
            finalLease.acquiredAt,
            finalLease.expiresAt,
            contract.digest,
            contract.sourceGroupingVersion,
            contract.promptVersion,
            contract.draftSchemaVersion,
          );
        ensureBlobAuthority(database, published.digest, published.byteLength);
        insertCompletedBlobOperationInTransaction(database, {
          requestId: mutation.requestId,
          method: "distill.brief",
          subjectId: current.subjectId,
          actor: session.actor,
          inputChecksum,
          resultBlob: { digest: published.digest, byteLength: published.byteLength },
          lease: finalLease,
          completedAt: transactionNow,
        });
        const event: EngineEvent = {
          kind: "job.changed",
          subjectId: current.subjectId,
          at: transactionNow,
        };
        insertEventInTransaction(database, {
          eventId: this.#dependencies.ids.eventId(),
          event,
          actor: session.actor,
          requestId: mutation.requestId,
        });
        this.#dependencies.hooks?.beforeTransactionCommit?.("distill.brief", mutation.requestId);
        return { result, events: [event], committed: true };
      });

      if ("replay" in outcome) {
        const bytes = await blobAccess.read(
          outcome.replay.resultBlob.digest,
          outcome.replay.resultBlob.byteLength,
        );
        return parseBriefTemplateBytes(bytes, outcome.replay);
      }
    } finally {
      await blobAccess.release();
    }
    if (outcome === undefined || "replay" in outcome) {
      throw storageCorrupt("A brief transaction ended without a result.");
    }
    if (outcome.committed) {
      await this.#dependencies.hooks?.afterTransactionCommit?.("distill.brief", mutation.requestId);
      for (const event of outcome.events) await this.#dependencies.eventBus.publish(event);
    }
    return outcome.result;
  }

  /**
   * Extends one active, session-owned lease by the frozen duration.
   *
   * @param rawInput - Untrusted job and lease selector.
   * @param rawSession - Trusted actor and lease owner.
   * @param rawMutation - Globally idempotent mutation context.
   * @returns The same lease identity with its extended expiry.
   */
  async renew(
    rawInput: RenewLeaseInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<JobLease> {
    return (await this.mutateLease("distill.renew", rawInput, rawSession, rawMutation)) as JobLease;
  }

  /**
   * Releases one active, session-owned lease without deleting its pending job.
   *
   * @param rawInput - Untrusted job, lease, and optional reason.
   * @param rawSession - Trusted actor and lease owner.
   * @param rawMutation - Globally idempotent mutation context.
   * @returns The Protocol empty result.
   */
  async release(
    rawInput: ReleaseLeaseInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<null> {
    return (await this.mutateLease("distill.release", rawInput, rawSession, rawMutation)) as null;
  }

  private async readBriefReplay(
    input: Parameters<typeof replayCompletedBlobMutation>[1],
  ): Promise<HostDistillBriefing | undefined> {
    const access = await this.#dependencies.blobs.acquireReadAccess();
    try {
      const replay = this.#dependencies.store.read((database) =>
        replayCompletedBlobMutation(database, input),
      );
      if (replay === undefined) return undefined;
      const bytes = await access.read(replay.resultBlob.digest, replay.resultBlob.byteLength);
      return parseBriefTemplateBytes(bytes, replay);
    } finally {
      await access.release();
    }
  }

  private async mutateLease(
    method: LeaseMutationMethod,
    rawInput: LeaseMutationInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<LeaseMutationResult> {
    const input = parseBoundary(() => engineMethodSchemas[method].params.parse(rawInput), "params");
    const session = parseBoundary(
      () => clientSessionContextSchema.parse(rawSession) as ClientSessionContext,
      "session",
    );
    const mutation = parseBoundary(
      () => mutationContextSchema.parse(rawMutation) as MutationContext,
      "requestId",
    );
    const inputChecksum = computeMutationInputChecksum(method, input, session.actor, {
      leaseOwnerId: session.leaseOwner,
    });
    const earlyReplay = this.#dependencies.store.read((database) =>
      replayCompletedMutation(database, {
        requestId: mutation.requestId,
        method,
        inputChecksum,
        actor: session.actor,
      }),
    );
    if (earlyReplay !== undefined) return earlyReplay;

    const outcome = this.#dependencies.store.write(
      (database): MutationOutcome<LeaseMutationResult> => {
        const replay = replayCompletedMutation(database, {
          requestId: mutation.requestId,
          method,
          inputChecksum,
          actor: session.actor,
        });
        if (replay !== undefined) return { result: replay, events: [], committed: false };
        const authority = readPendingAuthority(database, input.jobId);
        if (authority === undefined) throw nothingPending();
        const now = this.#dependencies.clock.now();
        const currentLease = authority.lease;
        if (currentLease === undefined || !activeAt(currentLease, now)) throw leaseExpired();
        if (currentLease.id !== input.leaseId || currentLease.owner !== session.leaseOwner) {
          throw leaseConflict("The requested lease belongs to a different session.");
        }
        let result: LeaseMutationResult;
        if (method === "distill.renew") {
          const expiresAt = addLeaseDuration(now);
          if (expiresAt <= currentLease.expiresAt) {
            throw leaseConflict("Renewal would not extend the current lease expiry.");
          }
          const changed = database
            .prepare(
              `UPDATE job_leases
             SET expires_at = ?
             WHERE job_id = ? AND lease_id = ? AND lease_owner = ? AND expires_at = ?`,
            )
            .run(
              expiresAt,
              authority.jobId,
              currentLease.id,
              currentLease.owner,
              currentLease.expiresAt,
            );
          if (changed.changes !== 1) throw leaseConflict();
          result = jobLeaseSchema.parse({
            id: currentLease.id,
            jobId: authority.jobId,
            generation: authority.generation,
            briefContractDigest: currentLease.contract.digest,
            owner: currentLease.owner,
            acquiredAt: currentLease.acquiredAt,
            expiresAt,
          });
        } else {
          const changed = database
            .prepare(
              `DELETE FROM job_leases
             WHERE job_id = ? AND lease_id = ? AND lease_owner = ? AND expires_at = ?`,
            )
            .run(authority.jobId, currentLease.id, currentLease.owner, currentLease.expiresAt);
          if (changed.changes !== 1) throw leaseConflict();
          result = null;
        }
        insertCompletedOperationInTransaction(database, {
          requestId: mutation.requestId,
          method,
          subjectId: authority.subjectId,
          actor: session.actor,
          inputChecksum,
          result,
          completedAt: now,
        });
        const event: EngineEvent = { kind: "job.changed", subjectId: authority.subjectId, at: now };
        insertEventInTransaction(database, {
          eventId: this.#dependencies.ids.eventId(),
          event,
          actor: session.actor,
          requestId: mutation.requestId,
        });
        this.#dependencies.hooks?.beforeTransactionCommit?.(method, mutation.requestId);
        return { result, events: [event], committed: true };
      },
    );
    if (outcome.committed) {
      await this.#dependencies.hooks?.afterTransactionCommit?.(method, mutation.requestId);
      for (const event of outcome.events) await this.#dependencies.eventBus.publish(event);
    }
    return outcome.result;
  }
}
