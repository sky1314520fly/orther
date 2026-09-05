import type { DatabaseSync } from "node:sqlite";

import {
  DistillyError,
  actorContextSchema,
  contentDigestSchema,
  engineMethodSchemas,
  eventRecordSchema,
  factChecksumSchema,
  isoDateTimeSchema,
  jobLeaseSchema,
  requestIdSchema,
  subjectIdSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  CommitResult,
  ContentDigest,
  EngineEvent,
  EngineMethodMap,
  EventId,
  EventRecord,
  FactChecksum,
  HostDistillBriefing,
  IngestResult,
  IngestFilesResult,
  IsoDateTime,
  JobLease,
  RequestId,
  SubjectId,
  SubjectSummary,
  VersionSummary,
  VersionId,
} from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { computeFactChecksum, sealFact, verifyFactChecksum } from "../facts/checksum.js";
import { idempotencyConflict, storageCorrupt } from "../internal-errors.js";

/** Mutation methods currently backed by the SQLite operation ledger. */
export type SqliteLedgerMethod =
  | "subjects.create"
  | "materials.ingest"
  | "materials.ingestFiles"
  | "distill.brief"
  | "distill.renew"
  | "distill.release"
  | "distill.commit"
  | "profiles.correct"
  | "versions.promote"
  | "versions.reject"
  | "versions.rollback"
  | "hosts.install"
  | "hosts.uninstall"
  | "hosts.export";

/** SQLite mutations whose stable result remains small enough for inline JSON. */
export type SqliteInlineLedgerMethod = Exclude<SqliteLedgerMethod, "distill.brief">;

type LedgerResult<M extends SqliteLedgerMethod> = EngineMethodMap[M]["result"];

/** Lookup key for a globally unique completed mutation. */
export interface MutationReplayInput<M extends SqliteLedgerMethod> {
  readonly requestId: RequestId;
  readonly method: M;
  readonly inputChecksum: FactChecksum;
  readonly actor: ActorContext;
}

/** Complete successful operation written in the same transaction as its business facts. */
export interface CompletedOperationInput<
  M extends SqliteInlineLedgerMethod,
> extends MutationReplayInput<M> {
  readonly subjectId: SubjectId;
  readonly actor: ActorContext;
  readonly result: LedgerResult<M>;
  readonly completedAt: IsoDateTime;
}

/** Immutable blob pointer used for a large stable operation result. */
interface OperationResultBlob {
  readonly digest: ContentDigest;
  readonly byteLength: number;
}

/** Verified operation scope paired with its immutable stable-result pointer. */
export interface BlobOperationReplay {
  readonly subjectId: SubjectId;
  readonly resultBlob: OperationResultBlob;
  readonly lease: JobLease;
}

/** Complete blob-backed brief operation written with its lease transaction. */
export interface CompletedBlobOperationInput extends MutationReplayInput<"distill.brief"> {
  readonly subjectId: SubjectId;
  readonly resultBlob: OperationResultBlob;
  readonly lease: JobLease;
  readonly completedAt: IsoDateTime;
}

/** Durable event fields written in the same transaction as their operation. */
export interface MutationEventInput {
  readonly eventId: EventId;
  readonly event: EngineEvent;
  readonly actor: ActorContext;
  readonly requestId: RequestId;
  readonly reason?: string;
  readonly relatedVersionId?: VersionId;
}

interface OperationRow {
  readonly method: unknown;
  readonly scope_subject_id: unknown;
  readonly actor_json: unknown;
  readonly input_checksum: unknown;
  readonly result_json: unknown;
  readonly completed_at: unknown;
  readonly existing_subject_id: unknown;
  readonly result_blob_digest: unknown;
  readonly result_blob_byte_length: unknown;
  readonly authority_blob_byte_length: unknown;
}

interface VerifiedOperationRow {
  readonly method: SqliteLedgerMethod;
  readonly subjectId: SubjectId;
  readonly completedAt: IsoDateTime;
  readonly inputChecksum: FactChecksum;
  readonly resultJson: string;
  readonly resultBlob?: OperationResultBlob;
}

interface EventOperationRow {
  readonly scope_subject_id: unknown;
  readonly actor_json: unknown;
}

const parseJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is not valid JSON.`, error);
  }
};

const storedText = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${label} is invalid.`);
  return value;
};

const storedSafeInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageCorrupt(`SQLite ${label} is invalid.`);
  }
  return value;
};

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError && error.code === "storage_corrupt") throw error;
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const runInsert = (write: () => void, label: string): void => {
  try {
    write();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw storageCorrupt(`SQLite could not persist ${label}.`, error);
  }
};

const parseOperationResult = <M extends SqliteInlineLedgerMethod>(
  method: M,
  resultJson: string,
): LedgerResult<M> => {
  const parsed = parseStored(
    () => engineMethodSchemas[method].result.parse(parseJson(resultJson, "operation result")),
    "operation result",
  );
  if (canonicalJson(parsed) !== resultJson) {
    throw storageCorrupt("SQLite operation result is not canonically encoded.");
  }
  return parsed;
};

const operationResultSubjectId = (
  method: SqliteLedgerMethod,
  result: EngineMethodMap[SqliteLedgerMethod]["result"],
): SubjectId | undefined => {
  switch (method) {
    case "subjects.create":
      return (result as SubjectSummary).id;
    case "materials.ingest":
      return (result as IngestResult).subject.id;
    case "materials.ingestFiles":
      return (result as IngestFilesResult).subject.id;
    case "distill.brief":
      return (result as HostDistillBriefing).subject.id;
    case "distill.commit":
    case "profiles.correct": {
      const commit = result as CommitResult;
      return commit.kind === "current" ? commit.version.subjectId : commit.candidate.subjectId;
    }
    case "versions.promote":
    case "versions.reject":
    case "versions.rollback":
      return (result as VersionSummary).subjectId;
    case "hosts.install":
    case "hosts.export":
      return (result as { readonly subjectId: SubjectId }).subjectId;
    case "distill.renew":
    case "distill.release":
    case "hosts.uninstall":
      return undefined;
  }
};

const isSqliteLedgerMethod = (value: string): value is SqliteLedgerMethod =>
  value === "subjects.create" ||
  value === "materials.ingest" ||
  value === "materials.ingestFiles" ||
  value === "distill.brief" ||
  value === "distill.renew" ||
  value === "distill.release" ||
  value === "distill.commit" ||
  value === "profiles.correct" ||
  value === "versions.promote" ||
  value === "versions.reject" ||
  value === "versions.rollback" ||
  value === "hosts.install" ||
  value === "hosts.uninstall" ||
  value === "hosts.export";

interface BriefTemplateOperationEnvelope {
  readonly kind: "brief_template_v1";
  readonly requestId: RequestId;
  readonly inputChecksum: FactChecksum;
  readonly subjectId: SubjectId;
  readonly resultBlob: OperationResultBlob;
  readonly lease: JobLease;
}

const object = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw storageCorrupt(`SQLite ${label} is invalid.`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const parseBriefTemplateEnvelope = (resultJson: string): BriefTemplateOperationEnvelope => {
  const raw = object(parseJson(resultJson, "brief template envelope"), "brief template envelope");
  if (raw.kind !== "brief_template_v1") {
    throw storageCorrupt("SQLite brief template envelope kind is invalid.");
  }
  const pointer = object(raw.resultBlob, "brief template blob pointer");
  const envelope: BriefTemplateOperationEnvelope = {
    kind: "brief_template_v1",
    requestId: parseStored(() => requestIdSchema.parse(raw.requestId), "brief template request id"),
    inputChecksum: parseStored(
      () => factChecksumSchema.parse(raw.inputChecksum),
      "brief template input checksum",
    ),
    subjectId: parseStored(() => subjectIdSchema.parse(raw.subjectId), "brief template subject id"),
    resultBlob: {
      digest: parseStored(
        () => contentDigestSchema.parse(pointer.digest),
        "brief template blob digest",
      ),
      byteLength: storedSafeInteger(pointer.byteLength, "brief template blob byte length"),
    },
    lease: parseStored(
      () => jobLeaseSchema.parse(raw.lease) as JobLease,
      "brief template final lease",
    ),
  };
  if (canonicalJson(envelope) !== resultJson) {
    throw storageCorrupt("SQLite brief template envelope is not canonically encoded.");
  }
  return envelope;
};

const readVerifiedOperation = <M extends SqliteLedgerMethod>(
  database: DatabaseSync,
  input: MutationReplayInput<M>,
): VerifiedOperationRow | undefined => {
  const requestId = parseStored(() => requestIdSchema.parse(input.requestId), "request id");
  const expectedChecksum = parseStored(
    () => factChecksumSchema.parse(input.inputChecksum),
    "input checksum",
  );
  const expectedActor = parseStored(
    () => actorContextSchema.parse(input.actor),
    "expected operation actor",
  );
  let row: OperationRow | undefined;
  try {
    row = database
      .prepare(
        `SELECT operations.method, operations.scope_subject_id, operations.actor_json,
                operations.input_checksum, operations.result_json, operations.completed_at,
                subjects.id AS existing_subject_id,
                operation_result_blobs.blob_digest AS result_blob_digest,
                operation_result_blobs.byte_length AS result_blob_byte_length,
                blobs.byte_length AS authority_blob_byte_length
         FROM operations
         LEFT JOIN subjects ON subjects.id = operations.scope_subject_id
         LEFT JOIN operation_result_blobs
           ON operation_result_blobs.request_id = operations.request_id
         LEFT JOIN blobs ON blobs.digest = operation_result_blobs.blob_digest
         WHERE operations.request_id = ?`,
      )
      .get(requestId) as OperationRow | undefined;
  } catch (error) {
    throw storageCorrupt("SQLite could not read the mutation ledger.", error);
  }
  if (row === undefined) return undefined;

  const storedMethodText = storedText(row.method, "operation method");
  if (!isSqliteLedgerMethod(storedMethodText)) {
    throw storageCorrupt("SQLite operation method is unsupported by its storage schema.");
  }
  const scopeSubjectId = parseStored(
    () => subjectIdSchema.parse(storedText(row.scope_subject_id, "operation subject scope")),
    "operation subject scope",
  );
  const existingSubjectId = parseStored(
    () =>
      subjectIdSchema.parse(
        storedText(row.existing_subject_id, "operation existing subject scope"),
      ),
    "operation existing subject scope",
  );
  if (existingSubjectId !== scopeSubjectId) {
    throw storageCorrupt("SQLite operation scope does not resolve to its subject authority row.");
  }
  const actorJson = storedText(row.actor_json, "operation actor");
  const actor = parseStored(
    () => actorContextSchema.parse(parseJson(actorJson, "operation actor")),
    "operation actor",
  );
  if (canonicalJson(actor) !== actorJson) {
    throw storageCorrupt("SQLite operation actor is not canonically encoded.");
  }
  const storedChecksum = parseStored(
    () => factChecksumSchema.parse(storedText(row.input_checksum, "operation input checksum")),
    "operation input checksum",
  );
  const completedAt = parseStored(
    () => isoDateTimeSchema.parse(storedText(row.completed_at, "operation completion time")),
    "operation completion time",
  );

  if (storedMethodText !== input.method || storedChecksum !== expectedChecksum) {
    throw idempotencyConflict("RequestId was already used by a different mutation input.");
  }
  if (canonicalJson(actor) !== canonicalJson(expectedActor)) {
    throw storageCorrupt("SQLite operation actor disagrees with its trusted mutation identity.");
  }

  const resultJson = storedText(row.result_json, "operation result");
  const digestValue = row.result_blob_digest;
  if (digestValue === null) {
    if (row.result_blob_byte_length !== null || row.authority_blob_byte_length !== null) {
      throw storageCorrupt("SQLite operation result blob metadata is incomplete.");
    }
    return {
      method: storedMethodText,
      subjectId: scopeSubjectId,
      completedAt,
      inputChecksum: storedChecksum,
      resultJson,
    };
  }
  const digest = parseStored(
    () => contentDigestSchema.parse(storedText(digestValue, "operation result blob digest")),
    "operation result blob digest",
  );
  const byteLength = storedSafeInteger(
    row.result_blob_byte_length,
    "operation result blob byte length",
  );
  const authorityByteLength = storedSafeInteger(
    row.authority_blob_byte_length,
    "operation result authority blob byte length",
  );
  if (byteLength !== authorityByteLength) {
    throw storageCorrupt("SQLite operation result blob metadata disagrees with blob authority.");
  }
  const resultBlob = { digest, byteLength } satisfies OperationResultBlob;
  return {
    method: storedMethodText,
    subjectId: scopeSubjectId,
    completedAt,
    inputChecksum: storedChecksum,
    resultJson,
    resultBlob,
  };
};

/**
 * Hashes normalized mutation parameters together with their trusted actor.
 *
 * The RequestId is deliberately excluded so a retry compares the actual mutation identity.
 *
 * @param method - Mutation method discriminant included in the digest.
 * @param normalizedParams - Canonical transaction input for the method.
 * @param actor - Trusted actor bound to the client session.
 * @param trustedSession - Additional trusted session fields for the mutation, when any.
 * @returns The full canonical mutation checksum.
 */
export const computeMutationInputChecksum = (
  method: SqliteLedgerMethod,
  normalizedParams: unknown,
  actor: ActorContext,
  trustedSession?: unknown,
): FactChecksum =>
  computeFactChecksum({
    method,
    params: normalizedParams,
    actor,
    ...(trustedSession === undefined ? {} : { trustedSession }),
  });

/**
 * Replays one exact completed mutation or rejects any global RequestId reuse.
 *
 * Result JSON is parsed with the Protocol schema for the stored method before it leaves storage.
 *
 * @param database - Database connection inside the caller's active transaction.
 * @param input - Expected global RequestId, method, and normalized input checksum.
 * @returns The strictly parsed stored result, or undefined when the RequestId is unused.
 */
export const replayCompletedMutation = <M extends SqliteInlineLedgerMethod>(
  database: DatabaseSync,
  input: MutationReplayInput<M>,
): LedgerResult<M> | undefined => {
  const row = readVerifiedOperation(database, input);
  if (row === undefined) return undefined;
  if (row.resultBlob !== undefined) {
    throw storageCorrupt("An inline operation unexpectedly references a result blob.");
  }
  const result = parseOperationResult(input.method, row.resultJson);
  const resultSubjectId = operationResultSubjectId(input.method, result);
  if (resultSubjectId !== undefined && resultSubjectId !== row.subjectId) {
    throw storageCorrupt("SQLite operation result disagrees with its subject scope.");
  }
  return result;
};

/**
 * Replays the verified immutable pointer for one completed blob-backed brief.
 *
 * The caller must read and validate the bytes through ContentAddressedBlobStore before parsing the
 * Protocol result. Keeping file I/O outside the synchronous SQLite callback preserves short reads.
 *
 * @param database - Database connection inside a consistent read or write transaction.
 * @param input - Expected brief mutation identity.
 * @returns The referenced template blob and exact lease overlay, or undefined when unused.
 */
export const replayCompletedBlobMutation = (
  database: DatabaseSync,
  input: MutationReplayInput<"distill.brief">,
): BlobOperationReplay | undefined => {
  const row = readVerifiedOperation(database, input);
  if (row === undefined) return undefined;
  if (row.resultBlob === undefined) {
    throw storageCorrupt("A blob-backed brief operation is missing its result blob.");
  }
  const envelope = parseBriefTemplateEnvelope(row.resultJson);
  if (
    envelope.requestId !== input.requestId ||
    envelope.inputChecksum !== row.inputChecksum ||
    envelope.subjectId !== row.subjectId ||
    envelope.resultBlob.digest !== row.resultBlob.digest ||
    envelope.resultBlob.byteLength !== row.resultBlob.byteLength ||
    envelope.lease.acquiredAt !== row.completedAt
  ) {
    throw storageCorrupt("SQLite brief template envelope disagrees with its operation authority.");
  }
  return { subjectId: row.subjectId, resultBlob: row.resultBlob, lease: envelope.lease };
};

/**
 * Inserts one successful operation into the global RequestId ledger.
 *
 * @param database - Database connection inside the caller's active write transaction.
 * @param input - Validated operation identity, actor, result, scope, and completion time.
 */
export const insertCompletedOperationInTransaction = <M extends SqliteInlineLedgerMethod>(
  database: DatabaseSync,
  input: CompletedOperationInput<M>,
): void => {
  const requestId = parseStored(() => requestIdSchema.parse(input.requestId), "request id");
  const subjectId = parseStored(
    () => subjectIdSchema.parse(input.subjectId),
    "operation subject id",
  );
  const actor = parseStored(() => actorContextSchema.parse(input.actor), "operation actor");
  const inputChecksum = parseStored(
    () => factChecksumSchema.parse(input.inputChecksum),
    "operation input checksum",
  );
  const completedAt = parseStored(
    () => isoDateTimeSchema.parse(input.completedAt),
    "operation completion time",
  );
  const result = parseStored(
    () => engineMethodSchemas[input.method].result.parse(input.result),
    "operation result",
  ) as LedgerResult<M>;
  const resultSubjectId = operationResultSubjectId(input.method, result);
  if (resultSubjectId !== undefined && resultSubjectId !== subjectId) {
    throw storageCorrupt("A completed operation result disagrees with its subject scope.");
  }

  runInsert(() => {
    database
      .prepare(
        `INSERT INTO operations(
           request_id, method, scope_subject_id, actor_json,
           input_checksum, result_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        input.method,
        subjectId,
        canonicalJson(actor),
        inputChecksum,
        canonicalJson(result),
        completedAt,
      );
  }, "a completed operation");
};

/**
 * Inserts a canonical blob-backed `distill.brief` operation and its reachability edge.
 *
 * @param database - Database connection inside the lease write transaction.
 * @param input - Template pointer, exact final lease, actor, and operation identity.
 */
export const insertCompletedBlobOperationInTransaction = (
  database: DatabaseSync,
  input: CompletedBlobOperationInput,
): void => {
  const requestId = parseStored(() => requestIdSchema.parse(input.requestId), "request id");
  const subjectId = parseStored(
    () => subjectIdSchema.parse(input.subjectId),
    "operation subject id",
  );
  const actor = parseStored(() => actorContextSchema.parse(input.actor), "operation actor");
  const inputChecksum = parseStored(
    () => factChecksumSchema.parse(input.inputChecksum),
    "operation input checksum",
  );
  const completedAt = parseStored(
    () => isoDateTimeSchema.parse(input.completedAt),
    "operation completion time",
  );
  const lease = parseStored(
    () => jobLeaseSchema.parse(input.lease) as JobLease,
    "completed brief lease",
  );
  if (lease.acquiredAt !== completedAt) {
    throw storageCorrupt("A completed brief lease disagrees with its operation completion time.");
  }
  const digest = parseStored(
    () => contentDigestSchema.parse(input.resultBlob.digest),
    "operation result blob digest",
  );
  const byteLength = storedSafeInteger(
    input.resultBlob.byteLength,
    "operation result blob byte length",
  );
  const blobRow = database.prepare("SELECT byte_length FROM blobs WHERE digest = ?").get(digest) as
    { readonly byte_length?: unknown } | undefined;
  if (
    blobRow === undefined ||
    storedSafeInteger(blobRow.byte_length, "operation result authority blob byte length") !==
      byteLength
  ) {
    throw storageCorrupt("A completed brief result is missing its blob authority row.");
  }
  const envelope: BriefTemplateOperationEnvelope = {
    kind: "brief_template_v1",
    requestId,
    inputChecksum,
    subjectId,
    resultBlob: { digest, byteLength },
    lease,
  };

  runInsert(() => {
    database
      .prepare(
        `INSERT INTO operations(
           request_id, method, scope_subject_id, actor_json,
           input_checksum, result_json, completed_at
         ) VALUES (?, 'distill.brief', ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        subjectId,
        canonicalJson(actor),
        inputChecksum,
        canonicalJson(envelope),
        completedAt,
      );
    database
      .prepare(
        `INSERT INTO operation_result_blobs(request_id, blob_digest, byte_length)
         VALUES (?, ?, ?)`,
      )
      .run(requestId, digest, byteLength);
  }, "a blob-backed completed operation");
};

/**
 * Inserts one checksummed event record into the caller's active transaction.
 *
 * @param database - Database connection inside the caller's active write transaction.
 * @param input - Request-correlated event fields to seal and persist.
 * @returns The exact sealed event record written to SQLite.
 */
export const insertEventInTransaction = (
  database: DatabaseSync,
  input: MutationEventInput,
): EventRecord => {
  const record = parseStored(
    () =>
      eventRecordSchema.parse(
        sealFact<EventRecord>({
          schemaVersion: 1,
          eventId: input.eventId,
          event: input.event,
          actor: input.actor,
          requestId: input.requestId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.relatedVersionId === undefined
            ? {}
            : { relatedVersionId: input.relatedVersionId }),
        }),
      ) as EventRecord,
    "event record",
  );
  verifyFactChecksum(record);
  if (record.event.subjectId === undefined) {
    throw storageCorrupt("A mutation event is missing its subject scope.");
  }
  if (record.requestId === undefined) {
    throw storageCorrupt("A mutation event is missing its request scope.");
  }
  const requestId = record.requestId;
  const subjectId = record.event.subjectId;
  let operation: EventOperationRow | undefined;
  try {
    operation = database
      .prepare(
        `SELECT scope_subject_id, actor_json
         FROM operations
         WHERE request_id = ?`,
      )
      .get(requestId) as EventOperationRow | undefined;
  } catch (error) {
    throw storageCorrupt("SQLite could not read the event's mutation operation.", error);
  }
  if (operation === undefined) {
    throw storageCorrupt("A mutation event is missing its completed operation.");
  }
  const operationSubjectId = parseStored(
    () =>
      subjectIdSchema.parse(
        storedText(operation.scope_subject_id, "event operation subject scope"),
      ),
    "event operation subject scope",
  );
  if (operationSubjectId !== subjectId) {
    throw storageCorrupt("A mutation event disagrees with its operation subject scope.");
  }
  const operationActorJson = storedText(operation.actor_json, "event operation actor");
  const operationActor = parseStored(
    () => actorContextSchema.parse(parseJson(operationActorJson, "event operation actor")),
    "event operation actor",
  );
  if (canonicalJson(operationActor) !== operationActorJson) {
    throw storageCorrupt("SQLite event operation actor is not canonically encoded.");
  }
  if (canonicalJson(operationActor) !== canonicalJson(record.actor)) {
    throw storageCorrupt("A mutation event disagrees with its operation actor.");
  }

  runInsert(() => {
    database
      .prepare(
        `INSERT INTO events(
           event_id, request_id, subject_id, actor_json, event_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.eventId,
        requestId,
        subjectId,
        canonicalJson(record.actor),
        canonicalJson(record),
        record.event.at,
      );
  }, "an event record");
  return record;
};
