import { invalidInput } from "../internal-errors.js";

const encodeNumber = (value: number): string => {
  if (!Number.isFinite(value)) throw invalidInput("Canonical JSON accepts only finite numbers.");
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
};

const encode = (value: unknown, active: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value !== "object") {
    throw invalidInput("Canonical JSON accepts only JSON values.");
  }
  if (active.has(value)) throw invalidInput("Canonical JSON cannot encode cycles.");

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw invalidInput("Canonical JSON cannot encode sparse arrays.");
        items.push(encode(value[index], active));
      }
      return `[${items.join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidInput("Canonical JSON accepts only plain objects.");
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${encode(child, active)}`)
      .join(",")}}`;
  } finally {
    active.delete(value);
  }
};

/**
 * Serializes a JSON value with recursively sorted object keys and no whitespace.
 *
 * @param value - JSON-compatible value to serialize.
 * @returns The deterministic canonical JSON representation.
 */
export const canonicalJson = (value: unknown): string => encode(value, new Set());

/**
 * Encodes canonical JSON as UTF-8 bytes for hashes and durable facts.
 *
 * @param value - JSON-compatible value to serialize and encode.
 * @returns Canonical JSON encoded as UTF-8 bytes.
 */
export const canonicalJsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalJson(value));
