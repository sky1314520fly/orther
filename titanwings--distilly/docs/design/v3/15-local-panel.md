> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 15. 本地审核面板

### 15.1 产品职责

Panel 首版的主体工作仍是看本地人物、看一份画像、看证据和处理风险。它不调用 LLM、不自主浏览网页、不直接发布 Profile Catalog，也不成为第二个事实编辑器；唯一联网采集入口是用户在 Settings / Subject 中显式运行经过审核的 SourceAdapter，且由本地 server 而不是浏览器持有 secret。

Chat 是发起 research 的主入口；Panel 的“继续调研”按钮只生成或复制一条宿主 prompt，不偷偷启动模型。

### 15.2 四个一级页面

**Library**

- 本地主体列表、搜索和空间筛选；
- displayName、privacy、maturity、active / contested claim 数、新材料数、current version；
- 进入主体、复制“继续调研”提示、临时使用、安装、archive；
- 不显示一个前端自己计算的百分比。

**Subject**

- Profile：七个 core facets 与已存在 domains；
- Claims：active / contested / superseded，按 facet 过滤；
- Evidence：claim、quote、来源 URI、capture time、source group / basis / diversity caution 与材料正文并排；
- Materials：载体、source role、artifact / representation、文本派生方法、raw 是否可用、capture audit、sensitivity、source group / caution 与是否参与当前 generation；
- Sources：选择已配置 adapter，预览 subject / resource / time range / limit，显式发起 collection；Xquik 在请求前另显示并确认最大计费条数；
- Versions：current / suspended / historical / rejected、diff、lineage。

**Review**

- 所有主体当前的 active suspended target 与 ReviewReason；
- current vs candidate 的 facet / claim diff；
- promote、reject、correct、rollback；
- 任何危险或不可逆操作使用显式确认，不预勾。

**Settings & Doctor**

- DISTILLY_ROOT、runtime / plugin / protocol 版本；
- HostBinding capability 与 MCP handshake；
- Panel 监听地址和安全状态；
- adapter / parser / optional executor preflight，以及只保存公开配置与 secret reference 的 adapter configure；
- telemetry 明确 off / on，不显示虚假使用量。

这是完整产品的页面信息架构，不授权 injected Panel slice 伪造尚未落地的 handler。当前 UI 只启用注入 client 已真实实现并经双向 schema 验证的 read methods，以及 promote/reject/rollback；correct、install、archive 与 production doctor 可以显示 disabled 的未来说明或只读文案，但不能返回假成功、写 fixture authority 或调用占位 handler。测试注入的 full EngineClient 若真实实现 system.doctor，可渲染其 DoctorSnapshot；production system.doctor handler 与 full binding 结论属于 production runtime feature。injected Panel 不创建 runtime、不提供 CLI executable 或用户可运行的 `distilly panel` command。

Discover 不出现在首版导航。Profile Catalog 没达到 §24 进入条件前，空 tab 只会制造“是不是要登录”的误解。

### 15.3 面板读模型

界面所需聚合由引擎返回：

~~~ts
export type LibraryPrivacy =
  | "none" | "private" | "shareable" | "mixed";

export interface LibraryEntry {
  readonly subject: SubjectSummary;
  readonly status: SubjectStatus;
  readonly privacy: LibraryPrivacy;
  readonly searchTerms: readonly string[];
  readonly currentQuality?: QualitySummary;
  readonly suspendedQuality?: QualitySummary;
  readonly pendingJobs: 0 | 1;
  readonly suspendedVersions: 0 | 1;
  readonly newMaterialCount: number;
  readonly lastChangedAt: IsoDateTime;
}

export interface ReviewItem {
  readonly candidate: VersionSummary;
  readonly current?: VersionSummary;
  readonly reasons: readonly ReviewReason[];
  readonly diff: ProfileDiff;
}

export interface ReviewPage {
  readonly items: readonly ReviewItem[];
  readonly nextCursor?: string;
}

export interface MaterialQuery extends SubjectRef {
  readonly kind?: MaterialRecord["kind"];
  readonly atVersionId?: VersionId;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MaterialSummary {
  readonly record: MaterialRecord;
  readonly contentScalarCount: number;
  readonly rawAvailable: boolean;
  readonly inCurrentGeneration: boolean;
  readonly sourceGroup: SourceGroup;
  readonly grouping: SourceGroupingContext;
}

export interface SourceGroupingContext {
  readonly algorithmVersion: string;
  readonly generation: number;
  readonly versionId?: VersionId;
}

export interface MaterialPage {
  readonly items: readonly MaterialSummary[];
  readonly nextCursor?: string;
}

export interface GetMaterialInput {
  readonly subjectId: SubjectId;
  readonly materialId: MaterialId;
  readonly atVersionId?: VersionId;
}

export interface MaterialView {
  readonly record: MaterialRecord;
  readonly content: string;
  readonly rawAvailable: boolean;
  readonly inCurrentGeneration: boolean;
  readonly sourceGroup: SourceGroup;
  readonly grouping: SourceGroupingContext;
}

export interface ExtensionStatus {
  readonly id: string;
  readonly kind: "host" | "adapter" | "parser";
  readonly ok: boolean;
  readonly version?: string;
  readonly warnings: readonly string[];
}

export interface DoctorInput {
  readonly host?: HostName;
}

export interface DoctorSnapshot {
  readonly runtime: {
    readonly productVersion: string;
    readonly wireVersion: string;
    readonly promptVersion: string;
  };
  readonly storage: {
    readonly rootLabel: string;
    readonly writable: boolean;
    readonly schemaSupported: boolean;
    readonly projectionsDirty: boolean;
    readonly pendingBlobGcCount: number;
  };
  readonly panel: {
    readonly loopbackOnly: boolean;
    readonly authentication: "enabled" | "unavailable";
  };
  readonly extensions: readonly ExtensionStatus[];
}
~~~

`PurgeResult` 的 runtime schema 是 strict 判别联合：`complete` 分支禁止 `pendingBlobCount`，`pending` 分支要求 `pendingBlobCount` 为 safe positive integer。`DoctorSnapshot.storage.pendingBlobGcCount` 是读取时的 live、safe non-negative integer；它可以在原 mutation 的稳定 `PurgeResult` 仍为 `pending` 时降为 0，因为 RequestId replay 不改写历史结果快照。

LibraryEntry、ReviewItem、ReviewPage、ProfileDiff 都住 protocol。Panel 不从多个接口拼接后自算 maturity、pending 或 review reason。新增屏幕聚合时先加入 EngineMethodMap，再由 SDK 与 UI 使用。每个 LibraryEntry 从同一个 SQLite read snapshot 的 subject、state、version、material membership 与 event rows 聚合：privacy 对 current generation 的 authoritative material membership 计算，空集合为 none、全 private 为 private、全 shareable 为 shareable、混合为 mixed；currentQuality / suspendedQuality 当且仅当相应 pointer 存在；pendingJobs 与 suspendedVersions 分别是相应 row/pointer 的 0 或 1；newMaterialCount 是 pending job 的 addedMaterialCount，显式 redistill 因而可为 0。searchTerms 是 exact-dedupe 后按 UTF-8 bytes 升序的有界 label tuple：subject domainPack（若存在）、current Profile.domains 的每个 root、subject lifecycle、privacy、current maturity（若存在），以及 pendingJobs=1 时的 literal `pending`、suspendedVersions=1 时的 literal `suspended`；最多 `WIRE_LIMITS.openRecordEntries + 6` 项。lastChangedAt 是该 subject event rows 的最大 event.at，subject.created 是非空基线；它不是文件 mtime、projection 更新时间或 Panel 当前时间。

ProfileDiff 的 added/removed 是 before/after ClaimId 集差，changed 是同一 ClaimId 但 canonical Claim bytes 不同的 `{before, after}`，三组分别按相关 ClaimId canonical UTF-8 bytes 升序；changedFacets 是三组所涉及 facet 的去重 canonical 升序。普通 versions.diff 的 beforeQuality/afterQuality 都存在。subject 的首个 suspended version 没有 current baseline 时，ReviewItem.current 与 diff.beforeQuality 都缺失，不伪造零质量；diff.added 是全部 candidate claims，removed/changed 为空，changedFacets 是 candidate facets。ReviewItem 的 reasons 必须逐字段等于 candidate version 的 reviewReasons。

MaterialQuery / GetMaterialInput 未给 atVersionId 时按当前 generation 派生分组；给定 atVersionId 时，引擎从 authoritative version-material membership rows 取得精确集合，并按该 version 记录的 sourceGroupingVersion 重建当时的 group。不存在于该 membership 的 MaterialId 返回 not_found，binary 已不支持该历史 grouping version 时返回 schema_unsupported。Panel 只展示返回的 SourceGroupingContext，不拿当前材料目录、投影 manifest 或当前算法猜历史结果。

contentScalarCount 按 Unicode scalar value 计数，精确等于 `Array.from(content).length`，与 quote locator 的计量单位一致而不是 UTF-16 code units 或 grapheme clusters。inCurrentGeneration 始终对读取时 authoritative material membership 判定；历史 atVersionId 查询也必须和当前 membership 比较。rawAvailable 当且仅当该 MaterialRecord 的 supported derivation 引用了一份当前存在且 digest 验证通过的 raw blob；没有 raw 引用或受支持策略未保留 raw 时为 false，引用存在但 blob 丢失/损坏仍返回 storage_corrupt，不能降级成 false。当前 injected read slice 只支持 native_text / host_extract，因此两者固定 rawAvailable=false；遇到尚未接通的 raw_extract 返回 schema_unsupported，不能猜 false/true。MaterialPage items 按 MaterialId canonical UTF-8 bytes 升序。

suspendedVersions 在 V3 首版只能是 0 或 1。历史上曾 suspended 后被 reject / promote 的版本通过 versions.list 查看，不计入该数。

所有带 cursor/limit 的首版本地 EngineMethodMap page 使用相同边界：limit 缺省 50、最小 1、最大 200，越界是 invalid_input；nextCursor 只在后面确有下一项时存在。cursor 是 engine 生成的 opaque、versioned value，UTF-8 最多 16,384 bytes，并绑定 exact method、canonical normalized filters 与最后一项的完整 sort tuple；该独立上限必须容纳合法 1,024-byte displayName 经 canonical JSON escaping/base64url 后的最坏情况，不能复用较窄的 labelBytes。格式错误、跨 method 或 filter mismatch 都是 invalid_input。SubjectPage 与 LibraryPage 分别按 `(displayName UTF-8 asc, id asc)` 和 `(subject.displayName UTF-8 asc, subject.id asc)`；ReviewPage 为 `(candidate.createdAt desc, candidate.subjectId asc, candidate.id asc)`；MaterialPage 为 `(record.id UTF-8 asc)`；VersionPage 为 `(createdAt desc, id asc)`；LineagePage 为 `(at desc, eventId asc)`。首版 cursor 不承诺跨 mutation 的 snapshot isolation；收到 EngineEvent、流断开或页面间检测到变化时，Panel 必须丢弃 cursor 并从第一页全量重读。

### 15.4 Transport

~~~text
distilly panel --port <n>
  GET  /                  固定 allowlist 内的静态资源
  GET  /health            不含人物数据的版本与 readiness
  POST /action-nonces     mutation 的短期一次性 transport nonce
  POST /rpc               完整 EngineMethodMap 的类型化 JSON 调用
  POST /sources           UserCollectionMethodMap 的本地连接器调用
  POST /events            带认证 header 的 fetch SSE 字节流
~~~

~~~ts
export interface PanelServerOptions {
  readonly client: EngineClient;
  readonly sources?: UserCollectionClient;
  readonly assetsDir: string;
  readonly port: number;
}

export interface PanelHandle {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export type PanelActionNonce = Branded<string, "PanelActionNonce">;

export type PanelQueryRpcRequest = {
  [M in QueryMethodName]: {
    readonly wireVersion: typeof WIRE_VERSION;
    readonly method: M;
    readonly params: EngineMethodMap[M]["params"];
    readonly requestId?: never;
    readonly actionNonce?: never;
  };
}[QueryMethodName];

export type PanelMutationRpcRequest = {
  [M in MutationMethodName]: {
    readonly wireVersion: typeof WIRE_VERSION;
    readonly method: M;
    readonly params: EngineMethodMap[M]["params"];
    readonly requestId: RequestId;
    readonly actionNonce: PanelActionNonce;
  };
}[MutationMethodName];

export type PanelRpcRequest =
  | PanelQueryRpcRequest
  | PanelMutationRpcRequest;

export type PanelRpcResponse<M extends keyof EngineMethodMap> =
  | WireSuccess<EngineMethodMap[M]["result"]>
  | WireFailure;

export type PanelSourceQueryRequest = {
  readonly wireVersion: typeof WIRE_VERSION;
  readonly method: SourceQueryActionName;
  readonly params: UserCollectionMethodMap[SourceQueryActionName]["params"];
  readonly requestId?: never;
  readonly actionNonce?: never;
};

export type PanelSourceMutationRequest = {
  [M in SourceMutationActionName]: {
    readonly wireVersion: typeof WIRE_VERSION;
    readonly method: M;
    readonly params: UserCollectionMethodMap[M]["params"];
    readonly requestId: RequestId;
    readonly actionNonce: PanelActionNonce;
  };
}[SourceMutationActionName];

export type PanelSourceRequest =
  | PanelSourceQueryRequest
  | PanelSourceMutationRequest;

export type PanelSourceResponse<M extends keyof UserCollectionMethodMap> =
  | WireSuccess<UserCollectionMethodMap[M]["result"]>
  | WireFailure;

export type PanelEngineActionNonceRequest = {
  [M in MutationMethodName]: {
    readonly wireVersion: typeof WIRE_VERSION;
    readonly route: "rpc";
    readonly method: M;
    readonly requestId: RequestId;
    readonly params: EngineMethodMap[M]["params"];
  };
}[MutationMethodName];

export type PanelSourceActionNonceRequest = {
  [M in SourceMutationActionName]: {
    readonly wireVersion: typeof WIRE_VERSION;
    readonly route: "sources";
    readonly method: M;
    readonly requestId: RequestId;
    readonly params: UserCollectionMethodMap[M]["params"];
  };
}[SourceMutationActionName];

export type PanelActionNonceRequest =
  | PanelEngineActionNonceRequest
  | PanelSourceActionNonceRequest;

export interface PanelActionNonceGrant {
  readonly actionNonce: PanelActionNonce;
  readonly expiresAt: IsoDateTime;
}

export interface PanelEventStreamRequest {
  readonly wireVersion: typeof WIRE_VERSION;
}

export declare function startPanelServer(
  options: PanelServerOptions,
): Promise<PanelHandle>;
~~~

`/rpc` 覆盖 exact、完整的 EngineMethodMap，不能只注册当前 UI 用到的子集。query object 严格禁止 requestId/actionNonce；mutation object 必须同时带 requestId/actionNonce。handler 先按 method 对 unknown params 做 `engineMethodSchemas[M].params.parse`，再调用 query 或 mutation overload；mutation 只把 requestId 放入 MutationContext，绝不把 actionNonce 传给 engine 或纳入 operations authority row 的 trusted preimage digest。成功结果在序列化前再经 `engineMethodSchemas[M].result.parse`；成功与 domain/validation failure 最后都解析成 strict `WireSuccess | WireFailure`，wireVersion 固定为 `"3"`，没有第三种 JSON 或未校验 passthrough。

`/sources` 只覆盖 exact `UserCollectionMethodMap`，不接受 EngineMethodMap 名称。top-level envelope 先按 source action strict schema 解析，params 再经 `userCollectionMethodSchemas[M].params` 和当前注册 adapter 的 `resourceSchema` 解析，成功 result 也反向 parse。`source.list` 不需要 nonce；`source.configure`、`source.preflight` 与 `source.collect` 都是需要直接用户动作的 mutation-shaped call，必须携带 requestId 与绑定 `route="sources"` 的一次性 action nonce。configure payload 只能含公开 values 与 opaque secret refs；Panel 不提供 secret-value 字段。没有注入 `sources` client 的 injected Panel slice 禁用 Sources UI，并让合法 `/sources` 请求返回 non-retryable `host_unsupported`，不能伪造空成功。

PanelServer 只借用注入的完整 EngineClient 与可选 UserCollectionClient，不创建 runtime、不读取 DISTILLY_ROOT，也不拥有任一 client。production composition 为本次 Panel 会话创建单独、kind=user 的 EngineClient，并用该 user actor 组合 UserCollectionClient；即使由 MCP ReviewPresenter 启动也不能复用 kind=host client。startPanelServer 借用而不关闭这些 client；PanelHandle.close 只停止 HTTP/SSE transport、拒绝新请求、清理订阅与 nonce store。测试需要的 clock/random/listen seam 保持 package-private，不进入 PanelServerOptions 或 public export。

`GET /health` 的成功 value 是 exact、closed `{ "status": "ready", "panelVersion": "<@distilly/panel package semver>", "wireVersion": "3" }`；HTTP 200 body bytes 固定为 canonical key ordering 的 `{"panelVersion":"<semver>","status":"ready","wireVersion":"3"}\n`，`Content-Type: application/json; charset=utf-8`。panelVersion 只来自该 package 的 build version source。它不调用 EngineClient，也不包含 root/path/token/nonce、主体、projection 计数或环境字段。

production token 是 32 个 crypto-random bytes 编码的 64 位小写十六进制，每次成功启动重新生成且只驻留内存。PanelHandle.url 精确形如 `http://127.0.0.1:PORT/#TOKEN`；某个 ReviewRef 的 ReviewLaunch.url 精确形如 `http://127.0.0.1:PORT/#TOKEN/review/SUBJECT_ID/CANDIDATE_VERSION_ID`。ReviewLaunch runtime schema 拒绝 https、localhost、IPv6、缺显式端口、userinfo、query、非根 path、错误 token/route 和 ref 与 route 不一致；它不是任意 http(s) URL。

Fragment 不发给服务器；前端在发起任何网络请求、加载任何非初始 document subresource 之前读出 token 与可选 review route，立即用 history.replaceState 从地址栏移除 token、保留 `#/review/SUBJECT_ID/CANDIDATE_VERSION_ID`，以后只在内存保存 token。所有受保护 fetch 使用 `Authorization: Bearer TOKEN`。事件流必须用可设置 header/body 的 fetch streaming `POST /events`，不使用原生 EventSource。

### 15.5 安全不变量

1. Server 只调用 literal `127.0.0.1` listen，不接受可配置 host、`0.0.0.0`、IPv6、LAN address 或 hostname 解析。port 必须是 1..65535 且不等于 HTTP 默认端口 80 的 safe integer，确保浏览器不会把显式端口从 origin/Host 规范化掉；占用就以 busy 失败，不在已生成 URL 后换端口。每个请求必须恰有一个 Host header，value 逐字节等于 `127.0.0.1:<actual-port>`。
2. `/rpc`、`/sources`、`/events`、`/action-nonces` 必须同时满足 exact Host、`Origin: http://127.0.0.1:<actual-port>` 和 timing-safe 比较成功的 exact Bearer token；Authorization 必须是恰好一个 header，value 精确为 `Bearer ` 加 64 lowercase hex，无前后空白或其它 auth parameter。Origin 缺失、`null`、多值、大小写/默认端口变体或跨站都拒绝。静态 GET 与 `/health` 只允许 Origin 缺失或同一个 exact Origin；任意其它 Origin 拒绝。服务不发 CORS allow headers。
3. 四个 POST endpoint 必须恰有一个 Content-Type header，value 逐字节为 `application/json` 或 `application/json; charset=utf-8`，并只接收严格单个 JSON value 与对应 closed schema。累计 request headers 不得超过 16,384 bytes；raw body 最多 4,194,304 bytes，读到第 4,194,305 byte 立即停止并返回 HTTP 413 + strict、retryable=false 的 invalid_input WireFailure，不调用 EngineClient、UserCollectionClient、nonce store 或业务 parser。
4. 非 streaming response 必须先完整构造、result-parse、bounded serialize 并确认 UTF-8 bytes 不超过 16,777,216，再一次写出；不能先发 headers/部分 JSON。超限改成 retryable=false、无内容的 context_too_large WireFailure，details 只可包含数字 size/limit；该 failure 本身也必须在限额内。日志只记 content-free method/status/size，不记 body、params/result、材料正文、token、nonce 或 secret。
5. 静态文件只从 build-time 固定 allowlist 提供。router 对 percent-decode failure、NUL、反斜线、编码后或解码后的 `/`、`.`、`..` path segment、重复 separator、query/fragment 与非 allowlist 路径 fail closed；assetsDir 的每个祖先与最终文件都必须拒绝 symlink，并验证 real path 仍在 exact assets root。不能把 URL path 直接 join 到磁盘。`/health` 只返回版本/readiness，不含人物、路径、token 或 nonce。
6. 所有 document/static response 固定发送 `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: same-origin` 与 `Cache-Control: no-store`。不允许 data/inline/eval/remote script、remote connect、frame 或 service worker。
7. 所有 MutationMethodName 与 SourceMutationActionName 都需要 transport nonce，不只 purge/publish 等危险子集。Panel 只有在用户明确确认一次动作后，才向 `/action-nonces` 发送 exact route/method/requestId/params；服务先按 route 选择对应 method params schema 校验，生成 `panel_action_` + 64 lowercase hex，再用 `WireSuccess<PanelActionNonceGrant>` 返回并对整个 result schema 做最终 parse。nonce 绑定当前 panel token、route、method、requestId 与 `SHA-256("panel-action-params-v1\0" + route + "\0" + canonicalJson(params))`，expiresAt 精确为签发时刻 +60 秒，只驻内存。RPC / source action 在 `now >= expiresAt`、任一 binding 不同或 nonce 不存在时返回 invalid_input；通过全部 envelope/params/binding 校验后、进入对应 client.call 前原子 consume，一经 consume 即使 client failure、response 超限或连接中断也不能重用。并发相同 nonce 恰有一个调用能进入任一 client。
8. `/events` body 必须逐字段等于 `{ "wireVersion": "3" }`。服务完成 auth/body 校验后先注册 `client.watch`，缓冲注册与 ready 之间的 EngineEvent，再以 HTTP 200、`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-store` 且无 compression 写恰好 `event: ready\ndata:{"wireVersion":"3"}\n\n`；Panel 收到 ready 后才启动初始全量 reads，随后处理已缓冲与新 frame，后者 bytes 精确为 `event: engine\ndata:` + `canonicalJson(engineEvent)` + `\n\n`。每个 SSE response header block 和每个完整 frame 各自最多 16,384 UTF-8 bytes；单个 EngineEvent 仍过大、socket backpressure 造成 bounded queue 溢出或任意流断开时，server 取消订阅并断流，client 丢弃 cursor、重新连接并全量重读。流没有 id/Last-Event-ID/replay 语义，不能把丢失事件猜成连续。

HTTP status 不留给 handler 自选：未知 path=404，已知 path 的错误 method=405，header 超限=431，Bearer 缺失/错误=401，Host/Origin 规则失败=403，不支持的 Content-Type=415，body 超限=413，malformed JSON 或 strict top-level envelope/wire/method shape 失败=400。经过这些 transport checks 后，合法 `/rpc` 或 `/sources` method 的 params invalid_input、domain error、result validation归一失败、unexpected internal_error 和 16 MiB context_too_large replacement 都以 HTTP 200 承载 strict WireFailure；合法 nonce request 的 expired/replayed/rebound nonce不会调用 client并以 HTTP 400 invalid_input WireFailure 返回。除 static 404 外，JSON endpoint 的 4xx body 仍须是 bounded strict WireFailure，统一使用现有 invalid_input、retryable=false，不新增 auth code；401/403 使用同一个无 details 的 generic message且不回显 token、Origin 或 Host，405 只列该 route 的 exact Allow method。

无 token、错 token、跨站/缺失 Origin、错误 Host、oversized header/body/response/event、nonce expiry/replay/rebinding、端口占用、symlink 与各种 path decode/traversal 各有拒绝测试；每条测试同时断言零 EngineClient / UserCollectionClient call 或按规定最多一次 call。

### 15.6 生命周期与宿主打开方式

~~~ts
export interface ReviewPresenter {
  present(review: ReviewRef): Promise<ReviewLaunch>;
}

export interface PanelLauncherOptions {
  readonly start: () => Promise<PanelHandle>;
}

export declare class PanelLauncher implements ReviewPresenter {
  constructor(options: PanelLauncherOptions);
  present(review: ReviewRef): Promise<ReviewLaunch>;
  close(): Promise<void>;
}
~~~

distilly panel 在前台运行并打印 URL。MCP / CLI presenter 得到 suspended CommitResult 时，通过注入的 ReviewPresenter 启动或复用本次会话的 PanelServer，再把 ReviewLaunch 作为工具 structured value 返回；CommitService / CommitResult 只知道 ReviewRef，不知道 HTTP 或 URL。ReviewPresenter 接口由 mcp 导出，PanelLauncher 由 panel/server 实现，所以 mcp 不静态依赖 panel。

PanelLauncher 的状态机精确为 new → starting → running → closing → closed。new 中首个 present 创建唯一 start promise；starting 中所有 present 共享它。start 在没有交出 handle 前失败时，所有 waiter 得到同一 failure，清空 promise并回到 new，之后 present 可重试；但 close 一旦开始就不再重试。start 交出的 handle.url 必须先通过 exact Panel root URL schema，随后每个 present 才为自己的 ReviewRef 构造 route；launch.ref 与输入逐字段相同，URL route 编码同一 ref，任一 mismatch fail closed。若已取得 handle 但 root URL validation 失败，launcher 立即进入 closing，所有 waiter 得到同一 validation failure，与并发 close 共享对该 handle 恰好一次的 close attempt，最终进入 closed且不可重试，不能泄漏 server 或另起第二个。

present 的 linearization point 是：start 已成功、handle URL 已验证、launcher 仍为 running，且 exact launch value 已构造完成。close 在该点之后才开始时，present 可返回该 launch；close 已把状态改成 closing 而 present 尚未越过该点时，present 必须失败，不能返回一个正在被关闭的首次 URL。start rejection 永远原样交给其 waiters；若 close 同时等待该 rejection，close 随后正常进入 closed。

close 是 single-flight 且幂等：closing/closed 以后所有新 present 都在调用 start 或复用 handle 前明确失败，不能重启。close 与 starting 竞争时先等待该 start settle；若它成功，PanelHandle.close 恰好调用一次，所有尚未成功返回的 present 失败；若它失败，不调用不存在的 handle。running handle 也只关闭一次。即使 handle.close 报错，所有 close caller 收到同一结果，launcher 仍终止在 closed、不可重启且保留已尝试关闭的 handle reference 只作 ownership 证明。PanelLauncher 只拥有它启动的 PanelHandle，借用 handle 所使用的 client；production composition 按 PanelLauncher → user client 顺序关闭，root service owner 独立决定 Engine shutdown。直接调用 startPanelServer 的 caller 则先关 handle、再关自己创建的 client。injected fixture 不创建或关闭 Engine service。

review route 不需要 `reviews.get`。UI 用 route.subjectId 调 `reviews.list({ subjectId, ... })`，必要时逐页读取并只接受 candidate.id 精确等于 route.candidateVersionId 的 ReviewItem；找不到、同 subject 出现不一致 active candidate、或 route/ref mismatch 都作为 stale review 显示并触发全量重读，不选择“最新 candidate”替代。promote/reject 的 mutation CAS 仍是最终权威，route 与 read 之后发生竞争时返回 review_conflict。

宿主能打开本机链接就展示；不能时让用户复制到系统浏览器。模型职责到“提供地址与说明”结束，不点击 DOM，也不把 Panel 操作当工具执行。

---
