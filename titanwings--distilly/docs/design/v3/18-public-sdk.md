> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 18. TypeScript 公共 SDK 与 EngineClient

### 18.1 EngineMethodMap

~~~ts
export type Method<P, R> = {
  readonly params: P;
  readonly result: R;
};

export type EmptyResult = null;

export interface IngestInput {
  readonly subject: IngestSubjectTarget;
  readonly materials: readonly MaterialInput[];
  readonly enqueue: "auto" | "now";
}

export interface IngestFilesInput {
  readonly subject: IngestSubjectTarget;
  readonly paths: readonly string[];
  readonly enqueue: "auto" | "now";
  readonly sensitivity?: "private" | "shareable";
}

export type FileIngestItemResult =
  | {
      readonly kind: "parsed";
      readonly pathLabel: string;
      readonly material: IngestItemResult;
    }
  | {
      readonly kind: "unparsed";
      readonly pathLabel: string;
      readonly rawId: RawId;
      readonly mediaType: string;
      readonly warnings: readonly string[];
    };

export interface IngestFilesResult {
  readonly subject: SubjectSummary;
  readonly created: boolean;
  readonly items: readonly FileIngestItemResult[];
  readonly generation: number;
  readonly materialSetHash?: MaterialSetHash;
  readonly job?: PendingJob;
}

export interface BriefInput {
  readonly jobId: JobId;
}

export interface RenewLeaseInput {
  readonly jobId: JobId;
  readonly leaseId: LeaseId;
}

export interface ReleaseLeaseInput extends RenewLeaseInput {
  readonly reason?: string;
}

export interface CommitInput {
  readonly jobId: JobId;
  readonly generation: number;
  readonly leaseId: LeaseId;
  readonly briefContractDigest: BriefContractDigest;
  readonly materialSetHash: MaterialSetHash;
  readonly baseVersionId?: VersionId;
  readonly patch: DistillPatch;
}

export type CommitResult =
  | {
      readonly kind: "current";
      readonly version: VersionSummary;
      readonly profile: Profile;
    }
  | {
      readonly kind: "suspended";
      readonly candidate: VersionSummary;
      readonly currentVersionId?: VersionId;
      readonly reasons: readonly ReviewReason[];
      readonly review: ReviewRef;
    };

export interface GetProfileInput extends SubjectRef {
  readonly versionId?: VersionId;
}

export interface CorrectionDraft {
  readonly text: string;
  readonly facet?: FacetPath;
  readonly supersedes?: readonly ClaimId[];
  readonly baseCandidateVersionId?: VersionId;
}

export interface CorrectInput extends SubjectRef {
  readonly correction: CorrectionDraft;
}

export interface DiffInput extends SubjectRef {
  readonly before: VersionId;
  readonly after: VersionId;
}

export interface ReviewActionInput extends SubjectRef {
  readonly candidateVersionId: VersionId;
  readonly reason?: string;
}

export interface RollbackInput extends SubjectRef {
  readonly targetVersionId: VersionId;
  readonly reason: string;
}

export interface VersionQuery extends SubjectRef {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface VersionPage {
  readonly items: readonly VersionSummary[];
  readonly nextCursor?: string;
}

export interface LineageInput extends SubjectRef {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface LineageEvent {
  readonly eventId: EventId;
  readonly kind:
    | "created" | "committed" | "suspended" | "promoted"
    | "rejected" | "candidate_replaced" | "rolled_back"
    | "corrected" | "imported";
  readonly versionId?: VersionId;
  readonly relatedVersionId?: VersionId;
  readonly actor: ActorContext;
  readonly at: IsoDateTime;
  readonly reason?: string;
}

export interface LineagePage {
  readonly items: readonly LineageEvent[];
  readonly nextCursor?: string;
}

// LineageEvent is a public read model aggregated from Engine-private event
// and immutable version rows; it is not a persistence schema.

export interface InstallOptions {
  readonly versionId?: VersionId;
  readonly destination?: string;
}

export interface InstallInput extends SubjectRef {
  readonly host: HostName;
  readonly options?: InstallOptions;
}

export interface UninstallInput {
  readonly install: InstallRef;
}

export interface ExportOptions {
  readonly destination: string;
  readonly versionId?: VersionId;
  readonly overwrite?: boolean;
}

export interface HostExportInput extends SubjectRef {
  readonly host: HostName;
  readonly options: ExportOptions;
}

export interface ExportRef {
  readonly host: HostName;
  readonly subjectId: SubjectId;
  readonly versionId: VersionId;
  readonly path: string;
  readonly contentDigest: ContentDigest;
}

export interface LibraryQuery {
  readonly text?: string;
  readonly spaceId?: SpaceId;
  readonly lifecycle?: SubjectLifecycle;
  readonly hasPending?: boolean;
  readonly hasSuspended?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface LibraryPage {
  readonly items: readonly LibraryEntry[];
  readonly nextCursor?: string;
}

export interface RebuildResult {
  readonly subjects: number;
  readonly jobs: number;
  readonly relations: number;
  readonly rebuiltAt: IsoDateTime;
}

export interface ReviewQuery {
  readonly subjectId?: SubjectId;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface BundleInspectInput {
  readonly path: string;
}

export interface BundleInspection {
  readonly displayName: string;
  readonly claimCount: number;
  readonly evidenceExcerptCount: number;
  readonly license: string;
  readonly signature: "valid" | "missing" | "invalid";
  readonly warnings: readonly string[];
}

export interface BundleImportInput extends BundleInspectInput {
  readonly spaceId?: SpaceId;
  readonly confirmation: string;
}

export interface BundleImportResult {
  readonly subject: SubjectSummary;
  readonly candidate: VersionSummary;
  readonly review: ReviewRef;
}

export interface BundleExportInput extends SubjectRef {
  readonly versionId?: VersionId;
  readonly destination: string;
  readonly provenancePolicy: "none" | "citations_and_quotes";
}

export interface BundleExportResult {
  readonly path: string;
  readonly contentDigest: ContentDigest;
}

export interface SystemBackupInput {
  readonly destination: string;
  readonly overwrite?: boolean;
}

export interface SystemBackupResult {
  readonly path: string;
  readonly manifestDigest: ContentDigest;
  readonly createdAt: IsoDateTime;
}

export interface SystemRestoreInput {
  readonly source: string;
  readonly confirmation: ContentDigest;
}

export interface SystemRestoreResult {
  readonly manifestDigest: ContentDigest;
  readonly restoredAt: IsoDateTime;
  readonly previousRootPath: string;
}

export interface EngineAdministrationClient {
  backup(input: SystemBackupInput): Promise<SystemBackupResult>;
  restore(input: SystemRestoreInput): Promise<SystemRestoreResult>;
}

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
  | "subjects.create" | "subjects.archive" | "subjects.purge"
  | "materials.ingest" | "materials.ingestFiles"
  | "distill.brief" | "distill.renew" | "distill.release"
  | "distill.commit" | "distill.redistill"
  | "profiles.correct"
  | "versions.promote" | "versions.reject" | "versions.rollback"
  | "hosts.install" | "hosts.uninstall" | "hosts.export"
  | "library.rebuild" | "bundles.import" | "bundles.export";

export type QueryMethodName =
  Exclude<keyof EngineMethodMap, MutationMethodName>;

export interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export type MethodSchemas<M extends Method<unknown, unknown>> = {
  readonly params: RuntimeSchema<M["params"]>;
  readonly result: RuntimeSchema<M["result"]>;
};

export declare const engineMethodSchemas: {
  readonly [M in keyof EngineMethodMap]: MethodSchemas<EngineMethodMap[M]>;
};

export declare const engineAdministrationSchemas: {
  readonly backup: MethodSchemas<Method<SystemBackupInput, SystemBackupResult>>;
  readonly restore: MethodSchemas<Method<SystemRestoreInput, SystemRestoreResult>>;
};
~~~

MCP 五工具是这个更大方法表的受限 presenter，不是一对一等同于五个 engine methods。materials.ingest 本身接收 IngestSubjectTarget，所以 create + first ingest 是一个 IngestService 事务；handler 禁止先 subjects.create 再 materials.ingest。

关系 slice 未进入首发 MethodMap；§22 固定其未来 additive 类型与复杂度，但在实现落地前不发布永远 unsupported 的 wire 方法。engineMethodSchemas 用 satisfies / mapped type 锁定完整 key 集；CI 的 protocol contract fixture import 五个 ToolOutput、实例化每个 MethodMap params/result，并对每个 key 做 schema round-trip，防止 types.ts 与 schemas/ 漂移。EngineMethodMap 作为 JSON/RPC 合同不使用 undefined/void；无 payload 的成功结果统一为 EmptyResult=null，facade 若承诺 Promise<void> 可在最外层丢弃 null，但 transport、schema 与 operations authority row 不可各造一种空值。

`EngineAdministrationClient` 是同一 root owner 暴露给本机 CLI/runtime 的窄 maintenance contract，不是第二个存储 writer。backup/restore 会冻结或切换整个 authority，不能假装成一条普通 subject business mutation，也不进入 EngineMethodMap、Panel `/rpc` 或五个 MCP 工具。它的四个 input/result object 仍由 Protocol 提供 strict runtime schemas；CLI 只能经已认证的 root owner 调用，不能直接复制 SQLite/WAL 或 blob 目录。

### 18.2 强类型 EngineClient

~~~ts
export interface EngineClient {
  call<M extends QueryMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
  ): Promise<EngineMethodMap[M]["result"]>;

  call<M extends MutationMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]>;

  watch(handler: (event: EngineEvent) => void): Promise<Unsubscribe>;
  close(): Promise<void>;
}

export type Unsubscribe = () => void;

export declare class DistillyError extends Error {
  readonly code: DistillyErrorCode;
  readonly retryable: boolean;
  readonly fieldPath?: string;
  readonly remediation?: string;
  readonly details?: JsonObject;
  readonly subjectResolution?: DistillyWireError["subjectResolution"];

  constructor(error: DistillyWireError, options?: ErrorOptions);
}
~~~

EngineClient.close() 只取消该 client 的 watch 与 session 绑定，不关闭 SQLite、Engine service 或同一 root 的其它 client，也不暗中 release durable lease；caller 需在 close 前显式 distill.release，否则 lease 按 expiresAt 自然失效。只有 root service owner 的 shutdown path 才关闭共享资源，并且必须先停止接收调用、关闭连接，再关闭 SQLite。MCP server、PanelLauncher 与 Panel handle 都借用注入的 EngineClient：各自 close 只关闭自己拥有的 transport、server、handle 与订阅。`openInProcess` 也遵守同一规则：它是 connect-or-start convenience seam，返回的 Distilly.close() 只关闭 sdk client，不因自己碰巧启动了 owner 就终止仍被其它 client 使用的 service。

不用 call<T>(method: string)：它允许拼错 method、错配 params / result 而编译照过。mutation overload 在类型层强制 requestId；MCP presenter 透传 WireRequest.requestId，facade 为一次顶层调用生成并在底层重试中复用。相同业务动作在调用者主动发起的新顶层调用里可以拿新 requestId，内容寻址的 VersionId 与 stale checks 仍防止重复事实。本地 attach transport 只能实现这张表，不能改 facade。

### 18.3 Distilly

~~~ts
export interface DistillyOptions {
  readonly client: EngineClient;
}

export interface MutationOptions {
  readonly requestId?: RequestId;
}

export declare class Distilly {
  constructor(options: DistillyOptions);

  person(subjectId: SubjectId): Person;
  create(input: CreateSubjectInput, mutation?: MutationOptions): Promise<Person>;
  list(query?: SubjectQuery): Promise<SubjectPage>;
  resolve(input: ResolveSubjectInput): Promise<ResolveSubjectResult>;

  pending(filter?: PendingFilter): Promise<readonly PendingJob[]>;
  brief(input: BriefInput, mutation?: MutationOptions): Promise<HostDistillBriefing>;
  renew(input: RenewLeaseInput, mutation?: MutationOptions): Promise<JobLease>;
  release(input: ReleaseLeaseInput, mutation?: MutationOptions): Promise<void>;
  commit(input: CommitInput, mutation?: MutationOptions): Promise<CommitResult>;

  reviews(query?: ReviewQuery): Promise<ReviewPage>;
  promote(input: ReviewActionInput, mutation?: MutationOptions): Promise<VersionSummary>;
  reject(input: ReviewActionInput, mutation?: MutationOptions): Promise<VersionSummary>;
  purge(input: PurgeSubjectInput, mutation?: MutationOptions): Promise<PurgeResult>;

  close(): Promise<void>;
}
~~~

Distilly 是纯 injected-client facade：构造器不读 HOME、不探测环境、不创建 runtime，也不重复 engine boundary schema。每个 query 恰好转发一次同名 EngineMethodMap read；每个 mutation 在进入 call 前选择一次 `mutation.requestId ?? cryptoRequestId()`，并把同一个 MutationContext 交给该顶层调用内的所有 transport retry。browser-safe cryptoRequestId 只用 globalThis.crypto.getRandomValues 取得 16 bytes 并编码成 `req_` + 32 lowercase hex，不 import node:crypto、不用 Math.random；环境缺少 Web Crypto 时在 client call 前返回 host_unsupported。release 等 facade `Promise<void>` 只在 method 成功返回协议 EmptyResult=null 后丢弃 null；purge 保留完整 `PurgeResult`。Distilly 不新增 watch shortcut；需要订阅的调用者直接使用注入的 EngineClient。

### 18.4 Person

~~~ts
export declare class Person {
  readonly id: SubjectId;

  constructor(client: EngineClient, subjectId: SubjectId);

  get(options?: { readonly versionId?: VersionId }): Promise<Profile>;
  prompt(options?: { readonly versionId?: VersionId }): Promise<string>;
  status(): Promise<SubjectStatus>;

  ingest(
    materials: readonly MaterialInput[],
    options: { readonly enqueue: "auto" | "now" },
    mutation?: MutationOptions,
  ): Promise<IngestResult>;
  ingestFiles(
    paths: readonly string[],
    options: Omit<IngestFilesInput, "subject" | "paths">,
    mutation?: MutationOptions,
  ): Promise<IngestFilesResult>;
  correct(input: CorrectionDraft, mutation?: MutationOptions): Promise<CommitResult>;
  redistill(
    input: Omit<RedistillInput, "subjectId">,
    mutation?: MutationOptions,
  ): Promise<PendingJob>;

  versions(
    options?: Omit<VersionQuery, "subjectId">,
  ): Promise<VersionPage>;
  diff(a: VersionId, b: VersionId): Promise<ProfileDiff>;
  rollback(
    input: { readonly versionId: VersionId; readonly reason: string },
    mutation?: MutationOptions,
  ): Promise<VersionSummary>;
  lineage(
    options?: Omit<LineageInput, "subjectId">,
  ): Promise<LineagePage>;

  install(
    host: HostName,
    options?: InstallOptions,
    mutation?: MutationOptions,
  ): Promise<InstallRef>;
  uninstall(ref: InstallRef, mutation?: MutationOptions): Promise<void>;
  export(
    host: HostName,
    options: ExportOptions,
    mutation?: MutationOptions,
  ): Promise<ExportRef>;

  archive(mutation?: MutationOptions): Promise<void>;
}
~~~

Person 的 public constructor 与 `distilly.person(subjectId)` 语义相同：只绑定一个已经带可信 session 的 EngineClient 和 SubjectId，不读取主体、不创建 actor/lease owner/capacity，也不拥有 client；Person 没有 close。公开 class 在 TypeScript 中若不声明 private/protected constructor 就可被构造，因此合同不伪装一个语言上不存在的 package-private constructor。常规发现路径仍是 Distilly.person。

purge 不放 Person 第一屏；它是 Distilly.purge / Panel / CLI 的显式危险入口。关系方法可以在关系 slice 后 additive 加到 Person，不阻塞首发。

browser-safe 根的 runtime export allowlist 精确为 `Distilly`、`Person`、`DistillyError`。type-only export allowlist 精确为 `DistillyOptions`、`MutationOptions`、`DistillyErrorCode`、`DistillyWireError`、`EngineClient`、`SubjectId`、`RequestId`、`VersionId`、`HostName`、`CreateSubjectInput`、`SubjectQuery`、`SubjectPage`、`ResolveSubjectInput`、`ResolveSubjectResult`、`PurgeSubjectInput`、`PurgeResult`、`PendingFilter`、`PendingJob`、`BriefInput`、`HostDistillBriefing`、`RenewLeaseInput`、`ReleaseLeaseInput`、`JobLease`、`CommitInput`、`CommitResult`、`ReviewQuery`、`ReviewItem`、`ReviewPage`、`ReviewActionInput`、`VersionQuery`、`VersionPage`、`VersionSummary`、`Profile`、`SubjectStatus`、`MaterialInput`、`IngestResult`、`IngestFilesInput`、`IngestFilesResult`、`CorrectionDraft`、`RedistillInput`、`ProfileDiff`、`LineageInput`、`LineageEvent`、`LineagePage`、`InstallOptions`、`InstallRef`、`ExportOptions` 与 `ExportRef`。更底层的 protocol/schema/host/adapter 类型从其 owning package import；根不做 wildcard re-export。构建快照分别锁 runtime 与 type-only names，新增任何 root symbol 都是 API review。

### 18.5 Composition root

distilly 包根只依赖 protocol，能在浏览器和非 Node transport 使用。Node 进程内接线走独立 subpath：

~~~ts
import { openInProcess } from "distilly/node";

export interface OpenInProcessOptions {
  readonly root?: string;
  readonly capacity: BriefCapacity;
  readonly callerLabel?: string;
}

export declare function openInProcess(
  options: OpenInProcessOptions,
): Promise<Distilly>;
~~~

distilly/node 依赖 @distilly/runtime；runtime 再组合 engine、内置 parsers 与 bindings。所有 production 入口共用一个 root-scoped `connectOrStartEngine` seam：若该 root 没有 owner，它取得 instance ownership、启动本机 service 并等待 ready；若已有 owner，它完成本机认证后 attach；owner 正在启动、异常退出或 ownership 不可证明时 fail closed，不退回第二个 writer。owner discovery/auth、crash takeover 与 service shutdown 都属于 runtime，不进入 Protocol。openInProcess 固定创建 kind=sdk 的 client，callerLabel 只是审计 label，不能选择 user / host actor。需要 host、Panel 或 CLI actor 的入口由各自 composition 调用 runtime.connectTrusted；该函数不从 distilly 根或 node convenience API 导出。根 index.ts 不 import / re-export node.ts。Distilly 构造器不偷偷创建引擎或读 HOME；只有名字明确的 openInProcess 做本机 attach/start I/O。

browser-safe 根与 injected-client tests 不创建 `distilly/node` subpath，也不声称任一 facade method 有本机 backend。openInProcess 与该 subpath 只能和完整 production single-writer runtime 同一 feature 落地；在那之前，Distilly / Person 的全部方法由 full fake EngineClient contract fixture 验证 method、params、MutationContext、null-to-void 与 close 转发。

### 18.6 API 稳定性

- 所有跨 EngineClient 或执行 I/O 的公开操作返回 Promise；纯 handle 构造 person() 同步。
- wire major 3 内，方法名与字段含义不改；新可选字段 / 新判别分支必须让旧消费者 fail visibly 或安全 default。
- 根包只导出 §18.4 明列的三个 runtime values 与 type-only allowlist；不 wildcard 转导 protocol。
- adapter、host、queue repository、engine services 从各自包导出，不从 facade 根“方便地”全部 re-export。
- 不把 unimplemented Catalog 方法预先放入 MethodMap。

---
