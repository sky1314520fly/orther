import { z } from "zod";

import { DISTILLY_ERROR_CODES } from "../errors.js";
import { WIRE_VERSION } from "../wire.js";
import { jsonObjectSchema, labelStringSchema, reasonStringSchema } from "./common.js";
import { requestIdSchema } from "./ids.js";
import { ambiguousSubjectCandidatesSchema, subjectSummarySchema } from "./subjects.js";

/** Runtime schema for the stable error-code union. */
export const distillyErrorCodeSchema = z.enum(DISTILLY_ERROR_CODES);

const errorBaseShape = {
  message: reasonStringSchema,
  retryable: z.boolean(),
  fieldPath: labelStringSchema.optional(),
  remediation: reasonStringSchema.optional(),
  details: jsonObjectSchema.optional(),
} as const;

const genericErrorCodeSchema = distillyErrorCodeSchema.exclude([
  "already_exists",
  "ambiguous_subject",
  "internal_error",
]);

/** Runtime schema for a transport-safe, code-correlated Distilly error. */
export const distillyWireErrorSchema = z.union([
  z.strictObject({
    ...errorBaseShape,
    code: z.literal("already_exists"),
    subjectResolution: z.strictObject({
      kind: z.literal("found"),
      subject: subjectSummarySchema,
    }),
  }),
  z.strictObject({
    ...errorBaseShape,
    code: z.literal("ambiguous_subject"),
    subjectResolution: z.strictObject({
      kind: z.literal("ambiguous"),
      candidates: ambiguousSubjectCandidatesSchema,
    }),
  }),
  z.strictObject({
    code: z.literal("internal_error"),
    message: reasonStringSchema,
    retryable: z.literal(false),
  }),
  z.strictObject({ ...errorBaseShape, code: genericErrorCodeSchema }),
]);

/** Runtime schema for fields common to every model-facing request. */
export const wireRequestSchema = z.strictObject({
  wireVersion: z.literal(WIRE_VERSION),
  requestId: requestIdSchema,
});

/**
 * Builds the exact success envelope for one result schema.
 *
 * @param value - Runtime schema for the successful result value.
 * @returns An exact runtime schema for the success envelope.
 */
export const wireSuccessSchema = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    ok: z.literal(true),
    wireVersion: z.literal(WIRE_VERSION),
    value,
  });

/** Runtime schema for the shared failure envelope. */
export const wireFailureSchema = z.strictObject({
  ok: z.literal(false),
  wireVersion: z.literal(WIRE_VERSION),
  error: distillyWireErrorSchema,
});
