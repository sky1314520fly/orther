> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 23. 本地索引、Library 与以后检索

### 23.1 读模型职责

首发需要三类读模型：

1. pending/job/lease 直接来自 authoritative SQLite rows；它不是 disposable queue database；
2. Library 是 subject、status、quality、privacy、pending/suspended counts 与 bounded search terms 的本地 read model；
3. relation neighbor、全文或以后 embedding 可以使用可重建 graph/search projection。

读模型不保存唯一 material、claim、version、correction 或 pointer。Library 简单查询优先使用同库 SQL view/query，只有经过 profiling证明需要时才物化本地projection；不能先为抽象对称造第二份数据库。

### 23.2 Library 不是 Marketplace

Library 是用户机器上的本地视图。它回答“我有哪些人物、哪些待审”，不提供发布、购买、关注或云同步。文件名、类型和 UI 文案都使用 library，不使用 marketplace。

### 23.3 Projection contract

所有 materialized projection 使用一个通用 contract，而不是 queue/Library/graph 各造事务协议：

~~~ts
interface ProjectionWatermark {
  readonly instanceId: string;
  readonly projection: string;
  readonly schemaVersion: number;
  readonly sourceLsn: number;
}

interface ProjectionBuilder {
  readonly name: string;
  rebuild(snapshot: EngineReadSnapshot): Promise<ProjectionWatermark>;
}
~~~

- Engine 在业务 transaction 中递增/取得 commit LSN并写outbox；不写projection文件。
- builder读取一个一致SQLite snapshot及其LSN，在临时输出中构造完整新一代，成功后原子发布data + watermark。
- query比较projection watermark与数据库要求的minimum/source LSN。落后、missing、malformed或unsupported时重建或返回index_unavailable；绝不把旧内容当clean。
- 增量apply若实现，也只消费committed outbox并单调推进LSN；失败可丢弃projection后全量重建。
- projection不持有subject/business lock，不反向调用mutation，不参与RequestId result。
- JSON/SQLite/全文索引只是某个projection的内部格式，不进入Protocol或产品事实合同。

不再使用Library intent/dirty/reservation、queue dirty、projection-specific journal或跨介质terminalization。单Engine writer保证mutation顺序；watermark保证projection freshness。

### 23.4 Rebuild

顶层 `library.rebuild` 是显式维护动作：

1. 在Engine中取得一致read snapshot和source LSN；
2. 从authoritative subjects/status/version quality/job rows生成Library entries，按canonical sort tuple去重排序；
3. 若graph/search已启用，分别从同一或各自明确snapshot重建；
4. 原子发布每个完整projection generation及watermark；
5. 返回每阶段count与watermark。

多个projection不伪造共同ACID transaction。某阶段失败只让该projection unavailable；SQLite事实与其他已完成projection不回滚。业务mutation可在build期间继续提交；它产生更高LSN，刚发布的projection会立即被识别为stale并继续追赶或再次重建，而不是靠锁住所有subjects解决。

普通`library.list`若使用SQL view，直接在read transaction中执行；若使用materialized projection，则只读validated watermark对应的generation。两种实现必须产生相同排序、filter、cursor和LibraryEntry语义。

### 23.5 不做向量召回

首版单人物 Recall 读取完整 Profile，不需要 embedding。Library `text` search 固定为 query NFC normalization 后用 ECMAScript `toLowerCase()`，再对 subject displayName、aliases、space displayName、identity hint 的公开字符串与bounded searchTerms做substring match。结构化space/lifecycle/pending/suspended filter与text取交集。

只有真实出现“几千份公开bundle的语义发现”需求，才评估本地embedding；它仍是可删projection，不成为claim/material/version权威，也不要求云key。

### 23.6 未来全文索引规则

未来索引必须：

- stable id与当前路径分开；
- source LSN/generation而不是mtime决定freshness；
- 读路径只读，不顺手修权威状态；
- subject family/fictional space先硬分区，再排序；
- 不让关系、八卦与工作事实在一个无解释总分中相互顶掉；
- 删除projection后能从SQLite+blobs完整重建。

---
