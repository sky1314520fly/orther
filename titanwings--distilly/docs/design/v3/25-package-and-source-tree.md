> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 25. 包、文件架构、依赖方向与抽象

### 25.1 Workspace

~~~text
packages/
├── protocol/                 # public values, MethodMap, EngineClient, wire schemas
├── engine/
│   ├── prompts/
│   └── src/
│       ├── core/             # normalize, evidence, claims, quality, ids, renderer
│       ├── services/         # subject, ingest, lease, commit, review, correction
│       ├── storage/
│       │   ├── sqlite/       # one private schema, transactions, queries
│       │   └── blobs/        # immutable content-addressed bytes + GC
│       ├── projections/      # profile, prompt, Library/search/graph builders
│       ├── doctor/           # exhaustive audit
│       ├── backup/           # snapshot / restore
│       └── engine.ts
├── runtime/                  # one Engine instance per root, local transport, composition
├── bindings/                 # host capabilities, injector, installer, forms
├── adapters/                 # source / parser adapters
├── distilly/                 # browser-safe Distilly + Person facade
├── mcp/                      # exactly five tools over injected EngineClient
├── panel/                    # local HTTP/SSE server + browser UI
└── cli/                      # local client and setup commands
plugins/                      # source manifests + canonical skill
~~~

Engine storage code has one home. There is no `facts/`, per-mutation `transaction/`, recovery union, mutation-specific staging directory, business file-lock hierarchy, queue database or Library intent protocol in the target tree. SQL migrations, rows and blob GC remain package-private.

### 25.2 依赖方向

~~~text
protocol
├── engine
├── bindings
├── adapters
├── distilly
├── mcp
└── panel/web

runtime → protocol + engine + bindings + adapters
panel/server → protocol + mcp + adapters
cli → runtime + distilly + mcp + panel/server
plugins → CLI launcher (process boundary)
~~~

- protocol 零内部依赖，也不导出 SQL rows、journal或projection formats；
- engine 只依赖protocol与明确runtime libraries，不依赖facade/MCP/Panel/CLI/binding；
- runtime是唯一production composition owner和每root single-writer owner；
- MCP、Panel、CLI、bindings、adapters只持EngineClient或输入port，不import engine storage；
- distilly browser root不触达Node/storage；Node entry通过runtime attach；
- Panel web只通过本地 typed `/rpc` 与 `/sources` HTTP transport；Panel server不成为writer，也不接收 secret value；
- package boundaries、browser bundles、未声明依赖和循环由静态gate拒绝。

SourceAdapter产出MaterialInput，MaterialParser产出ParsedMaterial；它们不能写blob或database。Host private capture只产生受信authorization/transcript；Engine完成audit与ingest transaction。任何surface出现`node:sqlite`、Engine storage import或DISTILLY_ROOT写入都是blocking defect。

### 25.3 哪些是 interface

| Interface | 为什么有真实多实现 |
|---|---|
| EngineClient | in-process owner client、本地RPC client、Panel HTTP client |
| SourceAdapter | 多来源与社区包 |
| MaterialParser | OCR、转写、文档解析 |
| HostCapabilityBinding / HostBinding / HostInjector / HostFormRenderer / PrivateUiCaptureController | 宿主能力与UI不同 |
| DraftProducer | 宿主模型与可选后台provider |
| Clock / IdGenerator / EngineEventBus | production与deterministic tests |
| ProjectionBuilder | profile/Library/graph/search是多个不同builder |

不定义通用StorageProvider、FactStore、QueueRepository或Library transaction port。首发SQLite schema和BlobStore各只有一个production implementation；测试使用real temporary database/blob root，只有clock/id等非持久化边界可替换。

### 25.4 哪些是纯函数

- label-v1、material-text-v1、material/provenance normalization、source identity/grouping；
- SHA-256、MaterialId/ClaimId/VersionId与material-set hash；
- facet parse、evidence resolve与quote/locator；
- claim/correction patch apply、strength、quality、maturity与ReviewReason；
- Markdown/prompt render与profile diff；
- relation reduce、bundle canonicalization与digest；
- public wire parse。

纯函数不读database/blob/projection，不调用模型，不持有clock。

### 25.5 哪些是 concrete service

- SubjectService、IngestService、DistillLeaseService、CommitService；
- CorrectionService、ReviewService、VersionService、LibraryService；
- SqliteEngineStore、ContentAddressedBlobStore、ProjectionCoordinator；
- DoctorService、BackupService、GarbageCollector；
- Engine、LocalRuntime、PanelServer、McpServer、SetupService。

Service编排SQL transaction或外部port；同类只有一个production实现时直接concrete，不先造interface。业务服务可以共享一个小TransactionContext/Store API，但不按mutation复制journal/recovery class。

### 25.6 为什么没有 public abstract class

TypeScript扩展方需要结构合同，不需要继承内部状态。V3第一版导出零个abstract class：

- adapter/binding/producer用interface；
- Distilly、Person、DistillyError是concrete public classes；
- storage/service是package-private concrete；
- 共享算法提取纯函数；
- 只有出现至少两个真实实现且组合无法表达的共享状态后，才考虑package-private base class。

### 25.7 Composition

~~~ts
export interface EngineRuntime {
  connect(session: ClientSessionContext): CoreEngineClient;
  openPrivateUiCapture(input: {
    readonly actor: ActorContext;
    readonly scope: PrivateUiCaptureScope;
    readonly authorization: PrivateUiCaptureAuthorization;
    readonly liveness: CaptureLivenessPort;
  }): Promise<CorePrivateUiCaptureSession>;
  doctor(): Promise<DoctorSnapshot>;
  close(): Promise<void>;
}

export interface EngineOptions {
  readonly root: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly events?: EngineEventBus;
  readonly parser?: MaterialParserPort;
  readonly auditKey?: AuditKeyPort;
}

export declare function openEngine(
  options: EngineOptions,
): Promise<EngineRuntime>;

export interface LocalRuntime {
  connectTrusted(session: ClientSessionContext): EngineClient;
  administration(): EngineAdministrationClient;
  registerPrivateUiCapture(input: {
    readonly host: HostName;
    readonly hostContext: HostContext;
  }): Promise<
    | { readonly kind: "registered"; readonly action: HostActionRegistration }
    | { readonly kind: "unavailable"; readonly remediation: string }
  >;
  close(): Promise<void>;
}
~~~

`openEngine`取得该root的唯一instance ownership，配置SQLite/WAL和BlobStore，检查storage schema并启动projection/outbox/GC workers。第二个owner只能attach到现有local service或fail closed；不会退回多层文件锁。SQLite自身处理WAL recovery，Engine startup不遍历mutation journals。

每个EngineClient session有可信ActorContext和engine-owned LeaseOwnerId；MCP=host，direct Panel/CLI=user，ordinary SDK=sdk，worker=executor。client close只解绑session，runtime close才停止accept、drain calls、checkpoint/close database并释放instance ownership。

`LocalRuntime.administration()` 是 CLI/setup 取得 `EngineAdministrationClient` 的唯一 production seam。它返回同一 root owner 的借用 client；调用方不能自行打开 SQLite/blob，MCP、Panel、binding 与普通 `distilly` facade 也不接收该 client。runtime close 使它终止，restore 成功时 runtime 在返回前把它重新绑定到已验证的新 authority。

LocalRuntime组合完整core methods、host/runtime-owned methods、Panel presenter和bindings。任何MethodMap key缺少真实handler都在production export前失败；不发布partial runtime或placeholder。storage migration期间，每个feature把一条真实method path切到SQLite并同时删除该path的旧file journal/lock/recovery；不能dual-write或长期保留两套authority。

tests对storage使用realtemp root、realSQLite/WAL和realblob files，注入clock/id/failure boundaries。transport/facade可以继续用完整fake EngineClient证明映射，但不能当backend证据。

---
