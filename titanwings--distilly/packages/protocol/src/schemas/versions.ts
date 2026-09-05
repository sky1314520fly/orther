import { z } from "zod";

import { WIRE_LIMITS } from "../json.js";
import {
  compareUtf8,
  cursorStringSchema,
  labelStringSchema,
  listLimitSchema,
  reasonStringSchema,
  safeNonNegativeIntegerSchema,
  safePositiveIntegerSchema,
} from "./common.js";
import { distillPatchSchema } from "./claims.js";
import {
  briefContractDigestSchema,
  claimIdSchema,
  contentDigestSchema,
  eventIdSchema,
  facetPathSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  materialIdSchema,
  materialSetHashSchema,
  subjectIdSchema,
  versionIdSchema,
} from "./ids.js";
import { actorContextSchema } from "./context.js";
import { profileDiffSchema, profileSchema, qualitySummarySchema } from "./profiles.js";

export const reviewReasonSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("identity_changed"),
    claimIds: z.array(claimIdSchema).max(WIRE_LIMITS.smallArrayItems),
  }),
  z.strictObject({
    code: z.literal("coverage_decreased"),
    facets: z.array(facetPathSchema).max(WIRE_LIMITS.smallArrayItems),
  }),
  z.strictObject({
    code: z.literal("voice_examples_removed"),
    claimIds: z.array(claimIdSchema).max(WIRE_LIMITS.smallArrayItems),
  }),
  z.strictObject({
    code: z.literal("new_contested_claims"),
    claimIds: z.array(claimIdSchema).max(WIRE_LIMITS.smallArrayItems),
  }),
  z.strictObject({
    code: z.literal("correction_conflict"),
    claimIds: z.array(claimIdSchema).max(WIRE_LIMITS.smallArrayItems),
  }),
  z.strictObject({ code: z.literal("source_diversity_decreased") }),
  z.strictObject({
    code: z.literal("suspicious_source"),
    materialIds: z.array(materialIdSchema).max(WIRE_LIMITS.smallArrayItems),
  }),
  z.strictObject({
    code: z.literal("relayed_correction"),
    actorKind: z.enum(["host", "sdk", "executor", "system"]),
  }),
  z.strictObject({ code: z.literal("imported_profile") }),
  z.strictObject({
    code: z.literal("manual_review_requested"),
    note: reasonStringSchema.optional(),
  }),
]);

export const reviewReasonsSchema = z
  .tuple([reviewReasonSchema], reviewReasonSchema)
  .refine((reasons) => reasons.length <= WIRE_LIMITS.smallArrayItems, {
    message: `must contain at most ${WIRE_LIMITS.smallArrayItems} items`,
  })
  .superRefine((reasons, context) => {
    const reasonOrder = [
      "identity_changed",
      "coverage_decreased",
      "voice_examples_removed",
      "new_contested_claims",
      "correction_conflict",
      "source_diversity_decreased",
      "suspicious_source",
      "relayed_correction",
      "imported_profile",
      "manual_review_requested",
    ] as const;
    const order = new Map(reasonOrder.map((code, index) => [code, index] as const));
    for (let index = 1; index < reasons.length; index += 1) {
      const previous = reasons[index - 1];
      const current = reasons[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        (order.get(previous.code) ?? -1) >= (order.get(current.code) ?? -1)
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "code"],
          message: "review reasons must follow canonical code order without duplicates",
        });
      }
    }

    for (const [index, reason] of reasons.entries()) {
      const values =
        "claimIds" in reason
          ? reason.claimIds
          : "facets" in reason
            ? reason.facets
            : "materialIds" in reason
              ? reason.materialIds
              : undefined;
      if (values === undefined) continue;
      for (let valueIndex = 1; valueIndex < values.length; valueIndex += 1) {
        const previous = values[valueIndex - 1];
        const current = values[valueIndex];
        if (
          previous !== undefined &&
          current !== undefined &&
          compareUtf8(previous, current) >= 0
        ) {
          context.addIssue({
            code: "custom",
            path: [
              index,
              "claimIds" in reason ? "claimIds" : "facets" in reason ? "facets" : "materialIds",
              valueIndex,
            ],
            message: "review reason members must be strictly ordered and unique",
          });
        }
      }
    }
  });

export const versionStatusSchema = z.enum(["current", "suspended", "historical", "rejected"]);
export const createdDispositionSchema = z.enum(["current", "suspended"]);

export const versionCreationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("host_distill"),
    briefContractDigest: briefContractDigestSchema,
    promptVersion: labelStringSchema,
    draftSchemaVersion: safePositiveIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal("correction"),
    correctionMaterialId: materialIdSchema,
  }),
  z.strictObject({
    kind: z.literal("rollback"),
    targetVersionId: versionIdSchema,
  }),
  z.strictObject({
    kind: z.literal("bundle_import"),
    bundleDigest: contentDigestSchema,
  }),
  z.strictObject({
    kind: z.literal("renderer_only"),
    sourceVersionId: versionIdSchema,
  }),
]);

export const versionSummarySchema = z.strictObject({
  id: versionIdSchema,
  subjectId: subjectIdSchema,
  parentId: versionIdSchema.optional(),
  derivedFromCandidateVersionId: versionIdSchema.optional(),
  generation: safeNonNegativeIntegerSchema,
  materialSetHash: materialSetHashSchema,
  creation: versionCreationSchema,
  status: versionStatusSchema,
  actor: actorContextSchema,
  quality: qualitySummarySchema,
  createdAt: isoDateTimeSchema,
});

export const currentVersionSummarySchema = versionSummarySchema.extend({
  status: z.literal("current"),
});

export const suspendedVersionSummarySchema = versionSummarySchema.extend({
  status: z.literal("suspended"),
});

export const reviewRefSchema = z.strictObject({
  subjectId: subjectIdSchema,
  candidateVersionId: versionIdSchema,
});

const REVIEW_LAUNCH_URL_PATTERN =
  /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/#([0-9a-f]{64})\/review\/(subject_[0-9a-f]{32})\/(version_[0-9a-f]{64})$/;

const reviewLaunchUrlSchema = z
  .string()
  .regex(REVIEW_LAUNCH_URL_PATTERN)
  .refine((url) => {
    const match = REVIEW_LAUNCH_URL_PATTERN.exec(url);
    return match !== null && Number(match[1]) <= 65_535 && Number(match[1]) !== 80;
  }, "must use a valid explicit non-default TCP port");

export const reviewLaunchSchema = z
  .strictObject({
    ref: reviewRefSchema,
    url: reviewLaunchUrlSchema,
  })
  .superRefine((launch, context) => {
    const match = REVIEW_LAUNCH_URL_PATTERN.exec(launch.url);
    if (
      match === null ||
      match[3] !== launch.ref.subjectId ||
      match[4] !== launch.ref.candidateVersionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "review route must match ref",
      });
    }
  });

export const commitInputSchema = z.strictObject({
  jobId: jobIdSchema,
  generation: safeNonNegativeIntegerSchema,
  leaseId: leaseIdSchema,
  briefContractDigest: briefContractDigestSchema,
  materialSetHash: materialSetHashSchema,
  baseVersionId: versionIdSchema.optional(),
  patch: distillPatchSchema,
});

export const commitResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("current"),
    version: currentVersionSummarySchema,
    profile: profileSchema,
  }),
  z.strictObject({
    kind: z.literal("suspended"),
    candidate: suspendedVersionSummarySchema,
    currentVersionId: versionIdSchema.optional(),
    reasons: reviewReasonsSchema,
    review: reviewRefSchema,
  }),
]);

export const diffInputSchema = z.strictObject({
  subjectId: subjectIdSchema,
  before: versionIdSchema,
  after: versionIdSchema,
});

export const reviewActionInputSchema = z.strictObject({
  subjectId: subjectIdSchema,
  candidateVersionId: versionIdSchema,
  reason: reasonStringSchema
    .refine((reason) => reason.trim().length !== 0, {
      message: "review reason must not be blank",
    })
    .optional(),
});

export const rollbackInputSchema = z.strictObject({
  subjectId: subjectIdSchema,
  targetVersionId: versionIdSchema,
  reason: reasonStringSchema.refine((reason) => reason.trim().length !== 0, {
    message: "rollback reason must not be blank",
  }),
});

export const versionQuerySchema = z.strictObject({
  subjectId: subjectIdSchema,
  cursor: cursorStringSchema.optional(),
  limit: listLimitSchema.optional(),
});

export const lineageInputSchema = z.strictObject({
  subjectId: subjectIdSchema,
  cursor: cursorStringSchema.optional(),
  limit: listLimitSchema.optional(),
});

export const lineageEventSchema = z.strictObject({
  eventId: eventIdSchema,
  kind: z.enum([
    "created",
    "committed",
    "suspended",
    "promoted",
    "rejected",
    "candidate_replaced",
    "rolled_back",
    "corrected",
    "imported",
  ]),
  versionId: versionIdSchema.optional(),
  relatedVersionId: versionIdSchema.optional(),
  actor: actorContextSchema,
  at: isoDateTimeSchema,
  reason: reasonStringSchema.optional(),
});

export const reviewQuerySchema = z.strictObject({
  subjectId: subjectIdSchema.optional(),
  cursor: cursorStringSchema.optional(),
  limit: listLimitSchema.optional(),
});

export const reviewItemSchema = z
  .strictObject({
    candidate: suspendedVersionSummarySchema,
    current: currentVersionSummarySchema.optional(),
    reasons: reviewReasonsSchema,
    diff: profileDiffSchema,
  })
  .superRefine((item, context) => {
    if (item.current === undefined) {
      if (item.candidate.parentId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["candidate", "parentId"],
          message: "a first-version review candidate must omit parentId",
        });
      }
      if (item.diff.beforeQuality !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["diff", "beforeQuality"],
          message: "a first-version review diff must omit before quality",
        });
      }
      if (item.diff.removed.length !== 0 || item.diff.changed.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["diff"],
          message: "a first-version review diff can only add claims",
        });
      }
    } else {
      if (
        item.current.subjectId !== item.candidate.subjectId ||
        item.candidate.parentId !== item.current.id
      ) {
        context.addIssue({
          code: "custom",
          path: ["current"],
          message: "review current must be the candidate parent for the same subject",
        });
      }
      if (
        item.diff.beforeQuality === undefined ||
        JSON.stringify(item.diff.beforeQuality) !== JSON.stringify(item.current.quality)
      ) {
        context.addIssue({
          code: "custom",
          path: ["diff", "beforeQuality"],
          message: "review before quality must match the current version",
        });
      }
    }
    if (JSON.stringify(item.diff.afterQuality) !== JSON.stringify(item.candidate.quality)) {
      context.addIssue({
        code: "custom",
        path: ["diff", "afterQuality"],
        message: "review after quality must match the candidate version",
      });
    }
  });

export const versionPageSchema = z
  .strictObject({
    items: z.array(versionSummarySchema).max(WIRE_LIMITS.listLimit),
    nextCursor: cursorStringSchema.optional(),
  })
  .superRefine((page, context) => {
    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1];
      const current = page.items[index];
      if (previous === undefined || current === undefined) continue;
      if (
        previous.createdAt < current.createdAt ||
        (previous.createdAt === current.createdAt && compareUtf8(previous.id, current.id) >= 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "versions must follow canonical creation-time and VersionId order",
        });
      }
    }
  });

export const lineagePageSchema = z
  .strictObject({
    items: z.array(lineageEventSchema).max(WIRE_LIMITS.listLimit),
    nextCursor: cursorStringSchema.optional(),
  })
  .superRefine((page, context) => {
    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1];
      const current = page.items[index];
      if (previous === undefined || current === undefined) continue;
      if (
        previous.at < current.at ||
        (previous.at === current.at && compareUtf8(previous.eventId, current.eventId) >= 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "lineage events must follow canonical event-time and EventId order",
        });
      }
    }
  });

export const reviewPageSchema = z
  .strictObject({
    items: z.array(reviewItemSchema).max(WIRE_LIMITS.listLimit),
    nextCursor: cursorStringSchema.optional(),
  })
  .superRefine((page, context) => {
    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1];
      const current = page.items[index];
      if (previous === undefined || current === undefined) continue;
      const candidate = current.candidate;
      const previousCandidate = previous.candidate;
      const subjectOrder = compareUtf8(previousCandidate.subjectId, candidate.subjectId);
      if (
        previousCandidate.createdAt < candidate.createdAt ||
        (previousCandidate.createdAt === candidate.createdAt &&
          (subjectOrder > 0 ||
            (subjectOrder === 0 && compareUtf8(previousCandidate.id, candidate.id) >= 0)))
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "reviews must follow canonical candidate order",
        });
      }
    }
  });
