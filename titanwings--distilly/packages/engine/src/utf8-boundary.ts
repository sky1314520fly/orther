import { invalidInput } from "./internal-errors.js";

const UTF8_ENCODER = new TextEncoder();

/**
 * Reapplies a wire-derived UTF-8 bound after canonicalization can change encoded size.
 *
 * @param value - Canonical value that will be hashed or persisted.
 * @param maximumBytes - Inclusive encoded byte limit.
 * @param fieldPath - Caller-visible input field that produced the value.
 * @returns The unchanged canonical value.
 */
export const enforceCanonicalUtf8Limit = (
  value: string,
  maximumBytes: number,
  fieldPath: string,
): string => {
  if (UTF8_ENCODER.encode(value).byteLength > maximumBytes) {
    throw invalidInput(
      `Canonical value must encode to at most ${maximumBytes} UTF-8 bytes.`,
      fieldPath,
    );
  }
  return value;
};
