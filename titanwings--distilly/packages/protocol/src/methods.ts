import type {
  BundleExportInput,
  BundleExportResult,
  BundleImportInput,
  BundleImportResult,
  BundleInspectInput,
  BundleInspection,
  DoctorInput,
  DoctorSnapshot,
  ExportRef,
  HostExportInput,
  InstallInput,
  InstallRef,
  UninstallInput,
} from "./values/hosts.js";
import type {
  BriefInput,
  HostDistillBriefing,
  JobLease,
  PendingFilter,
  PendingJob,
  RedistillInput,
  ReleaseLeaseInput,
  RenewLeaseInput,
} from "./values/jobs.js";
import type {
  GetMaterialInput,
  IngestFilesInput,
  IngestFilesResult,
  IngestInput,
  IngestResult,
  MaterialPage,
  MaterialQuery,
  MaterialView,
} from "./values/materials.js";
import type {
  CorrectInput,
  GetProfileInput,
  LibraryPage,
  LibraryQuery,
  Profile,
  ProfileDiff,
  RebuildResult,
} from "./values/profiles.js";
import type {
  CreateSubjectInput,
  PurgeResult,
  PurgeSubjectInput,
  ResolveSubjectInput,
  ResolveSubjectResult,
  SubjectPage,
  SubjectQuery,
  SubjectRef,
  SubjectStatus,
  SubjectSummary,
} from "./values/subjects.js";
import type {
  CommitInput,
  CommitResult,
  DiffInput,
  LineageInput,
  LineagePage,
  ReviewActionInput,
  ReviewPage,
  ReviewQuery,
  RollbackInput,
  VersionPage,
  VersionQuery,
  VersionSummary,
} from "./values/versions.js";
import type { RuntimeSchema } from "./wire.js";

export type Method<P, R> = {
  readonly params: P;
  readonly result: R;
};

export type EmptyResult = null;

export type EngineMethodMap = Readonly<{
  readonly "subjects.create": Method<CreateSubjectInput, SubjectSummary>;
  readonly "subjects.list": Method<SubjectQuery, SubjectPage>;
  readonly "subjects.resolve": Method<ResolveSubjectInput, ResolveSubjectResult>;
  readonly "subjects.archive": Method<SubjectRef, EmptyResult>;
  readonly "subjects.purge": Method<PurgeSubjectInput, PurgeResult>;

  readonly "materials.ingest": Method<IngestInput, IngestResult>;
  readonly "materials.ingestFiles": Method<IngestFilesInput, IngestFilesResult>;
  readonly "materials.list": Method<MaterialQuery, MaterialPage>;
  readonly "materials.get": Method<GetMaterialInput, MaterialView>;

  readonly "distill.pending": Method<PendingFilter, readonly PendingJob[]>;
  readonly "distill.brief": Method<BriefInput, HostDistillBriefing>;
  readonly "distill.renew": Method<RenewLeaseInput, JobLease>;
  readonly "distill.release": Method<ReleaseLeaseInput, EmptyResult>;
  readonly "distill.commit": Method<CommitInput, CommitResult>;
  readonly "distill.redistill": Method<RedistillInput, PendingJob>;

  readonly "profiles.get": Method<GetProfileInput, Profile>;
  readonly "profiles.prompt": Method<GetProfileInput, string>;
  readonly "profiles.status": Method<SubjectRef, SubjectStatus>;
  readonly "profiles.correct": Method<CorrectInput, CommitResult>;

  readonly "versions.list": Method<VersionQuery, VersionPage>;
  readonly "versions.diff": Method<DiffInput, ProfileDiff>;
  readonly "versions.promote": Method<ReviewActionInput, VersionSummary>;
  readonly "versions.reject": Method<ReviewActionInput, VersionSummary>;
  readonly "versions.rollback": Method<RollbackInput, VersionSummary>;
  readonly "versions.lineage": Method<LineageInput, LineagePage>;

  readonly "hosts.install": Method<InstallInput, InstallRef>;
  readonly "hosts.uninstall": Method<UninstallInput, EmptyResult>;
  readonly "hosts.export": Method<HostExportInput, ExportRef>;

  readonly "library.list": Method<LibraryQuery, LibraryPage>;
  readonly "library.rebuild": Method<Record<string, never>, RebuildResult>;
  readonly "reviews.list": Method<ReviewQuery, ReviewPage>;

  readonly "bundles.inspect": Method<BundleInspectInput, BundleInspection>;
  readonly "bundles.import": Method<BundleImportInput, BundleImportResult>;
  readonly "bundles.export": Method<BundleExportInput, BundleExportResult>;

  readonly "system.doctor": Method<DoctorInput, DoctorSnapshot>;
}>;

export type MutationMethodName =
  | "subjects.create"
  | "subjects.archive"
  | "subjects.purge"
  | "materials.ingest"
  | "materials.ingestFiles"
  | "distill.brief"
  | "distill.renew"
  | "distill.release"
  | "distill.commit"
  | "distill.redistill"
  | "profiles.correct"
  | "versions.promote"
  | "versions.reject"
  | "versions.rollback"
  | "hosts.install"
  | "hosts.uninstall"
  | "hosts.export"
  | "library.rebuild"
  | "bundles.import"
  | "bundles.export";

export type QueryMethodName = Exclude<keyof EngineMethodMap, MutationMethodName>;

export type MethodSchemas<M extends Method<unknown, unknown>> = {
  readonly params: RuntimeSchema<M["params"]>;
  readonly result: RuntimeSchema<M["result"]>;
};
