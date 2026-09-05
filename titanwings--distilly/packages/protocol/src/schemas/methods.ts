import { z } from "zod";

import { WIRE_LIMITS } from "../json.js";
import type { EngineMethodMap, Method, MethodSchemas } from "../methods.js";
import type {
  SystemBackupInput,
  SystemBackupResult,
  SystemRestoreInput,
  SystemRestoreResult,
} from "../values/hosts.js";
import { enforceToolInputBytes, exactOptionalRuntimeSchema } from "./common.js";
import type { MatchingSchema } from "./common.js";
import {
  bundleExportInputSchema,
  bundleExportResultSchema,
  bundleImportInputSchema,
  bundleImportResultSchema,
  bundleInspectInputSchema,
  bundleInspectionSchema,
  doctorInputSchema,
  doctorSnapshotSchema,
  exportRefSchema,
  hostExportInputSchema,
  installInputSchema,
  installRefSchema,
  systemBackupInputSchema,
  systemBackupResultSchema,
  systemRestoreInputSchema,
  systemRestoreResultSchema,
  uninstallInputSchema,
} from "./hosts.js";
import {
  briefInputSchema,
  hostDistillBriefingSchema,
  jobLeaseSchema,
  pendingFilterSchema,
  pendingJobSchema,
  redistillInputSchema,
  releaseLeaseInputSchema,
  renewLeaseInputSchema,
} from "./jobs.js";
import {
  getMaterialInputSchema,
  ingestFilesInputSchema,
  ingestFilesResultSchema,
  ingestInputSchema,
  ingestResultSchema,
  materialPageSchema,
  materialQuerySchema,
  materialViewSchema,
} from "./materials.js";
import {
  correctInputSchema,
  getProfileInputSchema,
  libraryPageSchema,
  libraryQuerySchema,
  profileDiffWithBaselineSchema,
  profileSchema,
  rebuildResultSchema,
  renderedPromptSchema,
} from "./profiles.js";
import {
  createSubjectInputSchema,
  purgeResultSchema,
  purgeSubjectInputSchema,
  resolveSubjectInputSchema,
  resolveSubjectResultSchema,
  subjectPageSchema,
  subjectQuerySchema,
  subjectRefSchema,
  subjectStatusSchema,
  subjectSummarySchema,
} from "./subjects.js";
import {
  commitInputSchema,
  commitResultSchema,
  diffInputSchema,
  lineageInputSchema,
  lineagePageSchema,
  reviewActionInputSchema,
  reviewPageSchema,
  reviewQuerySchema,
  rollbackInputSchema,
  versionPageSchema,
  versionQuerySchema,
  versionSummarySchema,
} from "./versions.js";

const schemasFor =
  <M extends keyof EngineMethodMap>() =>
  <P extends z.ZodType, R extends z.ZodType>(
    params: P & MatchingSchema<P, EngineMethodMap[M]["params"]>,
    result: R & MatchingSchema<R, EngineMethodMap[M]["result"]>,
  ) => ({
    params: exactOptionalRuntimeSchema(enforceToolInputBytes(params)),
    result: exactOptionalRuntimeSchema(result),
  });

const emptyResultSchema = z.null();
const emptyParamsSchema = z.strictObject({}).transform((): Record<string, never> => ({}));
const pendingJobListSchema = z.array(pendingJobSchema).max(WIRE_LIMITS.listLimit);

/** Complete runtime validator registry for the public engine method contract. */
export const engineMethodSchemas: {
  readonly [M in keyof EngineMethodMap]: MethodSchemas<EngineMethodMap[M]>;
} = {
  "subjects.create": schemasFor<"subjects.create">()(
    createSubjectInputSchema,
    subjectSummarySchema,
  ),
  "subjects.list": schemasFor<"subjects.list">()(subjectQuerySchema, subjectPageSchema),
  "subjects.resolve": schemasFor<"subjects.resolve">()(
    resolveSubjectInputSchema,
    resolveSubjectResultSchema,
  ),
  "subjects.archive": schemasFor<"subjects.archive">()(subjectRefSchema, emptyResultSchema),
  "subjects.purge": schemasFor<"subjects.purge">()(purgeSubjectInputSchema, purgeResultSchema),

  "materials.ingest": schemasFor<"materials.ingest">()(ingestInputSchema, ingestResultSchema),
  "materials.ingestFiles": schemasFor<"materials.ingestFiles">()(
    ingestFilesInputSchema,
    ingestFilesResultSchema,
  ),
  "materials.list": schemasFor<"materials.list">()(materialQuerySchema, materialPageSchema),
  "materials.get": schemasFor<"materials.get">()(getMaterialInputSchema, materialViewSchema),

  "distill.pending": schemasFor<"distill.pending">()(pendingFilterSchema, pendingJobListSchema),
  "distill.brief": schemasFor<"distill.brief">()(briefInputSchema, hostDistillBriefingSchema),
  "distill.renew": schemasFor<"distill.renew">()(renewLeaseInputSchema, jobLeaseSchema),
  "distill.release": schemasFor<"distill.release">()(releaseLeaseInputSchema, emptyResultSchema),
  "distill.commit": schemasFor<"distill.commit">()(commitInputSchema, commitResultSchema),
  "distill.redistill": schemasFor<"distill.redistill">()(redistillInputSchema, pendingJobSchema),

  "profiles.get": schemasFor<"profiles.get">()(getProfileInputSchema, profileSchema),
  "profiles.prompt": schemasFor<"profiles.prompt">()(getProfileInputSchema, renderedPromptSchema),
  "profiles.status": schemasFor<"profiles.status">()(subjectRefSchema, subjectStatusSchema),
  "profiles.correct": schemasFor<"profiles.correct">()(correctInputSchema, commitResultSchema),

  "versions.list": schemasFor<"versions.list">()(versionQuerySchema, versionPageSchema),
  "versions.diff": schemasFor<"versions.diff">()(diffInputSchema, profileDiffWithBaselineSchema),
  "versions.promote": schemasFor<"versions.promote">()(
    reviewActionInputSchema,
    versionSummarySchema,
  ),
  "versions.reject": schemasFor<"versions.reject">()(reviewActionInputSchema, versionSummarySchema),
  "versions.rollback": schemasFor<"versions.rollback">()(rollbackInputSchema, versionSummarySchema),
  "versions.lineage": schemasFor<"versions.lineage">()(lineageInputSchema, lineagePageSchema),

  "hosts.install": schemasFor<"hosts.install">()(installInputSchema, installRefSchema),
  "hosts.uninstall": schemasFor<"hosts.uninstall">()(uninstallInputSchema, emptyResultSchema),
  "hosts.export": schemasFor<"hosts.export">()(hostExportInputSchema, exportRefSchema),

  "library.list": schemasFor<"library.list">()(libraryQuerySchema, libraryPageSchema),
  "library.rebuild": schemasFor<"library.rebuild">()(emptyParamsSchema, rebuildResultSchema),
  "reviews.list": schemasFor<"reviews.list">()(reviewQuerySchema, reviewPageSchema),

  "bundles.inspect": schemasFor<"bundles.inspect">()(
    bundleInspectInputSchema,
    bundleInspectionSchema,
  ),
  "bundles.import": schemasFor<"bundles.import">()(
    bundleImportInputSchema,
    bundleImportResultSchema,
  ),
  "bundles.export": schemasFor<"bundles.export">()(
    bundleExportInputSchema,
    bundleExportResultSchema,
  ),

  "system.doctor": schemasFor<"system.doctor">()(doctorInputSchema, doctorSnapshotSchema),
};

const administrationSchemasFor =
  <M extends Method<unknown, unknown>>() =>
  <P extends z.ZodType, R extends z.ZodType>(
    params: P & MatchingSchema<P, M["params"]>,
    result: R & MatchingSchema<R, M["result"]>,
  ): MethodSchemas<M> => ({
    params: exactOptionalRuntimeSchema(enforceToolInputBytes(params)),
    result: exactOptionalRuntimeSchema(result),
  });

/** Strict maintenance validators intentionally excluded from EngineMethodMap. */
export const engineAdministrationSchemas: {
  readonly backup: MethodSchemas<Method<SystemBackupInput, SystemBackupResult>>;
  readonly restore: MethodSchemas<Method<SystemRestoreInput, SystemRestoreResult>>;
} = {
  backup: administrationSchemasFor<Method<SystemBackupInput, SystemBackupResult>>()(
    systemBackupInputSchema,
    systemBackupResultSchema,
  ),
  restore: administrationSchemasFor<Method<SystemRestoreInput, SystemRestoreResult>>()(
    systemRestoreInputSchema,
    systemRestoreResultSchema,
  ),
};
