import { z } from "zod";

import type {
  CommitToolInput,
  CommitToolOutput,
  CorrectToolInput,
  CorrectToolOutput,
  GetToolInput,
  GetToolOutput,
  IngestToolInput,
  IngestToolOutput,
  JsonSchemaObject,
  PendingToolInput,
  PendingToolOutput,
} from "../mcp.js";
import { JSON_SCHEMA_DIALECT, WIRE_LIMITS } from "../json.js";
import { WIRE_VERSION } from "../wire.js";
import type { RuntimeSchema } from "../wire.js";
import { DISTILL_PATCH_MAXIMUM_BYTES, distillPatchSchema } from "./claims.js";
import {
  claimTextSchema,
  correctionTextSchema,
  enforceToolInputBytes,
  exactOptionalRuntimeSchema,
  httpUrlSchema,
  jsonObjectSchema,
  labelStringSchema,
  materialContentSchema,
  queryStringSchema,
  quoteStringSchema,
  reasonStringSchema,
  runtimeSchemaFromZod,
  safeNonNegativeIntegerSchema,
  uriStringSchema,
} from "./common.js";
import {
  briefContractDigestSchema,
  claimIdSchema,
  facetPathSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  materialIdSchema,
  materialSetHashSchema,
  requestIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "./ids.js";
import { hostDistillBriefingSchema, jobLeaseSchema, pendingJobSchema } from "./jobs.js";
import { ingestResultSchema, ingestSubjectTargetSchema, materialInputSchema } from "./materials.js";
import { profileSchema } from "./profiles.js";
import {
  ambiguousSubjectCandidatesSchema,
  createSubjectInputSchema,
  subjectSelectorSchema,
  subjectStatusSchema,
  subjectSummarySchema,
} from "./subjects.js";
import {
  currentVersionSummarySchema,
  reviewLaunchSchema,
  reviewReasonSchema,
  suspendedVersionSummarySchema,
} from "./versions.js";
import { actorContextSchema } from "./context.js";
import { wireFailureSchema, wireSuccessSchema } from "./wire.js";

const getToolValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("resolved"), subject: subjectSummarySchema }),
  z.strictObject({
    kind: z.literal("profile"),
    subject: subjectSummarySchema,
    profile: profileSchema,
  }),
  z.strictObject({
    kind: z.literal("prompt"),
    subject: subjectSummarySchema,
    prompt: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("status"),
    subject: subjectSummarySchema,
    status: subjectStatusSchema,
  }),
  z.strictObject({ kind: z.literal("not_found"), query: queryStringSchema.optional() }),
  z.strictObject({
    kind: z.literal("ambiguous"),
    candidates: ambiguousSubjectCandidatesSchema,
  }),
]);

const pendingToolValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("jobs"),
    jobs: z.array(pendingJobSchema).min(1).max(WIRE_LIMITS.listLimit),
  }),
  z.strictObject({ kind: z.literal("briefing"), briefing: hostDistillBriefingSchema }),
  z.strictObject({ kind: z.literal("lease_renewed"), lease: jobLeaseSchema }),
  z.strictObject({ kind: z.literal("released"), jobId: jobIdSchema }),
  z.strictObject({ kind: z.literal("nothing_pending") }),
]);

const commitToolValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("current"),
    version: currentVersionSummarySchema,
    profile: profileSchema,
  }),
  z.strictObject({
    kind: z.literal("suspended"),
    candidate: suspendedVersionSummarySchema,
    currentVersionId: versionIdSchema.optional(),
    reasons: z.array(reviewReasonSchema).min(1).max(WIRE_LIMITS.smallArrayItems),
    review: reviewLaunchSchema,
  }),
]);

const hostCorrectionCandidateSchema = suspendedVersionSummarySchema.extend({
  creation: z.strictObject({
    kind: z.literal("correction"),
    correctionMaterialId: materialIdSchema,
  }),
  actor: actorContextSchema.extend({ kind: z.literal("host") }),
});

const hostRelayedReasonsSchema = z
  .array(reviewReasonSchema)
  .min(1)
  .max(WIRE_LIMITS.smallArrayItems)
  .superRefine((reasons, context) => {
    if (
      !reasons.some((reason) => reason.code === "relayed_correction" && reason.actorKind === "host")
    ) {
      context.addIssue({
        code: "custom",
        message: "correct must include the host-relayed correction reason",
      });
    }
  });

const correctToolValueSchema = z.strictObject({
  kind: z.literal("suspended"),
  candidate: hostCorrectionCandidateSchema,
  currentVersionId: versionIdSchema.optional(),
  reasons: hostRelayedReasonsSchema,
  review: reviewLaunchSchema,
});

const MAX_UTF8_BYTES_KEY = "x-distilly-maxUtf8Bytes";
const MAX_CANONICAL_JSON_UTF8_BYTES_KEY = "x-distilly-maxCanonicalJsonUtf8Bytes";
const PROPERTY_LESS_THAN_KEY = "x-distilly-propertyLessThan";
const PROPERTY_LESS_THAN_OR_EQUAL_KEY = "x-distilly-propertyLessThanOrEqual";
const PROPERTY_PATHS_EQUAL_KEY = "x-distilly-propertyPathsEqual";
const HTTP_URI_PATTERN = "^[Hh][Tt][Tt][Pp][Ss]?://";

const mcpJsonSchemaMetadata = z.registry<Record<string, unknown>>();

const registerUtf8Limit = (schema: z.ZodType, maximumBytes: number) => {
  mcpJsonSchemaMetadata.add(schema, {
    maxLength: maximumBytes,
    [MAX_UTF8_BYTES_KEY]: maximumBytes,
  });
};

registerUtf8Limit(labelStringSchema, WIRE_LIMITS.labelBytes);
registerUtf8Limit(queryStringSchema, WIRE_LIMITS.queryBytes);
registerUtf8Limit(uriStringSchema, WIRE_LIMITS.uriBytes);
registerUtf8Limit(reasonStringSchema, WIRE_LIMITS.reasonBytes);
registerUtf8Limit(claimTextSchema, WIRE_LIMITS.claimTextBytes);
registerUtf8Limit(quoteStringSchema, WIRE_LIMITS.quoteBytes);
registerUtf8Limit(correctionTextSchema, WIRE_LIMITS.correctionTextBytes);
registerUtf8Limit(materialContentSchema, WIRE_LIMITS.materialContentBytes);

mcpJsonSchemaMetadata.add(uriStringSchema, {
  format: "uri",
  maxLength: WIRE_LIMITS.uriBytes,
  [MAX_UTF8_BYTES_KEY]: WIRE_LIMITS.uriBytes,
});
mcpJsonSchemaMetadata.add(httpUrlSchema, {
  format: "uri",
  pattern: HTTP_URI_PATTERN,
  maxLength: WIRE_LIMITS.uriBytes,
  [MAX_UTF8_BYTES_KEY]: WIRE_LIMITS.uriBytes,
});
mcpJsonSchemaMetadata.add(isoDateTimeSchema, { format: "date-time" });
mcpJsonSchemaMetadata.add(createSubjectInputSchema, {
  not: { required: ["spaceId", "space"] },
});
mcpJsonSchemaMetadata.add(materialInputSchema, {
  allOf: [
    {
      if: {
        properties: { kind: { const: "web" } },
        required: ["kind"],
      },
      then: {
        properties: {
          source: {
            properties: {
              uri: { type: "string", format: "uri", pattern: HTTP_URI_PATTERN },
            },
            required: ["uri"],
          },
        },
      },
    },
  ],
});
mcpJsonSchemaMetadata.add(ingestResultSchema, {
  [PROPERTY_PATHS_EQUAL_KEY]: [
    { left: ["job", "subjectId"], right: ["subject", "id"] },
    { left: ["job", "generation"], right: ["generation"] },
    { left: ["job", "materialSetHash"], right: ["materialSetHash"] },
  ],
  allOf: [
    {
      if: { properties: { kind: { const: "ingested" } }, required: ["kind"] },
      then: {
        properties: {
          items: {
            contains: {
              type: "object",
              properties: { kind: { const: "accepted" } },
              required: ["kind"],
            },
            minContains: 1,
          },
        },
      },
    },
    {
      if: { properties: { kind: { const: "unchanged" } }, required: ["kind"] },
      then: {
        properties: {
          items: {
            not: {
              contains: {
                type: "object",
                properties: { kind: { const: "accepted" } },
                required: ["kind"],
              },
            },
          },
        },
      },
    },
  ],
});
mcpJsonSchemaMetadata.add(distillPatchSchema, {
  [MAX_CANONICAL_JSON_UTF8_BYTES_KEY]: DISTILL_PATCH_MAXIMUM_BYTES,
});
mcpJsonSchemaMetadata.add(hostRelayedReasonsSchema, {
  contains: {
    type: "object",
    properties: {
      code: { const: "relayed_correction" },
      actorKind: { const: "host" },
    },
    required: ["code", "actorKind"],
  },
  minContains: 1,
});

const outputSchema = <T extends z.ZodType>(valueSchema: T) =>
  z.union([wireSuccessSchema(valueSchema), wireFailureSchema]);

const requestShape = {
  wireVersion: z.literal(WIRE_VERSION),
  requestId: requestIdSchema,
} as const;

const getInputShape = {
  ...requestShape,
  subject: subjectSelectorSchema,
} as const;

const getToolInputZodSchema = enforceToolInputBytes(
  z.discriminatedUnion("action", [
    z.strictObject({ ...getInputShape, action: z.literal("resolve") }),
    z.strictObject({
      ...getInputShape,
      action: z.literal("profile"),
      versionId: versionIdSchema.optional(),
    }),
    z.strictObject({
      ...getInputShape,
      action: z.literal("prompt"),
      versionId: versionIdSchema.optional(),
    }),
    z.strictObject({ ...getInputShape, action: z.literal("status") }),
  ]),
);

const ingestToolInputZodSchema = enforceToolInputBytes(
  z.strictObject({
    ...requestShape,
    subject: ingestSubjectTargetSchema,
    materials: z.array(materialInputSchema).min(1).max(WIRE_LIMITS.ingestMaterials),
    enqueue: z.enum(["auto", "now"]),
  }),
);

const pendingToolInputZodSchema = enforceToolInputBytes(
  z.discriminatedUnion("action", [
    z.strictObject({
      ...requestShape,
      action: z.literal("list"),
      subjectId: subjectIdSchema.optional(),
    }),
    z.strictObject({
      ...requestShape,
      action: z.literal("brief"),
      jobId: jobIdSchema,
    }),
    z.strictObject({
      ...requestShape,
      action: z.literal("renew"),
      jobId: jobIdSchema,
      leaseId: leaseIdSchema,
    }),
    z.strictObject({
      ...requestShape,
      action: z.literal("release"),
      jobId: jobIdSchema,
      leaseId: leaseIdSchema,
      reason: reasonStringSchema.optional(),
    }),
  ]),
);

const commitToolInputZodSchema = enforceToolInputBytes(
  z.strictObject({
    ...requestShape,
    jobId: jobIdSchema,
    generation: safeNonNegativeIntegerSchema,
    leaseId: leaseIdSchema,
    briefContractDigest: briefContractDigestSchema,
    materialSetHash: materialSetHashSchema,
    baseVersionId: versionIdSchema.optional(),
    patch: distillPatchSchema,
  }),
);

const correctToolInputZodSchema = enforceToolInputBytes(
  z.strictObject({
    ...requestShape,
    subjectId: subjectIdSchema,
    text: correctionTextSchema,
    facet: facetPathSchema.optional(),
    supersedes: z.array(claimIdSchema).min(1).max(WIRE_LIMITS.smallArrayItems).optional(),
    baseCandidateVersionId: versionIdSchema.optional(),
  }),
);

for (const schema of [
  getToolInputZodSchema,
  ingestToolInputZodSchema,
  pendingToolInputZodSchema,
  commitToolInputZodSchema,
  correctToolInputZodSchema,
]) {
  mcpJsonSchemaMetadata.add(schema, {
    [MAX_CANONICAL_JSON_UTF8_BYTES_KEY]: WIRE_LIMITS.toolInputBytes,
  });
}

const getToolOutputZodSchema = outputSchema(getToolValueSchema);
const ingestToolOutputZodSchema = outputSchema(ingestResultSchema);
const pendingToolOutputZodSchema = outputSchema(pendingToolValueSchema);
const commitToolOutputZodSchema = outputSchema(commitToolValueSchema);
const correctToolOutputZodSchema = outputSchema(correctToolValueSchema);

export const getToolInputSchema = exactOptionalRuntimeSchema(
  getToolInputZodSchema,
) satisfies RuntimeSchema<GetToolInput>;
export const ingestToolInputSchema = exactOptionalRuntimeSchema(
  ingestToolInputZodSchema,
) satisfies RuntimeSchema<IngestToolInput>;
export const pendingToolInputSchema = exactOptionalRuntimeSchema(
  pendingToolInputZodSchema,
) satisfies RuntimeSchema<PendingToolInput>;
export const commitToolInputSchema = exactOptionalRuntimeSchema(
  commitToolInputZodSchema,
) satisfies RuntimeSchema<CommitToolInput>;
export const correctToolInputSchema = exactOptionalRuntimeSchema(
  correctToolInputZodSchema,
) satisfies RuntimeSchema<CorrectToolInput>;

export const getToolOutputSchema = runtimeSchemaFromZod<GetToolOutput>(getToolOutputZodSchema);
export const ingestToolOutputSchema =
  runtimeSchemaFromZod<IngestToolOutput>(ingestToolOutputZodSchema);
export const pendingToolOutputSchema = runtimeSchemaFromZod<PendingToolOutput>(
  pendingToolOutputZodSchema,
);
export const commitToolOutputSchema =
  runtimeSchemaFromZod<CommitToolOutput>(commitToolOutputZodSchema);
export const correctToolOutputSchema = runtimeSchemaFromZod<CorrectToolOutput>(
  correctToolOutputZodSchema,
);

const toMcpJsonObjectSchema = (schema: z.ZodType): JsonSchemaObject => {
  const parsed = jsonObjectSchema.parse({
    ...z.toJSONSchema(schema, {
      io: "input",
      metadata: mcpJsonSchemaMetadata,
      override: ({ jsonSchema }) => {
        if (
          jsonSchema.type === "object" &&
          typeof jsonSchema.additionalProperties === "object" &&
          jsonSchema.additionalProperties !== null
        ) {
          jsonSchema.maxProperties = WIRE_LIMITS.openRecordEntries;
        }

        const properties = jsonSchema.properties;
        if (
          typeof properties === "object" &&
          properties !== null &&
          Object.keys(properties).length === 2 &&
          "start" in properties &&
          "end" in properties
        ) {
          jsonSchema[PROPERTY_LESS_THAN_KEY] = { left: "start", right: "end" };
        }
        if (
          typeof properties === "object" &&
          properties !== null &&
          "validFrom" in properties &&
          "validTo" in properties
        ) {
          jsonSchema[PROPERTY_LESS_THAN_OR_EQUAL_KEY] = {
            left: "validFrom",
            right: "validTo",
          };
        }
      },
      target: "draft-2020-12",
      reused: "ref",
    }),
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
  });
  return { ...parsed, $schema: JSON_SCHEMA_DIALECT, type: "object" };
};

export const getToolInputJsonSchema = toMcpJsonObjectSchema(getToolInputZodSchema);
export const getToolOutputJsonSchema = toMcpJsonObjectSchema(getToolOutputZodSchema);
export const ingestToolInputJsonSchema = toMcpJsonObjectSchema(ingestToolInputZodSchema);
export const ingestToolOutputJsonSchema = toMcpJsonObjectSchema(ingestToolOutputZodSchema);
export const pendingToolInputJsonSchema = toMcpJsonObjectSchema(pendingToolInputZodSchema);
export const pendingToolOutputJsonSchema = toMcpJsonObjectSchema(pendingToolOutputZodSchema);
export const commitToolInputJsonSchema = toMcpJsonObjectSchema(commitToolInputZodSchema);
export const commitToolOutputJsonSchema = toMcpJsonObjectSchema(commitToolOutputZodSchema);
export const correctToolInputJsonSchema = toMcpJsonObjectSchema(correctToolInputZodSchema);
export const correctToolOutputJsonSchema = toMcpJsonObjectSchema(correctToolOutputZodSchema);
