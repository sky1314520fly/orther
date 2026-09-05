import { z } from "zod";

import { WIRE_LIMITS } from "../json.js";
import {
  compareUtf8,
  correctionTextSchema,
  cursorStringSchema,
  labelStringSchema,
  listLimitSchema,
  queryStringSchema,
  safeNonNegativeIntegerSchema,
} from "./common.js";
import { claimSchema, coreFacetNameSchema } from "./claims.js";
import {
  claimIdSchema,
  facetPathSchema,
  isoDateTimeSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "./ids.js";
import {
  maturitySchema,
  subjectLifecycleSchema,
  subjectStatusSchema,
  subjectSummarySchema,
} from "./subjects.js";

export const qualitySummarySchema = z.strictObject({
  sourceGroupingVersion: labelStringSchema,
  activeClaimCount: safeNonNegativeIntegerSchema,
  contestedClaimCount: safeNonNegativeIntegerSchema,
  userAssertedClaimCount: safeNonNegativeIntegerSchema,
  corroboratedClaimCount: safeNonNegativeIntegerSchema,
  sourceGroupCount: safeNonNegativeIntegerSchema,
  diversityEligibleSourceGroupCount: safeNonNegativeIntegerSchema,
  unknownSourceGroupCount: safeNonNegativeIntegerSchema,
  coveredCoreFacets: z.array(coreFacetNameSchema).max(7),
  uncoveredCoreFacets: z.array(coreFacetNameSchema).max(7),
  maturity: maturitySchema,
});

const profileCoreSchema = z.strictObject({
  identity: z.string().min(1),
  voice: z.string().min(1),
  psyche: z.string().min(1),
  relations: z.string().min(1),
  boundaries: z.string().min(1),
  texture: z.string().min(1),
  timeline: z.string().min(1),
});

const profileDomainsSchema = z
  .record(labelStringSchema, z.string().min(1))
  .refine((value) => Object.keys(value).length <= WIRE_LIMITS.openRecordEntries, {
    message: `must contain at most ${WIRE_LIMITS.openRecordEntries} entries`,
  });

export const profileSchema = z.strictObject({
  subjectId: subjectIdSchema,
  displayName: labelStringSchema,
  versionId: versionIdSchema,
  claims: z.array(claimSchema),
  core: profileCoreSchema,
  domains: profileDomainsSchema,
  rendered: z.string().min(1),
  quality: qualitySummarySchema,
});

const changedClaimSchema = z.strictObject({
  before: claimSchema,
  after: claimSchema,
});

const addOrderingIssue = (
  context: z.core.$RefinementCtx,
  path: PropertyKey[],
  message: string,
): void => {
  context.addIssue({ code: "custom", path, message });
};

export const profileDiffSchema = z
  .strictObject({
    added: z.array(claimSchema),
    removed: z.array(claimSchema),
    changed: z.array(changedClaimSchema),
    changedFacets: z.array(facetPathSchema).max(WIRE_LIMITS.smallArrayItems),
    beforeQuality: qualitySummarySchema.optional(),
    afterQuality: qualitySummarySchema,
  })
  .superRefine((diff, context) => {
    for (const [field, claims] of [
      ["added", diff.added],
      ["removed", diff.removed],
    ] as const) {
      for (let index = 1; index < claims.length; index += 1) {
        const previous = claims[index - 1];
        const current = claims[index];
        if (
          previous !== undefined &&
          current !== undefined &&
          compareUtf8(previous.id, current.id) >= 0
        ) {
          addOrderingIssue(
            context,
            [field, index, "id"],
            `${field} claims must be strictly ordered by ClaimId`,
          );
        }
      }
    }

    for (const [index, change] of diff.changed.entries()) {
      if (change.before.id !== change.after.id) {
        addOrderingIssue(
          context,
          ["changed", index, "after", "id"],
          "changed claims must retain the same ClaimId",
        );
      }
      if (JSON.stringify(change.before) === JSON.stringify(change.after)) {
        addOrderingIssue(
          context,
          ["changed", index],
          "changed claims must differ in canonical content",
        );
      }
      const previous = diff.changed[index - 1];
      if (previous !== undefined && compareUtf8(previous.before.id, change.before.id) >= 0) {
        addOrderingIssue(
          context,
          ["changed", index, "before", "id"],
          "changed claims must be strictly ordered by ClaimId",
        );
      }
    }

    const seenIds = new Set<string>();
    for (const [field, claims] of [
      ["added", diff.added],
      ["removed", diff.removed],
      ["changed", diff.changed.map((change) => change.before)],
    ] as const) {
      for (const [index, claim] of claims.entries()) {
        if (seenIds.has(claim.id)) {
          addOrderingIssue(
            context,
            [field, index, "id"],
            "a ClaimId may occur in only one diff group",
          );
        }
        seenIds.add(claim.id);
      }
    }

    for (let index = 1; index < diff.changedFacets.length; index += 1) {
      const previous = diff.changedFacets[index - 1];
      const current = diff.changedFacets[index];
      if (previous !== undefined && current !== undefined && compareUtf8(previous, current) >= 0) {
        addOrderingIssue(
          context,
          ["changedFacets", index],
          "changed facets must be strictly ordered and unique",
        );
      }
    }
    const expectedFacets = [
      ...diff.added.map((claim) => claim.facet),
      ...diff.removed.map((claim) => claim.facet),
      ...diff.changed.flatMap((change) => [change.before.facet, change.after.facet]),
    ]
      .filter((facet, index, facets) => facets.indexOf(facet) === index)
      .sort(compareUtf8);
    if (
      expectedFacets.length !== diff.changedFacets.length ||
      expectedFacets.some((facet, index) => facet !== diff.changedFacets[index])
    ) {
      addOrderingIssue(
        context,
        ["changedFacets"],
        "changed facets must exactly cover every changed claim facet",
      );
    }
  });

/** Profile diff variant returned only when both requested versions exist. */
export const profileDiffWithBaselineSchema = profileDiffSchema.refine(
  (diff) => diff.beforeQuality !== undefined,
  {
    path: ["beforeQuality"],
    message: "version diffs require before quality",
  },
);

export const getProfileInputSchema = z.strictObject({
  subjectId: subjectIdSchema,
  versionId: versionIdSchema.optional(),
});

export const correctionDraftSchema = z.strictObject({
  text: correctionTextSchema,
  facet: facetPathSchema.optional(),
  supersedes: z.array(claimIdSchema).max(WIRE_LIMITS.smallArrayItems).optional(),
  baseCandidateVersionId: versionIdSchema.optional(),
});

export const correctInputSchema = z.strictObject({
  subjectId: subjectIdSchema,
  correction: correctionDraftSchema,
});

export const libraryPrivacySchema = z.enum(["none", "private", "shareable", "mixed"]);

const librarySearchTermsSchema = z
  .array(labelStringSchema)
  .max(WIRE_LIMITS.openRecordEntries + 6)
  .superRefine((terms, context) => {
    for (let index = 1; index < terms.length; index += 1) {
      const previous = terms[index - 1];
      const current = terms[index];
      if (previous !== undefined && current !== undefined && compareUtf8(previous, current) >= 0) {
        addOrderingIssue(
          context,
          [index],
          "library search terms must be strictly UTF-8 ordered and unique",
        );
      }
    }
  });

export const libraryEntrySchema = z
  .strictObject({
    subject: subjectSummarySchema,
    status: subjectStatusSchema,
    privacy: libraryPrivacySchema,
    searchTerms: librarySearchTermsSchema,
    currentQuality: qualitySummarySchema.optional(),
    suspendedQuality: qualitySummarySchema.optional(),
    pendingJobs: z.union([z.literal(0), z.literal(1)]),
    suspendedVersions: z.union([z.literal(0), z.literal(1)]),
    newMaterialCount: safeNonNegativeIntegerSchema,
    lastChangedAt: isoDateTimeSchema,
  })
  .superRefine((entry, context) => {
    if (JSON.stringify(entry.subject) !== JSON.stringify(entry.status.subject)) {
      addOrderingIssue(
        context,
        ["status", "subject"],
        "library subject and status subject must match",
      );
    }

    const requiredSearchTerms = [
      entry.subject.lifecycle,
      entry.privacy,
      entry.currentQuality?.maturity,
      entry.pendingJobs === 1 ? "pending" : undefined,
      entry.suspendedVersions === 1 ? "suspended" : undefined,
    ].filter((term): term is string => term !== undefined);
    for (const term of requiredSearchTerms) {
      if (!entry.searchTerms.includes(term)) {
        addOrderingIssue(
          context,
          ["searchTerms"],
          "library search terms must include every projected status token",
        );
      }
    }

    const hasCurrent = entry.subject.currentVersionId !== undefined;
    if (hasCurrent !== (entry.currentQuality !== undefined)) {
      addOrderingIssue(
        context,
        ["currentQuality"],
        "current quality exists if and only if the subject has a current version",
      );
    }
    if (
      entry.currentQuality !== undefined &&
      entry.status.maturity !== entry.currentQuality.maturity
    ) {
      addOrderingIssue(
        context,
        ["status", "maturity"],
        "subject maturity must match current quality",
      );
    }

    const hasPending = entry.status.pendingJobId !== undefined;
    if (entry.pendingJobs !== (hasPending ? 1 : 0)) {
      addOrderingIssue(
        context,
        ["pendingJobs"],
        "pendingJobs must reflect the subject pending marker",
      );
    }
    if (!hasPending && entry.newMaterialCount !== 0) {
      addOrderingIssue(
        context,
        ["newMaterialCount"],
        "subjects without pending work must report zero new materials",
      );
    }

    const hasSuspended = entry.status.suspendedVersionId !== undefined;
    if (entry.suspendedVersions !== (hasSuspended ? 1 : 0)) {
      addOrderingIssue(
        context,
        ["suspendedVersions"],
        "suspendedVersions must reflect the subject suspended pointer",
      );
    }
    if (hasSuspended !== (entry.suspendedQuality !== undefined)) {
      addOrderingIssue(
        context,
        ["suspendedQuality"],
        "suspended quality exists if and only if the subject has a suspended version",
      );
    }
  });

export const libraryQuerySchema = z.strictObject({
  text: queryStringSchema.optional(),
  spaceId: spaceIdSchema.optional(),
  lifecycle: subjectLifecycleSchema.optional(),
  hasPending: z.boolean().optional(),
  hasSuspended: z.boolean().optional(),
  cursor: cursorStringSchema.optional(),
  limit: listLimitSchema.optional(),
});

export const libraryPageSchema = z
  .strictObject({
    items: z.array(libraryEntrySchema).max(WIRE_LIMITS.listLimit),
    nextCursor: cursorStringSchema.optional(),
  })
  .superRefine((page, context) => {
    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1];
      const current = page.items[index];
      if (previous === undefined || current === undefined) continue;
      const nameOrder = compareUtf8(previous.subject.displayName, current.subject.displayName);
      if (
        nameOrder > 0 ||
        (nameOrder === 0 && compareUtf8(previous.subject.id, current.subject.id) >= 0)
      ) {
        addOrderingIssue(
          context,
          ["items", index],
          "library items must follow canonical display-name and SubjectId order",
        );
      }
    }
  });

export const rebuildResultSchema = z.strictObject({
  subjects: safeNonNegativeIntegerSchema,
  jobs: safeNonNegativeIntegerSchema,
  relations: safeNonNegativeIntegerSchema,
  rebuiltAt: isoDateTimeSchema,
});

export const renderedPromptSchema = z.string().min(1);
