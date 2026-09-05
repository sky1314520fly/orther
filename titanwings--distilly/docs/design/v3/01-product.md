> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 1. 产品承诺、产品面与非目标

### 1.1 产品定义

**distilly 是一个 chat-first、local-first 的人物画像工作台。** 它利用用户已经在用的宿主 LLM 做语义工作，用本机确定性引擎保存可追溯事实，并让人通过面板审核高风险变化。

它不是“自带一个模型的记忆 API”，也不是“生成一次 Persona Markdown 的脚本”。真正的产品对象是主体、材料、claim、版本、修正和血缘。

### 1.2 首个可用版本的六个承诺

1. **零额外 LLM key。** Developer Preview 提供 Codex、Claude Code、OpenClaw 与 Hermes 的 binding，并使用宿主已有模型完成调研与蒸馏；只有具备 exact verified capacity evidence 的宿主才可进入 briefing。Distilly 引擎本身不调用模型。用户显式启用的来源适配器可以需要其来源系统凭据，但那不是模型 key，也不能进入模型上下文；OpenClaw `2026.3.24` 与 Hermes `v0.9.0` 的真实宿主 transport capacity 已分别由去敏 fixture 固定，未记录的版本或匹配失败的 tuple 仍必须 fail closed，不能伪造容量或成功蒸馏。
2. **本地事实。** 材料、画像、证据、版本与 correction 默认只在用户明确选择的 DISTILLY_ROOT。
3. **聊天发起。** 用户只需说“调研并蒸馏 X”；不先学习队列、哈希或 schema。
4. **证据可见。** 每条人物判断都能从面板回到确切材料和原文 quote。
5. **风险可审。** clean candidate 自动成为 current；身份、冲突或质量退化等风险进入 suspended，旧 current 不动。
6. **下一次可用。** commit 之后，下一次聊天可以 get / prompt 这份画像，或显式 install 到宿主。

### 1.3 产品面

| 产品面 | 第一版 | 以后 |
|---|---|---|
| 宿主聊天插件 | 必须；发起 research、ingest、briefing、commit 与 Recall | 更多宿主与更丰富的原生卡片 |
| 本地审核面板 | 必须；Library、Subject、Review、Settings | 关系图与本地高级搜索 |
| TypeScript SDK 与 CLI | 必须；通过同一个本地 Engine service 自动化、诊断与操作 | 额外语言客户端 |
| Profile Catalog | 不做；本地产品不登录 | 明确 publish / pull 的公开画像 |
| Bot 与 TUI | 不阻塞首发 | 共用同一 EngineClient 的额外脸 |

面板是首个可用版本的组成部分，但**不是每次 commit 的人工批准门**。把所有 clean 更新都变成点击确认，会破坏 chat-first；把所有风险都自动覆盖，又会破坏信任。

### 1.4 记谁

所有人：同事、朋友、亲人、公众人物、虚构角色和 self。差异通过空间、域和材料体现，不通过硬编码 PersonType 分叉。

### 1.5 明确非目标

- 不托管用户的私人画像数据库，不要求 Distilly 账号才能使用本地产品。
- 不在首版实现远程 Profile Catalog、关注流、社交关系或交易。
- 不把任意整段对话、思维过程或系统提示默认当人物材料。
- 不在引擎里绑定一家网页、消息或邮件厂商的官方采集 API。
- 不要求 embedding、rerank、OCR 或多模态云 key。
- 不把无法溯源的角色扮演文本伪装成客观画像。
- 不为假想后端设计通用 StorageProvider；首发只有一套 SQLite/WAL + immutable blob 本地实现。
- 不让模型、MCP、面板、CLI、binding 或插件直接写数据库、blob 根或投影；它们只能调用 EngineClient。

### 1.6 首发成立的定义

在干净机器上，不登录 Distilly、不给额外 LLM key，用户通过具备匹配 verified-capacity fixture 的宿主（当前 Codex、OpenClaw `2026.3.24` 或 Hermes `v0.9.0`；Claude Code fixture 待补）对一个公开人物完成：

research → ingest(enqueue now) → pending brief → host distill → commit → panel evidence review → next-chat get。

其中，briefing 的 verified-capacity 入口当前由 Codex、OpenClaw `2026.3.24` 与 Hermes `v0.9.0` 承担；Claude Code 仍等待自己的真实容量 fixture。OpenClaw/Hermes 的记录是在隔离 clean CLI home、固定 `openai-codex/gpt-5.4`、确定性的 synthetic fixture server 与真实宿主 executable/model/MCP transport 上完成的 transport-capacity 测试；它证明对应 probe 的净 briefing/tool-result 承载能力，不推断任意模型、任意用户 session 或完整 product runtime。容量证据不等于完整产品闭环：OpenClaw 与 Hermes 的安装、发现、重开和长期 Skill 生命周期仍须按下方 packaged fresh-install 验收单独证明；版本或 release tuple 不匹配时不扩大首发蒸馏宿主宣称。

缺少 create、briefing、证据 validator、fresh-install runtime 或 panel 中任意一项，都不叫首个可用版本。

---
