import { createHash } from "node:crypto";

import { distillyMcpTools } from "@distilly/protocol";
import type { ContentDigest } from "@distilly/protocol";

import type { McpSchemaProfile } from "./types.js";

export type { McpSchemaProfile } from "./types.js";

type JsonSchemaRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonSchemaRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Resolves local `$defs` references and removes dialect metadata for hosts
 * whose tool-schema adapters do not understand the 2020-12 URI. This is an
 * advertised-schema projection only; the canonical Protocol schemas still
 * validate every call at the handler boundary.
 *
 * @param value - Schema node currently being projected.
 * @param root - Original root schema containing local definitions.
 * @param seen - References on the current recursive path.
 * @returns The host-advertisable schema node.
 */
const resolveAdvertisedSchema = (
  value: unknown,
  root: JsonSchemaRecord,
  seen: ReadonlySet<string> = new Set(),
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveAdvertisedSchema(entry, root, seen));
  }
  if (!isRecord(value)) return value;
  const reference = value.$ref;
  if (typeof reference === "string" && reference.startsWith("#/$defs/")) {
    const key = reference.slice("#/$defs/".length);
    const target = root.$defs;
    const definition = isRecord(target) ? target[key] : undefined;
    if (definition !== undefined) {
      // The Protocol JSON value schema is intentionally recursive. A host
      // advertisement cannot carry that cycle after `$defs` is removed, so
      // terminate only the recursive edge with an unconstrained object.
      if (seen.has(reference)) return {};
      return resolveAdvertisedSchema(definition, root, new Set([...seen, reference]));
    }
  }
  const output: JsonSchemaRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$schema" || key === "$defs") continue;
    output[key] = resolveAdvertisedSchema(entry, root, seen);
  }
  return output;
};

const mergeAdvertisedProperties = (variants: readonly JsonSchemaRecord[]): JsonSchemaRecord => {
  const properties: JsonSchemaRecord = {};
  for (const variant of variants) {
    const variantProperties = variant.properties;
    if (!isRecord(variantProperties)) continue;
    for (const [key, value] of Object.entries(variantProperties)) {
      const existing = properties[key];
      if (existing === undefined || sameJson(existing, value)) {
        properties[key] = value;
      } else {
        properties[key] = { anyOf: [existing, value] };
      }
    }
  }
  return properties;
};

const commonRequired = (variants: readonly JsonSchemaRecord[]): string[] => {
  if (variants.length === 0) return [];
  const first = Array.isArray(variants[0]!.required)
    ? variants[0]!.required.filter((key): key is string => typeof key === "string")
    : [];
  return first.filter((key) =>
    variants
      .slice(1)
      .every((variant) => Array.isArray(variant.required) && variant.required.includes(key)),
  );
};

const projectRootUnion = (schema: JsonSchemaRecord): JsonSchemaRecord => {
  const variantKey = Array.isArray(schema.anyOf)
    ? "anyOf"
    : Array.isArray(schema.oneOf)
      ? "oneOf"
      : undefined;
  if (variantKey === undefined || ("type" in schema && isRecord(schema.properties))) {
    return schema;
  }
  const variants = (schema[variantKey] as unknown[]).filter(isRecord);
  if (variants.length === 0) return { ...schema, type: "object" };
  const projected: JsonSchemaRecord = { ...schema, type: "object" };
  delete projected.anyOf;
  delete projected.oneOf;
  projected.properties = mergeAdvertisedProperties(variants);
  const required = commonRequired(variants);
  if (required.length > 0) projected.required = required;
  else delete projected.required;
  if (variants.every((variant) => variant.additionalProperties === false)) {
    projected.additionalProperties = false;
  } else if (!("additionalProperties" in projected)) {
    projected.additionalProperties = true;
  }
  return projected;
};

/**
 * Projects one canonical Protocol schema into a host-advertisable schema.
 *
 * @param schema - Canonical JSON Schema value.
 * @param profile - Host dialect requiring the projection; undefined preserves
 *   the canonical schema byte-for-byte.
 * @returns The schema advertised to the selected MCP client.
 */
export const projectAdvertisedSchema = (
  schema: unknown,
  profile: McpSchemaProfile | undefined,
): unknown => {
  if (profile === undefined || !isRecord(schema)) return schema;
  return projectRootUnion(resolveAdvertisedSchema(schema, schema) as JsonSchemaRecord);
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => [key, canonicalize(record[key])]),
  );
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const advertisedDescriptors = (profile: McpSchemaProfile | undefined): unknown =>
  distillyMcpTools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema: projectAdvertisedSchema(inputSchema, profile),
    outputSchema: projectAdvertisedSchema(outputSchema, profile),
    annotations,
  }));

/**
 * Computes the digest of the exact descriptors advertised by this adapter.
 * The canonical profile retains the historical descriptor digest; projected
 * profiles include their profile label so a host-specific projection cannot
 * accidentally reuse another host's evidence.
 *
 * @param profile - Host schema profile, or undefined for canonical descriptors.
 * @returns SHA-256 digest suitable for binding a capacity fixture.
 */
export const advertisedToolContractDigest = (
  profile: McpSchemaProfile | undefined,
): ContentDigest => {
  const descriptors = advertisedDescriptors(profile);
  const preimage =
    profile === undefined
      ? descriptors
      : { schemaProjectionVersion: 1, schemaProfile: profile, descriptors };
  return `sha256_${createHash("sha256").update(canonicalJson(preimage)).digest("hex")}` as ContentDigest;
};
