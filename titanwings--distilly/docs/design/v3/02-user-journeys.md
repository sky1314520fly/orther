> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 2. 七条用户旅程

### 2.1 新建一个公开人物

1. 用户说“调研并蒸馏 X，重点看表达和决策风格”。
2. 产品 skill 先用 distilly_get 按名字与空间解析；唯一命中则更新，多候选就询问，不命中则继续研究。
3. 宿主检查 webResearch 能力。可用则浏览；不可用则请用户给链接、导出或文件。
4. 第一批材料调用 distilly_ingest，并用 subject.kind = create 原子创建主体；之后使用返回的 SubjectId。
5. 每个采集到的文本表示形成一份材料，保留 artifact / representation、URI、标题、时间、载体、derivation 与正文；是否属于不同来源组由引擎判定。
6. 最后一批使用 enqueue = now，保证材料有变化时返回 job。
7. distilly_pending 的 action = brief 原子领取 lease 并返回 briefing。
8. 宿主 LLM 只输出 claim patch；distilly_commit 校验、渲染并产生 current 或 suspended。
9. 若 suspended，engine 返回 ReviewRef，MCP presenter 将它变成带本地 URL 的 ReviewLaunch；用户决定 promote / reject / correct。
10. 下一句可以 get 或 prompt。

### 2.2 更新已有画像

distilly_get 唯一命中后，研究新材料并 ingest。新 job 的 baseVersionId 指向 current，briefing 只带**新增材料 + 当前 claims**。宿主提交 patch，未提及的 claim 保留，因此第二次蒸馏不会因为模型漏写而删掉历史事实。

### 2.3 用户直接给文件

宿主有 localFileRead 与相应 document/OCR/transcription 能力时生成带 derivation 的文本材料；没有时 CLI 的 ingest-files 负责。图片、PDF、音频或视频可以先进入 raw，只有解析器或宿主生成了可追溯文本派生材料后才参与 briefing。

### 2.4 从私人一对一消息补充人物材料

用户说“把我和联系人 X 在这段时间里的对话转成材料”。Developer Preview 的 skill 明确说明它不会打开消息 app、浏览器或屏幕，并请用户粘贴/导出可读文本，或在 CLI / Panel 选择已经配置、实际 scope 允许的 Lark / Slack adapter。用户侧 collection 显示账号空间、conversation、subject、time range 与 limit，确认后由 user-bound EngineClient 调同一个 IngestService；完成后宿主再通过原有五工具领取 pending 并蒸馏。DingTalk 消息历史、未授权 channel、不可读附件和任何 browser / Computer Use 私聊抓取都明确 unavailable。未来 private UI capture 即使通过完整设计验收，也必须是独立版本能力，不能静默改变这条 Developer Preview 旅程。

### 2.5 用户纠正

用户说“这条不对，他从来不用这个称呼”。插件调用 distilly_correct。引擎保存带 relayed provenance 的 correction 材料，生成一条 user_asserted replacement claim，并把显式 targets 指向该 replacement 后产出 suspended 版本；Panel / CLI 的直接用户动作可在同一审核里确认或修正。这样模型不能仅靠误调用工具把自己的猜测记成 actor=user。

### 2.6 审核挂起版本

用户打开 Review：

- 看 current 与 candidate 的 claim diff；
- 展开每条 quote 与来源；
- 查看 review reasons；
- promote、reject、correct 或 rollback。

审核动作进入事件与版本血缘；reject 不删除候选历史。

### 2.7 Recall、临时注入与安装

- 临时人格：父运行 get / prompt 后，把完整中性画像放进这一次子运行。
- 当前聊天：宿主有 run-level instructions 时由 binding 注入。
- 长期发现：用户明确 install，生成宿主 skill 投影。
- 单文件身份：export 生成一个宿主格式文件。

任何路径都不修改项目全局 AGENTS.md、CLAUDE.md 或 agent.md。

### 2.8 失败时的产品语言

| 情况 | 必须怎么表现 |
|---|---|
| 同名多候选 | 列候选并问用户，不猜 |
| 宿主不能浏览 | 请用户提供材料，不假装调研完成 |
| 图片没视觉能力 | 提示用户用 CLI 显式文件导入来保存 raw；完成前只报 unavailable，不声称模型工具已保存 |
| 音视频没有字幕/转写能力 | 找发布者文字稿或请用户提供；否则 unavailable，不把 URI 当正文 |
| 私人 UI capture 不能证明 scope / 隔离 / 披露 | unsupported 或 refused；不截第一帧，不自动扩大到群聊/附件 |
| briefing 超上下文 | 显式 briefing_too_large，给出缩小范围建议，不裁剪 |
| lease 过期 | 重新 brief，不能带旧 token 强行 commit |
| lease 后来了新材料 | 旧 commit 返回 stale_job，新 generation 保持 pending |
| evidence 不存在或 quote 不匹配 | hard reject，不生成 candidate |
| 质量可审核下降 | suspended，旧 current 保持 |

---
