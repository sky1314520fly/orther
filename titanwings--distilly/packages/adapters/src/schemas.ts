import {
  WIRE_LIMITS,
  distillyWireErrorSchema,
  identityHintSchema,
  ingestResultSchema,
  isoDateTimeSchema,
  subjectRefSchema,
  type JsonValue,
  type RuntimeSchema,
} from "@distilly/protocol";
import { z } from "zod";

import type {
  AdapterCapabilities,
  AdapterConfig,
  AdapterPreflightResult,
  AdapterResource,
  AgentPlan,
  ExternalSubjectRef,
  SourceActionInput,
  SourceCollectResult,
  SourceConfigureInput,
  SourcePreflightResult,
  SourceStatus,
  UserCollectionMethodMap,
} from "./contracts.js";

type UserCollectionMethodSchemas = {
  readonly [M in keyof UserCollectionMethodMap]: {
    readonly params: RuntimeSchema<UserCollectionMethodMap[M]["params"]>;
    readonly result: RuntimeSchema<UserCollectionMethodMap[M]["result"]>;
  };
};

const invalidJsonValue = Symbol("invalid-json-value");
const ADAPTER_RESOURCE_MAXIMUM_DEPTH = 64;

const utf8ByteLength = (value: string): number => {
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

const boundedString = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => utf8ByteLength(value) <= maximumBytes, {
      message: `must encode to at most ${maximumBytes} UTF-8 bytes`,
    });

const labelStringSchema = boundedString(WIRE_LIMITS.labelBytes);
const queryStringSchema = boundedString(WIRE_LIMITS.queryBytes);
const reasonStringSchema = boundedString(WIRE_LIMITS.reasonBytes);
const uriStringSchema = boundedString(WIRE_LIMITS.uriBytes).pipe(z.url({ protocol: /^https?$/ }));
const listLimitSchema = z.number().int().safe().positive().max(WIRE_LIMITS.listLimit);
const safeNonNegativeIntegerSchema = z.number().int().safe().nonnegative();

const removeUndefinedProperties = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(removeUndefinedProperties);
  if (value === null || typeof value !== "object") return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) normalized[key] = removeUndefinedProperties(child);
  }
  return normalized;
};

const runtimeSchemaFromZod = <T>(schema: z.ZodType): RuntimeSchema<T> => ({
  parse(value: unknown) {
    return removeUndefinedProperties(schema.parse(value)) as T;
  },
});

const isJsonValue = (value: unknown, active: Set<object>, depth = 0): value is JsonValue => {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || active.has(value) || depth > ADAPTER_RESOURCE_MAXIMUM_DEPTH) {
    return false;
  }

  active.add(value);
  const valid = Array.isArray(value)
    ? value.length <= WIRE_LIMITS.smallArrayItems &&
      value.every((item) => isJsonValue(item, active, depth + 1))
    : (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.keys(value).length <= WIRE_LIMITS.openRecordEntries &&
      Object.values(value).every((item) => isJsonValue(item, active, depth + 1));
  active.delete(value);
  return valid;
};

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

const adapterResourceSchema = z
  .preprocess(
    (value) => (isJsonValue(value, new Set()) && !Array.isArray(value) ? value : invalidJsonValue),
    z
      .record(z.string(), jsonValueSchema)
      .refine((value) => Object.keys(value).length <= WIRE_LIMITS.openRecordEntries),
  )
  .superRefine((value, context) => {
    const parsedKind = labelStringSchema.safeParse(value.kind);
    if (!parsedKind.success) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "resource kind must be a non-empty bounded string",
      });
    }
  })
  .transform((value) => value as AdapterResource);

const hasSecretName = (name: string): boolean => {
  const normalized = name
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/u).filter(Boolean);
  return tokens.some((token) => ["key", "password", "secret", "token"].includes(token));
};

const configRecordSchema = z
  .record(labelStringSchema, labelStringSchema)
  .refine((value) => Object.keys(value).length <= WIRE_LIMITS.openRecordEntries, {
    message: `must contain at most ${WIRE_LIMITS.openRecordEntries} entries`,
  });

const adapterConfigZodSchema = z
  .strictObject({
    values: configRecordSchema,
    secretRefs: configRecordSchema.optional(),
  })
  .superRefine((config, context) => {
    const secretRefs = config.secretRefs ?? {};
    for (const key of Object.keys(config.values)) {
      if (hasSecretName(key)) {
        context.addIssue({
          code: "custom",
          path: ["values", key],
          message: "secret-like configuration keys must use secretRefs",
        });
      }
      if (Object.hasOwn(secretRefs, key)) {
        context.addIssue({
          code: "custom",
          path: ["values", key],
          message: "configuration keys cannot appear in both values and secretRefs",
        });
      }
    }
  });

const resourceKindStatusSchema = z.strictObject({
  kind: labelStringSchema,
  availability: z.enum(["available", "unavailable"]),
  remediation: reasonStringSchema.optional(),
});

const adapterCapabilitiesZodSchema = z.strictObject({
  resolveSubject: z.boolean(),
  plan: z.boolean(),
  collect: z.boolean(),
  requiresSecret: z.boolean(),
  resourceKinds: z.array(resourceKindStatusSchema).max(WIRE_LIMITS.smallArrayItems),
});

const warningsSchema = z.array(reasonStringSchema).max(WIRE_LIMITS.smallArrayItems);

const adapterPreflightResultZodSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), warnings: warningsSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: distillyWireErrorSchema,
    warnings: warningsSchema,
  }),
]);

const externalSubjectRefZodSchema = z.strictObject({
  adapterId: labelStringSchema,
  externalId: labelStringSchema,
  displayName: labelStringSchema,
  canonicalUri: uriStringSchema.optional(),
  identityHints: z.array(identityHintSchema).max(WIRE_LIMITS.smallArrayItems),
});

const sourceAdapterRegistrationZodSchema = z.strictObject({
  id: labelStringSchema,
  mode: z.enum(["delegated", "direct"]),
  capabilities: adapterCapabilitiesZodSchema,
});

const sourceStatusZodSchema = z.strictObject({
  registration: sourceAdapterRegistrationZodSchema,
  configured: z.boolean(),
  warnings: warningsSchema,
});

const userCollectionSelectionZodSchema = z.strictObject({
  adapterId: labelStringSchema,
  resource: adapterResourceSchema,
});

const sourceConfigureInputZodSchema = z.strictObject({
  adapterId: labelStringSchema,
  config: adapterConfigZodSchema,
});

const sourceActionInputZodSchema = z.strictObject({
  selection: userCollectionSelectionZodSchema,
  subject: subjectRefSchema,
  externalSubjectQuery: queryStringSchema.optional(),
  objective: reasonStringSchema,
  since: isoDateTimeSchema.optional(),
  limit: listLimitSchema.optional(),
});

const sourcePreflightResultZodSchema = z.strictObject({
  adapter: adapterPreflightResultZodSchema,
  subjects: z.array(externalSubjectRefZodSchema).max(WIRE_LIMITS.smallArrayItems),
});

const sourceCollectResultZodSchema = z.strictObject({
  materialCount: safeNonNegativeIntegerSchema,
  ingestResults: z.array(ingestResultSchema).max(WIRE_LIMITS.smallArrayItems),
});

const enforceCanonicalBytes = <T extends z.ZodType>(schema: T): T =>
  schema.superRefine((value, context) => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || utf8ByteLength(serialized) > WIRE_LIMITS.toolInputBytes) {
      context.addIssue({
        code: "custom",
        message: `input must encode to at most ${WIRE_LIMITS.toolInputBytes} UTF-8 bytes`,
      });
    }
  });

export const adapterIdRuntimeSchema = runtimeSchemaFromZod<string>(labelStringSchema);
export const adapterCapabilitiesRuntimeSchema = runtimeSchemaFromZod<AdapterCapabilities>(
  adapterCapabilitiesZodSchema,
);
export const adapterConfigRuntimeSchema =
  runtimeSchemaFromZod<AdapterConfig>(adapterConfigZodSchema);
export const adapterPreflightResultRuntimeSchema = runtimeSchemaFromZod<AdapterPreflightResult>(
  adapterPreflightResultZodSchema,
);
export const externalSubjectRefRuntimeSchema = runtimeSchemaFromZod<ExternalSubjectRef>(
  externalSubjectRefZodSchema,
);
export const agentPlanRuntimeSchema = runtimeSchemaFromZod<AgentPlan>(
  z.strictObject({
    questions: z.array(queryStringSchema).max(WIRE_LIMITS.smallArrayItems),
    suggestedQueries: z.array(queryStringSchema).max(WIRE_LIMITS.smallArrayItems),
  }),
);

export const userCollectionMethodSchemas: UserCollectionMethodSchemas = {
  "source.list": {
    params: runtimeSchemaFromZod<null>(z.null()),
    result: runtimeSchemaFromZod<readonly SourceStatus[]>(
      z.array(sourceStatusZodSchema).max(WIRE_LIMITS.listLimit),
    ),
  },
  "source.configure": {
    params: runtimeSchemaFromZod<SourceConfigureInput>(
      enforceCanonicalBytes(sourceConfigureInputZodSchema),
    ),
    result: runtimeSchemaFromZod<SourceStatus>(sourceStatusZodSchema),
  },
  "source.preflight": {
    params: runtimeSchemaFromZod<SourceActionInput>(
      enforceCanonicalBytes(sourceActionInputZodSchema),
    ),
    result: runtimeSchemaFromZod<SourcePreflightResult>(sourcePreflightResultZodSchema),
  },
  "source.collect": {
    params: runtimeSchemaFromZod<SourceActionInput>(
      enforceCanonicalBytes(sourceActionInputZodSchema),
    ),
    result: runtimeSchemaFromZod<SourceCollectResult>(sourceCollectResultZodSchema),
  },
};
