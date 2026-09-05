> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 0. 怎么读、术语与合同边界

### 0.1 三条读法

**第一次理解产品：** §1 产品承诺 → §2 用户旅程 → §3 锁定项 → §4 信任边界 → §5 总体架构。读完应能解释为什么调研与蒸馏由宿主 LLM 完成，而事实、证据、版本与审核由本机引擎负责。

**准备实现一个纵向切片：** §3 确认没有重新打开锁定项 → §7 协议 → §8 五工具 → 所属机制章节 → §25 包与文件树 → §27 测试 → §29 落地验收。

**准备评审：** 先看 §3 的决策边界，再看 §4 的信任边界、§14 的 hard reject / suspended 分界、§27 的可执行证据。设计文本不是 shipped 证据。

### 0.2 精确词汇

| 词 | 本文含义 |
|---|---|
| **主体 subject** | 要记住的一个人或角色。同事、亲人、公众人物、虚构角色和使用者本人共用同一模型 |
| **self** | 使用者本人。是普通主体，不走特殊存储或蒸馏路径 |
| **空间 space** | 隔离同名人物和关系世界的命名边界。默认空间是 people；虚构人物必须明确作品空间 |
| **域包 domain pack** | 创建时打开哪些可选域的预设，不是人的类型 |
| **材料 material** | 一份已进入引擎的文本事实及其来源。网页、消息、文件、转写和 correction 都是材料 |
| **材料 id MaterialId** | 证据引用的稳定身份，由引擎根据来源身份、来源语义摘要与完整内容摘要生成 |
| **内容摘要 ContentDigest** | 完整 SHA-256，格式 sha256_ 加 64 位小写十六进制；不截短承担身份 |
| **材料集合哈希 MaterialSetHash** | 当前主体全部有效材料 id 与内容摘要排序后的完整 SHA-256 |
| **来源 provenance** | 材料的 URI、标题、提供方、外部 id、采集时间、发生时间和派生链 |
| **摄入 ingest** | 规范化、哈希、去重、落盘并按策略排队；它不自行产生人物判断 |
| **enqueue now** | 本批结束后立即形成可领取的蒸馏作业；它是产品语言中的“现在蒸”，不用让用户理解 flush |
| **作业 job** | 对一个主体、一个 base version 与一个材料 generation 的蒸馏任务 |
| **generation** | 同一主体材料快照的单调代次。lease 后又来新材料会产生新 generation |
| **lease** | 宿主领取 briefing 时取得的短期独占权；防止两个会话同时为同一 generation 付出模型成本 |
| **briefing** | 给宿主 LLM 的完整、类型化蒸馏输入：任务合同、基线画像、增量材料、短证据句柄、限制与 lease |
| **brief contract** | 一次 briefing 固定的 source-grouping、prompt 与 draft schema 版本；lease 和 commit 用完整摘要证明没有中途换规则 |
| **claim** | 一条有 facet、文本、证据与状态的人物判断。它是画像语义事实的最小单位 |
| **claim patch** | 宿主提交的 add / revise / supersede / contest 操作；未提及的现有 claim 默认保留 |
| **profile** | 某一版本的 active / contested claims 加确定性 Markdown 投影和质量摘要 |
| **current** | 当前 Recall 默认读取的版本 |
| **suspended** | 候选版本已经完整落盘，但因可审核风险没有替换 current |
| **hard reject** | 输入不满足安全或一致性合同，不能产出候选版本 |
| **review reason** | 引擎可机械给出的挂起原因，如身份变化、覆盖下降、 correction 冲突或新增 contested claim |
| **quality summary** | 引擎从证据、来源、覆盖和冲突复算的计数与成熟度；不是模型自评分数 |
| **correction** | 用户明确提供的高优先级材料；立即形成版本，并参与下一次增量蒸馏 |
| **事务权威 transactional authority** | SQLite/WAL 中决定主体、材料引用、claim、版本、指针、作业、事件与 RequestId 结果是否存在的结构化状态 |
| **内容 blob** | 由完整内容摘要寻址的不可变正文或 raw bytes；SQLite 中的引用决定其产品可见性 |
| **投影 projection** | 可从事务权威与 blob 重建的 Markdown、prompt、Library、queue/search/graph、SKILL 与宿主文件 |
| **投影水位 projection watermark** | 投影已经消费的数据库 generation / LSN；低于权威水位的投影只能重建，不能冒充最新事实 |
| **宿主 host** | 真正运行 LLM、浏览网页或读取文件的程序，如 Codex、Claude Code、OpenClaw、Hermes 或以后别的 agent |
| **绑定 binding** | 把中性 Distilly 工作流翻译到一个宿主真实能力和生命周期的薄层 |
| **EngineClient** | 所有门面到引擎的唯一类型化方法缝；进程内、MCP、面板 HTTP 共用同一方法表 |
| **本地面板 panel** | 首个可用版本必须交付的审核与证据界面；不是云端后台 |
| **插件源 plugin source** | 安装 manifest、skill 与本机 runtime 的分发来源；不是人物画像市场 |
| **Profile Catalog** | 以后显式发布和拉取公开画像 bundle 的远程产品；首版不存在 |

### 0.3 一句话架构

用户在宿主聊天里发起调研；宿主 LLM 浏览、理解并产出有证据的 claim patch；每个本地根只有一个 Engine writer，用一个 SQLite 事务提交结构化变化并引用不可变内容 blob，再异步重建人类可读投影；本地面板展示证据与风险；所有私人资料默认只留在用户机器。

---
