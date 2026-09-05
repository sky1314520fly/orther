> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 6. 存储权威、内容 blob、事务与恢复

### 6.1 本地根

`DISTILLY_ROOT` 是一个 Engine instance 的私有本地根。首发只有一套布局，不提供通用 StorageProvider：

~~~text
~/.distilly/
├── instance.json                 # bootstrap instance id、非 secret runtime 配置；非业务权威
├── store.sqlite3                 # SQLite/WAL 结构化事务权威
├── blobs/
│   └── sha256/
│       └── <prefix>/<digest>     # normalized material、raw、大正文；不可变
├── projections/
│   ├── profiles/                 # current profile Markdown / prompt
│   ├── library/                  # Library / search / graph read models
│   └── hosts/                    # installable skill / host files
├── exports/                      # 用户显式生成的人类可读 JSON / Markdown
├── backups/                      # 用户显式创建的完整本地 backup
└── runtime/                      # 单 Engine instance ownership 与本地 transport
~~~

SQLite 自己管理 WAL/SHM 等伴生文件；它们不是 Distilly 自造的 journal。除 Engine service 外，任何产品面都不得修改这里的数据库、blob 或投影。投影和 export 可以被用户复制、查看或删除；删除后只影响可用性，不改变权威状态。

### 6.2 数据所有权

**SQLite/WAL 是唯一结构化事务权威。** 它至少拥有这些逻辑关系；具体表名和索引属于 Engine-private storage schema，不进入 Protocol：

- spaces、subjects、aliases、identity hints 与 lifecycle；
- material/correction metadata、source、provenance、privacy、blob reference 与 subject membership；
- subject generation、material-set identity、pending job 与 lease；
- claims、evidence、claim status 与 version membership；
- immutable version metadata、parent / candidate-derived / rollback lineage、quality 与 renderer versions；
- current / suspended pointer 与 review status；
- operations：全局唯一 RequestId、method、trusted input/actor digest、stable result；
- events / outbox：同事务提交的审计事件与 watch invalidation sequence；
- projection watermarks、blob reachability / GC state 与 backup pins。

**Blob store 拥有不可变大 bytes。** normalized material/correction body、raw bytes、大型 briefing/result/import payload 或其它不适合行内保存的正文以完整 SHA-256 寻址。SQLite row 保存 digest、长度、媒体/编码元数据和语义归属。一个 blob 可以被多条材料引用；`MaterialId` 仍按冻结的来源、provenance 与内容语义派生，不能退化成 blob digest。

**Projection / export 不拥有业务事实。** profile Markdown、prompt、Library、queue/search/graph、host skill/plugin 文件和人类可读 JSON 都能从数据库与 blob 重建。每个可读投影携带 instance id、storage/renderer version 与 source generation/LSN；watermark 落后时必须重建或返回 `index_unavailable`，不能返回 clean-stale 数据。

### 6.3 确定性身份与不变量

以下是产品语义，不因存储改变：

- `ContentDigest`、`RawId`、`MaterialId`、`ClaimId`、`VersionId`、`MaterialSetHash` 继续由版本化 canonical preimage 和完整 SHA-256 产生；
- RequestId、SubjectId、SpaceId、JobId、LeaseId、EventId 等随机 id 继续使用已冻结 grammar 与可信 generator；
- evidence 必须引用同 subject、同 generation/version 可见的 material，并且 quote/locator 与 blob 正文匹配；
- immutable version 写入后不能原地修改；current、suspended、historical、rejected 是数据库中的明确状态与 lineage；
- 一个 subject 至多一个 current pointer、至多一个 active suspended candidate；pending job、generation、lease 与 material membership 必须一致；
- claims 是语义真相；profile Markdown 和 prompt 只由固定 renderer 从 version snapshot 生成；
- actor 来自可信 EngineClient session，不能由调用参数伪造。

SQLite storage schema 用 foreign key、unique、check constraint 和事务内显式验证维护这些不变量。完整 canonical hash、evidence quote 和业务 state transition 仍由确定性代码验证，不能把业务规则全推给 SQL constraint。

### 6.4 一次 mutation，一个 SQLite transaction

所有业务 mutation 先在事务外完成不需要锁住权威状态的工作，再进入一个短 SQLite write transaction 重新校验 preconditions 并提交全部结构化变化：

| mutation | 事务内原子变化 |
|---|---|
| create / ingest | identity conflict、subject/material reference、generation、pending job、operation/result、events |
| brief | pending/generation/base 校验、lease、brief contract/result、operation、event |
| renew / release | lease owner/expiry CAS、operation/result、event |
| commit | lease/evidence/base 校验、claims/evidence/version/membership、current 或 suspended pointer、清理 pending、operation/result、events |
| promote / reject | active candidate CAS、version status/pointer、pending rebase、operation/result、events |
| correction | correction material reference、replacement/supersession、new immutable version、candidate replacement、pointer、fresh pending、operation/result、events |
| rollback | historical target 校验、new immutable descendant、pointer、pending rebase、operation/result、events |
| archive / purge / import / redistill | 对应 lifecycle、membership、job、operation/result 与 events |

需要新增正文的 mutation 先在 blob 访问门闩下调用通用 BlobStore put，并保持该 lease 直到引用它的 SQLite transaction commit 或 rollback。Blob 完成后才可在 transaction 中引用；transaction abort 或进程退出只可能留下未引用 blob，不会留下半个业务状态。普通 read 先取得 shared blob-access lease，再打开一致 SQLite snapshot、读取直接需要的 digest，并保持该 lease 直到对应 bytes 已校验/交付。GC 取得 exclusive maintenance lease 后重新查询数据库引用、backup/export pin，只删除仍为零引用且没有 active put/read 的 blob；它不为 ingest、commit、correction、rollback 各造 cleanup/recovery。门闩只在当前 Engine 进程内存在，crash 后自然消失，不是新的 durable journal。

RequestId 在 operations 中全局唯一。事务先比较 method + canonical params + trusted actor/session fields 的 digest：相同请求返回 stable stored result，不再次写；同 RequestId 不同 preimage 返回 `idempotency_conflict`。不再用 request file lock 或 TransactionRecord 实现幂等。

### 6.5 Crash、并发、读取与审计

**Crash safety：** SQLite/WAL 决定 transaction committed 或未 committed，不做 application-level target/previous/third-state 猜测。Blob put 在数据库引用前完成；投影只在 commit 后消费 LSN。Engine 重启只需要打开/检查数据库、恢复 SQLite 自身 WAL、继续未完成 projection/outbox/GC 工作，不重放六类 mutation journal。

**并发：** 单 Engine writer 串行业务 mutation；数据库 constraint 和 transaction-time revision/generation/lease checks 防止 stale calculation。普通读可用 read transaction 获取一致 snapshot。不会为 request、space、identity、subject、Library 分别建立文件锁。

**普通读取：** 只验证本次返回直接使用的 row、关联约束、canonical id 和 blob digest/length。涉及 blob 的 read 必须先取得 shared blob-access lease，再取得数据库 snapshot，并持有该 lease 直到所需 bytes 已校验并交付；purge/GC 不得在该窗口物理删除。缺 row、dangling reference、SQLite integrity error 或缺失/错误 blob 都 fail closed。普通 profile/material/version/list 调用不枚举并重放整个 history。

**完整审计：** `system.doctor`、restore 和 bundle import 执行昂贵的全库验证：SQLite integrity/foreign keys、所有 deterministic ids、lineage DAG、current/suspended uniqueness、evidence quote、renderer output、blob reachability、projection watermark 与 backup manifest。完整历史审计能力必须保留，只是不放在每次热读取路径。

**Projection：** 业务 transaction 只提交 state 和 outbox/LSN。projection worker 幂等消费，写临时输出后原子发布 watermark 对应的完整投影。失败只让 projection stale/unavailable，不回滚已经提交的业务事实，也不需要 Library intent/dirty/reservation 或 queue dirty transaction simulation。

**Backup / restore：** 完整 backup 使用一致 SQLite snapshot、该 snapshot 引用的 blobs 和 versioned manifest；backup 期间用 pin 阻止 GC 删除这些 blobs。restore 在非 live sibling root 校验 schema、database integrity、全部 referenced blob digest、lineage 与 manifest，成功后才由 Engine maintenance flow 切换。现有 subject bundle 不是完整 store backup，二者不得混称。

**Privacy purge：** 数据库 transaction 原子移除产品可见引用并保留不含内容的幂等 tombstone，同时存入当次稳定 `PurgeResult`。若没有待删除的零引用 blob，result 为 `physicalDeletion="complete"`；否则为 `pending` 且 `pendingBlobCount` 是当次提交排入 GC 的 safe positive integer。generic GC 取得 exclusive blob-access lease、等待旧 read/put lease 释放、重新确认引用后物理删除。相同 RequestId 永远重放原始结果快照，不把后来完成的 GC 伪装成原事务结果；实时 pending/完成状态由 `system.doctor` 的 GC health 读取。CLI/Panel 必须显示 pending 和 doctor remediation，不能把逻辑删除冒充物理擦除。

### 6.6 Schema、权限与兼容

- SQLite storage schema、blob layout、projection format、bundle/export format 各自版本化；storage migration 只针对已经发布的 schema。
- 当前 V3 Engine 没有发布 runtime 或用户磁盘格式，因此首个 SQLite schema 从 v1 开始；不实现未发布 file-fact layout 的 dual-read、dual-write 或迁移器。
- 已发布的 legacy skill 目录仍是 `LegacySkillMigrator` 的真实 import source；它不使未发布 V3 文件布局获得兼容地位。
- root、database、blob 与 secrets 默认仅当前用户可读写。Engine 拒绝 blob/projection 路径逃逸与 symlink root；所有用户指定 export/restore path 在边界验证。
- database rows、SQL schema、WAL、GC records、projection checkpoints 和任何内部 persistence model 都是 Engine-private。公共 Protocol 不导出它们。

---
