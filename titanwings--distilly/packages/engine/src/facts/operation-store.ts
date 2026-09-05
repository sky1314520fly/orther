import {
  DistillyError,
  operationFactSchema,
  operationRecordSchema,
  requestIdSchema,
} from "@distilly/protocol";
import type {
  CommitResult,
  OperationFact,
  OperationRecord,
  RequestId,
  RuntimeSchema,
  SubjectId,
} from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { createFactFile, readFactFile } from "./fact-file.js";
import { listFactDirectory } from "./directory-scan.js";
import type { FileSubjectStore } from "./subject-store.js";

const storedOperationFactSchema: RuntimeSchema<OperationFact> = {
  parse(value) {
    return operationFactSchema.parse(value) as OperationFact;
  },
};

const completedOperationSchema: RuntimeSchema<OperationRecord> = {
  parse(value) {
    return operationRecordSchema.parse(value) as OperationRecord;
  },
};

const isFileCollision = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const OPERATION_FILE_PATTERN = /^(req_[0-9a-f]{32})\.json$/u;
const OPERATION_TEMP_PATTERN = /^\.req_[0-9a-f]{32}\.json\.[1-9][0-9]*\.[0-9a-f]{16}\.tmp$/u;

const requireSubject = async (subjects: FileSubjectStore, subjectId: SubjectId): Promise<void> => {
  try {
    await subjects.read(subjectId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("Operation fact references a missing subject.", error);
    }
    throw error;
  }
};

const commitSubjectIds = (result: CommitResult): readonly SubjectId[] =>
  result.kind === "current"
    ? [result.version.subjectId, result.profile.subjectId]
    : [result.candidate.subjectId, result.review.subjectId];

const assertNever = (value: never): never => {
  throw storageCorrupt(`Unsupported operation method: ${String(value)}`);
};

const resultSubjectIds = (record: OperationRecord): readonly SubjectId[] => {
  switch (record.method) {
    case "subjects.create":
      return [record.result.id];
    case "subjects.archive":
    case "distill.renew":
    case "distill.release":
    case "hosts.uninstall":
    case "library.rebuild":
    case "bundles.export":
      return [];
    case "subjects.purge":
      return [record.result.subjectId];
    case "materials.ingest":
    case "materials.ingestFiles":
      return [record.result.subject.id];
    case "distill.brief":
      return [record.result.subject.id, record.result.job.subjectId];
    case "distill.commit":
    case "profiles.correct":
      return commitSubjectIds(record.result);
    case "distill.redistill":
      return [record.result.subjectId];
    case "versions.promote":
    case "versions.reject":
    case "versions.rollback":
      return [record.result.subjectId];
    case "hosts.install":
    case "hosts.export":
      return [record.result.subjectId];
    case "bundles.import":
      return [
        record.result.subject.id,
        record.result.candidate.subjectId,
        record.result.review.subjectId,
      ];
    default:
      return assertNever(record);
  }
};

const assertScopeKind = (record: OperationFact): void => {
  const expected = record.method === "library.rebuild" ? "global" : "subject";
  if (record.scope.kind !== expected) {
    throw storageCorrupt("Operation scope does not match its mutation method.");
  }
};

const assertCompletedSubject = (record: OperationRecord): SubjectId | undefined => {
  assertScopeKind(record);
  if (record.scope.kind === "global") return undefined;
  const scopedSubjectId = record.scope.subjectId;
  if (resultSubjectIds(record).some((subjectId) => subjectId !== scopedSubjectId)) {
    throw storageCorrupt("Operation result subject does not match its durable scope.");
  }
  return scopedSubjectId;
};

/** Concrete root-scoped store for immutable completed-operation facts and purge tombstones. */
export class FileOperationStore {
  readonly #layout: Layout;
  readonly #subjects: FileSubjectStore;

  /**
   * Creates a root-scoped operation store with its subject-fact dependency.
   *
   * @param layout - Confined local fact layout.
   * @param subjects - Store used to validate completed subject-scoped facts.
   */
  constructor(layout: Layout, subjects: FileSubjectStore) {
    this.#layout = layout;
    this.#subjects = subjects;
  }

  /**
   * Publishes one completed operation or accepts an exact immutable retry.
   *
   * @param record - Complete checksummed operation fact to publish.
   */
  async write(record: OperationRecord): Promise<void> {
    let parsed: OperationRecord;
    try {
      parsed = completedOperationSchema.parse(record);
    } catch (error) {
      throw storageCorrupt(
        "Operation fact cannot be written because its schema is invalid.",
        error,
      );
    }
    const subjectId = assertCompletedSubject(parsed);
    if (subjectId !== undefined) await requireSubject(this.#subjects, subjectId);

    const path = this.#layout.operationFile(parsed.requestId);
    try {
      await createFactFile(this.#layout.root, path, parsed, completedOperationSchema);
    } catch (error) {
      if (!isFileCollision(error)) throw error;
      const existing = await this.read(parsed.requestId);
      if (existing.recordKind === "completed" && existing.checksum === parsed.checksum) return;
      throw storageCorrupt("Immutable request id already contains a different operation.", error);
    }
  }

  /**
   * Reads a completed operation or content-free purge tombstone by root RequestId.
   *
   * @param requestId - Globally unique request identifier.
   * @returns The verified completed operation or purge tombstone.
   */
  async read(requestId: RequestId): Promise<OperationFact> {
    const record = await readFactFile(
      this.#layout.root,
      this.#layout.operationFile(requestId),
      storedOperationFactSchema,
    );
    if (record.requestId !== requestId) {
      throw storageCorrupt("Operation request id does not match its fact path.");
    }
    assertScopeKind(record);
    if (record.recordKind === "completed") {
      const subjectId = assertCompletedSubject(record);
      if (subjectId !== undefined) await requireSubject(this.#subjects, subjectId);
    }
    return record;
  }

  /**
   * Reads one operation fact or returns undefined only when its exact path is absent.
   *
   * @param requestId - Globally unique request identifier.
   * @returns The verified operation fact, or undefined when absent.
   */
  async readOptional(requestId: RequestId): Promise<OperationFact | undefined> {
    try {
      return await this.read(requestId);
    } catch (error) {
      if (error instanceof DistillyError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  /**
   * Lists every verified operation fact in canonical RequestId order.
   *
   * @returns All completed operations and purge tombstones.
   */
  async list(): Promise<readonly OperationFact[]> {
    const records: OperationFact[] = [];
    for (const entry of await listFactDirectory(
      this.#layout.root,
      this.#layout.operationsDirectory(),
    )) {
      if (entry.name === ".locks" && entry.kind === "directory") continue;
      if (OPERATION_TEMP_PATTERN.test(entry.name) && entry.kind === "file") continue;
      const match = OPERATION_FILE_PATTERN.exec(entry.name);
      if (match === null || entry.kind !== "file") {
        throw storageCorrupt("Operations directory contains an unknown entry.");
      }
      records.push(await this.read(requestIdSchema.parse(match[1])));
    }
    return records;
  }
}
