import { z } from "zod";

import type { JsonObject, JsonValue } from "../json.js";
import { FACT_LIMITS, WIRE_LIMITS } from "../json.js";
import type { RuntimeSchema } from "../wire.js";

type Primitive = string | number | boolean | null | undefined;

type OptionalKey<T extends object> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

type RequiredKey<T extends object> = Exclude<keyof T, OptionalKey<T>>;

export type NormalizeExactOptional<T> = T extends Primitive
  ? T
  : T extends readonly unknown[]
    ? Readonly<{ [K in keyof T]: NormalizeExactOptional<T[K]> }>
    : T extends object
      ? string extends keyof T
        ? { readonly [K in keyof T]: NormalizeExactOptional<T[K]> }
        : {
            readonly [K in RequiredKey<T>]: NormalizeExactOptional<T[K]>;
          } & {
            readonly [K in OptionalKey<T>]?: NormalizeExactOptional<Exclude<T[K], undefined>>;
          }
      : T;

export type MatchingSchema<S extends z.ZodType, T> =
  NormalizeExactOptional<z.output<S>> extends T ? S : never;

const removeUndefinedProperties = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(removeUndefinedProperties);
  if (value === null || typeof value !== "object") return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) {
      normalized[key] = removeUndefinedProperties(child);
    }
  }
  return normalized;
};

/**
 * Adapts a fixture-covered Zod schema to a declared protocol runtime type.
 *
 * This is the single type escape hatch for schemas whose inferred type exceeds
 * TypeScript's instantiation depth. Callers must cover every union branch in a
 * compile-and-runtime contract fixture.
 *
 * @param schema - Strict Zod schema for the declared protocol type.
 * @returns A parser that recursively removes explicit undefined object properties.
 */
export const runtimeSchemaFromZod = <T>(schema: z.ZodType): RuntimeSchema<T> => ({
  parse(value: unknown) {
    return removeUndefinedProperties(schema.parse(value)) as T;
  },
});

/**
 * Adapts a Zod JSON schema to its inferred exact-optional runtime type.
 *
 * @param schema - Schema whose normalized output is the declared protocol type.
 * @returns A parser with the schema's normalized output type.
 */
export const exactOptionalRuntimeSchema = <S extends z.ZodType>(
  schema: S,
): RuntimeSchema<NormalizeExactOptional<z.output<S>>> =>
  runtimeSchemaFromZod<NormalizeExactOptional<z.output<S>>>(schema);

/**
 * Counts the UTF-8 bytes that would encode a JavaScript string.
 *
 * @param value - String to measure.
 * @returns Encoded UTF-8 byte count.
 */
export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

/**
 * Compares strings by the canonical UTF-8 byte order used by fact and page models.
 *
 * @param left - First string to compare.
 * @param right - Second string to compare.
 * @returns A negative, zero, or positive ordering value.
 */
export const compareUtf8 = (left: string, right: string): number => {
  const leftScalars = Array.from(left, (character) => {
    const value = character.codePointAt(0) ?? 0xfffd;
    return value >= 0xd800 && value <= 0xdfff ? 0xfffd : value;
  });
  const rightScalars = Array.from(right, (character) => {
    const value = character.codePointAt(0) ?? 0xfffd;
    return value >= 0xd800 && value <= 0xdfff ? 0xfffd : value;
  });
  const sharedLength = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftScalar = leftScalars[index];
    const rightScalar = rightScalars[index];
    if (leftScalar !== rightScalar) return (leftScalar ?? 0) - (rightScalar ?? 0);
  }
  return leftScalars.length - rightScalars.length;
};

/**
 * Builds a non-empty string schema bounded by encoded UTF-8 bytes.
 *
 * @param maximumBytes - Inclusive encoded byte limit.
 * @returns Runtime schema for the bounded string.
 */
const boundedString = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => utf8ByteLength(value) <= maximumBytes, {
      message: `must encode to at most ${maximumBytes} UTF-8 bytes`,
    });

export const labelStringSchema = boundedString(WIRE_LIMITS.labelBytes);
export const cursorStringSchema = boundedString(WIRE_LIMITS.cursorBytes);
export const queryStringSchema = boundedString(WIRE_LIMITS.queryBytes);
export const uriStringSchema = boundedString(WIRE_LIMITS.uriBytes);
export const sourceIdentityStringSchema = boundedString(FACT_LIMITS.sourceIdentityBytes);
export const reasonStringSchema = boundedString(WIRE_LIMITS.reasonBytes);
export const claimTextSchema = boundedString(WIRE_LIMITS.claimTextBytes);
export const quoteStringSchema = boundedString(WIRE_LIMITS.quoteBytes);
export const correctionTextSchema = boundedString(WIRE_LIMITS.correctionTextBytes);
export const materialContentSchema = boundedString(WIRE_LIMITS.materialContentBytes);

export const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();
export const safePositiveIntegerSchema = z.number().int().safe().positive();
export const listLimitSchema = safePositiveIntegerSchema.max(WIRE_LIMITS.listLimit);

export const httpUrlSchema = uriStringSchema.pipe(z.url({ protocol: /^https?$/ }));

const isJsonValue = (value: unknown, active: Set<object>): value is JsonValue => {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (active.has(value)) return false;

  active.add(value);
  const valid = Array.isArray(value)
    ? value.length <= WIRE_LIMITS.smallArrayItems &&
      value.every((item) => isJsonValue(item, active))
    : (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.keys(value).length <= WIRE_LIMITS.openRecordEntries &&
      Object.values(value).every((item) => isJsonValue(item, active));
  active.delete(value);
  return valid;
};

const invalidJsonValue = Symbol("invalid-json-value");
const jsonValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema).max(WIRE_LIMITS.smallArrayItems),
    z
      .record(z.string(), jsonValueSchema)
      .refine((value) => Object.keys(value).length <= WIRE_LIMITS.openRecordEntries),
  ]),
);

/** Runtime schema for a finite, acyclic JSON object with bounded fan-out. */
export const jsonObjectSchema = z
  .preprocess(
    (value) => (isJsonValue(value, new Set()) && !Array.isArray(value) ? value : invalidJsonValue),
    z
      .record(z.string(), jsonValueSchema)
      .refine((value) => Object.keys(value).length <= WIRE_LIMITS.openRecordEntries),
  )
  .transform((value) => value as JsonObject);

/**
 * Rejects a parsed tool input whose canonical JSON exceeds the shared cap.
 *
 * @param schema - Strict input schema to augment.
 * @returns The schema with the aggregate byte bound attached.
 */
export const enforceToolInputBytes = <T extends z.ZodType>(schema: T) =>
  schema.superRefine((value, context) => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || utf8ByteLength(serialized) > WIRE_LIMITS.toolInputBytes) {
      context.addIssue({
        code: "custom",
        message: `tool input must encode to at most ${WIRE_LIMITS.toolInputBytes} UTF-8 bytes`,
      });
    }
  });
