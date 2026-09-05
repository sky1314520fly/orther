> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 27. 测试、宿主契约与治理

### 27.1 测试原则

- 测真实public/package entry、real SQLite/WAL和real blob files，不以“helper被调用”代替结果。
- 所有storage tests使用temp DISTILLY_ROOT；不碰用户目录。
- mock只放clock、id、network、LLM/DraftProducer与不可控host；storage不用大而全fake。
- mutation证据按业务transaction边界组织，不按第几个JSON文件或rename步骤组织。
- 无live web、无真实API key、无真实个人数据。
- 零测试、意外skip、取消或超时都不是绿。
- generated prompt/skill/manifest/export用可读snapshot并逐条review。

### 27.2 Protocol 与纯函数

Protocol tests覆盖：

- 所有public id/time/facet grammar、WIRE_LIMITS、strict object、JSON-safe error与Wire envelope；
- EngineMethodMap exact method set、query/mutation分区、per-method params/result correlation、EngineAdministrationClient backup/restore schemas与五MCP descriptor；
- RequestId mutation context、actor/lease owner不出现在caller params、idempotency conflict；
- public page/cursor sort/filter/limit、ProfileDiff、ReviewReason、EngineEvent forward compatibility；
- PurgeResult complete/pending判别、pendingBlobCount safe-positive cross-field、same-RequestId stable replay与DoctorSnapshot.storage.pendingBlobGcCount live status；
- public Protocol export allowlist明确不含SQLite row、FactEnvelope、TransactionRecord、journal、projection checkpoint或GC record。

Pure-function goldens覆盖：

- label-v1、material-text-v1、URI/provenance normalization、ContentDigest/MaterialId/MaterialSetHash；
- source-groups-v1、evidence quote/Unicode-scalar locator、ClaimId/VersionId canonical preimage；
- empty/add/revise/supersede/contest与correction replacement；
- strength、quality、maturity、ReviewReason ordering；
- profile-renderer-v1、prompt与diff byte stability；
- AcceptedCorrection normalization、direct/relayed provenance、candidate-content/current-delta baseline。

这些测试保留完整产品语义，但不构造或验证旧磁盘journal schema。

### 27.3 SQLite authority、blob 与 projection

real temp Engine integration必须证明：

- fresh schema启用foreign keys和WAL，unsupported published storage version fail closed；
- create/ingest、brief/renew/release、commit、promote/reject、correction、rollback各自只在一个SQLite write transaction中改变结构化state；
- 在transaction commit前强制process/connection failure，重开只能看到previous state；commit成功后重开看到operation/result/events/pointers的完整target state；
- 没有application-level prepared/aborted/terminal mutation record，也没有target/previous/third-state semantic recovery；
- 同RequestId exact input/actor/session fields返回same stable result且不重复row/event；cross-method或changed preimage永久idempotency_conflict；
- immutable version/claim/evidence/material membership与current/suspended uniqueness由constraint和service invariant共同保持；
- blob put相同content幂等、digest collision/mismatch拒绝；测试在put完成、DB commit前暂停mutation并尝试GC，GC必须等待且commit后blob仍可读；commit前crash后重开则orphan可被GC删除；
- read先取得shared blob lease、再打开旧SQLite snapshot并暂停于blob读取；另一路purge移除最后引用并请求GC，GC必须等待active read交付bytes后才删除，physical-complete purge也必须等待同一门闩；测试反转取得顺序时必须稳定复现删除竞态；
- mutation failure不扫描全历史引用或同步删除orphan blob；
- ordinary profile/material/version/Library reads只查询直接rows和blobs，缺失reference/digest fail closed；它们不枚举全history；
- doctor执行SQLite integrity/foreign-key、全部deterministic ids、lineage DAG、evidence quote、blob reachability、renderer与projection watermark全审计，并能定位corruption；
- Library/profile/prompt/search/graph projection的source LSN落后时不会返回clean-stale；rebuild从一致snapshot发布完整generation，concurrent newercommit使它显式stale并继续追赶；
- 删除projection不丢business state；jobs/leases直接从authoritative rows读取；
- `EngineAdministrationClient.backup/restore`四个strict schemas与CLI真实命令通过；backup由一致SQLite snapshot+reachable blobs+manifest组成，目标冲突/overwrite与pin释放精确；corrupt/missing blob backup拒绝。restore confirmation mismatch零写，只构造/验证sibling root，失败不修改live root，成功后切换、重新打开authority并返回retained old root；
- privacy purge先原子移除可见references/tombstone并存入stable PurgeResult；无待删blob返回complete，有待删blob返回pending+safe-positive count。same RequestId在GC完成后仍重放原result，fresh system.doctor显示live pendingBlobGcCount；CLI/Panel不混淆logical与physical completion。

Storage crash tests只需要覆盖SQLite commit前/后、generic blob publication、projection publish、GC与backup/restore边界；禁止为ingest/commit/correction/review/rollback分别复制每个文件步骤的crash matrix。

### 27.4 Lease、并发与single writer

- 每个EngineClient session获得不同engine-owned LeaseOwnerId；public params不能提交owner；
- absent/expired→brief lease、renew只改expiry、release删除lease、exact expiry、owner conflict与new-generation stale全部有transaction tests；
- capacity与brief size在lease transaction前验证；65,536/+1 patch、999 refs和host net capacity边界零权威写入；
- active suspended、stale job、lease mismatch、evidence/patch error按§7.6 precedence返回最窄code并保持pending/lease；
- 两个client并发create同identity、brief同job、commit同lease、promote/reject同candidate、correction与review/ingest只产生一个合法serial world；
- long calculation后write transaction重查generation/current/candidate/lease，不能lost update；
- MCP、Panel、CLI和binding可以是不同process，但都attach同一Engine service；第二个Engine writer不能打开同root；
- static boundaries与runtime sentinel共同证明surfaces不importstorage、不写DISTILLY_ROOT；
- SQLite busy/backpressure有bounded retry或typed busy，不用request/subject/Library file lock解决。

### 27.5 Keyless host workflow

完整 production FakeHost conformance 至少覆盖 Codex-like、Claude-like、OpenClaw-like 与 Hermes-like 的五工具、handler 和 lifecycle 形状。它与真实宿主容量证据分开：当前 Codex、OpenClaw `2026.3.24` 与 Hermes `v0.9.0` 各有独立的真实 binding fixture，Claude Code 与未来宿主仍须固定自己的真实版本和净容量。OpenClaw/Hermes 还各有 compatibility fixture，负责宿主安装/发现边界；compatibility 与 capacity 两类 fixture 不能互相替代：

clean root → get not_found → ingest(create) → research fixture materials → enqueue now → pending brief → fixed claim patch → commit → get / prompt → correct → review。

这条 clean-root 流程不属于 injected-client stdio smoke。暂停的 Step 11a 文件 journal/staging/recovery 不构成 product conformance，也不作为新 CorrectionService 的基础。correct→review 只有在 correction 纯逻辑接到 SQLite authority、PanelLauncher/ReviewPresenter、全部 Core handlers 与 production single-writer composition 后才进入 FakeHost；更早的 fake correct/suspended result 只证明 handler shape，不能写成 correction、Panel 或 keyless product 已实现。

Step 9 单独做 capability-binding conformance：HostPreflight runtime schema 必须接受且只接受 success(capabilities+capacity+evidence+warnings) 或 failure(capabilities+host_unsupported error+warnings)；success 强制 structuredToolCalls、evidence.kind/capacity.source 一致，failure 禁止 capacity/evidence。四个 factory 只消费 injected HostPreflightProvider 的 unknown payload，不探 HOME、PATH、进程或网络；provider throw、unknown-key、host/environment/source mismatch、gross-only limit、缺净预算与过期 fixture 都 fail closed，并 snapshot §17.2 exact fallback capabilities/non-retryable sanitized error。binding_fixture 必须绑定 exact host/version/environment/release/wire/canonical-skill digest，并在真实宿主验证公告 exact net budget 下完整的 structuredContent 与 JSON text duplication；对 OpenClaw/Hermes 还必须在同一 immutable record 中匹配 `schemaProfile`、`advertisedToolContractDigest` 与 `probeContractDigest`，而这些校验值不出现在 HostPreflight wire evidence。tuple 任一字段变化必须重跑 fixture。四个 builtin 一律 privateUiCapture=unavailable。OpenClaw compatibility fixture 还必须证明 Claude bundle、owned `.mcp.json`、global-entry preservation 与 `plugins inspect` discovery；Hermes compatibility fixture 必须证明 managed Skill、owned wrapper/config、`resources` / `prompts` 关闭、恰好五个 tools，以及未知 config 字段 fail closed；这些 fixture 不能被当成 capacity evidence。HostRegistry 覆盖 capability/full 两分支、跨分支 duplicate 无 mutation、get exact 与 list HostName UTF-8 稳定顺序；Injector/FormRenderer 不可单独注册。

还要覆盖：

- no web fallback；
- 无 document/OCR/caption/transcription 能力时走文字稿或 unavailable；raw/unparsed 只由 SDK / CLI 的显式 file-ingest fixture 证明，不伪装成五工具结果；
- subrun 不继承 MCP；
- malicious material instructions；
- validator remediation 重试；
- briefing_too_large；
- suspended + Panel review。

FakeHost 不声称证明真实宿主 UI；capability binding 只证明 manifest/capability/fixture。kind=full factory 的临时 HOME fixture 证明 launcher rendering、owned install/uninstall、doctor、marketplace preservation、injector 与 person-Skill digest refusal；真实宿主重开、五工具与 runtime handshake 仍必须由 packaged fresh-install E2E 证明。真实容量 fixture 只证明对应版本在其 advertised-schema projection 下能完整承载 briefing 和 tool result，不替代 UI、安装、重开或长期 Skill 生命周期证据。

内置 adapter / parser conformance 全部离线运行：HTTP mock 覆盖 Lark 中国与国际 endpoint 不混用、scope、pagination、limit、bounded retry 与 secret redaction；Slack 只返回 bot 已加入范围，按不同 provider page limits / cursors 工作并逐字尊重 bounded `Retry-After`；DingTalk message-history 请求在零网络调用下返回 non-retryable `host_unsupported`；Xquik 的 MeteredReadConsentPort declined/throw 与 subject/resource/objective/limit 不匹配都在解析 secret 和发网前拒绝。TXT / Markdown / JSON / Lark export / EML / MBOX / SRT / VTT / embedded-text PDF 使用真实格式 fixture；Lark export / MBOX 覆盖 exact subject hints、歧义/缺失拒绝、稳定聚合、1,048,576-byte 边界与 +1 无 material，扫描 PDF / image 在没有已验证宿主提取能力时明确 unparsed / unavailable。CLI 与 Panel 的等价 collect fixture 产生相同规范化 MaterialInput、provenance 与 ingest 结果，并断言配置、payload、日志、错误和诊断中没有 secret。Codex / Claude Code 的全流程各自断言没有 browser、Playwright、Computer Use、截图或 private-capture Controller；OpenClaw/Hermes compatibility 流程另外断言不启动 browser/private capture，并保留各自的 bundle/managed-Skill 边界；OpenClaw/Hermes 的真实 capacity fixture 单独证明对应 advertised-schema projection 下的 briefing/tool-result 完整性，不替代上述宿主生命周期验收。

未来某个 full binding 首次报告 privateUiCapture=available 时，private UI capture conformance 还必须覆盖：第一帧前原生 consent；exact app/account/1:1 thread/range；OS permission 或 Always allow 不能绕过；错账号、错窗口、侧栏、通知、OTP/支付/secret 立即停止；群聊、附件、链接、scheduled/background/locked/subrun/executor 拒绝；无发送/删除/下载；屏幕 prompt injection 无效；audit stamp 不能由 MaterialInput 伪造；public/shareable/web/article/URI/artifact 等跨字段伪装被 engine 拒绝；grant replay 与授权后、ingest 前 revoke 被拒绝且 audit 保留 guard 的真实 reason；每个 start 在成功、engine ingest_rejected、coordinator_aborted 与 process recovery 下都恰有一个封闭 stop；成功与中止后 DISTILLY_ROOT、日志和诊断包都没有 screenshot；privacy purge 删除 transcript；host data policy unknown 返回 unsupported。稳定 locator 的 label 改名仍合到同 conversation，同名但不同 locator 不碰撞；无 locator 的 subject fallback 保守合一；create+fallback 在 hash 前绑定最终预分配 SubjectId；两个 runtime 与重启使用同一安装 audit key；原生 action 的 IngestResult 必须返回当前 task。fixture 只用合成窗口和合成聊天，不读取真实个人数据。当前四个 full binding 与 capability binding 都不运行 available lane，只验证 unavailable 与 paste/export fallback。

### 27.6 Panel

- `/rpc` 对 EngineMethodMap exact 35 keys 做 query/mutation envelope、params-before-call/result-after-call 与 final WireSuccess/WireFailure round-trip；query 的 requestId/actionNonce、mutation 缺任一字段和所有 unknown key 都拒绝且零 call；
- `/sources` 对 UserCollectionMethodMap exact 四个 action 做 envelope、adapter registration/resource schema、params-before-call/result-after-call 与 final WireSuccess/WireFailure round-trip；未注入 UserCollectionClient 时返回 non-retryable `host_unsupported`，零 fake success；
- `/action-nonces` 覆盖 `panel_action_<64hex>`、token/route/method/requestId/canonical-params digest binding、60 秒前/边界 expiry、原子 single consume、并发 replay 与 client/connection/oversize failure 后不可复用；所有 MutationMethodName 与 SourceMutationActionName 都走 nonce，跨 `/rpc` / `/sources` 不能重放；
- 四个 POST endpoint 都覆盖 exact Bearer、literal Host/Origin，static/health 只允许无 Origin 或 exact Origin；无 token、错 token、Origin 缺失/null/多值/跨站、错 Host 与 CORS preflight 全部拒绝；token 在首个 fetch/subresource 前从 fragment 移除并只以 header 发送；
- `/health` exact canonical JSON+LF bytes、package-semver source、200/content-type 与零 EngineClient call；404/405/431/401/403/415/413/400 transport matrix固定，合法 method/domain WireFailure 保持 HTTP 200；
- request header 16 KiB、body 4 MiB/+1→HTTP 413 invalid_input、nonstream response 16 MiB/+1→一次性 context_too_large failure，证明 oversized 路径不半写且 EngineClient call 数符合 §15.5；
- build allowlist、percent-decode/NUL/dot/repeated separator/backslash/encoded separator/query、symlink ancestor/file、realpath containment 与占用端口拒绝；CSP/Referrer-Policy/nosniff/CORP/no-store exact snapshot且没有远程资源或 service worker；
- `POST /events` strict body 与 fetch streaming 覆盖 watch subscribe→ready→initial reads 次序、ready 前 buffer、无 id/replay、慢消费者、断线和单 frame/header 16 KiB/+1；断流都取消订阅并触发 cursor discard + full reread；不用 EventSource；
- SSE unknown event 由 decoder 产生 schema_unsupported、不调 UI handler 并触发全库 re-read；
- PanelLauncher 覆盖 new/starting/running/closing/closed、并发 present single-flight、start failure retry、invalid handle URL、close-vs-start、handle.close exactly once、close failure sharing、closed 后不重启与 borrowed client 不关闭；
- Panel engine action 与等价 CLI action 产出相同 version / event；Panel source configure/preflight/collect 与等价 CLI source action 产出相同 status、规范化 MaterialInput、provenance 与 ingest result，浏览器 payload/result 不含 secret value 或 provider raw response；
- UI 显示的 privacy/quality/pending/suspended/new-material/lastChangedAt 字段全部来自 protocol，同 snapshot 聚合且排序/cursor 语义固定；review route 只从 subject-filtered ReviewPage 找 exact candidate，再由 mutation CAS fail closed，不存在 reviews.get；
- Evidence / Materials 显示 medium、role、derivation、raw/capture provenance 与 engine source-group basis，不在前端重算 eligibility；
- atVersionId 只从该版本 authoritative material membership 重建 source group；新增 bridge material不改变历史展示，旧 grouping 实现不可用时明确 schema_unsupported；当前 native_text/host_extract 返回 rawAvailable=false，raw_extract 在其 blob reader 落地前返回 schema_unsupported；
- injected Panel 只启用真实 reads 与 promote/reject/rollback；correct/install/archive/production doctor controls disabled/future-only，injected full-client doctor 只读可显示；断言没有 fake success、Engine service、CLI 或 production command；
- Discover 首版不存在。

### 27.7 Fresh install

release-assembly gate 从 canonical root 递归覆盖 nested references/assets、raw byte digest、POSIX UTF-8 path order、source/target symlink拒绝、target stale prune、两个 mirror 的 exact file tuple/tree digest、两个 platform manifest raw digest、releaseVersion 同源与 schemaVersion=1 release-manifest canonical bytes。check mode 必须证明第二次生成零 diff；改变一个 nested byte、删 source file、注入 stale target、改变 package version或任一 exact target path 都产生预期 diff/failure。`.mcp.json.template` sentinel 存在但不出现在 release target/platform manifest/installable archive；该 gate 不执行 setup，也不宣称 source tree 是可启动插件。

从 Core closure + production composition 之后构建的发布包而不是 source；此前的 injected-client stdio child 不满足本节：

- npx setup 写 versioned runtime 与绝对 launcher；
- Codex / Claude Code manifest schema；OpenClaw Claude-bundle discovery 与 Hermes managed-Skill/MCP-config smoke；
- MCP `tools/list` 恰好五工具，顺序、name/title/description/annotations 与 protocol snapshot 字节一致；Codex/Claude Code 公告 canonical schemas，OpenClaw/Hermes 公告经 `schemaProfile` 投影的兼容 schemas，所有 handler 仍按 canonical RuntimeSchema 校验；
- engine / plugin wire mismatch 拒绝；
- skill copies 与 release manifest 的 canonical recursive tree digest 相同；
- 路径含空格、非 ASCII 与 Windows separator fixture；
- upgrade 原子切换且可 rollback；
- uninstall 保留 DISTILLY_ROOT 人物事实。

`0.1.0-preview.1` 已完成上述 Codex/macOS 纵向子集：package manifest 逐文件 digest、无 symlink/source/test/sentinel 扫描、含空格和非 ASCII 的 copy install、绝对 launcher、官方 Codex plugin/MCP/Skill 重开发现、server version 与五 descriptor、真实 SQLite/Panel/人物 Skill 主流程、解压目录移除后的运行，以及 uninstall 对 SQLite 与人物 Skill 的 byte-identical 保留。runtime 任一 owned byte 被改动时 doctor 失败且 uninstall 不删除该 runtime。另为 OpenClaw `2026.3.24` 与 Hermes `v0.9.0` 补充了独立的真实容量 fixture；它们只证明各自 advertised-schema projection 下的 transport/value 承载能力，不把安装/发现 smoke 自动升级为 packaged fresh-install 完整闭环。未知版本仍 fail closed。尚未完成的本节项目是 Claude Code packaged host reopen、OpenClaw/Hermes 各自的 packaged host reopen/长期 Skill 生命周期、Windows separator、upgrade/rollback 与把只读 initialize smoke 内置到 setup；这些继续作为后续宿主 hardening，不回退已验证的 Codex/OpenClaw/Hermes 容量证据。

### 27.8 门禁

设计目标中的 pnpm 门禁：

~~~text
pnpm install --frozen-lockfile
pnpm run gates:fast
pnpm run typecheck
pnpm run test
pnpm run test:coverage
pnpm run snapshots
pnpm run docs
pnpm run notes
pnpm run build
pnpm run hygiene
pnpm run gates
~~~

命令只有实际存在并跑过后，才能写入当前态 docs/development.md。构建产物 import、类型解析、exports、未声明依赖与 plugin archive 是独立发布门禁；源码测试绿不等于可安装。

### 27.9 设计 corpus 治理

- system-v3.md 是唯一父合同；
- v3/ 编号章节只由 scripts/sync_design_chapters.py 生成；
- V1 / V2 只保留在 Git 历史，不作为当前树的维护对象；
- corpus registry 在写任何文件前验证 parent、version、chapter dir、输出路径唯一和恰好一个 in-force；
- 合同变化与当前实现文档在同一 PR 更新；
- architecture.md 只写 shipped tree，不把 V3 目标说成已发布；
- 操作文档只在真实入口落地后写可执行步骤；
- 机器验证链接、结构、生成一致性；语义 review 判断设计是否正确。

---
