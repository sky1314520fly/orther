> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 21. 可选后台 DistillExecutor

### 21.1 不属于首发默认路径

首发只有宿主 LLM。后台 executor 只有用户明确配置 provider 与 secret reference 后才启动；没有配置时不提示、不轮询、不创建网络请求。

DistillExecutor 只能处理已经由 Engine 提交的 material。它永远不能请求 private UI grant、调用 Computer Use、重开消息 app 或在 background / locked session 采集屏幕；即使宿主平台本身支持这些模式，Distilly 的产品合同也更窄。

### 21.2 DraftProducer

~~~ts
export interface DraftContext {
  readonly executorId: string;
  readonly model?: string;
  readonly promptVersion: string;
}

export interface DraftProducer {
  readonly id: string;
  preflight(): Promise<PreflightResult>;
  produce(
    briefing: HostDistillBriefing,
    context: DraftContext,
  ): Promise<DistillPatch>;
}
~~~

宿主路径可以用一个 HostDraftProducer adapter 表达，但引擎不会调用它；canonical skill 在宿主外层完成 produce。后台 worker 是 EngineClient 的消费者：

pending list → brief lease → producer.produce → commit。

它没有 store、DraftValidator 或 CommitService 的私有引用。

### 21.3 进程与失败

后台模式需要独立 distilly worker 命令或受宿主管理的 process；不隐藏在普通 CLI 调用里。它必须定义：

- start / stop / status；
- 单实例 owner id 与健康时间；
- provider auth、rate limit、timeout、context 与 schema failures；
- lease renew 与 shutdown release；
- retryable backoff 上限；
- prompt / model metadata；
- 日志脱敏；
- 与 Panel / MCP 并发时由同一 Engine writer 排队和 revision check 的行为。

认证、非法 schema、briefing_too_large 是人工修复；限流和瞬时网络失败可重试。重试不换 generation 或偷偷降模型。

### 21.4 Secret

distilly.toml 只保存 secret reference，不保存 key 值。实现优先宿主 secret store / OS keychain，其次显式环境变量。doctor 只报告存在与权限，不打印值。

### 21.5 一个提交口

后台 executor 与宿主 LLM 经过完全相同的 briefing、evidence validator、QualityGate、transaction 和 Panel review。为性能新增第二条“trusted commit”是禁止项。

---
