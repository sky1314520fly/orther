> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 3. 锁定项、开放项与 V2 取代关系

### 3.1 V3 锁定项

改变以下任一项，必须在 PR 中写清理由、被放弃的替代方案和可执行证据；不能只改代码或 generated chapter。

1. 主 UX 是 chat-first，本地面板负责可见性、证据与风险审核。
2. 面板属于首个可用版本，但 clean commit 不要求人工点击。
3. 默认零额外 LLM key；引擎不在默认路径调用模型。
4. 宿主 LLM 负责调研、语义抽取与 claim patch；引擎负责所有确定性状态变化。
5. 模型面固定五个名字：distilly_get、distilly_ingest、distilly_pending、distilly_commit、distilly_correct。
6. 首次创建通过 distilly_ingest 的判别式 subject target 完成，不增加第六个 create 工具。
7. “现在蒸”通过 enqueue = now 完成，不暴露 flush 工具。
8. distilly_pending 同时拥有 list / brief / renew / release；brief 是宿主取得材料的唯一合法入口。
9. briefing 原子取得 generation lease；同一 generation 同时至多一个有效 lease。
10. briefing 包含基线 claims、完整增量文本、来源、证据短句柄、prompt/schema 版本与限制；不让宿主私读内部目录。
11. briefing 不静默裁剪。首版超限显式失败；分块协议以后只能 additive 加入。
12. 宿主提交 claim patch，不提交 claim id、质量评分、版本 id、actor、关系操作或任意 core/domain Markdown；首个 commit contract 只有 claim operations，关系在后续独立 feature 以 additive contract 加入。
13. claims 是语义真相；Markdown 与 prompt 由固定 `profile-renderer-v1` 从完整 Profile 确定性生成。
14. MaterialId 与 ContentDigest 分开；ContentDigest 使用完整 SHA-256，EvidenceRef 引用 MaterialId。
15. commit 从 verified state、base version 与 material facts 重建 lease 固定的 EvidenceContext，并验证证据存在、主体归属、generation 集合成员关系和 quote / locator；不依赖可变的 briefing operation replay 来取得授权事实。
16. actor 由入口执行上下文决定，调用方不能伪装 user、host 或 executor。
17. “客观”表示证据受限、可复核、默认不重复调度；不承诺两个外部 LLM 逐字相同。
18. 新材料可以削弱旧结论；可审核质量下降进入 suspended，而不是假定置信度只能上升。
19. 不接受模型自报 profile confidence。质量摘要和成熟度由版本化纯函数复算。
20. 每个 `DISTILLY_ROOT` 恰有一个本地 Engine writer；MCP、Panel、CLI 与 Host binding 都只能经 EngineClient 调它，不能直接写持久化目录。
21. SQLite/WAL 是结构化状态、RequestId 幂等、事件与 current/suspended 指针的唯一事务权威；一次业务 mutation 恰对应一个 SQLite transaction。
22. 材料正文、raw 与其它大正文使用完整摘要寻址的不可变 blob；数据库引用决定可见性，未引用 blob 由通用 GC 处理，不进入 mutation-specific abort cleanup。
23. Markdown、profile、prompt、Library、queue/search/graph、插件与 JSON 导出是带 generation/LSN 水位的可重建投影或 export，不参与业务事务的 commit point。
24. Host capability 必须 preflight；没有某项能力就走显式 fallback。
25. 网页、文件和转写内容是不可信数据，不得改变 skill 的工具流程或获得 secret。
26. 本地产品无账号、无远程同步。远程 Profile Catalog 第二版以后单独设计。
27. 插件源、本地 Library index 和远程 Profile Catalog 是三个概念，接口与安全域不得混用。
28. 对外门面只有 Distilly + Person；扩展能力通过 interface 注册，不把具体宿主或厂商写进门面。
29. 所有公开方法异步；跨边界 JSON 使用判别联合与精确错误码。
30. 不导出公共 abstract class。外部扩展用 interface，纯算法用函数，有状态单实现用 concrete service。
31. 临时人格只进入当前 run / subrun；禁止改全局指令文件。
32. 第一版完整画像注入，放不下显式 context_too_large，不静默按显著度裁剪。
33. 第一批 Node 支持窗口固定为 `^22.19 || ^24`；改变窗口必须同时更新安装检查、CI 矩阵与插件 fresh-install fixture，未经验证的未来 major 不自动进入支持面。
34. 未来私人 UI capture 只能由可信 HostBinding 在第一帧前取得一次性、前台、精确范围授权；Developer Preview 的 Codex、Claude Code、OpenClaw 与 Hermes binding 都必须报告 unavailable，不创建 Controller，也不以 browser、Playwright、Computer Use 或截图读取私人消息。
35. Protocol 的 id/time/facet grammars、WIRE_LIMITS、JSON-safe error / EmptyResult 和五工具 descriptor registry 是跨入口合同；不得由 SDK、MCP、Panel 或 HTTP 各自放宽。
36. Developer Preview 当前可进入 briefing 的 verified-capacity tuple 是 Codex、OpenClaw `2026.3.24` 与 Hermes `v0.9.0`；Claude Code 和其它版本仍需各自真实 fixture。OpenClaw 与 Hermes 的容量记录来自隔离干净 home、固定 `openai-codex/gpt-5.4`、确定性的 synthetic fixture server，以及真实可执行文件、模型调用和 MCP transport；分别固定 65,536 与 49,752 serialized-byte 净预算。这是对应 transport/value probe 的保守 lower bound，不是任意模型或任意用户 session 的剩余上下文保证；宿主安装/发现 smoke 与 packaged fresh-install 是独立证据，不能互相替代。没有 exact handshake 或匹配 binding fixture 时，setup / doctor 只能报告兼容层健康，必须明确 briefing capacity 未验证，不得把它们报告为可蒸馏宿主或写入 successful fresh-install 宣称；其它宿主可以以后增加 binding。
37. Developer Preview 可以在 `@distilly/adapters` 内提供经过审核的 TypeScript SourceAdapter 与 MaterialParser；所有厂商凭据只通过 secret reference 解析，联网采集只能由用户在 CLI 或 Panel 显式发起，不能增加第六个 MCP 工具或把 secret 暴露给宿主模型。

### 3.2 仍开放

| # | 问题 | 当前边界 |
|---|---|---|
| A | Panel 的视觉技术栈 | 只能影响 packages/panel 内部，不能改变 RPC、事实归属或安全规则 |
| B | Codex / Claude Code 的公共目录能力 | 由 HostInstaller 与发布流程吸收；不能把本地事实改成云端事实 |
| C | Profile Catalog 的运营、真人同意和删除政策 | 未关闭前不得实现 publish |
| D | 首个 Bot 宿主 | 不阻塞核心发布 |
| E | 大型 briefing 的分块策略 | 首版 fail closed；未来必须保持 generation 与证据完整，不得假装全量 |

### 3.3 V2 哪些保留、哪些废弃

| V2 决定 | V3 |
|---|---|
| 本地事实、多主体、closed core + open domains、版本、correction、关系与瘦门面 | 保留并重述 |
| TypeScript、ESM、零第三方原生依赖、EngineClient 与 watch | 保留；首批 Node 支持窗口冻结为 `^22.19 || ^24` |
| 五工具是 get / ingest / pending / commit / correct | 保留名字，冻结可执行 wire shape |
| pending 只返回 id/hash/count，hostBriefing 只在引擎内部 | 废弃；pending brief 是正式 wire / facade 能力 |
| 模型同时提交 claims 与 Markdown | 废弃；只提交 claim patch |
| src_ + 八位十六进制承担材料身份 | 废弃；MaterialId 与完整 SHA-256 分开 |
| create 只在 SDK，模型无法从空仓开始 | 废弃；ingest 可带 create target |
| flush 只在 SDK，模型无法保证立即蒸馏 | 废弃；ingest.enqueue = now |
| actor 可由 CommitInput 提供 | 废弃；入口派生 |
| 材料只增，所以 profile confidence 理应只升 | 废弃；冲突材料可以降低质量并触发 review |
| 相同材料而外部 LLM 文字不同就是引擎 bug | 废弃；相同集合默认不重跑，显式重跑记录 executor 与 prompt |
| 面板第一版可以完全没有，TUI 可先做 | 废弃；薄审核面板是首发必要面，TUI 后置 |
| 一个 Git repo 就足够解决插件安装 | 废弃；必须有 runtime bootstrap、绝对 launcher、doctor 与版本握手 |
| 宿主包通过 symlink 共用 skill | 废弃；一个 canonical skill，由构建复制并做漂移校验 |
| 市场 browse / pull / publish 先占公共能力位 | 废弃；进入条件满足前不污染 SDK、MCP 或 panel 导航 |

---
