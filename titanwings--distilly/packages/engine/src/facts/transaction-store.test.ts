import {
  DistillyError,
  briefContractDigestSchema,
  eventIdSchema,
  factChecksumSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialSetHashSchema,
  requestIdSchema,
  subjectIdSchema,
  transactionRecordSchema,
} from "@distilly/protocol";
import type {
  DistillLeaseTransactionRecord,
  DistillyErrorCode,
  EventRecord,
  OperationRecord,
  RequestId,
  RuntimeSchema,
  TransactionRecord,
} from "@distilly/protocol";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Layout } from "../layout.js";
import { computeFactChecksum, sealFact } from "./checksum.js";
import { replaceFactFile } from "./fact-file.js";
import { FileTransactionStore } from "../testing/legacy-file-transaction-store.test.fixture.js";

const ZERO_32 = "0".repeat(32);
const ONE_32 = "1".repeat(32);
const TWO_32 = "2".repeat(32);
const ZERO_64 = "0".repeat(64);
const ONE_64 = "1".repeat(64);
const REQUEST_ID = requestIdSchema.parse(`req_${ZERO_32}`);
const OTHER_REQUEST_ID = requestIdSchema.parse(`req_${ONE_32}`);
const THIRD_REQUEST_ID = requestIdSchema.parse(`req_${TWO_32}`);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${ZERO_32}`);
const AT = isoDateTimeSchema.parse("2026-08-20T00:00:00.000Z");
const LATER = isoDateTimeSchema.parse("2026-08-20T00:01:00.000Z");
const OTHER_CHECKSUM = factChecksumSchema.parse(`fact_sha256_${ONE_64}`);
const MATERIAL_SET_HASH = materialSetHashSchema.parse(`set_sha256_${ZERO_64}`);
const BRIEF_CONTRACT_DIGEST = briefContractDigestSchema.parse(`brief_contract_${ZERO_64}`);
const ACTOR = { kind: "sdk", id: "transaction-store-test" } as const;
const TRANSACTION_SCHEMA: RuntimeSchema<TransactionRecord> = {
  parse(value) {
    return transactionRecordSchema.parse(value) as TransactionRecord;
  },
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-transaction-store-"));
  roots.push(root);
  return root;
};

const expectCode = async (promise: Promise<unknown>, code: DistillyErrorCode): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect((error as DistillyError).code).toBe(code);
  }
};

const suffixOf = (requestId: RequestId): string => requestId.slice("req_".length);

const makePrepared = (requestId: RequestId): DistillLeaseTransactionRecord => {
  const suffix = suffixOf(requestId);
  const jobId = jobIdSchema.parse(`job_${suffix}`);
  const previousPending = {
    jobId,
    generation: 1,
    materialSetHash: MATERIAL_SET_HASH,
    addedMaterialCount: 0,
    totalMaterialCount: 0,
    queuedAt: AT,
    lease: {
      id: leaseIdSchema.parse(`lease_${suffix}`),
      owner: leaseOwnerIdSchema.parse(`lease_owner_${suffix}`),
      acquiredAt: AT,
      expiresAt: LATER,
      contract: {
        digest: BRIEF_CONTRACT_DIGEST,
        sourceGroupingVersion: "source-groups-v1",
        promptVersion: `host-distill-v1-sha256_${ZERO_64}` as const,
        draftSchemaVersion: 1,
      },
    },
  } as const;
  const operation = sealFact<OperationRecord<"distill.release">>({
    schemaVersion: 1,
    recordKind: "completed",
    requestId,
    method: "distill.release",
    scope: { kind: "subject", subjectId: SUBJECT_ID },
    actor: ACTOR,
    inputChecksum: computeFactChecksum({ method: "distill.release", requestId }),
    result: null,
    completedAt: AT,
  });
  const event = sealFact<EventRecord>({
    schemaVersion: 1,
    eventId: eventIdSchema.parse(`event_${suffix}`),
    event: { kind: "job.changed", subjectId: SUBJECT_ID, at: AT },
    actor: ACTOR,
    requestId,
  });
  const payload = {
    schemaVersion: 1,
    transactionKind: "distill_lease",
    method: "release",
    requestId,
    subjectId: SUBJECT_ID,
    jobId,
    previousStateChecksum: computeFactChecksum({ state: "previous", requestId }),
    targetStateChecksum: computeFactChecksum({ state: "target", requestId }),
    previousPending,
    targetPending: {
      jobId,
      generation: previousPending.generation,
      materialSetHash: previousPending.materialSetHash,
      addedMaterialCount: previousPending.addedMaterialCount,
      totalMaterialCount: previousPending.totalMaterialCount,
      queuedAt: previousPending.queuedAt,
    },
    operation,
    event,
    preparedAt: AT,
    state: "prepared",
  } as const;
  return transactionRecordSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  }) as DistillLeaseTransactionRecord;
};

const withOperation = (
  prepared: DistillLeaseTransactionRecord,
  operation: OperationRecord<"distill.release">,
): DistillLeaseTransactionRecord => {
  if (prepared.state !== "prepared" || prepared.method !== "release") {
    throw new Error("Expected a prepared release transaction.");
  }
  const { checksum: _checksum, ...base } = prepared;
  void _checksum;
  const payload = { ...base, operation };
  return transactionRecordSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  }) as DistillLeaseTransactionRecord;
};

const finish = (
  prepared: DistillLeaseTransactionRecord,
  state: "committed" | "aborted",
): DistillLeaseTransactionRecord => {
  if (prepared.state !== "prepared") throw new Error("Expected a prepared transaction.");
  const { checksum: _checksum, state: _state, ...base } = prepared;
  void _checksum;
  void _state;
  const payload = { ...base, state, finishedAt: LATER } as const;
  return transactionRecordSchema.parse({
    ...payload,
    checksum: computeFactChecksum(payload),
  }) as DistillLeaseTransactionRecord;
};

describe("FileTransactionStore", () => {
  it("lists verified records and enforces lifecycle transitions", async () => {
    const root = await createRoot();
    const layout = new Layout(root);
    const transactions = new FileTransactionStore(layout);
    const later = makePrepared(OTHER_REQUEST_ID);
    const first = makePrepared(REQUEST_ID);
    await transactions.write(later);
    await transactions.write(first);
    await expect(transactions.readOptional(THIRD_REQUEST_ID)).resolves.toBeUndefined();
    expect((await transactions.list()).map((record) => record.requestId)).toEqual([
      REQUEST_ID,
      OTHER_REQUEST_ID,
    ]);

    const committed = finish(first, "committed");
    await transactions.write(committed);
    await transactions.write(committed);
    await expect(transactions.read(REQUEST_ID)).resolves.toEqual(committed);
    await expectCode(transactions.write(first), "storage_corrupt");
    await expectCode(
      transactions.write(finish(makePrepared(THIRD_REQUEST_ID), "committed")),
      "storage_corrupt",
    );

    const aborted = finish(later, "aborted");
    await transactions.write(aborted);
    await transactions.write(later);
    await transactions.write(aborted);
    if (later.state !== "prepared" || later.method !== "release") {
      throw new Error("Expected a prepared release transaction.");
    }
    const changedOperation = sealFact<OperationRecord<"distill.release">>({
      ...later.operation,
      inputChecksum: OTHER_CHECKSUM,
    });
    await expectCode(transactions.write(withOperation(later, changedOperation)), "storage_corrupt");

    await replaceFactFile(
      root,
      layout.transactionFile(REQUEST_ID),
      makePrepared(OTHER_REQUEST_ID),
      TRANSACTION_SCHEMA,
    );
    await expectCode(transactions.read(REQUEST_ID), "storage_corrupt");
    await replaceFactFile(root, layout.transactionFile(REQUEST_ID), committed, TRANSACTION_SCHEMA);
    await writeFile(
      layout.transactionFile(REQUEST_ID),
      `${JSON.stringify({ ...committed, state: "aborted" })}\n`,
    );
    await expectCode(transactions.read(REQUEST_ID), "storage_corrupt");
    await replaceFactFile(root, layout.transactionFile(REQUEST_ID), committed, TRANSACTION_SCHEMA);

    await writeFile(
      join(
        layout.transactionsDirectory(),
        `.${THIRD_REQUEST_ID}.json.${process.pid}.${"a".repeat(16)}.tmp`,
      ),
      "partial",
    );
    expect((await transactions.list()).map((record) => record.requestId)).toEqual([
      REQUEST_ID,
      OTHER_REQUEST_ID,
    ]);
    await writeFile(join(layout.transactionsDirectory(), "unknown.json"), "{}\n");
    await expectCode(transactions.list(), "storage_corrupt");
    await rm(join(layout.transactionsDirectory(), "unknown.json"));
    await symlink(root, join(layout.transactionsDirectory(), `${THIRD_REQUEST_ID}.json`));
    await expectCode(transactions.list(), "storage_corrupt");
  });

  it("keeps a prepared record unchanged when a terminal payload is mutated", async () => {
    const root = await createRoot();
    const transactions = new FileTransactionStore(new Layout(root));
    const prepared = makePrepared(REQUEST_ID);
    await transactions.write(prepared);
    if (prepared.state !== "prepared" || prepared.method !== "release") {
      throw new Error("Expected a prepared release transaction.");
    }
    const changedOperation = sealFact<OperationRecord<"distill.release">>({
      ...prepared.operation,
      inputChecksum: OTHER_CHECKSUM,
    });
    const changed = withOperation(prepared, changedOperation);

    for (const state of ["committed", "aborted"] as const) {
      await expectCode(transactions.write(finish(changed, state)), "storage_corrupt");
      await expect(transactions.read(REQUEST_ID)).resolves.toEqual(prepared);
    }
  });
});
