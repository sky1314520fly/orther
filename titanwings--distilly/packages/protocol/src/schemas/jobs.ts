import { z } from "zod";

import { WIRE_LIMITS } from "../json.js";
import {
  listLimitSchema,
  materialContentSchema,
  reasonStringSchema,
  safeNonNegativeIntegerSchema,
  safePositiveIntegerSchema,
} from "./common.js";
import { claimSchema } from "./claims.js";
import {
  briefContractDigestSchema,
  briefMaterialRefSchema,
  contentDigestSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialIdSchema,
  materialSetHashSchema,
  subjectIdSchema,
  versionIdSchema,
} from "./ids.js";
import {
  materialRecordKindSchema,
  materialSourceSchema,
  sourceGroupSchema,
  textDerivationSchema,
} from "./materials.js";
import { qualitySummarySchema } from "./profiles.js";
import { subjectSummarySchema } from "./subjects.js";
import { distillyErrorCodeSchema } from "./wire.js";

export const publicJobStateSchema = z.enum(["pending", "leased", "failed"]);

const pendingJobBaseShape = {
  id: jobIdSchema,
  subjectId: subjectIdSchema,
  generation: safeNonNegativeIntegerSchema,
  baseVersionId: versionIdSchema.optional(),
  materialSetHash: materialSetHashSchema,
  addedMaterialCount: safeNonNegativeIntegerSchema,
  totalMaterialCount: safeNonNegativeIntegerSchema,
  queuedAt: isoDateTimeSchema,
} as const;

export const pendingJobFailureSchema = z.strictObject({
  code: distillyErrorCodeSchema,
  retryable: z.boolean(),
  remediation: reasonStringSchema.optional(),
});

export const pendingJobSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ ...pendingJobBaseShape, state: z.literal("pending") }),
    z.strictObject({
      ...pendingJobBaseShape,
      state: z.literal("leased"),
      leaseExpiresAt: isoDateTimeSchema,
    }),
    z.strictObject({
      ...pendingJobBaseShape,
      state: z.literal("failed"),
      failure: pendingJobFailureSchema,
    }),
  ])
  .superRefine((job, context) => {
    if (job.addedMaterialCount > job.totalMaterialCount) {
      context.addIssue({
        code: "custom",
        path: ["addedMaterialCount"],
        message: "added material count cannot exceed total material count",
      });
    }
  });

export const pendingFilterSchema = z.strictObject({
  subjectId: subjectIdSchema.optional(),
  state: publicJobStateSchema.optional(),
  limit: listLimitSchema.optional(),
});

const hostDistillPromptVersionSchema = z
  .string()
  .regex(/^host-distill-v1-sha256_[0-9a-f]{64}$/)
  .transform((value) => value as `host-distill-v1-sha256_${string}`);

export const briefContractSchema = z.strictObject({
  digest: briefContractDigestSchema,
  sourceGroupingVersion: z.literal("source-groups-v1"),
  promptVersion: hostDistillPromptVersionSchema,
  draftSchemaVersion: z.literal(1),
});

export const jobLeaseSchema = z
  .strictObject({
    id: leaseIdSchema,
    jobId: jobIdSchema,
    generation: safeNonNegativeIntegerSchema,
    briefContractDigest: briefContractDigestSchema,
    owner: leaseOwnerIdSchema,
    acquiredAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
  })
  .refine((lease) => lease.expiresAt > lease.acquiredAt, {
    path: ["expiresAt"],
    message: "lease expiry must be later than acquisition",
  });

export const briefMaterialSchema = z.strictObject({
  ref: briefMaterialRefSchema,
  materialId: materialIdSchema,
  contentDigest: contentDigestSchema,
  kind: z.lazy(() => materialRecordKindSchema),
  content: materialContentSchema,
  source: z.lazy(() => materialSourceSchema),
  derivation: z.lazy(() => textDerivationSchema),
  sourceGroup: z.lazy(() => sourceGroupSchema),
  sensitivity: z.enum(["private", "shareable"]),
});

export const briefEvidenceFactSchema = z.strictObject({
  materialId: materialIdSchema,
  source: z.lazy(() => materialSourceSchema),
  derivation: z.lazy(() => textDerivationSchema),
  sourceGroup: z.lazy(() => sourceGroupSchema),
  sensitivity: z.enum(["private", "shareable"]),
  flags: z.array(z.literal("suspicious_source")).max(WIRE_LIMITS.smallArrayItems),
});

export const hostDistillContractSchema = z.strictObject({
  ...briefContractSchema.shape,
  instructions: reasonStringSchema,
  evidenceRules: z.array(reasonStringSchema).max(WIRE_LIMITS.smallArrayItems),
});

export const hostDistillBriefingSchema = z
  .strictObject({
    job: pendingJobSchema,
    lease: jobLeaseSchema,
    subject: subjectSummarySchema,
    baseline: z
      .strictObject({
        versionId: versionIdSchema,
        claims: z.array(claimSchema),
        quality: qualitySummarySchema,
        evidenceFacts: z.array(briefEvidenceFactSchema),
      })
      .optional(),
    materials: z.array(briefMaterialSchema),
    contract: hostDistillContractSchema,
    limits: z.strictObject({
      estimatedInputTokens: safePositiveIntegerSchema,
      maximumInputTokens: safePositiveIntegerSchema,
      maximumOutputBytes: safePositiveIntegerSchema,
    }),
  })
  .superRefine((briefing, context) => {
    if (briefing.job.state !== "leased") {
      context.addIssue({
        code: "custom",
        path: ["job", "state"],
        message: "a host briefing requires a leased job",
      });
    }
    if (briefing.job.id !== briefing.lease.jobId) {
      context.addIssue({
        code: "custom",
        path: ["lease", "jobId"],
        message: "briefing lease must belong to the briefing job",
      });
    }
    if (briefing.job.generation !== briefing.lease.generation) {
      context.addIssue({
        code: "custom",
        path: ["lease", "generation"],
        message: "briefing lease generation must match the job generation",
      });
    }
    if (
      briefing.job.state === "leased" &&
      briefing.job.leaseExpiresAt !== briefing.lease.expiresAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["job", "leaseExpiresAt"],
        message: "leased job expiry must match the briefing lease",
      });
    }
    if (briefing.lease.briefContractDigest !== briefing.contract.digest) {
      context.addIssue({
        code: "custom",
        path: ["contract", "digest"],
        message: "briefing contract must match the lease contract digest",
      });
    }
    if (briefing.subject.id !== briefing.job.subjectId) {
      context.addIssue({
        code: "custom",
        path: ["subject", "id"],
        message: "briefing subject must own the leased job",
      });
    }

    const expectsBaseline = briefing.job.baseVersionId !== undefined;
    if (expectsBaseline !== (briefing.baseline !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["baseline"],
        message: "baseline presence must match the job base version",
      });
    } else if (
      briefing.baseline !== undefined &&
      briefing.baseline.versionId !== briefing.job.baseVersionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseline", "versionId"],
        message: "baseline version must match the job base version",
      });
    }

    const materialIds = new Set<string>();
    for (const [index, material] of briefing.materials.entries()) {
      const expectedRef = `m${String(index + 1).padStart(3, "0")}`;
      if (material.ref !== expectedRef) {
        context.addIssue({
          code: "custom",
          path: ["materials", index, "ref"],
          message: "briefing material refs must be contiguous from m001",
        });
      }
      if (materialIds.has(material.materialId)) {
        context.addIssue({
          code: "custom",
          path: ["materials", index, "materialId"],
          message: "briefing material ids must be unique",
        });
      }
      const previous = briefing.materials[index - 1];
      if (previous !== undefined && previous.materialId >= material.materialId) {
        context.addIssue({
          code: "custom",
          path: ["materials", index, "materialId"],
          message: "briefing materials must be strictly ordered by MaterialId",
        });
      }
      materialIds.add(material.materialId);
    }

    if (briefing.baseline !== undefined) {
      for (let index = 1; index < briefing.baseline.evidenceFacts.length; index += 1) {
        const previous = briefing.baseline.evidenceFacts[index - 1];
        const current = briefing.baseline.evidenceFacts[index];
        if (
          previous !== undefined &&
          current !== undefined &&
          previous.materialId >= current.materialId
        ) {
          context.addIssue({
            code: "custom",
            path: ["baseline", "evidenceFacts", index, "materialId"],
            message: "baseline evidence facts must be strictly ordered by MaterialId",
          });
        }
      }
    }
  });

export const briefInputSchema = z.strictObject({ jobId: jobIdSchema });

export const renewLeaseInputSchema = z.strictObject({
  jobId: jobIdSchema,
  leaseId: leaseIdSchema,
});

export const releaseLeaseInputSchema = z.strictObject({
  jobId: jobIdSchema,
  leaseId: leaseIdSchema,
  reason: reasonStringSchema.optional(),
});

export const redistillInputSchema = z.strictObject({
  subjectId: subjectIdSchema,
  mode: z.enum(["incremental", "full"]),
  reason: reasonStringSchema,
});
