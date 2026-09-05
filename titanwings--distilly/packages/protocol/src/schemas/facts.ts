import { z } from "zod";

import { WIRE_LIMITS } from "../json.js";
import type { MutationMethodName } from "../methods.js";
import type {
  DistillCommitTransactionRecord,
  DistillLeaseTransactionRecord,
  EventRecord,
  FactEnvelope,
  OperationScope,
  OperationTombstoneRecord,
  PendingLeaseMarker,
  PendingJobMarker,
  ReviewDecisionTransactionMethod,
  ReviewDecisionTransactionRecord,
  RollbackTransactionRecord,
  SpaceRecord,
  StoredOperationResult,
  SubjectRecord,
  SubjectStateRecord,
  TransactionRecord,
  VersionClaimsSnapshot,
  VersionMaterialEntry,
} from "../values/facts.js";
import type { VersionMaterialManifest, VersionRecord } from "../values/versions.js";
import {
  labelStringSchema,
  reasonStringSchema,
  safeNonNegativeIntegerSchema,
  safePositiveIntegerSchema,
} from "./common.js";
import type { MatchingSchema } from "./common.js";
import { actorContextSchema } from "./context.js";
import { claimSchema, distillPatchSchema } from "./claims.js";
import { engineEventSchema } from "./events.js";
import {
  bundleExportResultSchema,
  bundleImportResultSchema,
  exportRefSchema,
  installRefSchema,
} from "./hosts.js";
import {
  briefContractSchema,
  hostDistillBriefingSchema,
  jobLeaseSchema,
  pendingJobSchema,
} from "./jobs.js";
import { ingestFilesResultSchema, ingestResultSchema } from "./materials.js";
import {
  contentDigestSchema,
  eventIdSchema,
  factChecksumSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialIdSchema,
  materialSetHashSchema,
  provenanceDigestSchema,
  requestIdSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "./ids.js";
import {
  profileSchema,
  qualitySummarySchema,
  rebuildResultSchema,
  renderedPromptSchema,
} from "./profiles.js";
import {
  identityHintSchema,
  purgeResultSchema,
  subjectLifecycleSchema,
  subjectSummarySchema,
} from "./subjects.js";
import {
  commitResultSchema,
  createdDispositionSchema,
  reviewReasonsSchema,
  versionCreationSchema,
  versionSummarySchema,
} from "./versions.js";

const schemaFor =
  <T>() =>
  <S extends z.ZodType>(schema: S & MatchingSchema<S, T>): S =>
    schema;

const factEnvelopeV1Shape = {
  schemaVersion: z.literal(1),
  checksum: factChecksumSchema,
} as const;

const factEnvelopeV2Shape = {
  schemaVersion: z.literal(2),
  checksum: factChecksumSchema,
} as const;

/** Runtime schema for the shared fact integrity envelope. */
export const factEnvelopeSchema = schemaFor<FactEnvelope>()(
  z.strictObject({
    schemaVersion: safePositiveIntegerSchema,
    checksum: factChecksumSchema,
  }),
);

/** Runtime schema for a persisted space namespace. */
export const spaceRecordSchema = schemaFor<SpaceRecord>()(
  z.strictObject({
    ...factEnvelopeV1Shape,
    id: spaceIdSchema,
    displayName: labelStringSchema,
    kind: z.enum(["people", "fictional", "custom"]),
  }),
);

/** Runtime schema for persisted subject identity. */
export const subjectRecordSchema = schemaFor<SubjectRecord>()(
  z.strictObject({
    ...factEnvelopeV1Shape,
    id: subjectIdSchema,
    spaceId: spaceIdSchema,
    displayName: labelStringSchema,
    aliases: z.array(labelStringSchema).max(WIRE_LIMITS.smallArrayItems),
    identityHints: z.array(identityHintSchema).max(WIRE_LIMITS.smallArrayItems),
    domainPack: labelStringSchema.optional(),
    lifecycle: subjectLifecycleSchema,
  }),
);

/** Runtime schema for digest-only material membership. */
export const versionMaterialEntrySchema = schemaFor<VersionMaterialEntry>()(
  z.strictObject({
    materialId: materialIdSchema,
    contentDigest: contentDigestSchema,
    provenanceDigest: provenanceDigestSchema,
  }),
);

const sortedMaterialEntriesSchema = z
  .array(versionMaterialEntrySchema)
  .superRefine((items, context) => {
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1];
      const current = items[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        previous.materialId >= current.materialId
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "materialId"],
          message: "material entries must be strictly ordered by MaterialId",
        });
      }
    }
  });

const sortedClaimsSchema = z.array(claimSchema).superRefine((claims, context) => {
  for (let index = 1; index < claims.length; index += 1) {
    const previous = claims[index - 1];
    const current = claims[index];
    if (previous !== undefined && current !== undefined && previous.id >= current.id) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: "claims must be strictly ordered by ClaimId",
      });
    }
  }
});

/** Runtime schema for immutable claims owned by one persisted version. */
export const versionClaimsSnapshotSchema = schemaFor<VersionClaimsSnapshot>()(
  z.strictObject({
    ...factEnvelopeV1Shape,
    subjectId: subjectIdSchema,
    versionId: versionIdSchema,
    claims: sortedClaimsSchema,
  }),
);

/** Runtime schema for one persisted pending-work lease. */
export const pendingLeaseMarkerSchema = schemaFor<PendingLeaseMarker>()(
  z
    .strictObject({
      id: leaseIdSchema,
      owner: leaseOwnerIdSchema,
      acquiredAt: isoDateTimeSchema,
      expiresAt: isoDateTimeSchema,
      contract: briefContractSchema,
    })
    .refine((lease) => lease.expiresAt > lease.acquiredAt, {
      path: ["expiresAt"],
      message: "pending lease expiry must be later than acquisition",
    }),
);

/** Runtime schema for the fact-owned subset of pending job state. */
export const pendingJobMarkerSchema = schemaFor<PendingJobMarker>()(
  z
    .strictObject({
      jobId: jobIdSchema,
      generation: safeNonNegativeIntegerSchema,
      baseVersionId: versionIdSchema.optional(),
      materialSetHash: materialSetHashSchema,
      addedMaterialCount: safeNonNegativeIntegerSchema,
      totalMaterialCount: safeNonNegativeIntegerSchema,
      queuedAt: isoDateTimeSchema,
      lease: pendingLeaseMarkerSchema.optional(),
    })
    .superRefine((marker, context) => {
      if (marker.addedMaterialCount > marker.totalMaterialCount) {
        context.addIssue({
          code: "custom",
          path: ["addedMaterialCount"],
          message: "added material count cannot exceed total material count",
        });
      }
    }),
);

/** Runtime schema for authoritative current subject state. */
export const subjectStateRecordSchema = schemaFor<SubjectStateRecord>()(
  z
    .strictObject({
      ...factEnvelopeV2Shape,
      subjectId: subjectIdSchema,
      generation: safeNonNegativeIntegerSchema,
      materialSetHash: materialSetHashSchema.optional(),
      materialManifest: sortedMaterialEntriesSchema,
      currentVersionId: versionIdSchema.optional(),
      suspendedVersionId: versionIdSchema.optional(),
      pending: pendingJobMarkerSchema.optional(),
    })
    .superRefine((state, context) => {
      if (state.materialManifest.length === 0) {
        if (state.generation !== 0) {
          context.addIssue({
            code: "custom",
            path: ["generation"],
            message: "an empty subject must have generation zero",
          });
        }
        if (state.materialSetHash !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["materialSetHash"],
            message: "an empty subject cannot have a material-set hash",
          });
        }
        if (state.pending !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["pending"],
            message: "an empty subject cannot have pending distillation work",
          });
        }
        return;
      }

      if (state.generation === 0) {
        context.addIssue({
          code: "custom",
          path: ["generation"],
          message: "a non-empty subject must have a positive generation",
        });
      }
      if (state.materialSetHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["materialSetHash"],
          message: "a non-empty subject requires a material-set hash",
        });
      }

      if (state.pending !== undefined) {
        if (state.pending.generation !== state.generation) {
          context.addIssue({
            code: "custom",
            path: ["pending", "generation"],
            message: "pending generation must match subject state",
          });
        }
        if (state.pending.materialSetHash !== state.materialSetHash) {
          context.addIssue({
            code: "custom",
            path: ["pending", "materialSetHash"],
            message: "pending material-set hash must match subject state",
          });
        }
        if (state.pending.totalMaterialCount !== state.materialManifest.length) {
          context.addIssue({
            code: "custom",
            path: ["pending", "totalMaterialCount"],
            message: "pending total count must match the subject manifest",
          });
        }
        if (state.pending.baseVersionId !== state.currentVersionId) {
          context.addIssue({
            code: "custom",
            path: ["pending", "baseVersionId"],
            message: "pending base version must match the current subject version",
          });
        }
      }
    }),
);

/** Runtime schema for one durable engine event. */
export const eventRecordSchema = schemaFor<EventRecord>()(
  z
    .strictObject({
      ...factEnvelopeV1Shape,
      eventId: eventIdSchema,
      event: engineEventSchema,
      actor: actorContextSchema,
      requestId: requestIdSchema.optional(),
      reason: reasonStringSchema.optional(),
      relatedVersionId: versionIdSchema.optional(),
    })
    .superRefine((record, context) => {
      if (record.requestId === undefined && record.actor.kind !== "system") {
        context.addIssue({
          code: "custom",
          path: ["requestId"],
          message: "only system events may omit a request id",
        });
      }

      const hasReason = record.reason !== undefined;
      const hasRelatedVersion = record.relatedVersionId !== undefined;
      if (record.reason !== undefined && record.reason.trim().length === 0) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "event reason must not be blank",
        });
      }

      if (record.event.kind === "version.promoted") {
        if (hasRelatedVersion) {
          context.addIssue({
            code: "custom",
            path: ["relatedVersionId"],
            message: "promote events cannot identify a related version",
          });
        }
      } else if (record.event.kind === "version.rejected") {
        if (hasReason && hasRelatedVersion) {
          context.addIssue({
            code: "custom",
            path: ["reason"],
            message: "candidate replacement events cannot include a direct-review reason",
          });
        }
      } else if (record.event.kind === "version.rolled_back") {
        if (!hasReason) {
          context.addIssue({
            code: "custom",
            path: ["reason"],
            message: "rollback events require a reason",
          });
        }
        if (!hasRelatedVersion) {
          context.addIssue({
            code: "custom",
            path: ["relatedVersionId"],
            message: "rollback events require their source version",
          });
        }
      } else if (hasReason || hasRelatedVersion) {
        context.addIssue({
          code: "custom",
          path: hasReason ? ["reason"] : ["relatedVersionId"],
          message: "only review and rollback events carry lineage metadata",
        });
      }

      if (
        record.relatedVersionId !== undefined &&
        record.relatedVersionId === record.event.versionId
      ) {
        context.addIssue({
          code: "custom",
          path: ["relatedVersionId"],
          message: "related version must differ from the event version",
        });
      }
    }),
);

/** Runtime schema for immutable persisted version metadata. */
export const versionRecordSchema = schemaFor<VersionRecord>()(
  z
    .strictObject({
      ...factEnvelopeV1Shape,
      id: versionIdSchema,
      subjectId: subjectIdSchema,
      subjectDisplayName: labelStringSchema,
      parentId: versionIdSchema.optional(),
      derivedFromCandidateVersionId: versionIdSchema.optional(),
      generation: safeNonNegativeIntegerSchema,
      materialSetHash: materialSetHashSchema,
      materialCount: safeNonNegativeIntegerSchema,
      creation: versionCreationSchema,
      createdDisposition: createdDispositionSchema,
      reviewReasons: reviewReasonsSchema.optional(),
      actor: actorContextSchema,
      quality: qualitySummarySchema,
      rendererVersion: labelStringSchema,
      createdAt: isoDateTimeSchema,
    })
    .superRefine((version, context) => {
      if (version.createdDisposition === "current" && version.reviewReasons !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["reviewReasons"],
          message: "current versions must omit review reasons",
        });
      }
      if (version.createdDisposition === "suspended" && version.reviewReasons === undefined) {
        context.addIssue({
          code: "custom",
          path: ["reviewReasons"],
          message: "suspended versions require review reasons",
        });
      }
    }),
);

/** Runtime schema for historical version material membership. */
export const versionMaterialManifestSchema = schemaFor<VersionMaterialManifest>()(
  z.strictObject({
    ...factEnvelopeV1Shape,
    items: sortedMaterialEntriesSchema,
  }),
);

const operationRecordVariant = <M extends MutationMethodName, S extends z.ZodType>(
  method: M,
  result: S & MatchingSchema<S, StoredOperationResult<M>>,
) =>
  z.strictObject({
    ...factEnvelopeV1Shape,
    recordKind: z.literal("completed"),
    requestId: requestIdSchema,
    method: z.literal(method),
    scope: operationScopeSchema,
    actor: actorContextSchema,
    inputChecksum: factChecksumSchema,
    result,
    completedAt: isoDateTimeSchema,
  });

const emptyResultSchema = z.null();

/** Runtime schema for root-global or single-subject operation ownership. */
export const operationScopeSchema = schemaFor<OperationScope>()(
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("global") }),
    z.strictObject({ kind: z.literal("subject"), subjectId: subjectIdSchema }),
  ]),
);

const operationRecordVariants = {
  "subjects.create": operationRecordVariant("subjects.create", subjectSummarySchema),
  "subjects.archive": operationRecordVariant("subjects.archive", emptyResultSchema),
  "subjects.purge": operationRecordVariant("subjects.purge", purgeResultSchema),
  "materials.ingest": operationRecordVariant("materials.ingest", ingestResultSchema),
  "materials.ingestFiles": operationRecordVariant("materials.ingestFiles", ingestFilesResultSchema),
  "distill.brief": operationRecordVariant("distill.brief", hostDistillBriefingSchema),
  "distill.renew": operationRecordVariant("distill.renew", jobLeaseSchema),
  "distill.release": operationRecordVariant("distill.release", emptyResultSchema),
  "distill.commit": operationRecordVariant("distill.commit", commitResultSchema),
  "distill.redistill": operationRecordVariant("distill.redistill", pendingJobSchema),
  "profiles.correct": operationRecordVariant("profiles.correct", commitResultSchema),
  "versions.promote": operationRecordVariant("versions.promote", versionSummarySchema),
  "versions.reject": operationRecordVariant("versions.reject", versionSummarySchema),
  "versions.rollback": operationRecordVariant("versions.rollback", versionSummarySchema),
  "hosts.install": operationRecordVariant("hosts.install", installRefSchema),
  "hosts.uninstall": operationRecordVariant("hosts.uninstall", emptyResultSchema),
  "hosts.export": operationRecordVariant("hosts.export", exportRefSchema),
  "library.rebuild": operationRecordVariant("library.rebuild", rebuildResultSchema),
  "bundles.import": operationRecordVariant("bundles.import", bundleImportResultSchema),
  "bundles.export": operationRecordVariant("bundles.export", bundleExportResultSchema),
} satisfies { readonly [M in MutationMethodName]: z.ZodType };

const mutationMethodNameSchema = z.enum([
  "subjects.create",
  "subjects.archive",
  "subjects.purge",
  "materials.ingest",
  "materials.ingestFiles",
  "distill.brief",
  "distill.renew",
  "distill.release",
  "distill.commit",
  "distill.redistill",
  "profiles.correct",
  "versions.promote",
  "versions.reject",
  "versions.rollback",
  "hosts.install",
  "hosts.uninstall",
  "hosts.export",
  "library.rebuild",
  "bundles.import",
  "bundles.export",
] as const satisfies readonly MutationMethodName[]);

const operationRecordUnionSchema = z.discriminatedUnion("method", [
  operationRecordVariants["subjects.create"],
  operationRecordVariants["subjects.archive"],
  operationRecordVariants["subjects.purge"],
  operationRecordVariants["materials.ingest"],
  operationRecordVariants["materials.ingestFiles"],
  operationRecordVariants["distill.brief"],
  operationRecordVariants["distill.renew"],
  operationRecordVariants["distill.release"],
  operationRecordVariants["distill.commit"],
  operationRecordVariants["distill.redistill"],
  operationRecordVariants["profiles.correct"],
  operationRecordVariants["versions.promote"],
  operationRecordVariants["versions.reject"],
  operationRecordVariants["versions.rollback"],
  operationRecordVariants["hosts.install"],
  operationRecordVariants["hosts.uninstall"],
  operationRecordVariants["hosts.export"],
  operationRecordVariants["library.rebuild"],
  operationRecordVariants["bundles.import"],
  operationRecordVariants["bundles.export"],
]);

type ParsedOperationRecord = z.infer<typeof operationRecordUnionSchema>;

const operationResultSubjectIds = (record: ParsedOperationRecord): readonly string[] => {
  switch (record.method) {
    case "subjects.create":
      return [record.result.id];
    case "subjects.archive":
    case "distill.renew":
    case "distill.release":
    case "hosts.uninstall":
    case "library.rebuild":
    case "bundles.export":
      return [];
    case "subjects.purge":
      return [record.result.subjectId];
    case "materials.ingest":
    case "materials.ingestFiles":
      return [record.result.subject.id];
    case "distill.brief":
      return [record.result.subject.id, record.result.job.subjectId];
    case "distill.commit":
    case "profiles.correct":
      return record.result.kind === "current"
        ? [record.result.version.subjectId, record.result.profile.subjectId]
        : [record.result.candidate.subjectId, record.result.review.subjectId];
    case "distill.redistill":
      return [record.result.subjectId];
    case "versions.promote":
    case "versions.reject":
    case "versions.rollback":
      return [record.result.subjectId];
    case "hosts.install":
    case "hosts.export":
      return [record.result.subjectId];
    case "bundles.import":
      return [
        record.result.subject.id,
        record.result.candidate.subjectId,
        record.result.review.subjectId,
      ];
    default: {
      const exhaustive: never = record;
      return exhaustive;
    }
  }
};

const refineMethodScope = (
  record: { readonly method: MutationMethodName; readonly scope: OperationScope },
  context: z.core.$RefinementCtx,
): void => {
  const expectsGlobal = record.method === "library.rebuild";
  if (expectsGlobal !== (record.scope.kind === "global")) {
    context.addIssue({
      code: "custom",
      path: ["scope"],
      message: expectsGlobal
        ? "library rebuild operations require global scope"
        : "subject-owned operations require subject scope",
    });
  }
};

const refineCompletedOperationScope = (
  record: ParsedOperationRecord,
  context: z.core.$RefinementCtx,
): void => {
  refineMethodScope(record, context);
  if (record.scope.kind === "subject") {
    const scopeSubjectId = record.scope.subjectId;
    if (
      operationResultSubjectIds(record).some(
        (resultSubjectId) => resultSubjectId !== scopeSubjectId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope", "subjectId"],
        message: "operation result subjects must match the operation scope",
      });
    }
  }
};

/** Runtime discriminated union for all completed mutation records. */
export const operationRecordSchema = operationRecordUnionSchema.superRefine(
  refineCompletedOperationScope,
);

/** Runtime schema for a content-free operation marker left by subject purge. */
export const operationTombstoneRecordSchema = schemaFor<OperationTombstoneRecord>()(
  z
    .strictObject({
      ...factEnvelopeV1Shape,
      recordKind: z.literal("tombstone"),
      requestId: requestIdSchema,
      method: mutationMethodNameSchema,
      scope: operationScopeSchema,
      inputChecksum: factChecksumSchema,
      removedAt: isoDateTimeSchema,
      reason: z.literal("subject_purged"),
    })
    .superRefine(refineMethodScope),
);

/** Runtime discriminated union for a completed operation or purge tombstone. */
export const operationFactSchema = z.discriminatedUnion("recordKind", [
  operationRecordSchema,
  operationTombstoneRecordSchema,
]);

const actorsEqual = (
  left: { readonly kind: string; readonly id: string; readonly host?: string | undefined },
  right: { readonly kind: string; readonly id: string; readonly host?: string | undefined },
): boolean => left.kind === right.kind && left.id === right.id && left.host === right.host;

const distillLeaseTransactionBaseShape = {
  ...factEnvelopeV1Shape,
  transactionKind: z.literal("distill_lease"),
  requestId: requestIdSchema,
  subjectId: subjectIdSchema,
  jobId: jobIdSchema,
  previousStateChecksum: factChecksumSchema,
  targetStateChecksum: factChecksumSchema,
  previousPending: pendingJobMarkerSchema,
  targetPending: pendingJobMarkerSchema,
  event: eventRecordSchema,
  preparedAt: isoDateTimeSchema,
} as const;

/** Runtime schema for one persisted lease transaction method discriminant. */
export const distillLeaseTransactionMethodSchema = z.enum(["brief", "renew", "release"]);

const distillLeaseTransactionVariant = <M extends "brief" | "renew" | "release">(
  method: M,
  operation: (typeof operationRecordVariants)[`distill.${M}`],
) =>
  z.union([
    z.strictObject({
      ...distillLeaseTransactionBaseShape,
      method: z.literal(method),
      operation,
      state: z.literal("prepared"),
    }),
    z.strictObject({
      ...distillLeaseTransactionBaseShape,
      method: z.literal(method),
      operation,
      state: z.literal("committed"),
      finishedAt: isoDateTimeSchema,
    }),
    z.strictObject({
      ...distillLeaseTransactionBaseShape,
      method: z.literal(method),
      operation,
      state: z.literal("aborted"),
      finishedAt: isoDateTimeSchema,
    }),
  ]);

const distillLeaseTransactionUnionSchema = z.union([
  distillLeaseTransactionVariant("brief", operationRecordVariants["distill.brief"]),
  distillLeaseTransactionVariant("renew", operationRecordVariants["distill.renew"]),
  distillLeaseTransactionVariant("release", operationRecordVariants["distill.release"]),
]);

type ParsedDistillLeaseTransaction = z.infer<typeof distillLeaseTransactionUnionSchema>;
type ParsedPendingJobMarker = z.infer<typeof pendingJobMarkerSchema>;

const pendingStableFieldsEqual = (
  left: ParsedPendingJobMarker,
  right: ParsedPendingJobMarker,
): boolean =>
  left.jobId === right.jobId &&
  left.generation === right.generation &&
  left.baseVersionId === right.baseVersionId &&
  left.materialSetHash === right.materialSetHash &&
  left.addedMaterialCount === right.addedMaterialCount &&
  left.totalMaterialCount === right.totalMaterialCount &&
  left.queuedAt === right.queuedAt;

const briefContractsEqual = (
  left: PendingLeaseMarker["contract"],
  right: PendingLeaseMarker["contract"],
): boolean =>
  left.digest === right.digest &&
  left.sourceGroupingVersion === right.sourceGroupingVersion &&
  left.promptVersion === right.promptVersion &&
  left.draftSchemaVersion === right.draftSchemaVersion;

const pendingMarkerMatchesBriefing = (
  marker: ParsedPendingJobMarker,
  transaction: Extract<ParsedDistillLeaseTransaction, { readonly method: "brief" }>,
): boolean => {
  const briefing = transaction.operation.result;
  return (
    briefing.job.id === marker.jobId &&
    briefing.job.subjectId === transaction.subjectId &&
    briefing.job.generation === marker.generation &&
    briefing.job.baseVersionId === marker.baseVersionId &&
    briefing.job.materialSetHash === marker.materialSetHash &&
    briefing.job.addedMaterialCount === marker.addedMaterialCount &&
    briefing.job.totalMaterialCount === marker.totalMaterialCount &&
    briefing.job.queuedAt === marker.queuedAt &&
    briefing.job.state === "leased" &&
    marker.lease !== undefined &&
    briefing.job.leaseExpiresAt === marker.lease.expiresAt &&
    briefing.lease.id === marker.lease.id &&
    briefing.lease.jobId === marker.jobId &&
    briefing.lease.generation === marker.generation &&
    briefing.lease.owner === marker.lease.owner &&
    briefing.lease.acquiredAt === marker.lease.acquiredAt &&
    briefing.lease.expiresAt === marker.lease.expiresAt &&
    briefing.lease.briefContractDigest === marker.lease.contract.digest &&
    briefContractsEqual(marker.lease.contract, briefing.contract) &&
    briefing.subject.currentVersionId === marker.baseVersionId
  );
};

const leaseMarkerMatchesJobLease = (
  marker: ParsedPendingJobMarker,
  result: z.infer<typeof jobLeaseSchema>,
): boolean =>
  marker.lease !== undefined &&
  result.id === marker.lease.id &&
  result.jobId === marker.jobId &&
  result.generation === marker.generation &&
  result.owner === marker.lease.owner &&
  result.acquiredAt === marker.lease.acquiredAt &&
  result.expiresAt === marker.lease.expiresAt &&
  result.briefContractDigest === marker.lease.contract.digest;

/** Runtime schema for an atomic lease acquire, renewal, or release journal. */
export const distillLeaseTransactionRecordSchema = schemaFor<DistillLeaseTransactionRecord>()(
  distillLeaseTransactionUnionSchema.superRefine((transaction, context) => {
    if (transaction.state !== "prepared" && transaction.finishedAt < transaction.preparedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "lease journal finish time cannot precede preparation",
      });
    }
    if (transaction.previousPending.jobId !== transaction.jobId) {
      context.addIssue({
        code: "custom",
        path: ["previousPending", "jobId"],
        message: "previous pending marker must match the journal job",
      });
    }
    if (transaction.targetPending.jobId !== transaction.jobId) {
      context.addIssue({
        code: "custom",
        path: ["targetPending", "jobId"],
        message: "target pending marker must match the journal job",
      });
    }
    if (!pendingStableFieldsEqual(transaction.previousPending, transaction.targetPending)) {
      context.addIssue({
        code: "custom",
        path: ["targetPending"],
        message: "lease transactions cannot change stable pending-job fields",
      });
    }
    if (transaction.operation.requestId !== transaction.requestId) {
      context.addIssue({
        code: "custom",
        path: ["operation", "requestId"],
        message: "operation request id must match the lease journal",
      });
    }
    if (
      transaction.operation.scope.kind !== "subject" ||
      transaction.operation.scope.subjectId !== transaction.subjectId
    ) {
      context.addIssue({
        code: "custom",
        path: ["operation", "scope"],
        message: "operation scope must match the lease journal subject",
      });
    }
    if (transaction.event.event.kind !== "job.changed") {
      context.addIssue({
        code: "custom",
        path: ["event", "event", "kind"],
        message: "lease journals require exactly one job.changed event",
      });
    }
    if (transaction.event.event.subjectId !== transaction.subjectId) {
      context.addIssue({
        code: "custom",
        path: ["event", "event", "subjectId"],
        message: "lease journal event subject must match the journal",
      });
    }
    if (transaction.event.event.versionId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["event", "event", "versionId"],
        message: "job.changed events cannot identify a version",
      });
    }
    if (transaction.event.requestId !== transaction.requestId) {
      context.addIssue({
        code: "custom",
        path: ["event", "requestId"],
        message: "lease journal event request id must match the journal",
      });
    }
    if (!actorsEqual(transaction.event.actor, transaction.operation.actor)) {
      context.addIssue({
        code: "custom",
        path: ["event", "actor"],
        message: "lease journal event actor must match the stored operation",
      });
    }

    switch (transaction.method) {
      case "brief": {
        if (transaction.targetPending.lease === undefined) {
          context.addIssue({
            code: "custom",
            path: ["targetPending", "lease"],
            message: "brief must persist the acquired lease",
          });
        } else if (!pendingMarkerMatchesBriefing(transaction.targetPending, transaction)) {
          context.addIssue({
            code: "custom",
            path: ["operation", "result"],
            message: "brief result must exactly match the target pending marker",
          });
        }
        break;
      }
      case "renew": {
        const previousLease = transaction.previousPending.lease;
        const targetLease = transaction.targetPending.lease;
        if (previousLease === undefined || targetLease === undefined) {
          context.addIssue({
            code: "custom",
            path: ["targetPending", "lease"],
            message: "renew requires previous and target leases",
          });
          break;
        }
        if (
          previousLease.id !== targetLease.id ||
          previousLease.owner !== targetLease.owner ||
          previousLease.acquiredAt !== targetLease.acquiredAt ||
          !briefContractsEqual(previousLease.contract, targetLease.contract) ||
          targetLease.expiresAt <= previousLease.expiresAt
        ) {
          context.addIssue({
            code: "custom",
            path: ["targetPending", "lease"],
            message: "renew may only extend the expiry of the existing lease",
          });
        }
        if (!leaseMarkerMatchesJobLease(transaction.targetPending, transaction.operation.result)) {
          context.addIssue({
            code: "custom",
            path: ["operation", "result"],
            message: "renew result must exactly match the target pending marker",
          });
        }
        break;
      }
      case "release":
        if (transaction.previousPending.lease === undefined) {
          context.addIssue({
            code: "custom",
            path: ["previousPending", "lease"],
            message: "release requires a previous lease",
          });
        }
        if (transaction.targetPending.lease !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["targetPending", "lease"],
            message: "release must remove the pending lease",
          });
        }
        break;
      default: {
        const exhaustive: never = transaction;
        return exhaustive;
      }
    }
  }),
);

const distillCommitTransactionBaseShape = {
  ...factEnvelopeV1Shape,
  transactionKind: z.literal("distill_commit"),
  requestId: requestIdSchema,
  subjectId: subjectIdSchema,
  jobId: jobIdSchema,
  leaseId: leaseIdSchema,
  leaseOwner: leaseOwnerIdSchema,
  previousStateChecksum: factChecksumSchema,
  previousPending: pendingJobMarkerSchema,
  targetState: subjectStateRecordSchema,
  acceptedPatch: distillPatchSchema,
  patchDigest: contentDigestSchema,
  version: versionRecordSchema,
  materialManifest: versionMaterialManifestSchema,
  claims: versionClaimsSnapshotSchema,
  profile: profileSchema,
  prompt: renderedPromptSchema,
  operation: operationRecordVariants["distill.commit"],
  events: z.tuple([eventRecordSchema, eventRecordSchema]),
  preparedAt: isoDateTimeSchema,
} as const;

const distillCommitTransactionUnionSchema = z.union([
  z.strictObject({
    ...distillCommitTransactionBaseShape,
    state: z.literal("prepared"),
  }),
  z.strictObject({
    ...distillCommitTransactionBaseShape,
    state: z.literal("committed"),
    finishedAt: isoDateTimeSchema,
  }),
  z.strictObject({
    ...distillCommitTransactionBaseShape,
    state: z.literal("aborted"),
    finishedAt: isoDateTimeSchema,
  }),
]);

type ParsedDistillCommitTransaction = z.infer<typeof distillCommitTransactionUnionSchema>;

const factValuesEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const versionSummaryMatchesRecord = (
  summary: z.infer<typeof versionSummarySchema>,
  version: z.infer<typeof versionRecordSchema>,
  status: "current" | "suspended",
): boolean =>
  summary.id === version.id &&
  summary.subjectId === version.subjectId &&
  summary.parentId === version.parentId &&
  summary.derivedFromCandidateVersionId === version.derivedFromCandidateVersionId &&
  summary.generation === version.generation &&
  summary.materialSetHash === version.materialSetHash &&
  factValuesEqual(summary.creation, version.creation) &&
  summary.status === status &&
  actorsEqual(summary.actor, version.actor) &&
  factValuesEqual(summary.quality, version.quality) &&
  summary.createdAt === version.createdAt;

const refineDistillCommitTransaction = (
  transaction: ParsedDistillCommitTransaction,
  context: z.core.$RefinementCtx,
): void => {
  const issue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };

  if (transaction.state !== "prepared" && transaction.finishedAt < transaction.preparedAt) {
    issue(["finishedAt"], "commit journal finish time cannot precede preparation");
  }

  const previousLease = transaction.previousPending.lease;
  if (transaction.previousPending.jobId !== transaction.jobId) {
    issue(["previousPending", "jobId"], "previous pending marker must match the journal job");
  }
  if (previousLease === undefined) {
    issue(["previousPending", "lease"], "commit journals require the accepted active lease");
  } else {
    if (previousLease.id !== transaction.leaseId) {
      issue(["leaseId"], "journal lease id must match the previous pending lease");
    }
    if (previousLease.owner !== transaction.leaseOwner) {
      issue(["leaseOwner"], "journal lease owner must match the previous pending lease");
    }
  }

  if (transaction.targetState.subjectId !== transaction.subjectId) {
    issue(["targetState", "subjectId"], "target state must belong to the journal subject");
  }
  if (transaction.targetState.pending !== undefined) {
    issue(["targetState", "pending"], "a successful commit target must remove pending work");
  }
  if (transaction.targetState.generation !== transaction.previousPending.generation) {
    issue(["targetState", "generation"], "target generation must match the accepted pending job");
  }
  if (transaction.targetState.materialSetHash !== transaction.previousPending.materialSetHash) {
    issue(
      ["targetState", "materialSetHash"],
      "target material-set hash must match the accepted pending job",
    );
  }
  if (
    transaction.targetState.materialManifest.length !==
      transaction.previousPending.totalMaterialCount ||
    !factValuesEqual(transaction.targetState.materialManifest, transaction.materialManifest.items)
  ) {
    issue(
      ["targetState", "materialManifest"],
      "target and version material manifests must match the accepted pending job",
    );
  }

  const version = transaction.version;
  if (version.subjectId !== transaction.subjectId) {
    issue(["version", "subjectId"], "version must belong to the journal subject");
  }
  if (version.parentId !== transaction.previousPending.baseVersionId) {
    issue(["version", "parentId"], "version parent must match the accepted base version");
  }
  if (version.generation !== transaction.previousPending.generation) {
    issue(["version", "generation"], "version generation must match the accepted pending job");
  }
  if (version.materialSetHash !== transaction.previousPending.materialSetHash) {
    issue(
      ["version", "materialSetHash"],
      "version material-set hash must match the accepted pending job",
    );
  }
  if (version.materialCount !== transaction.materialManifest.items.length) {
    issue(["version", "materialCount"], "version material count must match its manifest");
  }
  if (version.creation.kind !== "host_distill") {
    issue(["version", "creation"], "distill commit versions require host_distill creation");
  } else if (
    previousLease !== undefined &&
    (version.creation.briefContractDigest !== previousLease.contract.digest ||
      version.creation.promptVersion !== previousLease.contract.promptVersion ||
      version.creation.draftSchemaVersion !== previousLease.contract.draftSchemaVersion)
  ) {
    issue(["version", "creation"], "version creation must match the accepted lease contract");
  }

  if (version.createdDisposition === "current") {
    if (
      transaction.targetState.currentVersionId !== version.id ||
      transaction.targetState.suspendedVersionId !== undefined
    ) {
      issue(
        ["targetState"],
        "current commits must point current at the new version and omit suspended",
      );
    }
  } else if (
    transaction.targetState.currentVersionId !== transaction.previousPending.baseVersionId ||
    transaction.targetState.suspendedVersionId !== version.id
  ) {
    issue(
      ["targetState"],
      "suspended commits must preserve current and point suspended at the new version",
    );
  }

  if (
    transaction.claims.subjectId !== transaction.subjectId ||
    transaction.claims.versionId !== version.id
  ) {
    issue(["claims"], "claims snapshot must identify the journal subject and version");
  }
  if (
    transaction.profile.subjectId !== transaction.subjectId ||
    transaction.profile.versionId !== version.id
  ) {
    issue(["profile"], "profile must identify the journal subject and version");
  }
  if (transaction.profile.displayName !== version.subjectDisplayName) {
    issue(["profile", "displayName"], "profile and version display names must match");
  }
  if (!factValuesEqual(transaction.profile.claims, transaction.claims.claims)) {
    issue(["profile", "claims"], "profile claims must match the version claims snapshot");
  }
  if (!factValuesEqual(transaction.profile.quality, version.quality)) {
    issue(["profile", "quality"], "profile quality must match version quality");
  }

  const operation = transaction.operation;
  if (operation.requestId !== transaction.requestId) {
    issue(["operation", "requestId"], "operation request id must match the commit journal");
  }
  if (operation.scope.kind !== "subject" || operation.scope.subjectId !== transaction.subjectId) {
    issue(["operation", "scope"], "operation scope must match the commit journal subject");
  }
  if (!actorsEqual(operation.actor, version.actor)) {
    issue(["operation", "actor"], "operation actor must match the committed version actor");
  }

  const result = operation.result;
  if (version.createdDisposition === "current") {
    if (result.kind !== "current") {
      issue(["operation", "result"], "current versions require a current commit result");
    } else {
      if (!versionSummaryMatchesRecord(result.version, version, "current")) {
        issue(["operation", "result", "version"], "result version must match the journal version");
      }
      if (!factValuesEqual(result.profile, transaction.profile)) {
        issue(["operation", "result", "profile"], "result profile must match the journal profile");
      }
    }
  } else if (result.kind !== "suspended") {
    issue(["operation", "result"], "suspended versions require a suspended commit result");
  } else {
    if (!versionSummaryMatchesRecord(result.candidate, version, "suspended")) {
      issue(
        ["operation", "result", "candidate"],
        "result candidate must match the journal version",
      );
    }
    if (result.currentVersionId !== transaction.previousPending.baseVersionId) {
      issue(
        ["operation", "result", "currentVersionId"],
        "suspended result must preserve the accepted base version",
      );
    }
    if (!factValuesEqual(result.reasons, version.reviewReasons)) {
      issue(["operation", "result", "reasons"], "result reasons must match version review reasons");
    }
    if (
      result.review.subjectId !== transaction.subjectId ||
      result.review.candidateVersionId !== version.id
    ) {
      issue(["operation", "result", "review"], "review ref must identify the journal version");
    }
  }

  const expectedVersionEventKind =
    version.createdDisposition === "current" ? "version.current" : "version.suspended";
  const [versionEvent, jobEvent] = transaction.events;
  if (
    versionEvent.event.kind !== expectedVersionEventKind ||
    versionEvent.event.subjectId !== transaction.subjectId ||
    versionEvent.event.versionId !== version.id
  ) {
    issue(["events", 0, "event"], "first event must identify the committed version disposition");
  }
  if (
    jobEvent.event.kind !== "job.changed" ||
    jobEvent.event.subjectId !== transaction.subjectId ||
    jobEvent.event.versionId !== undefined
  ) {
    issue(["events", 1, "event"], "second event must be the subject job.changed event");
  }
  if (versionEvent.eventId === jobEvent.eventId) {
    issue(["events", 1, "eventId"], "commit event ids must be unique");
  }
  for (const [index, event] of transaction.events.entries()) {
    if (event.requestId !== transaction.requestId) {
      issue(["events", index, "requestId"], "event request id must match the commit journal");
    }
    if (!actorsEqual(event.actor, operation.actor)) {
      issue(["events", index, "actor"], "event actor must match the stored operation");
    }
    if (event.event.at !== transaction.preparedAt) {
      issue(["events", index, "event", "at"], "event time must match journal preparation");
    }
  }
  if (version.createdAt !== transaction.preparedAt) {
    issue(["version", "createdAt"], "version creation time must match journal preparation");
  }
  if (operation.completedAt !== transaction.preparedAt) {
    issue(["operation", "completedAt"], "operation completion must match journal preparation");
  }
};

/** Runtime schema for a complete deterministic distillation commit journal. */
export const distillCommitTransactionRecordSchema = schemaFor<DistillCommitTransactionRecord>()(
  distillCommitTransactionUnionSchema.superRefine(refineDistillCommitTransaction),
);

const decisionEventsSchema = z.union([
  z.tuple([eventRecordSchema]),
  z.tuple([eventRecordSchema, eventRecordSchema]),
]);

const reviewDecisionTransactionBaseShape = {
  ...factEnvelopeV1Shape,
  transactionKind: z.literal("review_decision"),
  requestId: requestIdSchema,
  subjectId: subjectIdSchema,
  candidateVersionId: versionIdSchema,
  previousStateChecksum: factChecksumSchema,
  previousCurrentVersionId: versionIdSchema.optional(),
  previousSuspendedVersionId: versionIdSchema,
  previousPending: pendingJobMarkerSchema.optional(),
  targetState: subjectStateRecordSchema,
  events: decisionEventsSchema,
  preparedAt: isoDateTimeSchema,
} as const;

/** Runtime schema for one persisted review-decision transaction method. */
export const reviewDecisionTransactionMethodSchema = z.enum(["promote", "reject"]);

const reviewDecisionTransactionVariant = <M extends ReviewDecisionTransactionMethod>(
  method: M,
  operation: (typeof operationRecordVariants)[`versions.${M}`],
) =>
  z.union([
    z.strictObject({
      ...reviewDecisionTransactionBaseShape,
      method: z.literal(method),
      operation,
      state: z.literal("prepared"),
    }),
    z.strictObject({
      ...reviewDecisionTransactionBaseShape,
      method: z.literal(method),
      operation,
      state: z.literal("committed"),
      finishedAt: isoDateTimeSchema,
    }),
    z.strictObject({
      ...reviewDecisionTransactionBaseShape,
      method: z.literal(method),
      operation,
      state: z.literal("aborted"),
      finishedAt: isoDateTimeSchema,
    }),
  ]);

const reviewDecisionTransactionUnionSchema = z.union([
  reviewDecisionTransactionVariant("promote", operationRecordVariants["versions.promote"]),
  reviewDecisionTransactionVariant("reject", operationRecordVariants["versions.reject"]),
]);

type ParsedReviewDecisionTransaction = z.infer<typeof reviewDecisionTransactionUnionSchema>;

const pendingFactsEqual = (
  left: z.infer<typeof pendingJobMarkerSchema> | undefined,
  right: z.infer<typeof pendingJobMarkerSchema> | undefined,
): boolean => factValuesEqual(left, right);

const refineDecisionEvents = (
  transaction: ParsedReviewDecisionTransaction,
  expectedKind: "version.promoted" | "version.rejected",
  pendingChanged: boolean,
  context: z.core.$RefinementCtx,
): void => {
  const issue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  const [decisionEvent, jobEvent] = transaction.events;
  if (
    decisionEvent.event.kind !== expectedKind ||
    decisionEvent.event.subjectId !== transaction.subjectId ||
    decisionEvent.event.versionId !== transaction.candidateVersionId
  ) {
    issue(["events", 0, "event"], "first event must identify the reviewed candidate");
  }
  if (decisionEvent.relatedVersionId !== undefined) {
    issue(
      ["events", 0, "relatedVersionId"],
      "direct review decisions cannot identify a related version",
    );
  }
  if (pendingChanged !== (jobEvent !== undefined)) {
    issue(["events"], "a job.changed event exists if and only if the pending marker changes");
  }
  if (
    jobEvent !== undefined &&
    (jobEvent.event.kind !== "job.changed" ||
      jobEvent.event.subjectId !== transaction.subjectId ||
      jobEvent.event.versionId !== undefined)
  ) {
    issue(["events", 1, "event"], "second event must be the subject job.changed event");
  }
  if (jobEvent !== undefined && decisionEvent.eventId === jobEvent.eventId) {
    issue(["events", 1, "eventId"], "review event ids must be unique");
  }
  for (const [index, event] of transaction.events.entries()) {
    if (event.requestId !== transaction.requestId) {
      issue(["events", index, "requestId"], "event request id must match the review journal");
    }
    if (!actorsEqual(event.actor, transaction.operation.actor)) {
      issue(["events", index, "actor"], "event actor must match the stored operation");
    }
    if (event.event.at !== transaction.preparedAt) {
      issue(["events", index, "event", "at"], "event time must match journal preparation");
    }
  }
};

const refineReviewDecisionTransaction = (
  transaction: ParsedReviewDecisionTransaction,
  context: z.core.$RefinementCtx,
): void => {
  const issue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };

  if (transaction.state !== "prepared" && transaction.finishedAt < transaction.preparedAt) {
    issue(["finishedAt"], "review journal finish time cannot precede preparation");
  }
  if (transaction.previousStateChecksum === transaction.targetState.checksum) {
    issue(["targetState", "checksum"], "review target state must differ from previous state");
  }
  if (transaction.candidateVersionId !== transaction.previousSuspendedVersionId) {
    issue(["candidateVersionId"], "review candidate must match the previous suspended pointer");
  }
  if (transaction.candidateVersionId === transaction.previousCurrentVersionId) {
    issue(["candidateVersionId"], "review candidate must differ from previous current");
  }
  if (
    transaction.previousPending !== undefined &&
    transaction.previousPending.baseVersionId !== transaction.previousCurrentVersionId
  ) {
    issue(
      ["previousPending", "baseVersionId"],
      "previous pending base must match previous current",
    );
  }

  const target = transaction.targetState;
  if (target.subjectId !== transaction.subjectId) {
    issue(["targetState", "subjectId"], "target state must belong to the journal subject");
  }
  if (target.suspendedVersionId !== undefined) {
    issue(["targetState", "suspendedVersionId"], "review target must clear suspended");
  }

  const operation = transaction.operation;
  if (operation.requestId !== transaction.requestId) {
    issue(["operation", "requestId"], "operation request id must match the review journal");
  }
  if (operation.scope.kind !== "subject" || operation.scope.subjectId !== transaction.subjectId) {
    issue(["operation", "scope"], "operation scope must match the review journal subject");
  }
  if (operation.completedAt !== transaction.preparedAt) {
    issue(["operation", "completedAt"], "operation completion must match journal preparation");
  }
  if (
    operation.result.id !== transaction.candidateVersionId ||
    operation.result.subjectId !== transaction.subjectId ||
    operation.result.parentId !== transaction.previousCurrentVersionId
  ) {
    issue(["operation", "result"], "operation result must identify the reviewed candidate");
  }

  if (transaction.method === "reject") {
    if (target.currentVersionId !== transaction.previousCurrentVersionId) {
      issue(["targetState", "currentVersionId"], "reject must preserve previous current");
    }
    if (!pendingFactsEqual(target.pending, transaction.previousPending)) {
      issue(["targetState", "pending"], "reject must preserve pending work exactly");
    }
    if (operation.result.status !== "rejected") {
      issue(["operation", "result", "status"], "reject result must be rejected");
    }
    refineDecisionEvents(transaction, "version.rejected", false, context);
  } else {
    if (target.currentVersionId !== transaction.candidateVersionId) {
      issue(["targetState", "currentVersionId"], "promote must make the candidate current");
    }
    if (operation.result.status !== "current") {
      issue(["operation", "result", "status"], "promote result must be current");
    }
    if (transaction.previousPending === undefined && target.pending !== undefined) {
      issue(["targetState", "pending"], "promote cannot create previously absent pending work");
    }
    if (target.pending !== undefined) {
      if (target.pending.baseVersionId !== transaction.candidateVersionId) {
        issue(["targetState", "pending", "baseVersionId"], "promote must rebase pending");
      }
      if (target.pending.lease !== undefined) {
        issue(["targetState", "pending", "lease"], "rebased pending work cannot retain a lease");
      }
      if (target.pending.queuedAt !== transaction.preparedAt) {
        issue(
          ["targetState", "pending", "queuedAt"],
          "rebased pending work must use the mutation time",
        );
      }
      if (target.pending.addedMaterialCount === 0) {
        issue(
          ["targetState", "pending", "addedMaterialCount"],
          "zero-delta pending work must be cleared",
        );
      }
      if (target.pending.jobId === transaction.previousPending?.jobId) {
        issue(["targetState", "pending", "jobId"], "rebased pending work requires a new JobId");
      }
    }
    const pendingChanged = !pendingFactsEqual(target.pending, transaction.previousPending);
    refineDecisionEvents(transaction, "version.promoted", pendingChanged, context);
  }
};

/** Runtime schema for an atomic candidate promote or reject journal. */
export const reviewDecisionTransactionRecordSchema = schemaFor<ReviewDecisionTransactionRecord>()(
  reviewDecisionTransactionUnionSchema.superRefine(refineReviewDecisionTransaction),
);

const rollbackTransactionBaseShape = {
  ...factEnvelopeV1Shape,
  transactionKind: z.literal("rollback"),
  requestId: requestIdSchema,
  subjectId: subjectIdSchema,
  targetVersionId: versionIdSchema,
  previousStateChecksum: factChecksumSchema,
  previousCurrentVersionId: versionIdSchema,
  previousPending: pendingJobMarkerSchema.optional(),
  targetState: subjectStateRecordSchema,
  version: versionRecordSchema,
  materialManifest: versionMaterialManifestSchema,
  claims: versionClaimsSnapshotSchema,
  profile: profileSchema,
  prompt: renderedPromptSchema,
  operation: operationRecordVariants["versions.rollback"],
  events: decisionEventsSchema,
  preparedAt: isoDateTimeSchema,
} as const;

const rollbackTransactionUnionSchema = z.union([
  z.strictObject({ ...rollbackTransactionBaseShape, state: z.literal("prepared") }),
  z.strictObject({
    ...rollbackTransactionBaseShape,
    state: z.literal("committed"),
    finishedAt: isoDateTimeSchema,
  }),
  z.strictObject({
    ...rollbackTransactionBaseShape,
    state: z.literal("aborted"),
    finishedAt: isoDateTimeSchema,
  }),
]);

type ParsedRollbackTransaction = z.infer<typeof rollbackTransactionUnionSchema>;

const refineRollbackTransaction = (
  transaction: ParsedRollbackTransaction,
  context: z.core.$RefinementCtx,
): void => {
  const issue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  if (transaction.state !== "prepared" && transaction.finishedAt < transaction.preparedAt) {
    issue(["finishedAt"], "rollback journal finish time cannot precede preparation");
  }
  if (transaction.previousStateChecksum === transaction.targetState.checksum) {
    issue(["targetState", "checksum"], "rollback target state must differ from previous state");
  }
  if (transaction.targetVersionId === transaction.previousCurrentVersionId) {
    issue(["targetVersionId"], "rollback source must differ from previous current");
  }
  if (
    transaction.previousPending !== undefined &&
    transaction.previousPending.baseVersionId !== transaction.previousCurrentVersionId
  ) {
    issue(
      ["previousPending", "baseVersionId"],
      "previous pending base must match previous current",
    );
  }

  const target = transaction.targetState;
  const version = transaction.version;
  if (target.subjectId !== transaction.subjectId) {
    issue(["targetState", "subjectId"], "target state must belong to the journal subject");
  }
  if (target.currentVersionId !== version.id || target.suspendedVersionId !== undefined) {
    issue(["targetState"], "rollback target must make the new version current and omit suspended");
  }
  if (version.subjectId !== transaction.subjectId) {
    issue(["version", "subjectId"], "rollback version must belong to the journal subject");
  }
  if (
    version.id === transaction.targetVersionId ||
    version.id === transaction.previousCurrentVersionId
  ) {
    issue(["version", "id"], "rollback must create a distinct immutable version");
  }
  if (version.parentId !== transaction.previousCurrentVersionId) {
    issue(["version", "parentId"], "rollback parent must be previous current");
  }
  if (
    version.creation.kind !== "rollback" ||
    version.creation.targetVersionId !== transaction.targetVersionId
  ) {
    issue(["version", "creation"], "rollback creation must identify the source version");
  }
  if (version.createdDisposition !== "current") {
    issue(["version", "createdDisposition"], "rollback version must be created current");
  }
  if (version.materialCount !== transaction.materialManifest.items.length) {
    issue(["version", "materialCount"], "rollback material count must match its manifest");
  }
  if (version.createdAt !== transaction.preparedAt) {
    issue(["version", "createdAt"], "rollback version time must match journal preparation");
  }
  if (
    transaction.claims.subjectId !== transaction.subjectId ||
    transaction.claims.versionId !== version.id
  ) {
    issue(["claims"], "claims snapshot must identify the rollback subject and version");
  }
  if (
    transaction.profile.subjectId !== transaction.subjectId ||
    transaction.profile.versionId !== version.id
  ) {
    issue(["profile"], "profile must identify the rollback subject and version");
  }
  if (transaction.profile.displayName !== version.subjectDisplayName) {
    issue(["profile", "displayName"], "profile and rollback version display names must match");
  }
  if (!factValuesEqual(transaction.profile.claims, transaction.claims.claims)) {
    issue(["profile", "claims"], "profile claims must match the rollback claims snapshot");
  }
  if (!factValuesEqual(transaction.profile.quality, version.quality)) {
    issue(["profile", "quality"], "profile quality must match the rollback version");
  }

  const operation = transaction.operation;
  if (operation.requestId !== transaction.requestId) {
    issue(["operation", "requestId"], "operation request id must match the rollback journal");
  }
  if (operation.scope.kind !== "subject" || operation.scope.subjectId !== transaction.subjectId) {
    issue(["operation", "scope"], "operation scope must match the rollback journal subject");
  }
  if (!actorsEqual(operation.actor, version.actor)) {
    issue(["operation", "actor"], "operation actor must match the rollback version actor");
  }
  if (operation.completedAt !== transaction.preparedAt) {
    issue(["operation", "completedAt"], "operation completion must match journal preparation");
  }
  if (!versionSummaryMatchesRecord(operation.result, version, "current")) {
    issue(["operation", "result"], "operation result must match the rollback version");
  }

  if (transaction.previousPending === undefined && target.pending !== undefined) {
    issue(["targetState", "pending"], "rollback cannot create previously absent pending work");
  }
  if (target.pending !== undefined) {
    if (target.pending.baseVersionId !== version.id) {
      issue(["targetState", "pending", "baseVersionId"], "rollback must rebase pending");
    }
    if (target.pending.lease !== undefined) {
      issue(["targetState", "pending", "lease"], "rebased pending work cannot retain a lease");
    }
    if (target.pending.queuedAt !== transaction.preparedAt) {
      issue(
        ["targetState", "pending", "queuedAt"],
        "rebased pending work must use the mutation time",
      );
    }
    if (target.pending.addedMaterialCount === 0) {
      issue(
        ["targetState", "pending", "addedMaterialCount"],
        "zero-delta pending work must be cleared",
      );
    }
    if (target.pending.jobId === transaction.previousPending?.jobId) {
      issue(["targetState", "pending", "jobId"], "rebased pending work requires a new JobId");
    }
  }

  const pendingChanged = !pendingFactsEqual(target.pending, transaction.previousPending);
  const [rollbackEvent, jobEvent] = transaction.events;
  if (
    rollbackEvent.event.kind !== "version.rolled_back" ||
    rollbackEvent.event.subjectId !== transaction.subjectId ||
    rollbackEvent.event.versionId !== version.id ||
    rollbackEvent.relatedVersionId !== transaction.targetVersionId
  ) {
    issue(["events", 0], "first event must identify the rollback version and source");
  }
  if (pendingChanged !== (jobEvent !== undefined)) {
    issue(["events"], "a job.changed event exists if and only if rollback changes pending work");
  }
  if (
    jobEvent !== undefined &&
    (jobEvent.event.kind !== "job.changed" ||
      jobEvent.event.subjectId !== transaction.subjectId ||
      jobEvent.event.versionId !== undefined)
  ) {
    issue(["events", 1, "event"], "second event must be the subject job.changed event");
  }
  if (jobEvent !== undefined && rollbackEvent.eventId === jobEvent.eventId) {
    issue(["events", 1, "eventId"], "rollback event ids must be unique");
  }
  for (const [index, event] of transaction.events.entries()) {
    if (event.requestId !== transaction.requestId) {
      issue(["events", index, "requestId"], "event request id must match the rollback journal");
    }
    if (!actorsEqual(event.actor, operation.actor)) {
      issue(["events", index, "actor"], "event actor must match the stored operation");
    }
    if (event.event.at !== transaction.preparedAt) {
      issue(["events", index, "event", "at"], "event time must match journal preparation");
    }
  }
};

/** Runtime schema for a complete deterministic rollback journal. */
export const rollbackTransactionRecordSchema = schemaFor<RollbackTransactionRecord>()(
  rollbackTransactionUnionSchema.superRefine(refineRollbackTransaction),
);

/** Runtime schema for the root transaction fact union. */
export const transactionRecordSchema = schemaFor<TransactionRecord>()(
  z.union([
    distillLeaseTransactionRecordSchema,
    distillCommitTransactionRecordSchema,
    reviewDecisionTransactionRecordSchema,
    rollbackTransactionRecordSchema,
  ]),
);
