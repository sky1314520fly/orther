> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 19. CLI、setup、插件包与分发

### 19.1 CLI

~~~text
distilly setup --host codex|claude-code|openclaw|hermes
distilly doctor [--host <host>]
distilly upgrade [--version <version>]
distilly uninstall --host <host>

distilly mcp
distilly panel [--port <n>]

distilly source list
distilly source configure <adapter>
distilly source collect <adapter> <subject> [--limit <n>] [--confirm-billable-limit <n>]

distilly create --name <name> [--space <space>]
distilly ingest <subject> <path...> [--enqueue auto|now]
distilly pending [--subject <id>]
distilly distill <job> --draft <file>
distilly get <subject> [--format profile|prompt|status]
distilly correct <subject> --text <text> [--facet <facet>]
distilly archive <subject>
distilly purge <subject> --confirm <exact-display-name>

distilly review [--version <id>]
distilly promote <version>
distilly reject <version> --reason <text>
distilly rollback <subject> <version>

distilly install <subject> --host <host>
distilly export <subject> --host <host> --dest <path>
distilly backup --dest <path> [--overwrite]
distilly restore --from <path> --confirm <manifest-digest>
distilly migrate --from <legacy-skill-dir>
~~~

CLI 只解析、组合 EngineClient、格式化结果和退出码。测试调用真实 binary entry，不直接测 private command helper 代替。上表是 production CLI 的最终命令面，不允许早期 slice 注册一组会对数据命令返回“尚未实现”的占位 shell。repo-local Developer Preview 暴露 `setup --host codex|claude-code|openclaw|hermes`、`doctor`、`uninstall --host ...` 与 plugin-owned `mcp --host ...`；Codex、OpenClaw `2026.3.24` 与 Hermes `v0.9.0` 在匹配 fixture 时可进入 briefing，未知版本或缺证据时 setup 在写入宿主配置前返回 `host_unsupported`。其它数据命令在 §29 production composition slice 落地前不进入 help 或稳定 exports。

`source configure` 只保存非敏感配置与 secret reference；需要新建 keychain secret 时使用 TTY 隐藏输入，不接受明文 secret flag。`source collect` 先显示 adapter、resolved subject、resource、time range 与 limit，再由直接用户动作执行；非交互 Xquik 调用还必须给出与 `--limit` 数值相同的 `--confirm-billable-limit`，缺失或不一致时在解析 secret 或发网络请求前失败。source 子命令不注册成 MCP tool，也不允许 canonical skill 用 shell 权限替用户绕过确认。

`backup` / `restore` 只通过 `LocalRuntime.administration()` 取得同一 root owner 的 `EngineAdministrationClient`，不是复制内部目录的 shell shortcut。backup destination 默认 create-exclusive，只有显式 `--overwrite` 才可替换一个已验证为 Distilly backup 的目标；restore 的 confirmation 必须逐字等于先检查所得 manifest digest。restore 进入 maintenance、让普通 client 停止新调用、在 sibling root 完成验证与切换，CLI 只在新 authority 已重新打开后报告成功和保留的 previousRootPath。

setup/doctor/upgrade/uninstall 是安装 composition 命令；mcp 创建 kind=host 且由 binding capacity 绑定的 client；panel 与其余数据命令各创建一个 kind=user client。每次 connect 都由 engine 生成新的 LeaseOwnerId，flag、环境变量和模型输入都没有 owner override。direct CLI user client 固定使用下述 sdk_explicit capacity；每个 mutation 顶层动作生成一个新的 RequestId，并只在该动作的 transport retry 内复用，绝不把一个 RequestId 跨 method 复用。`purge --confirm` 必须逐字等于 resolve 后 SubjectRecord 的 exact displayName，再作为 PurgeSubjectInput.confirmation 传入；ambiguous selector 在显示候选后退出，不能自行选中。CLI 必须逐字段显示 PurgeResult；`physicalDeletion="pending"` 时明确显示 pendingBlobCount 与 `distilly doctor` remediation，不能打印“已物理删除”。`uninstall --host` 只移除 host plugin/bootstrap，不等于 Person.uninstall 的某个 profile projection；首版 CLI 不为后者另设隐含重载。

`distilly distill` 是一个前台、单 EngineClient session 的 brief→编辑→commit 命令。它 attach 到该 root 的唯一 Engine service，取得 lease 后以 create-exclusive 创建仅当前用户可读的 draft envelope（POSIX mode 0600；Windows 用 current-user-only ACL），保持同一 client 与 engine-owned LeaseOwnerId 存活，把文件路径和明确的“编辑完成后确认/取消”提示交给用户，并在确认前按该 session 的 lease 做 renew。确认后它重新读取同一文件，验证 snapshot 未改、解析 DistillPatch，再用内存中的同一 lease owner 和一次生成后复用的 commit RequestId 调 distill.commit。成功后删除 envelope；用户取消、schema 失败或正常 shutdown 时先 best-effort release 再删除；CLI 退出只依靠 expiresAt，不伪造 release，也不关闭仍供 MCP/Panel 使用的 Engine service。

CLI-owned draft envelope schemaVersion=1，包含 `briefing`（HostDistillBriefing 去掉唯一字段 `lease.owner`）、一个初始空 `patch` 槽和 content-free `snapshotDigest`；digest 覆盖去 owner 后的完整 briefing，所以 jobId、generation、leaseId、briefContractDigest、materialSetHash、baseVersionId、材料、短 evidence refs、prompt、限制和 expiry 任一改动都被拒绝。LeaseOwnerId 只留在当前 EngineClient session 内，绝不写入 envelope、flag、环境变量或重连 token。用户手写的裸 DistillPatch、已有文件、非 regular file、symlink、owner/mode 不安全的 envelope 与 snapshotDigest 不匹配都在 commit 前拒绝。CLI direct session 的 BriefCapacity 固定为 source=`sdk_explicit`，maximumInputTokens=4,194,304、maximumToolResultBytes=4,194,304；这只是本地文件上限，不声称外部模型拥有同样 context。

禁止把 brief 与 commit 拆成两个短进程后把 `--lease` 当作恢复权限：每次 connect 都必须生成新 LeaseOwnerId，第二个进程即使知道 LeaseId 也只能得到 lease_conflict。以后若要非交互分离流程，必须设计 engine-issued、可撤销的 delegation capability；不得把 owner 放进文件来绕过 §7.4。

### 19.2 Setup 不能依赖 PATH 运气

npx distilly@VERSION setup 是最终 bootstrap 入口，只有 complete EngineRuntime、LocalRuntime、production CLI/MCP composition、Panel presenter 和 correction 都已落地后才发布。发布前的 `0.1.0-preview.1` 包支持 macOS/Linux、已有真实容量证据的 Codex exact version、OpenClaw `2026.3.24` 与 Hermes `v0.9.0`，以及当前 release manifest；它从 production build output 组装无 symlink、无 workspace source/dependency、无测试 fake 的自包含 runtime，setup 校验逐文件 digest 后原子复制到 `~/.distilly/runtime/<version>/`，再写指向该副本的绝对 launcher。package assembler 的强制重建只能在新 staging 包完成后替换仍通过完整 manifest/digest 校验的旧 Distilly artifact；普通目录、symlink 或已被修改的输出一律保留并失败，不能对任意 `--output` 递归删除。解压目录删除后 doctor、MCP、Panel、人物 Skill 安装和 uninstall 仍从版本化副本运行。它不开启 upgrade；Claude Code 与未记录版本保留 full binding，但在取得 exact capacity evidence 前不进入 CLI 的 verified briefing 可用面。OpenClaw/Hermes 的安装 smoke 与真实容量 fixture 分开，Hermes 也不引入 Python plugin。两种 setup 均遵循下列目标；真实 initialize/tools/list 由 packaged fresh-install E2E 验证而非伪造 setup 成功：

1. 检查 Node、平台、目标宿主与写权限；
2. 把精确版本 runtime 安装到 ~/.distilly/runtime/<version>/；
3. 生成 ~/.distilly/bin/distilly launcher，记录 Node executable 与 package entry 的绝对路径；
4. 调用 HostBinding.installPlugin，生成指向 launcher 的 MCP 配置；
5. 安装由 release assembler 生成的 manifest、canonical skill copy 与支持的 hook；
6. 运行真实 MCP initialize + tools/list +只读 health smoke；
7. 写安装 manifest，显示是否需重开宿主会话；
8. 运行 doctor 并给出逐项结果。

禁止把 .mcp.json 写成裸 distilly mcp 后假设全局 npm bin 已进 PATH；也禁止每次启动静默 npx latest。

### 19.3 版本握手

PluginInstallManifest 是 production setup 写入 `~/.distilly/` 的机器级安装记录，记录 pluginVersion、engineVersion、wireMajor、promptVersion 与 launcher digest；它不是业务 authority，也不是 source tree 的 `plugins/release-manifest.json`。MCP initialize 暴露 server version；canonical skill 的 minimum / maximum wire major 与 engine 握手。

- major 不兼容：拒绝工具调用并给 upgrade / rollback 命令；
- plugin patch 落后但 wire 兼容：doctor 警告，不阻塞；
- runtime digest 变化：doctor 报安装损坏，不静默重装；
- upgrade 先安装新 version、smoke 通过后原子切 launcher；旧 runtime 保留一个 rollback window。

### 19.4 插件文件树

MCP 包只接收已经绑定 host actor、engine-owned LeaseOwnerId 与 capacity 的 EngineClient；它不 import engine、store 或 Panel：

~~~ts
export interface McpServerOptions {
  readonly client: EngineClient;
  readonly reviewPresenter: ReviewPresenter;
  /**
   * Optional advertised-schema projection for hosts that cannot consume the
   * canonical JSON-Schema dialect. It never changes handler validation.
   */
  readonly schemaProfile?: "openclaw" | "hermes";
}

export interface McpServer {
  close(): Promise<void>;
}

export declare function createMcpServer(options: McpServerOptions): McpServer;
~~~

McpServerOptions.client 在进入 mcp 包前已经由外层 composition 绑定 host actor、engine-owned LeaseOwnerId 与 BriefCapacity；MCP handler 不接收或推测这些值。McpServerOptions 故意没有 capture client/token：普通 handler 不能提权。受支持 binding 在同一 host session 旁路注册 §17.2 的 user-gesture private capture action；action 由 runtime coordinator 持有 engine core capture session，完成后只把 PrivateUiCaptureActionResult 送回当前 task。它不改变 MCP initialize、tools/list 或五个 handler，普通 distilly_ingest 也不会根据模型字段“升级”为 capture session。

McpServer 借用而不拥有 options.client 与 reviewPresenter。close 幂等，只拒绝新 call、在同一 5,000 ms grace period 内等待已进入的 handler、取消 server 自己建立的订阅并关闭 MCP SDK server；外层 transport adapter 拥有其 transport，server close 只要求 SDK 的 transitive transport close 可重复。它不调用 EngineClient.close、PanelLauncher.close 或 LocalRuntime.close。production composition 的 teardown 顺序是 stop accepting → transport/McpServer.close → ReviewPresenter.close（若具体 presenter 拥有该方法）→ EngineClient.close → LocalRuntime.close。

@distilly/mcp 根只定义 transport-neutral server；Node stdio 只从 @distilly/mcp/stdio 导出：

~~~ts
export declare function runStdio(server: McpServer): Promise<void>;
~~~

runStdio 为传入 server 创建并拥有唯一 stdio transport，不创建 client/runtime。stdin EOF、transport close、SIGINT/SIGTERM 的 graceful path 与显式 close 都汇合到同一个 idempotent teardown；transport onerror 必须立即触发同一有界 teardown，不能只记录后继续等待 stdin EOF。runStdio 的 finally 总是先幂等关闭 transport、再调用 McpServer.close；它不关闭 process-owned stdin/stdout，也不替 composition 关闭 injected EngineClient、reviewPresenter 或 runtime。正常 close 完成后 runStdio resolve；启动、协议或 transport error reject，但也先完成同一 bounded teardown。grace period 固定 5,000 ms，从 stop-accepting 时开始；到期后不再等待 in-flight handler，完成 transport/server 自有资源关闭并让 runStdio settle。原始 startup/protocol/transport error 优先于 teardown error；无原始 error 时，close error 或 timeout 使 runStdio reject。该常量由 mcp stdio 实现拥有并用 fake clock 固定测试，不能由模型输入控制。

MCP initialize 的 serverInfo.name 固定为 `distilly`，serverInfo.version 来自 `@distilly/mcp` 构建时写入并由 package.json 与发布 manifest 同源的精确 semver；不从 cwd、全局 CLI、latest tag、clientInfo 或 wire major 猜版本。tools/list 的五个对象、顺序、name、title、description 与 annotations 始终来自 protocol 的 `distillyMcpTools` 唯一 descriptor source。Codex/Claude Code 直接公告 canonical input/output schema；OpenClaw/Hermes 通过 `schemaProfile` 只对 advertised schema 做兼容投影（解析本地 `$defs`、移除不被宿主接受的 dialect 元数据、把根 union 展平为 object），不改变五工具数量、语义或 canonical `toolContractDigest`。每个 profile 的完整公告 descriptor 集合另计算 `advertisedToolContractDigest`；真实容量记录还绑定不含模型秘密的 `probeContractDigest`，以防只改 projection 或 probe 文本却复用旧证据。两者都是 release/fixture 内部校验值，不是额外 MCP 字段。所有 tools/call 仍在 handler 边界用 canonical RuntimeSchema 验证，投影不是放宽输入的旁路。

handler 把 WireRequest.requestId 原样作为 MutationContext 传入 client；SDK facade 自己生成 requestId 时，在同一次网络重试中复用。commit handler 还必须把 CommitToolInput.briefContractDigest 原样放进 CommitInput，不能丢弃或以 server 当前默认合同替代。commit 得到 suspended CommitResult 后调用 reviewPresenter；correct 的 engine result 按 actor 合同必为 suspended。presenter 对两者都只把 ReviewRef 变成 ReviewLaunch 并放进 ToolValue，不设置 reason、不改变 current / suspended。presenter 返回的 launch.ref 必须逐字段 exact 等于传入 ReviewRef，ReviewLaunch URL route 也必须编码同一 ref；任一 mismatch 按 internal_error fail closed，不能把另一个 candidate URL 放进成功结果。没有 presenter 的 development server 不得声称完成首发插件闭环。

每个 tools/call 使用同一封闭流水线：先用 descriptor.input 解析 unknown arguments；再把 action 映射到 §8.7 的 EngineMethodMap；将 expected domain error、输入错误、presenter/adapter failure与真正 unexpected exception 分别归一为最窄 DistillyWireError（unknown 仅用脱敏 internal_error）；构造 WireSuccess 或 WireFailure 后，最后用该 descriptor.output 解析整个 ToolOutput。若成功候选没有通过 output parser，丢弃它并改成脱敏 internal_error WireFailure，再对该 failure 做最后一次 output parse；不能把 Zod/MCP SDK exception、stack 或第三种 JSON 泄漏给模型。MCP 自己生成的 internal_error 精确为 `{ code: "internal_error", message: "The Distilly MCP adapter encountered an unexpected internal error.", retryable: false }`，没有其它字段；presenter ref/route mismatch、correct 意外返回 current、unclassified exception 和 invalid success output 都走这一形状。可校验的 DistillyError 保留原最窄 wire error；invalid arguments 则生成 retryable=false 的 invalid_input，而不是 internal_error。

解析后的 ToolOutput 是唯一结果值。MCP CallToolResult 精确使用 `structuredContent: parsedOutput` 与 `content: [{ type: "text", text: JSON.stringify(parsedOutput) }]`；content text 解码后必须与 structuredContent 深相等。domain、invalid_input、presenter failure 与 unexpected 都作为正常的这份 structured WireFailure 返回，不依赖 MCP SDK generic `isError` / JSON-RPC error 承载产品错误。只有 transport 在连一份合法 WireFailure 都无法序列化时才允许协议级失败。

MCP 包自己的 stdio conformance smoke 仍由 test-only child 注入覆盖全部 EngineMethodMap 的 deterministic fake EngineClient 与 fake ReviewPresenter，以隔离验证 descriptor、handler、envelope 与 transport 生命周期。CLI built smoke 从真实 binary 执行 Codex setup，并对未知/未记录的宿主 tuple 保持 fail-closed，经安装后的绝对 launcher 启动 plugin-owned `mcp --host ...`，在真实临时 `~/.distilly` SQLite root 上完成 initialize 与恰好五个 tools/list，再执行 uninstall 并验证 root 数据保留。独立的真实宿主传输容量 verifier 分别运行 OpenClaw `2026.3.24` 与 Hermes `v0.9.0` 的实际可执行文件，在隔离 clean home 中以固定 `openai-codex/gpt-5.4` 调用确定性的 synthetic fixture server；它检查对应 `schemaProfile` 的 probe 工具调用、完整 structured/text duplication 与两个模型可见尾标，最后只写入去敏的 normalized fixture（净预算分别为 65,536 与 49,752 serialized bytes）。这是真实 host executable/model/MCP transport 的证据，不是真实产品 Engine、用户材料或所有模型/session 的保证；fixture 同时保存 canonical、advertised projection 与 probe contract 的 digest。Codex packaged fresh-install E2E 另从 production bundle 在含空格和非 ASCII 的临时路径 setup，删除解压目录后用官方 Codex listing 与 MCP client 验证 release/server/五工具，完成 create→ingest→brief→commit→prompt→correction→Panel promote→显式人物 Skill install→新 Codex 进程发现，并证明 Plugin uninstall 删除 runtime/plugin 但保持 SQLite 与人物 Skill byte-identical。OpenClaw/Hermes 的安装/发现 smoke 另外验证 bundle/managed Skill、wrapper、config 与五工具 discovery；容量 fixture 是独立证据且只对记录的版本、release、canonical descriptor digest、advertised schema profile、projection digest、probe digest 与 serializer 生效。该组测试证明 `0.1.0-preview.1` Codex Preview 与 OpenClaw/Hermes 的真实宿主传输容量接线，不证明跨进程共享 writer、Claude activation 或 production upgrade。

~~~text
plugins/
├── release-manifest.json                # assembler 生成；repo release contract
├── shared/
│   └── skills/
│       └── distilly/
│           ├── SKILL.md                 # 唯一 canonical orchestration
│           ├── references/
│           └── assets/
├── codex/
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json.template               # production setup input；不可安装
│   ├── hooks/
│   └── skills/distilly/                 # assembler exact mirror
├── claude-code/
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json.template               # production setup input；不可安装
│   ├── hooks/
│   └── skills/distilly/                 # assembler exact mirror
└── fixtures/
~~~

canonical skill root 精确为 `plugins/shared/skills/distilly`。tree walk 递归包含其下每个 regular file，包括 SKILL.md、references 与 skill-local assets；空目录不进入 digest，root 内任何 symlink、socket、device 或其它非 regular file 都拒绝。relative path 必须是无前导 slash、反斜杠、NUL、空 segment、`.` 或 `..` 的 UTF-8 POSIX path，并按 path 的 UTF-8 bytes 严格升序。每项精确为 `{ path, contentDigest }`，其中 `contentDigest = "sha256_" + SHA-256(rawFileBytes)`；assembler 不做 LF、Unicode、frontmatter 或 Markdown normalization。canonical tree digest 固定为：

~~~text
"sha256_" + SHA-256(
  "canonical-skill-tree-v1\0" +
  canonicalJson(sortedFiles)
)
~~~

assembler 把 canonical root exact-mirror 到 `plugins/codex/skills/distilly` 与 `plugins/claude-code/skills/distilly`：创建缺项、逐 raw byte 覆盖漂移项，并删除目标中 source 不存在的 stale file/empty directory；目标路径也不得穿过 symlink。完成后两个 target 重新 walk 得到与 canonical 完全相同的 file tuple 与 tree digest，否则 assembly 失败。canonical SKILL.md 的 frontmatter name 固定 distilly；宿主差异只在 target manifest/hook，不能在两个 skill copy 中插入条件化 bytes。

`plugins/release-manifest.json` 的 schemaVersion 固定 1，exact shape 是：

~~~ts
export interface PluginReleaseManifestV1 {
  readonly schemaVersion: 1;
  readonly releaseVersion: string;
  readonly wire: {
    readonly minimumMajor: 3;
    readonly maximumMajor: 3;
  };
  readonly canonicalSkill: {
    readonly root: "plugins/shared/skills/distilly";
    readonly digest: `sha256_${string}`;
    readonly files: readonly {
      readonly path: string;
      readonly contentDigest: `sha256_${string}`;
    }[];
  };
  readonly targets: readonly {
    readonly host: HostName;
    readonly pluginRoot: string;
    readonly pluginManifestPath: string;
    readonly pluginManifestDigest: `sha256_${string}`;
    readonly skillRoot: string;
    readonly skillDigest: `sha256_${string}`;
  }[];
}
~~~

releaseVersion 是无 `v` 前缀的 exact SemVer，唯一来源为 `packages/mcp/package.json.version`；Codex 与 Claude Code plugin.json 的 version、MCP serverInfo.version 与 release manifest 必须逐字相同。canonicalSkill.files 使用上述 path order。targets 固定按 HostName UTF-8 bytes 排序，且只有下列两个 exact entry：Claude Code 为 `pluginRoot=plugins/claude-code`、`pluginManifestPath=plugins/claude-code/.claude-plugin/plugin.json`、`skillRoot=plugins/claude-code/skills/distilly`；Codex 为对应的 `plugins/codex`、`plugins/codex/.codex-plugin/plugin.json`、`plugins/codex/skills/distilly`。OpenClaw 与 Hermes 不新增 release-manifest target：OpenClaw 在安装时复用 Claude-compatible bundle，Hermes 在安装时复用 `plugins/shared/skills/distilly`。每个 pluginManifestDigest 对 assembler 写入 version 后的 manifest raw bytes 计算，每个 skillDigest 必须等于 canonicalSkill.digest。manifest 不允许额外字段，以 §6.3 compact canonical JSON 加唯一尾 LF 写出；check mode 在临时目录重算全部 outputs并做 raw-byte diff。

Codex 的 discovery manifest path 固定 `.codex-plugin/plugin.json`，Claude Code 固定 `.claude-plugin/plugin.json`；manifest 中出现的 component path 必须相对 plugin root 并带 `./` 前缀。两家的 `.mcp.json.template` 都只是 source-assembly fixture，必须包含 sentinel `__DISTILLY_LAUNCHER_ABSOLUTE_PATH__`，不得被 platform plugin manifest、release manifest target、runtime bundle 或 installable archive引用；source release tree 单独存在时因此不声称可启动 MCP。full HostBinding 不读取或替换模板内容，而只在 owned install tree 中根据受信 absolute launcher 直接生成宿主实际读取的 `.mcp.json`，Codex companion shape 为 `{mcpServers:{distilly:{command,args}}}`，参数固定 `mcp --host codex`；Claude Code 使用同一顶层 companion shape 与自己的固定 host 参数。OpenClaw 读取同一 Claude-compatible bundle，但把 `.mcp.json` 写在 `~/.openclaw/extensions/distilly` owned tree，并只用 `openclaw plugins inspect` 验证 bundle/MCP discovery；它不通过全局 MCP entry 接管用户配置。Hermes 不读取 plugin manifest 或 sentinel template，而把 canonical Skill 安装到 `~/.hermes/skills/distilly`，以 `~/.distilly/bin/distilly-hermes` wrapper 和 `~/.hermes/config.yaml` 注册 stdio MCP；`resources` / `prompts` auxiliary surfaces 必须关闭，使模型仍只见五个 Distilly tools。packaged fresh-install E2E 做 Codex/Claude initialize-tools-list 与 OpenClaw/Hermes discovery/config smoke；OpenClaw `2026.3.24` 与 Hermes `v0.9.0` 在 matching capacity fixture 下还可进入 briefing，未记录版本或其它 release/descriptor/profile/projection/probe/serializer tuple 仍 fail closed。最终 production setup 仍需内置同等只读 smoke。源仓不靠 symlink 作为发行契约：zip、npm 与 Windows 对 symlink 支持不一致。[Codex plugin packaging](https://developers.openai.com/plugins/build/plugins)；[Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)；[OpenClaw plugin bundles](https://docs.openclaw.ai/plugins/bundles)；[OpenClaw plugin tools](https://docs.openclaw.ai/tools/plugin)；[Hermes Agent](https://github.com/NousResearch/Hermes-Agent)。

### 19.5 三种分发概念

1. **npm / release runtime**：安装本机 engine 与 CLI。
2. **local / repo plugin source**：开发、测试或团队分发 manifests 与 skill。
3. **公共插件目录**：平台支持本机 MCP 时可增加的发现渠道。

这三者都不是 Profile Catalog。

截至 2026-08-20，OpenAI 官方文档把 public plugin directory 与 local/repo marketplaces 区分，并说明只有本地 stdio MCP 的插件不能按公共 remote-MCP 路径提交；V3 因此把 local/repo source 当首发分发渠道，而不是把本机资料搬到远程服务器。[Package your plugin](https://developers.openai.com/plugins/build/plugins)；[Submit a Claude Code plugin](https://developers.openai.com/plugins/guides/submit-claude-plugin)。

平台以后支持本机 MCP 公共分发时，只新增 HostInstaller / release target；不改变 EngineClient、家目录或数据归属。

### 19.6 Hooks

插件可以携带平台支持的 lifecycle hooks，但 core workflow 不依赖所有表面都有 hook。Hook 只能：

- 检查 pending / suspended 并提醒；
- 在明确的 session boundary flush 已被用户标为材料的 Capture buffer；
- 打开 doctor 或 Panel。

Hook 不读对话私自 ingest、不直写文件、不在无 consent 时后台 research。每个 HostBinding 的 hook matrix 用真实宿主 fixture 验证。

### 19.7 Fresh-install 验收

在没有全局 distilly、没有 Distilly 账号、没有额外 LLM key的临时用户目录：

1. 一条 setup 安装 runtime 与插件；
2. doctor 通过；
3. 重开宿主后恰好看到五工具；
4. 对公开人物完成主路径；
5. 本地事实与 Panel 可见；
6. 下一次 get 成功；
7. uninstall 只移除插件投影与 launcher，不删除人物数据。

这七步的 packaged fresh-install 完整闭环与 briefing-capacity evidence 是两道独立门槛。目前完整闭环只计入已经完成该序列的 Codex；OpenClaw `2026.3.24` 与 Hermes `v0.9.0` 的真实 capacity fixture 允许匹配 tuple 进入 briefing，但它们的 install、重开、长期 Skill 与 uninstall 保持/删除边界仍须各自通过同一套 packaged E2E 后，才能写入完整闭环矩阵。Claude Code 在取得自己的真实 capacity fixture 与 host-reopen 证据前，缺证据时返回 `host_unsupported`。任何宿主在没有匹配 evidence 时只运行 compatibility install、discovery、config 与五工具 smoke，不能把 smoke 结果写成 briefing 或完整闭环成功。

---
