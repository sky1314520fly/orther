import { z } from "zod";

import { WIRE_LIMITS } from "../json.js";
import {
  jobIdSchema,
  materialSetHashSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "./ids.js";
import {
  compareUtf8,
  cursorStringSchema,
  httpUrlSchema,
  labelStringSchema,
  listLimitSchema,
  queryStringSchema,
  safeNonNegativeIntegerSchema,
  safePositiveIntegerSchema,
} from "./common.js";

export const subjectLifecycleSchema = z.enum(["active", "archived"]);
export const maturitySchema = z.enum(["sparse", "forming", "stable"]);

export const identityHintSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("url"), value: httpUrlSchema }),
  z.strictObject({
    kind: z.literal("account"),
    provider: labelStringSchema.regex(/^[a-z][a-z0-9._-]*$/),
    handle: labelStringSchema,
  }),
  z.strictObject({
    kind: z.literal("external_id"),
    provider: labelStringSchema.regex(/^[a-z][a-z0-9._-]*$/),
    value: labelStringSchema,
  }),
  z.strictObject({ kind: z.literal("description"), value: labelStringSchema }),
]);

export const spaceSummarySchema = z.strictObject({
  id: spaceIdSchema,
  displayName: labelStringSchema,
  kind: z.enum(["people", "fictional", "custom"]),
});

export const subjectSummarySchema = z.strictObject({
  id: subjectIdSchema,
  displayName: labelStringSchema,
  aliases: z.array(labelStringSchema).max(WIRE_LIMITS.smallArrayItems),
  identityHints: z.array(identityHintSchema).max(WIRE_LIMITS.smallArrayItems),
  space: spaceSummarySchema,
  lifecycle: subjectLifecycleSchema,
  currentVersionId: versionIdSchema.optional(),
});

export const ambiguousSubjectCandidatesSchema = z
  .tuple([subjectSummarySchema, subjectSummarySchema])
  .rest(subjectSummarySchema);

export const subjectStatusSchema = z.strictObject({
  subject: subjectSummarySchema,
  generation: safeNonNegativeIntegerSchema,
  materialSetHash: materialSetHashSchema.optional(),
  pendingJobId: jobIdSchema.optional(),
  suspendedVersionId: versionIdSchema.optional(),
  maturity: maturitySchema.optional(),
});

export const subjectRefSchema = z.strictObject({ subjectId: subjectIdSchema });

export const subjectSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("id"), subjectId: subjectIdSchema }),
  z.strictObject({
    kind: z.literal("query"),
    query: queryStringSchema,
    spaceId: spaceIdSchema.optional(),
  }),
]);

export const subjectQuerySchema = z.strictObject({
  text: queryStringSchema.optional(),
  spaceId: spaceIdSchema.optional(),
  lifecycle: subjectLifecycleSchema.optional(),
  cursor: cursorStringSchema.optional(),
  limit: listLimitSchema.optional(),
});

export const subjectPageSchema = z
  .strictObject({
    items: z.array(subjectSummarySchema).max(WIRE_LIMITS.listLimit),
    nextCursor: cursorStringSchema.optional(),
  })
  .superRefine((page, context) => {
    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1];
      const current = page.items[index];
      if (previous === undefined || current === undefined) continue;
      const nameOrder = compareUtf8(previous.displayName, current.displayName);
      if (nameOrder > 0 || (nameOrder === 0 && compareUtf8(previous.id, current.id) >= 0)) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "subjects must follow canonical display-name and SubjectId order",
        });
      }
    }
  });

export const resolveSubjectInputSchema = z.strictObject({ selector: subjectSelectorSchema });

export const resolveSubjectResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("found"), subject: subjectSummarySchema }),
  z.strictObject({ kind: z.literal("not_found") }),
  z.strictObject({ kind: z.literal("ambiguous"), candidates: ambiguousSubjectCandidatesSchema }),
]);

export const purgeSubjectInputSchema = z.strictObject({
  subjectId: subjectIdSchema,
  confirmation: labelStringSchema,
});

export const purgeResultSchema = z.discriminatedUnion("physicalDeletion", [
  z.strictObject({
    subjectId: subjectIdSchema,
    logicalDeletion: z.literal("complete"),
    physicalDeletion: z.literal("complete"),
  }),
  z.strictObject({
    subjectId: subjectIdSchema,
    logicalDeletion: z.literal("complete"),
    physicalDeletion: z.literal("pending"),
    pendingBlobCount: safePositiveIntegerSchema,
  }),
]);

export const createSubjectInputSchema = z
  .strictObject({
    displayName: labelStringSchema,
    spaceId: spaceIdSchema.optional(),
    space: z
      .strictObject({
        displayName: labelStringSchema,
        kind: z.enum(["people", "fictional", "custom"]),
      })
      .optional(),
    aliases: z.array(labelStringSchema).max(WIRE_LIMITS.smallArrayItems).optional(),
    domainPack: labelStringSchema.optional(),
    identityHints: z.array(identityHintSchema).max(WIRE_LIMITS.smallArrayItems).optional(),
  })
  .superRefine((value, context) => {
    if (value.spaceId !== undefined && value.space !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["space"],
        message: "spaceId and inline space are mutually exclusive",
      });
    }
  });
