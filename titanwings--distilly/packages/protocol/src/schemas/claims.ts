import { z } from "zod";

import { WIRE_LIMITS } from "../json.js";
import {
  claimTextSchema,
  labelStringSchema,
  quoteStringSchema,
  reasonStringSchema,
  safeNonNegativeIntegerSchema,
  utf8ByteLength,
} from "./common.js";
import {
  briefMaterialRefSchema,
  claimIdSchema,
  facetPathSchema,
  isoDateTimeSchema,
  materialIdSchema,
  relationIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "./ids.js";

export const DISTILL_PATCH_MAXIMUM_BYTES = 65_536;

export const coreFacetNameSchema = z.enum([
  "identity",
  "voice",
  "psyche",
  "relations",
  "boundaries",
  "texture",
  "timeline",
]);

const evidenceLocatorSchema = z
  .strictObject({
    start: safeNonNegativeIntegerSchema,
    end: safeNonNegativeIntegerSchema,
  })
  .refine((value) => value.end > value.start, {
    path: ["end"],
    message: "end must be greater than start",
  });

const refineDateRange = (
  value: { readonly validFrom?: string | undefined; readonly validTo?: string | undefined },
  context: z.core.$RefinementCtx,
): void => {
  if (
    value.validFrom !== undefined &&
    value.validTo !== undefined &&
    value.validFrom > value.validTo
  ) {
    context.addIssue({
      code: "custom",
      path: ["validTo"],
      message: "validTo must not precede validFrom",
    });
  }
};

export const evidenceRefSchema = z.strictObject({
  materialId: materialIdSchema,
  quote: quoteStringSchema,
  locator: evidenceLocatorSchema.optional(),
});

export const evidenceDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("brief_material"),
    materialRef: briefMaterialRefSchema,
    quote: quoteStringSchema,
    locator: evidenceLocatorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("baseline_evidence"),
    claimId: claimIdSchema,
    evidenceIndex: safeNonNegativeIntegerSchema,
  }),
]);

export const claimDraftSchema = z
  .strictObject({
    facet: facetPathSchema,
    text: claimTextSchema,
    evidence: z.array(evidenceDraftSchema).min(1).max(WIRE_LIMITS.evidencePerOperation),
    observedIn: z.array(labelStringSchema).max(WIRE_LIMITS.smallArrayItems).optional(),
    validFrom: isoDateTimeSchema.optional(),
    validTo: isoDateTimeSchema.optional(),
  })
  .superRefine(refineDateRange);

export const claimOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), claim: claimDraftSchema }),
  z.strictObject({
    op: z.literal("revise"),
    claimId: claimIdSchema,
    replacement: claimDraftSchema,
    reason: reasonStringSchema,
  }),
  z.strictObject({
    op: z.literal("supersede"),
    claimId: claimIdSchema,
    reason: reasonStringSchema,
    evidence: z.array(evidenceDraftSchema).min(1).max(WIRE_LIMITS.evidencePerOperation),
  }),
  z.strictObject({
    op: z.literal("contest"),
    claimId: claimIdSchema,
    reason: reasonStringSchema,
    evidence: z.array(evidenceDraftSchema).min(1).max(WIRE_LIMITS.evidencePerOperation),
  }),
]);

const relationTargetSchema = z.union([
  z.strictObject({ subjectId: subjectIdSchema }),
  z.strictObject({ rawName: labelStringSchema }),
]);

const openLabelRecordSchema = z
  .record(labelStringSchema, labelStringSchema)
  .refine((value) => Object.keys(value).length <= WIRE_LIMITS.openRecordEntries, {
    message: `must contain at most ${WIRE_LIMITS.openRecordEntries} entries`,
  });

export const relationOperationDraftSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add"),
    target: relationTargetSchema,
    type: labelStringSchema,
    role: openLabelRecordSchema.optional(),
    evidence: z.array(evidenceDraftSchema).min(1).max(WIRE_LIMITS.evidencePerOperation),
  }),
  z.strictObject({
    op: z.literal("invalidate"),
    relationId: relationIdSchema,
    reason: reasonStringSchema,
    evidence: z.array(evidenceDraftSchema).min(1).max(WIRE_LIMITS.evidencePerOperation),
  }),
]);

export const distillPatchSchema = z
  .strictObject({
    operations: z.array(claimOperationSchema).max(WIRE_LIMITS.patchOperations),
    reviewRequest: z.strictObject({ note: reasonStringSchema.optional() }).optional(),
    notes: reasonStringSchema.optional(),
  })
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= DISTILL_PATCH_MAXIMUM_BYTES, {
    message: `canonical patch must encode to at most ${DISTILL_PATCH_MAXIMUM_BYTES} UTF-8 bytes`,
  });

export const claimStatusSchema = z.enum(["active", "contested", "superseded"]);

export const evidenceStrengthSchema = z.enum([
  "user_asserted",
  "single_source",
  "corroborated",
  "contested",
  "imported_unverified",
]);

export const claimSchema = z
  .strictObject({
    id: claimIdSchema,
    facet: facetPathSchema,
    text: claimTextSchema,
    evidence: z.array(evidenceRefSchema).min(1).max(WIRE_LIMITS.smallArrayItems),
    status: claimStatusSchema,
    strength: evidenceStrengthSchema,
    observedIn: z.array(labelStringSchema).max(WIRE_LIMITS.smallArrayItems),
    validFrom: isoDateTimeSchema.optional(),
    validTo: isoDateTimeSchema.optional(),
    createdIn: versionIdSchema,
    supersededBy: claimIdSchema.optional(),
  })
  .superRefine(refineDateRange);
