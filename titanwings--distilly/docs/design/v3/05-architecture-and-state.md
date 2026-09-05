> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 5. 总体架构、进程与状态机

### 5.1 六层

~~~text
用户意图       “调研并蒸馏 X” / “使用 X” / “纠正这条”
   │
产品面         MCP / Panel / CLI / SDK / Host binding
   │           只持 EngineClient，不打开持久化存储
   ▼
本地 Engine    每个 DISTILLY_ROOT 的唯一 writer
   │
确定性内核     normalize / evidence / patch / quality / ids / rendering
   │
事务权威       SQLite/WAL：state / claims / versions / jobs / operations / events
   │
内容与输出     immutable blob store + rebuildable projections / exports
~~~

Protocol 只定义产品方法与 wire。Engine 拥有业务规则和持久化。所有产品面是 client；它们可以与 Engine 同进程组合，也可以通过本地 transport 连接，但同一个 root 不得出现第二个 writer。

### 5.2 进程拓扑

每个 `DISTILLY_ROOT` 只有一个 Engine service 打开 SQLite 写连接并拥有 blob/projection 写权限。MCP stdio、Panel server、CLI、Host binding 和 SDK 都通过 EngineClient 调用它；它们不得 import Engine store、解析内部表或直接修改根目录。

首个客户端可以启动或取得该 root 的 Engine ownership，之后客户端只能 attach。第二个 writer 必须连接现有 owner 或以 `busy` / `permission_denied` 失败，不能退回文件锁竞争。instance ownership 只解决“谁是唯一 Engine service”，不承担 subject、request、Library 或 mutation 级业务事务。

Engine 可以有并发只读连接和后台 projection / GC 工作，但业务 mutation 由单 writer 串行进入数据库事务。长时间的宿主 research、LLM distill 和 UI 浏览不占用数据库写事务；它们在提交时以 generation、lease、current/candidate revision 再校验新鲜度。Blob put 到建立数据库引用的短窗口，以及从一致 read snapshot 读取 blob 的窗口，都登记在同一个 Engine-private 内存访问门闩中；read 必须先取得 shared lease、再打开 SQLite snapshot，GC 只在取得该门闩的独占 maintenance lease 后运行。

### 5.3 主路径

~~~text
host research / user files
        │
        ▼
Engine ingest
  normalize + put immutable blob
  one SQLite transaction:
  material reference + generation + pending job + operation + events
        │
        ▼
host brief / distill
        │
        ▼
Engine commit
  validate lease + evidence + patch
  deterministic claims + quality + VersionId + rendering
  one SQLite transaction:
  immutable version + pointers/status + operation + events
        │
        ├── clean ─────► current
        └── risky ─────► suspended ─► Panel promote / reject / correct
                                      each one SQLite transaction
        │
        ▼
projection workers advance their generation / LSN
        │
        ▼
next-chat get / prompt / explicit install or export
~~~

Blob writes may precede the transaction that references them. They do not make a material or version visible by themselves. The SQLite commit is the only business commit point; projections never decide whether a mutation succeeded.

### 5.4 状态机

~~~text
empty
  │ ingest
  ▼
pending(generation, job, no lease)
  │ brief
  ▼
pending(generation, job, active lease)
  │ commit current
  ▼
current(version)

current
  │ ingest / correction
  ▼
current + pending
  │ commit risky
  ▼
current + suspended(candidate)
  ├── promote ─► candidate becomes current
  ├── reject  ─► current unchanged; candidate remains historical/rejected
  └── correct ─► new current or new suspended derived from candidate

historical(version)
  │ rollback
  ▼
new immutable descendant becomes current
~~~

`lease expired → pending` 仍按读取时 clock 派生，不需要 timer。`suspended` 是完整不可变版本；它只是不作为 Recall 默认值。SQLite 内的 pointer/status 行必须在同一事务中保持唯一 current、至多一个 active suspended 和 generation/job 一致性。

### 5.5 新材料与旧 lease

新 material 或 correction 改变 material generation。任何针对旧 generation、旧 material set、旧 current/candidate revision 或旧 lease 的 commit 都返回 `stale_job` / `lease_*`，不能覆盖新状态。Engine 可以在事务外准备 deterministic candidate，但进入写事务后必须重新检查这些 preconditions。

### 5.6 事件与 watch

业务事件与 operation/result 在同一个 SQLite transaction 内提交。watch 只发送 content-light invalidation；订阅丢失、进程在通知前退出或客户端重连都只要求重新读取，不会丢掉权威事实。实现可用同库 event/outbox sequence 追踪通知进度，但不得为 watch 再造独立业务事务或跨介质 recovery。

---
