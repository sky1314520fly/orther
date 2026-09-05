import type { FactEnvelope, RuntimeSchema } from "@distilly/protocol";

import { lockBusy, schemaUnsupported, storageCorrupt } from "../internal-errors.js";
import { atomicCreateFile, atomicReplaceFile } from "./atomic-write.js";
import { canonicalJson } from "./canonical-json.js";
import { verifyFactChecksum } from "./checksum.js";
import type { ReadRegularFileHooks } from "./safe-fs.js";
import { decodeUtf8, isRegularFileReplacement, readRegularFile } from "./safe-fs.js";

const MUTABLE_READ_ATTEMPTS = 3;

/** Internal hooks for deterministic mutable-fact replacement tests. */
type ReadFactFileHooks = ReadRegularFileHooks;

const parseJson = (data: Buffer): unknown => {
  try {
    return JSON.parse(decodeUtf8(data, "Fact file")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "storage_corrupt") {
      throw error;
    }
    throw storageCorrupt("Fact file is not valid UTF-8 JSON.", error);
  }
};

const checkSchemaVersion = (value: unknown): void => {
  const schemaVersion =
    typeof value === "object" && value !== null && "schemaVersion" in value
      ? (value as { readonly schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (
    typeof schemaVersion === "number" &&
    Number.isSafeInteger(schemaVersion) &&
    schemaVersion > 0 &&
    schemaVersion !== 1 &&
    schemaVersion !== 2
  ) {
    throw schemaUnsupported("Fact schemaVersion is not supported.");
  }
};

/**
 * Parses, schema-validates, and checksum-validates one JSON fact file.
 *
 * @param root - Trusted local fact root.
 * @param path - Exact JSON fact path to read.
 * @param schema - Runtime schema for the expected fact type.
 * @param hooks - Optional deterministic race hooks used by tests.
 * @returns The schema-normalized, checksum-verified fact.
 */
export const readFactFile = async <T extends FactEnvelope>(
  root: string,
  path: string,
  schema: RuntimeSchema<T>,
  hooks: ReadFactFileHooks = {},
): Promise<T> => {
  const value = parseJson(await readRegularFile(root, path, undefined, hooks));
  checkSchemaVersion(value);

  let record: T;
  try {
    record = schema.parse(value);
  } catch (error) {
    throw storageCorrupt("Fact file does not match its runtime schema.", error);
  }
  verifyFactChecksum(record);
  return record;
};

/**
 * Reads one atomically replaced mutable fact, retrying only a proven inode-swap race.
 *
 * Immutable facts continue to use readFactFile directly so replacement remains
 * corruption at those boundaries.
 *
 * @param root - Trusted local fact root.
 * @param path - Exact mutable JSON fact path to read.
 * @param schema - Runtime schema for the expected fact type.
 * @param hooks - Optional deterministic race hooks used by tests.
 * @returns One checksum-verified old or new record.
 */
export const readMutableFactFile = async <T extends FactEnvelope>(
  root: string,
  path: string,
  schema: RuntimeSchema<T>,
  hooks: ReadFactFileHooks = {},
): Promise<T> => {
  for (let attempt = 0; attempt < MUTABLE_READ_ATTEMPTS; attempt += 1) {
    try {
      return await readFactFile(root, path, schema, hooks);
    } catch (error) {
      if (!isRegularFileReplacement(error)) throw error;
    }
  }
  throw lockBusy("A mutable fact changed repeatedly while it was being read.");
};

const encodeFact = <T extends FactEnvelope>(record: T, schema: RuntimeSchema<T>): string => {
  let parsed: T;
  try {
    parsed = schema.parse(record);
  } catch (error) {
    throw storageCorrupt("Fact cannot be written because its schema is invalid.", error);
  }
  verifyFactChecksum(parsed);
  return `${canonicalJson(parsed)}\n`;
};

/**
 * Atomically creates one immutable JSON fact.
 *
 * @param root - Trusted local fact root.
 * @param path - Exact immutable fact path to publish.
 * @param record - Complete schema-normalized fact with checksum.
 * @param schema - Runtime schema for the fact type.
 * @returns Completion after durable publication.
 */
export const createFactFile = async <T extends FactEnvelope>(
  root: string,
  path: string,
  record: T,
  schema: RuntimeSchema<T>,
): Promise<void> => atomicCreateFile(root, path, encodeFact(record, schema));

/**
 * Atomically creates or replaces one mutable JSON fact.
 *
 * @param root - Trusted local fact root.
 * @param path - Exact mutable fact path to publish.
 * @param record - Complete schema-normalized fact with checksum.
 * @param schema - Runtime schema for the fact type.
 * @returns Completion after durable replacement.
 */
export const replaceFactFile = async <T extends FactEnvelope>(
  root: string,
  path: string,
  record: T,
  schema: RuntimeSchema<T>,
): Promise<void> => atomicReplaceFile(root, path, encodeFact(record, schema));
