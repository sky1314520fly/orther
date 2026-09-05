> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 29. 落地顺序、首发验收与本文演进

### 29.1 纵向切片

已经落地的 Protocol、deterministic core、injected Facade/MCP、capability/full host bindings 与 injected Panel 保留；旧文件事实实现不再决定后续设计。迁移从以下独立 feature 重新编号；每项使用独立分支、可审查提交与对应测试，并在接通替代路径时删除对应旧机制：

1. **Storage authority contract**：冻结单 writer、SQLite/WAL、blob、projection、doctor/backup 边界；只改合同与治理，不改产品代码。
2. **SQLite + create/ingest vertical foundation**：只建立 `subjects.create` / `materials.ingest(existing|create)` 所需的 spaces、subjects、aliases、identity hints、material metadata/blob references、current subject material membership、authoritative pending-job、operations 与 events 逻辑关系，以及一个短 write-transaction runner 和 ContentAddressedBlobStore。Blob put lease 保持到引用它的 transaction commit 或 rollback；两条方法共享 transaction-local create primitive，但 ingest(create) 不调用公开 create。该 commit 删除 live create/ingest 的 IngestTransactionRecord、staging、mutation-specific recovery、space catalog/identity locks 与旧 composition；仍被未迁移 brief/commit/review 测试使用的 shared file stores、request/subject locks 和 disposable queue 只能留在显式 test-only legacy fixture，不能被 SQLite composition import、不能 dual-write，也不是兼容路径，并由各自 owner migration 删除。没有当前消费者的 outbox、projection、doctor、backup 或 GC task abstraction 不提前出现。
3. **Brief + lease migration**：pending-job rows 已由 Step 2 成为权威；本步迁移 `distill.pending` / brief / renew / release，为同库 authoritative job 增加 lease 状态并让每个 mutation 各用一个 transaction；随后删除 legacy queue sibling database、dirty marker、lease journal 与相关 recovery。
4. **Commit migration**：保留 evidence/claim/quality/rendering 纯逻辑，把 immutable version、claims、memberships、pointers、operation/events 在一个 transaction 中提交；删除 version staging、state file swap 与 commit recovery。
5. **Review migration**：promote/reject 进入普通 SQLite transaction，rollback 创建新 immutable version；删除 review/rollback journal、staging 与 recovery。
6. **Correction migration**：保留 normalization/provenance/replacement/reason 纯逻辑，correction body 进 blob、metadata/version transition 进一个 transaction；不采用暂停的 Step 11a CorrectionTransactionRecord、staging 或 recovery。
7. **Projection generation/rebuild**：在第一个真实 projection 消费者出现时加入统一 outbox/source LSN/watermark builder；profile/prompt/Library/search/graph/export 共用它，并删除 Library intent/dirty/reservation 与其它 projection-specific transaction simulation；legacy queue database/dirty 已在 Step 3 删除，不留到本步。
8. **Verified read 与 doctor 分离**：普通 read 只验证所用 rows/blobs；此时才加入有真实调用者的 doctor 全 lineage/evidence/blob/renderer 审计，并删除每次公开读取的全历史扫描。
9. **Blob GC + backup/restore**：通用 unreferenced-blob GC、backup pin、SQLite snapshot + reachable blobs、sibling-root restore与真实 admin methods/CLI；不为 mutation 做 abort cleanup。
10. **旧 authority 与 Protocol 收口验证**：验证各 owner migration 已删除全部 file journals/locks/recovery/checksum envelopes、test-only legacy fixture 与 queue database；任何残留都阻塞本步。随后让持久化结构退出公共 Protocol，并证明没有 dual-write 或旧 reader。
11. **剩余产品方法 closure**：按 subject lifecycle、raw/file ingest、redistill、bundle、host install/export 等真实用户路径继续拆独立 feature；不把无关 methods 塞进 runtime。
12. **Built-in adapters 与 parsers**：建立 `@distilly/adapters`，按 §10.6 的白名单逐个交付 Lark、DingTalk、Slack、Xquik 与本地 parser；每个 provider 是独立 feature，使用离线 fixture，secret 只走 refs，DingTalk message history 与全部 browser private-chat capture 保持 unavailable。加入 composition-owned user collection service，但不增加 EngineMethodMap 或 MCP tool。
13. **Single-writer production runtime**：全部方法已有真 handler后，交付 root-scoped connect-or-start/attach service、actor-bound clients、production MCP/Panel/CLI/setup、user collection service 与 teardown ownership；第二 writer fail closed。
14. **Legacy import 与 fresh install**：只迁移真实 dot-skill fixtures，完成 clean install、doctor、upgrade/uninstall 与 Codex / Claude Code host reopen；每个宿主的 packaged closure 结果单独记入 §29.5 矩阵。
15. **OpenClaw / Hermes binding 与容量证据**：OpenClaw 复用 Claude-compatible bundle 并在 owned extension tree 生成绝对 launcher 的 `.mcp.json`；Hermes 使用 managed Skill、Distilly-owned wrapper 与 `config.yaml`，关闭 auxiliary resources/prompts；两者都运行真实 discovery/config smoke，并分别以独立真实宿主版本 fixture 固定净容量。容量 fixture 只开放对应 tuple 的 briefing，不替代各自 packaged fresh-install closure；版本、release、descriptor、advertised schema projection、projection/probe digest 或 serializer 任一变化时保持 `host_unsupported`，直到重跑对应端到端测试。
16. **其它宿主、关系、Bot、TUI、后台 executor 与 Catalog**：按真实需求分别立项，不能阻塞蒸馏主路径或扩大 Developer Preview 的宿主宣称。

前一 feature 未完成可审查提交、设计/standing docs 与验收时，不开始下一 feature。任何迁移 feature 都禁止 dual-write、长期 adapter 或“先保留以防万一”的未发布格式兼容层。

### 29.2 Chat 主路径验收

- 干净 DISTILLY_ROOT、无全局 CLI、无 Distilly 账号、无额外 LLM key；
- 一条 setup 后 doctor 绿、宿主重开后恰好五工具；
- 用户只说“调研并蒸馏公开人物 X”；
- get not_found 后 ingest(create) 成功，用户不发明 subject id；
- 宿主按 public-figure portfolio 使用多个 research fixtures，每份保存 artifact / representation、URI / title / time / medium / derivation / body；
- enqueue now 有变化时必返 job；
- pending brief 原子取得 lease，返回 baseline、全部增量正文、来源和短 refs；
- 宿主提交 claim patch，无 Markdown / confidence / actor；
- commit 验证 evidence 后产生 current；
- get 得到 identity、voice 例句、boundaries 与逐 claim evidence；
- 下一次 prompt 可注入同一 current。

### 29.3 审核验收

- clean commit 不要求点击 Panel；
- identity change、coverage drop、new contested 或 correction conflict 产生 suspended；
- old current 不变；
- commit presenter 返回可打开的 review URL；
- Panel 显示 diff、reason、quote、URI 与原始材料；
- 首个 suspended 没有 current/beforeQuality 时不造 baseline；同 ClaimId 内容变化进入 changed before/after，review route 只接受 subject-filtered page 中的 exact candidate；
- promote/reject/rollback 各自在一个 SQLite transaction 中原子提交且 RequestId 精确重放；reject pending 原样，promote/rollback pending rebase 使用新 JobId、mutation-time queuedAt、无 lease并重算 delta；
- Panel / CLI promote、reject、correct、rollback 结果一致；
- events 与 versions 保留完整历史。

### 29.4 正确性与恢复验收

- 八位短 hash 不存在于 V3 identity contract；
- duplicate source/content 幂等，同正文不同来源保留；
- 不存在、跨主体、跨 generation evidence 和错误 quote hard reject；
- 相同 requestId 不重复建主体、材料或版本；
- 同 generation 两个 brief 只有一个 lease；
- lease owner 绑定 client session，renew / expiry / release 由 authoritative job/lease rows 与 transaction preconditions 保证；
- lease 后新材料使旧 commit stale，新 generation pending；
- briefing 使用 source-groups-v1、raw asset prompt version、exact BriefContract 与 fixed-point capacity；超限在 write transaction 前失败且不返回半份；
- commit 从 verified state/base/materials 而非 brief operation 重建 m001/EvidenceContext；accepted patch 65,536 bytes 通过、+1 zero-write invalid_input，locator start<end、date range、target唯一与 pinned algorithm dispatch 都有正反验收；
- claim add/revise/supersede/contest、canonical ClaimId/evidence/observedIn、exact quality/reason order、首版 delta skip 与 suspicious/manual gate可字节复算；
- process 在 SQLite commit 前终止时只见 previous state，commit 后终止时只见完整 target state；WAL reopen 不运行 mutation-specific recovery；
- review/correction/rollback 与 commit 共享同一 transaction、RequestId、constraint 与 stale-precondition 语义，不各造 recovery state machine；
- current 成功 current=new/suspended absent，suspended 成功 current unchanged/suspended=new，已有 active suspended 的 ordinary commit 在任何写入前 review_conflict；
- 删除 projection 后可按 source LSN 重建且不丢权威 job/profile/history；stale projection 不伪装 fresh；
- immutable version rows、claims、material/evidence memberships 可由 doctor 完整交叉审计，createdIn 不与 VersionId preimage 循环；`profile-renderer-v1` 七 core/domain/active/contested/JSON escaping 与单 LF 字节稳定，历史 displayName/prompt 不受以后改名影响；
- AcceptedCorrection/source/provenance/replacement/reasons 可字节复算，generation+1/full material membership/fresh pending 与固定 events 一致；correction body 使用 immutable blob，失败后未引用 blob 由通用 GC 清理，privacy purge 精确删除引用并等待 GC。

### 29.5 宿主与安全验收

- no web、no extraction、no file、subrun no MCP 都走明确 fallback；
- Developer Preview 的宿主证据分成 briefing-capacity 与 packaged fresh-install 两张表，不能把一张表的绿灯复制到另一张：

  | 宿主与 exact 版本 | `tools/list` advertised surface | briefing capacity（max input tokens / max result bytes） | packaged fresh-install closure |
  |---|---|---|---|
  | Codex `codex-cli 0.146.0` | canonical 五工具与 schemas | verified：65,536 / 65,536 | 已验证 Codex/macOS 纵向闭环 |
  | OpenClaw `OpenClaw 2026.3.24 (af6f32f)` | 五工具；`schemaProfile=openclaw` 兼容投影，handler 仍用 canonical schemas | verified：65,536 / 65,536 | 安装/发现 smoke；完整重开、长期 Skill 与 uninstall 闭环待独立 E2E |
  | Hermes `Hermes Agent v0.9.0 (2026.4.13)` | 五工具；`schemaProfile=hermes` 兼容投影，handler 仍用 canonical schemas | verified：49,752 / 49,752 | 安装/发现 smoke；完整重开、长期 Skill 与 uninstall 闭环待独立 E2E |
  | Claude Code（版本未固定） | canonical 五工具与 schemas | fixture pending；未匹配时 `host_unsupported` | host-reopen 与容量证据待补 |

  表中的 OpenClaw/Hermes 数值只计入带 `schemaProfile`、`advertisedToolContractDigest`、`probeContractDigest` 的 `fixtureId ...-v2` 记录；旧的 `...-v1` 记录不可加载。只有 exact host/version、release、wire、canonical descriptor、advertised schema projection、projection digest、probe digest 与 serializer tuple 全部匹配时，OpenClaw/Hermes 才能进入 briefing；其中 projection/probe digest 是内部 fixture 元数据，不是 MCP wire 字段。未记录版本只能运行兼容安装/发现 smoke，不能写成可蒸馏或 successful fresh-install。
- 公开人物、创作者与私人联系人三种 source portfolio 都到达 traceable text、用户显式 file-ingest 的 raw-only、或 unavailable 之一；五工具路径不得声称自己保存 raw；
- CLI / Panel credentialed collection 只从 secret refs 解析凭据，Lark 中国/国际不跨区、DingTalk 消息历史零网络返回 `host_unsupported`、Slack 不越过 bot scope且尊重 provider limits / `Retry-After`、Xquik 每次使用有界 limit 和非持久 MeteredReadConsentPort 的直接用户确认；
- 同一 artifact 的多个表示不提高 eligible source count，unknown provenance 也不提高 stable；
- Step 9 的 Codex、Claude Code、OpenClaw 与 Hermes private UI capture 都明确 unavailable 并走粘贴/导出；未来 full binding 只有通过 §27.5 的授权、隔离、只读、前台与零截图留存拒绝矩阵后才可报告 available；
- Developer Preview 的源树与运行依赖不包含 browser / Playwright 私聊抓取，四个 full binding 也不注册 private-capture Controller；
- 恶意材料不能改变工具序列或获得 secret；
- actor、version id、claim id 与 quality 不能由模型输入；
- Panel 的 `/rpc` 覆盖完整 EngineMethodMap，`/sources` 覆盖 UserCollectionMethodMap，二者都双向 parse；所有 mutation 使用 token/route/method/requestId/params-bound 60-second one-use nonce；四个 POST endpoint 都要求 exact Bearer/Host/Origin；4 MiB request、16 MiB bounded response、16 KiB header/SSE frame、fixed static allowlist/symlink 与 CSP 拒绝全部通过；
- `POST /events` fetch stream 先 subscribe 再 ready/initial reads，无 replay；慢消费者、未知/超大 event 或断线都取消订阅并全量重读；
- plugin fresh install 不依赖 PATH 或 npx latest；
- canonical skill 两宿主内容 digest 相同；
- 没有 Catalog 登录、上传或 hidden sync；
- executor 未配置时完全不启动。

### 29.6 本文怎么演进

- 产品合同改变：先改 system-v3.md 并在 PR 中记录理由，再改实现。
- 只编辑 parent；生成 v3/，门禁拒绝 drift。
- 实现落地：同 change 更新 architecture.md、tests 与必要的操作文档；不把临时 task progress 写进 standing docs。
- §3.1 锁定项变化必须在 PR 中记录替代方案；§3.2 开放项关闭时写日期与结论。
- V1 / V2 只保留在 Git 历史，不为“保持一致”恢复到当前树。
- 平台能力变化优先改 HostBinding / distribution 章节；只有破坏 core contract 才升设计 major。
- 仓库外聊天、画布、未跟踪实验和模型记忆都不是规范来源。

### 29.7 设计完成与实现完成不是一回事

V3 完成表示实现者现在能找到：

- 用户闭环与失败语义；
- 每个 wire 字段与 engine-owned 字段；
- 包、文件、interface、纯函数与 concrete service；
- authority schema、transaction boundary、single-writer 并发和 WAL 恢复；
- Panel、插件 bootstrap 与安全边界；
- 未来 executor、关系、索引和 Catalog 的进入缝；
- 可观察的首发验收。

只有代码、真实入口测试、fresh install 和 architecture.md 同时证明这些行为，产品才算 shipped。

---
