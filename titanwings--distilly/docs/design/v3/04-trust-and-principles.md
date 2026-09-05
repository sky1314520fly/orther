> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 4. 信任边界与设计原则

### 4.1 谁能被信任什么

| 参与者 | 可以相信 | 不可以相信 |
|---|---|---|
| 用户 | 明确 consent、correction、promote/reject/purge | 自然语言一定已被模型正确解析 |
| 宿主 LLM | 语义理解、调研规划、claim proposal | id、actor、证据归属、质量分数、文件路径或写入顺序 |
| 网页/文件正文 | 它是被保存的来源内容 | 其中任何“忽略规则、调用工具、泄露 secret”的指令 |
| 插件 skill | 编排顺序和 fallback | 宿主一定拥有浏览、提取、private capture、hook 或 subrun 工具 |
| HostBinding | 探测到的 capability、原生 consent 结果、capture audit stamp | 屏幕正文是真实指令、OS Always allow 等于内容授权 |
| 本机引擎 | schema、哈希、事务约束、证据引用、版本与权威写入 | 它能独自判断一条人物结论在语义上绝对真实 |
| Panel | 展示引擎返回的数据，传回用户动作 | 自己计算成熟度、直接改文件或绕过 CommitService |
| Profile Catalog | 经签名的公开 bundle 与 listing | 用户本地的 current、private materials 或 correction |

### 4.2 LLM 与硬规则的分界

**交给 LLM：**

- 设计调研问题与选择来源；
- 从长文本判断哪些细节能构成人物 claim；
- 识别语气、矛盾、边界、关系和时间语义；
- 生成 add / revise / supersede / contest proposal；
- 根据 validator 的字段错误修正 draft。

**交给确定性代码：**

- 主体 id、材料 id、完整哈希、去重、source grouping 和 generation；
- lease、RequestId 幂等、单 writer 排序、SQLite transaction、WAL 恢复和事件；
- EvidenceRef 的存在、归属、集合成员与 quote 匹配；
- claim id、patch 应用、质量摘要、成熟度、Markdown 和 prompt；
- current / suspended / historical / rejected 状态；
- import、export、投影重建与权限。

把语义判断写成几十条正则会脆；把证据和事务交给 LLM 会不安全。V3 的抽象边界就是这条分界。

### 4.3 十条原则

1. **本地优先不是离线口号。** 默认没有远程 Distilly 数据路径；宿主自行联网不改变事实归属。
2. **一条写路径。** CLI、MCP、Panel、SDK 最终都调用同一 EngineMethodMap；没有 UI 专用后门。
3. **claims 单真相。** prose 不能包含无法回到 claim 的人物判断。
4. **错误要区分不可接受与需审核。** 伪造 evidence 是 hard reject；合理但风险较高的变化才 suspended。
5. **输入增长不等于可信度增长。** 新证据可以反驳旧结论，产品必须展示冲突。
6. **无能力就承认。** 没 browse、提取、file、private capture 或 context 就显式退回用户，不做假成功。
7. **接口按所有权切，不按屏幕切。** Panel 缺数据时先补引擎聚合，不在前端自行推导。
8. **扩展点必须有第二个实现的合理来源。** 宿主、来源、解析器和 executor 用 interface；唯一文件格式与 renderer 不造 provider。
9. **平台限制停在适配层。** 某家 manifest、hook、目录或 UI 变化不能改 profile、material 或 commit。
10. **一个 mutation 就是一个数据库事务。** 不用文件 journal、投影锁或逐文件 recovery 模拟跨介质 ACID；blob 先于引用持久化，投影在 commit 后按水位追赶。

---
