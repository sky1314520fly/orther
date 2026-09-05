export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** JSON Schema dialect emitted by the transport-neutral MCP contracts. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

/** Safety bounds shared by every wire-facing runtime schema. */
export const WIRE_LIMITS = {
  toolInputBytes: 4_194_304,
  labelBytes: 1_024,
  cursorBytes: 16_384,
  queryBytes: 4_096,
  uriBytes: 8_192,
  reasonBytes: 8_192,
  claimTextBytes: 16_384,
  quoteBytes: 65_536,
  correctionTextBytes: 16_384,
  materialContentBytes: 1_048_576,
  ingestMaterials: 32,
  smallArrayItems: 64,
  patchOperations: 256,
  evidencePerOperation: 64,
  openRecordEntries: 64,
  listLimit: 200,
} as const;

/** Bounds for engine-derived fact fields whose namespaces can exceed their wire inputs. */
export const FACT_LIMITS = {
  sourceIdentityBytes: 8_208,
} as const;
