import { DistillyError, requestIdSchema, transactionRecordSchema } from "@distilly/protocol";
import type { RequestId, RuntimeSchema, TransactionRecord } from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { verifyFactChecksum } from "../facts/checksum.js";
import { listFactDirectory } from "../facts/directory-scan.js";
import { readMutableFactFile, replaceFactFile } from "../facts/fact-file.js";

const transactionFactSchema: RuntimeSchema<TransactionRecord> = {
  parse(value) {
    return transactionRecordSchema.parse(value) as TransactionRecord;
  },
};

const TRANSACTION_FILE_PATTERN = /^(req_[0-9a-f]{32})\.json$/u;
const TRANSACTION_TEMP_PATTERN = /^\.req_[0-9a-f]{32}\.json\.[1-9][0-9]*\.[0-9a-f]{16}\.tmp$/u;

const withoutLifecycle = (record: TransactionRecord): Readonly<Record<string, unknown>> => {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "checksum" && key !== "state" && key !== "finishedAt") payload[key] = value;
  }
  return payload;
};

const sameExactRetryPayload = (left: TransactionRecord, right: TransactionRecord): boolean =>
  canonicalJson(withoutLifecycle(left)) === canonicalJson(withoutLifecycle(right));

const verifyNestedFacts = (record: TransactionRecord): void => {
  verifyFactChecksum(record.operation);
  if (record.transactionKind === "distill_lease") {
    verifyFactChecksum(record.event);
    return;
  }
  for (const event of record.events) verifyFactChecksum(event);
};

const mayReprepareTransaction = (previous: TransactionRecord, next: TransactionRecord): boolean => {
  if (previous.transactionKind !== next.transactionKind) return false;
  switch (previous.transactionKind) {
    case "distill_lease":
      return sameExactRetryPayload(previous, next);
    case "distill_commit":
    case "review_decision":
    case "rollback":
      return sameExactRetryPayload(previous, next);
    default: {
      const exhaustive: never = previous;
      return exhaustive;
    }
  }
};

const assertTransition = (previous: TransactionRecord, next: TransactionRecord): void => {
  if (previous.checksum === next.checksum) return;
  if (previous.state === "committed") {
    throw storageCorrupt("A committed transaction can only be replayed exactly.");
  }
  if (previous.state === "prepared") {
    if (
      next.state === "prepared" ||
      canonicalJson(withoutLifecycle(previous)) !== canonicalJson(withoutLifecycle(next))
    ) {
      throw storageCorrupt("A prepared transaction can only enter an exact terminal state.");
    }
    return;
  }
  const mayReprepare = next.state === "prepared" && mayReprepareTransaction(previous, next);
  if (!mayReprepare) {
    throw storageCorrupt(
      "An aborted transaction can only reprepare its permitted immutable request payload.",
    );
  }
};

/** Root-scoped mutable store for the TransactionRecord discriminated union. */
export class FileTransactionStore {
  readonly #layout: Layout;

  /**
   * Creates a root-scoped transaction store for one fact layout.
   *
   * @param layout - Confined local fact layout.
   */
  constructor(layout: Layout) {
    this.#layout = layout;
  }

  /**
   * Creates or replaces one checksummed transaction state.
   *
   * @param record - Complete transaction record to persist.
   */
  async write(record: TransactionRecord): Promise<void> {
    let parsed: TransactionRecord;
    try {
      parsed = transactionFactSchema.parse(record);
    } catch (error) {
      throw storageCorrupt(
        "Transaction fact cannot be written because its schema is invalid.",
        error,
      );
    }
    verifyFactChecksum(parsed);
    verifyNestedFacts(parsed);
    const previous = await this.readOptional(parsed.requestId);
    if (previous === undefined) {
      if (parsed.state !== "prepared") {
        throw storageCorrupt("A transaction must begin in the prepared state.");
      }
    } else {
      assertTransition(previous, parsed);
      if (previous.checksum === parsed.checksum) return;
    }
    await replaceFactFile(
      this.#layout.root,
      this.#layout.transactionFile(parsed.requestId),
      parsed,
      transactionFactSchema,
    );
  }

  /**
   * Reads one verified root transaction.
   *
   * @param requestId - Journal request identifier.
   * @returns The verified transaction record.
   */
  async read(requestId: RequestId): Promise<TransactionRecord> {
    const record = await readMutableFactFile(
      this.#layout.root,
      this.#layout.transactionFile(requestId),
      transactionFactSchema,
    );
    if (record.requestId !== requestId) {
      throw storageCorrupt("Transaction request id does not match its fact path.");
    }
    verifyNestedFacts(record);
    return record;
  }

  /**
   * Reads one transaction or returns undefined only when its exact path is absent.
   *
   * @param requestId - Journal request identifier.
   * @returns The verified transaction record, or undefined when absent.
   */
  async readOptional(requestId: RequestId): Promise<TransactionRecord | undefined> {
    try {
      return await this.read(requestId);
    } catch (error) {
      if (error instanceof DistillyError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  /**
   * Lists every verified transaction in canonical RequestId order.
   *
   * @returns All verified transaction records.
   */
  async list(): Promise<readonly TransactionRecord[]> {
    const records: TransactionRecord[] = [];
    for (const entry of await listFactDirectory(
      this.#layout.root,
      this.#layout.transactionsDirectory(),
    )) {
      const match = TRANSACTION_FILE_PATTERN.exec(entry.name);
      if (TRANSACTION_TEMP_PATTERN.test(entry.name) && entry.kind === "file") continue;
      if (match === null || entry.kind !== "file") {
        throw storageCorrupt("Transactions directory contains an unknown entry.");
      }
      records.push(await this.read(requestIdSchema.parse(match[1])));
    }
    return records;
  }
}
