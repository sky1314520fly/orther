import { createHash } from "node:crypto";

import type { FactChecksum, FactEnvelope } from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { canonicalJsonBytes } from "./canonical-json.js";

type FactPayload<T extends FactEnvelope> = Omit<T, "checksum">;

const withoutChecksum = (record: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "checksum") payload[key] = value;
  }
  return payload;
};

/**
 * Returns a full lowercase SHA-256 hex digest.
 *
 * @param value - Text or bytes to hash.
 * @returns The full lowercase hexadecimal digest.
 */
export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Computes the checksum over a fact after removing its checksum field.
 *
 * @param record - Fact-shaped record whose payload should be hashed.
 * @returns The canonical fact checksum.
 */
export const computeFactChecksum = (record: Readonly<Record<string, unknown>>): FactChecksum =>
  `fact_sha256_${sha256Hex(canonicalJsonBytes(withoutChecksum(record)))}` as FactChecksum;

/**
 * Adds the deterministic checksum to one already-normalized fact payload.
 *
 * @param payload - Schema-normalized fact payload without a checksum.
 * @returns The complete fact with its deterministic checksum.
 */
export const sealFact = <T extends FactEnvelope>(payload: FactPayload<T>): T => {
  const checksum = computeFactChecksum(payload);
  return { ...payload, checksum } as T;
};

/**
 * Rejects a parsed fact whose checksum does not cover its complete payload.
 *
 * @param record - Parsed fact to verify.
 */
export const verifyFactChecksum = (record: FactEnvelope): void => {
  const actual = computeFactChecksum(record as unknown as Readonly<Record<string, unknown>>);
  if (actual !== record.checksum) {
    throw storageCorrupt("Fact checksum does not match its canonical payload.");
  }
};
