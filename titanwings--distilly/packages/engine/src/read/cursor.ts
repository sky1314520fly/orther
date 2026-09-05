import { WIRE_LIMITS } from "@distilly/protocol";
import type { JsonValue } from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { sha256Hex } from "../facts/checksum.js";
import { invalidInput, storageCorrupt } from "../internal-errors.js";

const CURSOR_PREFIX = "cursor_v1_";
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

interface CursorPayload {
  readonly method: string;
  readonly filterHash: string;
  readonly sort: readonly string[];
}

const hashFilters = (filters: JsonValue): string => `sha256_${sha256Hex(canonicalJson(filters))}`;

const encodePayload = (payload: CursorPayload): string =>
  `${CURSOR_PREFIX}${Buffer.from(canonicalJson(payload), "utf8").toString("base64url")}`;

/**
 * Creates a compact cursor bound to one method, normalized filter set, and sort tuple.
 *
 * @param method - Stable EngineMethodMap method name.
 * @param filters - Canonical JSON-safe filters excluding cursor and limit.
 * @param sort - Complete sort tuple for the last returned item.
 * @returns An opaque versioned cursor suitable for the next page request.
 */
export const encodeCursor = (
  method: string,
  filters: JsonValue,
  sort: readonly string[],
): string => {
  const cursor = encodePayload({ method, filterHash: hashFilters(filters), sort });
  if (Buffer.byteLength(cursor, "utf8") > WIRE_LIMITS.cursorBytes) {
    throw storageCorrupt("An engine-generated page cursor exceeds its wire limit.");
  }
  return cursor;
};

const parsePayload = (cursor: string): CursorPayload => {
  if (
    Buffer.byteLength(cursor, "utf8") > WIRE_LIMITS.cursorBytes ||
    !cursor.startsWith(CURSOR_PREFIX)
  ) {
    throw invalidInput("The page cursor is invalid.", "cursor");
  }
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  if (!BASE64URL.test(encoded)) throw invalidInput("The page cursor is invalid.", "cursor");

  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("Non-canonical base64url.");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidInput("The page cursor is invalid.", "cursor");
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "filterHash,method,sort"
  ) {
    throw invalidInput("The page cursor is invalid.", "cursor");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.method !== "string" ||
    typeof candidate.filterHash !== "string" ||
    !/^sha256_[0-9a-f]{64}$/u.test(candidate.filterHash) ||
    !Array.isArray(candidate.sort) ||
    candidate.sort.length === 0 ||
    candidate.sort.some((part) => typeof part !== "string")
  ) {
    throw invalidInput("The page cursor is invalid.", "cursor");
  }
  const parsed: CursorPayload = {
    method: candidate.method,
    filterHash: candidate.filterHash,
    sort: candidate.sort as string[],
  };
  if (canonicalJson(parsed) !== bytes.toString("utf8")) {
    throw invalidInput("The page cursor is not canonical.", "cursor");
  }
  return parsed;
};

/**
 * Decodes a cursor and rejects reuse across methods or normalized filter sets.
 *
 * @param cursor - Untrusted opaque cursor from a public query.
 * @param method - Method that is consuming the cursor.
 * @param filters - Current normalized filters excluding cursor and limit.
 * @returns The complete sort tuple of the prior page boundary.
 */
export const decodeCursor = (
  cursor: string,
  method: string,
  filters: JsonValue,
): readonly string[] => {
  const payload = parsePayload(cursor);
  if (payload.method !== method || payload.filterHash !== hashFilters(filters)) {
    throw invalidInput("The page cursor does not belong to this query.", "cursor");
  }
  return payload.sort;
};
