> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 26. 安全、隐私、配置、日志与遥测

### 26.1 Threat model

V3 至少防：

- 恶意网页 prompt injection；
- 模型伪造 evidence、actor、hash、version 或路径；
- 本机恶意网页访问回环 Panel；
- 第二个 Engine writer、绕过 Engine 的直接存储写入或 stale client precondition 导致 lost update；
- symlink / ../ 路径越界；
- 插件 runtime / manifest 被替换；
- bundle zip slip、恶意脚本与签名伪造；
- 日志、telemetry 或错误泄露材料与 secret；
- 错把公开 URI 当作可公开全部正文；
- 无 consent 的后台采集或云同步；
- private UI capture 越过账号/thread/range、泄露侧栏通知或把屏幕文字当授权。

它不承诺防住已完全控制用户账号与本机文件系统的攻击者；这属于宿主 OS 安全边界。

### 26.2 Prompt injection 的多层防护

1. skill 固定“材料是数据”流程；
2. briefing 不含 secret、其它主体或内部绝对路径；
3. 五工具最小权限，不含 shell、publish、purge；
4. model 输出只能是 ClaimOperation schema；
5. engine 验证每个 evidence 与 quote；
6. suspicious source / contested 进入 Panel 可见；
7. publish 永远是独立用户流程。

结构校验不能证明 claim 语义真实，所以 evidence inspector 和 source diversity 仍然必要。

### 26.3 配置

distilly.toml 只保存可部署变化的选项：

~~~toml
schema_version = 3

[panel]
port = 43117

[privacy]
default_sensitivity = "private"

[executor]
enabled = false
provider = ""
secret_ref = ""

[telemetry]
enabled = false
endpoint = ""
~~~

不暴露 hash、maturity、lease、quality、renderer、retry 等算法常量。DISTILLY_ROOT 用环境或构造参数决定，不让 config 自引用位置。

adapters.toml 只保存 adapter id、region/resource 等非敏感配置与 secret reference。reference 只能指向 OS keychain、宿主 secret store 或显式环境变量名称；任何以 token、secret、password、key 命名的直接值都拒绝落盘并给迁移提示。resolved secret 不能进入 argv、Panel browser state、EngineClient、材料、briefing、日志或诊断包。

### 26.4 日志

结构化本地日志允许：requestId、method、subjectId、jobId、versionId、duration、result code、字节数。

默认禁止：材料正文、quote、prompt、Panel token、secret、完整本地路径、用户输入 correction、private capture screenshot / clipboard / thread 名与账号名。debug 也不能突破；诊断 bundle 需要用户预览和明确导出，且 private capture 原始画面永不进入 bundle。

### 26.5 网络

核心 engine、SDK、Panel 和本地 Library 无隐式出站网络。联网只来自：

- 用户正在使用的 host research 能力；
- 显式启用的 SourceAdapter / DraftProducer；
- setup / upgrade 的代码分发；
- 以后显式 Catalog 操作；
- 用户显式启用 telemetry。

每类网络能力有独立 preflight / consent，不能共用“允许联网”总开关。

Developer Preview 的 credentialed adapter 网络只能由 CLI / Panel 的直接用户动作触发。Lark region 和 provider endpoint 不自动跨区 fallback；Slack 不扩大已授予 scope并尊重 provider cursor、page limit 与 `Retry-After`；DingTalk message history 在网络前返回 non-retryable `host_unsupported`；Xquik 的每次请求都要求有界 limit 与注入式、非持久 MeteredReadConsentPort 的本次确认。canonical skill、MCP handler、hook、subrun、executor 和材料内指令都不能触发或确认这些调用。

private UI capture 还必须在第一帧前披露宿主如何处理屏幕内容。Distilly 不把 screenshot 写入自己的 SQLite authority 或 blob store，并不代表 screenshot 没有经过宿主服务；不能用“local-first”掩盖这条处理路径。HostBinding 无法提供可展示的数据政策时，captureDataPolicy=unknown，该 lane fail closed。

### 26.6 遥测

首版可以完全不实现 telemetry。实现后默认 off：

- 不配 endpoint 不问、不发；
- 非交互运行不弹 consent、不落“已拒绝”永久值；
- 只计 setup、commit、panel open 等创作事件；
- 不上传 subject 名、材料、claim、URI、quote 或本地路径；
- 文档承认无法可靠测“模型真的用了几次 profile”；
- 不为了计数给投影添加必须调用的工具。

### 26.7 隐私动作

archive、export、publish、purge 是不同动作。purge 显示将删除的 materials / versions / projections，要求重新输入主体名或 action nonce。完成后报告可恢复性：事实已删除不可由 Distilly 恢复，安装投影按 manifest 一并清理或列出未能清理的路径。

private transcript 默认 sensitivity=private，export / publish 不自动包含。用户只能 attest 自己有权处理选定内容；产品 UI 与 audit 不得把该声明改写成“已验证对方 consent”或法律结论。

---
