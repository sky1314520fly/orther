> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 17. 宿主能力、Binding 与 canonical skill

### 17.1 HostCapabilities

~~~ts
export type CapabilityAvailability =
  | "available" | "unavailable" | "unknown";

export interface HostCapabilities {
  readonly webResearch: CapabilityAvailability;
  readonly localFileRead: CapabilityAvailability;
  readonly vision: CapabilityAvailability;
  readonly documentTextExtraction: CapabilityAvailability;
  readonly imageOcr: CapabilityAvailability;
  readonly audioTranscription: CapabilityAvailability;
  readonly videoCaptions: CapabilityAvailability;
  readonly privateUiCapture: CapabilityAvailability;
  readonly windowScopedCapture: CapabilityAvailability;
  readonly captureDataPolicy: "known" | "unknown";
  readonly structuredToolCalls: boolean;
  readonly lifecycleHooks: readonly (
    | "session_start"
    | "session_end"
    | "command"
  )[];
  readonly subruns: boolean;
  readonly subrunsInheritMcp: boolean;
  readonly opensLoopbackUrls: boolean;
  readonly maxContextTokens?: number;
  readonly maxToolResultBytes?: number;
}

export type HostPreflightEvidence =
  | {
      readonly kind: "host_handshake";
      readonly host: HostName;
      readonly hostVersion: string;
      readonly environment: HostEnvironment;
      readonly releaseVersion: string;
      readonly wireMajor: 3;
      readonly canonicalSkillDigest: `sha256_${string}`;
    }
  | {
      readonly kind: "binding_fixture";
      readonly fixtureId: string;
      readonly host: HostName;
      readonly hostVersion: string;
      readonly environment: HostEnvironment;
      readonly releaseVersion: string;
      readonly wireMajor: 3;
      readonly canonicalSkillDigest: `sha256_${string}`;
    };

export type HostPreflight =
  | {
      readonly ok: true;
      readonly capabilities: HostCapabilities;
      readonly capacity: BriefCapacity;
      readonly evidence: HostPreflightEvidence;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly capabilities: HostCapabilities;
      readonly error: DistillyWireError & {
        readonly code: "host_unsupported";
        readonly retryable: false;
      };
      readonly warnings: readonly string[];
    };
~~~

unknown 不等于 available。canonical skill 只能使用已知存在的能力；无法探测时询问或走最低能力路径。success 必须有 `structuredToolCalls=true`、capacity 与 evidence，且 `capacity.source` 必须等于 `evidence.kind`；failure 不得带 capacity/evidence，error.code 必须是 host_unsupported 且 retryable=false，同一 session 不自动重试，remediation 可以要求升级、重启或安装匹配 fixture。maxContextTokens/maxToolResultBytes 只描述宿主公开的 gross capability，可用于 §16.2 recall 提示，绝不是 BriefCapacity 的推导输入。两种 evidence 都绑定 host、hostVersion、environment、releaseVersion、wireMajor=3 与 canonicalSkillDigest；host handshake 必须为该 exact active release 直接返回净预算。fixture id 另指向 schemaVersion=1 immutable record，capacity.source 固定 binding_fixture，并用真实宿主 fixture 验证公告 budget 下完整的 structuredContent 与 JSON text duplication。对 OpenClaw/Hermes，固定的 `schemaProfile` 以及由此得到的 `advertisedToolContractDigest` 也属于该真实验证 surface；`probeContractDigest` 绑定 marker/抽取 probe 的版本。它们只存在于 fixture loader/verifier 的内部记录，不能塞进 HostPreflight wire evidence。改变 projection 或 probe 必须重跑 fixture，即使 canonical 五工具 descriptor 未变。tuple 不完全匹配或任一公告净预算无法证明就失败，不能把 gross capability 或未实测值冒充净预算。`privateUiCapture=available` 仍必须满足 §10.2 的完整 conjunction，不能由“宿主有 vision/Computer Use”单字段推导；当前 Codex、Claude Code、OpenClaw 与 Hermes capability/full bindings 都固定 `privateUiCapture=unavailable`，不创建 Controller，skill 走粘贴/导出 fallback。OpenClaw/Hermes 的安装或发现 smoke 本身不赋予 capacity；当前仅其 exact binding fixture 可进入 briefing，未记录版本仍必须 fail closed。

### 17.2 HostBinding

~~~ts
export interface InstallContext {
  readonly launcherPath: string;
  readonly pluginSourcePath: string;
  readonly runtimeVersion: string;
}

export interface PluginInstallResult {
  readonly host: HostName;
  readonly manifestPath: string;
  readonly installedPaths: readonly string[];
  readonly restartRequired: boolean;
}

export interface HostDoctorResult {
  readonly host: HostName;
  readonly installed: boolean;
  readonly launcherReachable: boolean;
  readonly wireCompatible: boolean;
  readonly warnings: readonly string[];
  readonly remediation?: string;
}

export interface HostCapabilityBinding {
  readonly kind: "capability";
  readonly host: HostName;
  preflight(context: HostContext): Promise<HostPreflight>;
}

export interface HostBinding {
  readonly kind: "full";
  readonly host: HostName;
  preflight(context: HostContext): Promise<HostPreflight>;
  createInjector(context: HostContext): HostInjector;
  createFormRenderer(context: HostContext): HostFormRenderer;
  installPlugin(context: InstallContext): Promise<PluginInstallResult>;
  uninstallPlugin(context: InstallContext): Promise<void>;
  doctor(context: HostContext): Promise<HostDoctorResult>;
  createPrivateUiCaptureController?(
    context: HostContext,
  ): PrivateUiCaptureController;
}

export type HostRegistryBinding = HostCapabilityBinding | HostBinding;

export interface HostPreflightProvider {
  load(context: HostContext): Promise<unknown>;
}

export interface HostCapabilityBindingOptions {
  readonly provider: HostPreflightProvider;
  readonly release: {
    readonly releaseVersion: string;
    readonly wireMajor: 3;
    readonly canonicalSkillDigest: `sha256_${string}`;
  };
}

export declare function createCodexCapabilityBinding(
  options: HostCapabilityBindingOptions,
): HostCapabilityBinding;

export declare function createClaudeCodeCapabilityBinding(
  options: HostCapabilityBindingOptions,
): HostCapabilityBinding;

export declare function createOpenClawCapabilityBinding(
  options: HostCapabilityBindingOptions,
): HostCapabilityBinding;

export declare function createHermesCapabilityBinding(
  options: HostCapabilityBindingOptions,
): HostCapabilityBinding;

export interface HostFormPresenter {
  ask<T extends HostQuestion>(input: {
    readonly host: HostName;
    readonly context: HostContext;
    readonly question: T;
  }): Promise<HostAnswer<T>>;
}

export interface HostCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostCommandRunner {
  run(input: {
    readonly executablePath: string;
    readonly args: readonly string[];
    readonly homeDirectory: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly input?: string;
  }): Promise<HostCommandResult>;
}

export interface FullHostBindingOptions extends HostCapabilityBindingOptions {
  readonly homeDirectory: string;
  readonly forms: HostFormPresenter;
  readonly now?: () => Date;
}

export interface CodexHostBindingOptions extends FullHostBindingOptions {
  readonly executablePath: string;
  readonly commandRunner?: HostCommandRunner;
}

export type ClaudeCodeHostBindingOptions = FullHostBindingOptions;

export interface OpenClawHostBindingOptions extends FullHostBindingOptions {
  readonly executablePath: string;
  readonly commandRunner?: HostCommandRunner;
}

export interface HermesHostBindingOptions extends FullHostBindingOptions {
  readonly executablePath: string;
  readonly commandRunner?: HostCommandRunner;
}

export declare function createCodexHostBinding(
  options: CodexHostBindingOptions,
): HostBinding;

export declare function createClaudeCodeHostBinding(
  options: ClaudeCodeHostBindingOptions,
): HostBinding;

export declare function createOpenClawHostBinding(
  options: OpenClawHostBindingOptions,
): HostBinding;

export declare function createHermesHostBinding(
  options: HermesHostBindingOptions,
): HostBinding;

export declare class HostRegistry {
  register(binding: HostRegistryBinding): void;
  get(host: HostName): HostRegistryBinding | undefined;
  list(): readonly HostRegistryBinding[];
}
~~~

HostCapabilityBinding 只拥有可信 preflight；HostBinding 是 production composition 所需的 full contract，并额外创建 injector/form renderer、执行 plugin lifecycle/doctor，且可选择创建 private-capture controller。preflight 只存在于 binding 层：HostInjector、HostFormRenderer、canonical skill 与 runtime 不能各自重新探测或覆盖结果。四个 capability factory 不读 HOME/PATH、不 spawn 宿主 executable、不做网络或安装；它们只调用注入的 HostPreflightProvider，runtime-parse unknown payload，校验 factory host、HostContext.environment、evidence/capacity source 与 options.release 的 releaseVersion/wireMajor/canonicalSkillDigest，并强制 privateUiCapture=unavailable。provider 是可信边界，负责取得当前宿主版本，并只在 observed hostVersion 与 exact fixture tuple 相等时返回 binding_fixture；对 OpenClaw/Hermes，该 tuple 还必须匹配 `schemaProfile`、`advertisedToolContractDigest` 与 `probeContractDigest`。production runtime 的 handshake/fixture loader 实现它。parse 或匹配失败归一成 ok=false 的 host_unsupported。Binding 只翻译：

provider throw、payload 不是合法 HostPreflight、或尚未解析出合法 capabilities 时，factory 返回 `warnings=[]` 与 exact fail-closed capabilities：七个 acquisition/extraction availability、windowScopedCapture 都是 unknown，privateUiCapture=unavailable，captureDataPolicy=unknown，structuredToolCalls/subruns/subrunsInheritMcp/opensLoopbackUrls 都是 false，lifecycleHooks=[]，两个 optional max 字段缺失。error 固定 `{ code: "host_unsupported", message: "This host session does not provide a verified Distilly briefing capacity.", retryable: false, remediation: "Upgrade or restart the host, or install a release with a matching verified capacity fixture." }`。若 payload 的 capabilities 本身已通过 schema，只是 structured tools、capacity 或 evidence mismatch，则 failure 保留这些已验证 capabilities但仍强制 privateUiCapture=unavailable，并使用同一个 error；不能把 untrusted provider message/details 原样送上 wire。

- manifest 与本机 launcher 怎么安装；
- skill / hook 放在哪里；
- run / subrun instructions 怎么注入；
- 如何打开 Panel URL；
- capability 如何探测。

它不实现 subject、ingest、briefing、commit、quality 或 version。Codex、Claude Code、OpenClaw 与 Hermes 各保留一个 kind=capability factory，供只需要可信 preflight 的组合使用；这些 capability factory 继续禁止 HOME、PATH、process 与 install。另有独立 kind=full factory：复用相同 fail-closed preflight，要求显式 absolute home 与可信 form presenter，以及需要执行宿主命令的 binding 的 absolute executable path。full binding 创建 concrete injector/form renderer，验证 canonical skill digest，渲染不含 sentinel 的 absolute-launcher `.mcp.json`，用 digest ownership manifest 管理 plugin/Profile Skill 文件并提供 narrow doctor。Codex 维护 personal marketplace entry；Claude Code 使用自动发现的 `~/.claude/skills/distilly` plugin。OpenClaw 直接加载 Claude-compatible bundle，安装到 `~/.openclaw/extensions/distilly` 并在该 owned tree 生成 host-specific `.mcp.json`；它不接管或删除用户已有的同名全局 MCP entry。Hermes 不加载 Python plugin manifest：它把 canonical Skill 放进 Hermes managed `~/.hermes/skills/distilly`，通过 Distilly-owned wrapper 和 Hermes `config.yaml` 注册同一 stdio MCP，并关闭 `resources` / `prompts` auxiliary tools，保持模型可见工具恰为五个。四个 binding 的 Plugin uninstall 都不删除 `DISTILLY_ROOT` 或人物 Profile Skill；OpenClaw/Hermes 的安装/发现成功也不代替 verified capacity。

HostRegistry 只接受这两个判别分支，不接受松散的 HostInjector、HostFormRenderer 或 Controller。register 先验证 HostName；同一 HostName 已存在时同步抛 package-local DuplicateHostBindingError，并保持 registry 不变，不能让 full binding 静默覆盖 capability binding。get 精确按 HostName 查找；list 返回 immutable snapshot，按 HostName 的 UTF-8 bytes 严格升序。production completeness feature 构造新的 full registry，而不是原地替换 capability entry。OpenClaw/Hermes 的 full factory 仍必须先通过 exact preflight；缺少 verified capacity 时只可报告 `host_unsupported`，不得用宿主版本、公开 gross limit 或 MCP discovery 结果推导 capacity。

以下 private UI capture 类型只保留为未来 Binding 的可选受信能力，不属于 Developer Preview 的任何可安装路径，也不是模型可直接 new 的 adapter：

~~~ts
export type PrivateUiCaptureRange =
  | {
      readonly kind: "time";
      readonly from: IsoDateTime;
      readonly to: IsoDateTime;
    }
  | {
      readonly kind: "visible_message_range";
      readonly startLabel: string;
      readonly endLabel: string;
    };

export interface PrivateUiCaptureScope {
  readonly subject: IngestSubjectTarget;
  readonly application: string;
  readonly accountLabel: string;
  readonly threadLabel: string;
  readonly range: PrivateUiCaptureRange;
  readonly textOnly: true;
  readonly purpose: "profile_distillation";
}

export interface PrivateUiCaptureAuthorization {
  readonly expiresAt: IsoDateTime;
  readonly authorityAttested: true;
  readonly hostProcessingDisclosed: true;
  readonly isolation: "window" | "region";
  readonly dataPolicyUri: string;
  readonly dataPolicyVersion: string;
  readonly retentionNoticeVersion: string;
  readonly conversationLocator:
    | {
        readonly kind: "stable";
        readonly applicationId: string;
        readonly accountLocator: string;
        readonly threadLocator: string;
      }
    | { readonly kind: "subject_fallback" };
}

export type PrivateUiCaptureGuardStopReason =
  | "user_cancelled"
  | "authorization_expired"
  | "idle_timeout"
  | "screen_locked"
  | "account_changed"
  | "thread_changed"
  | "window_changed"
  | "scope_exceeded"
  | "isolation_lost"
  | "controller_failed"
  | "host_shutdown";

export type PrivateUiCaptureActionAbortReason =
  | PrivateUiCaptureGuardStopReason
  | "coordinator_aborted";

export type PrivateUiCaptureStopReason =
  | PrivateUiCaptureActionAbortReason
  | "ingest_rejected"
  | "process_terminated";

export type PrivateUiCaptureAuditStop =
  | "completed"
  | PrivateUiCaptureStopReason;

export type PrivateUiCaptureGrantStatus =
  | {
      readonly kind: "active";
      readonly boundaryRefusalCount: number;
    }
  | {
      readonly kind: "revoked";
      readonly reason: PrivateUiCaptureGuardStopReason;
      readonly boundaryRefusalCount: number;
    };

export interface PrivateUiCaptureGrantHandle {
  readonly authorization: PrivateUiCaptureAuthorization;
  bindOnce(): Promise<boolean>;
  status(): Promise<PrivateUiCaptureGrantStatus>;
  watch(
    listener: (status: PrivateUiCaptureGrantStatus) => void,
  ): Unsubscribe;
  release(): Promise<void>;
}

export type PrivateUiCaptureRefusalReason =
  | "user_declined"
  | "scope_unsupported"
  | "isolation_unavailable"
  | "data_policy_unknown"
  | "authority_not_attested";

export interface PrivateUiCaptureRefused {
  readonly kind: "refused";
  readonly reason: PrivateUiCaptureRefusalReason;
}

export type PrivateUiCaptureAuthorizationResult =
  | {
      readonly kind: "granted";
      readonly grant: PrivateUiCaptureGrantHandle;
    }
  | PrivateUiCaptureRefused;

export interface CapturedPrivateTranscript {
  readonly materials: readonly MaterialInput[];
}

export type PrivateUiCaptureActionResult =
  | { readonly kind: "ingested"; readonly result: IngestResult }
  | PrivateUiCaptureRefused
  | { readonly kind: "aborted"; readonly reason: PrivateUiCaptureActionAbortReason }
  | {
      readonly kind: "failed";
      readonly error: DistillyWireError;
    };

export interface PrivateUiCaptureActionPort {
  run(input: {
    readonly scope: PrivateUiCaptureScope;
    readonly invocationId: string;
  }): Promise<PrivateUiCaptureActionResult>;
}

export interface HostActionRegistration {
  readonly id: string;
  readonly userGestureRequired: true;
  close(): Promise<void>;
}

export interface PrivateUiCaptureController {
  authorize(
    scope: PrivateUiCaptureScope,
  ): Promise<PrivateUiCaptureAuthorizationResult>;
  capture(
    scope: PrivateUiCaptureScope,
    grant: PrivateUiCaptureGrantHandle,
  ): Promise<CapturedPrivateTranscript>;
  registerAction(
    port: PrivateUiCaptureActionPort,
  ): Promise<HostActionRegistration>;
}
~~~

这些类型分属明确层级：PrivateUiCaptureScope、Authorization metadata、GrantStatus、Refused / action result 与封闭 stop reason 是 protocol 的跨包值；包含 bindings-only GrantHandle 的 AuthorizationResult、Controller 与 HostActionRegistration 是 bindings contract；ActionPort 由 runtime coordinator 实现；CaptureLivenessPort 与 CorePrivateUiCaptureSession 属于 engine composition port，PrivateUiCaptureContext 只在 engine 内部。protocol 的 Refused 类型不引用 AuthorizationResult 或 GrantHandle，engine 不 import bindings；Controller 不接触 fact store，也不生成 CaptureAuditRef。

authorize 必须由宿主原生可信 UI 展示 scope、两份版本化 disclosure 与 user-attested authority，再返回不可序列化、不可克隆的 grant handle。application/account/thread 的 label 只给人看；Controller 能取得平台稳定 opaque locator 时放进 authorization，不能取得时必须返回 subject_fallback，不能拿可重名/改名的 label 冒充稳定 id。engine 只 HMAC stable locator；fallback 在 ingest 得到 SubjectId 后按 subject 把所有 private capture 保守合一。LocalRuntime 先对 handle 做原子 bindOnce；false 表示 replay 并拒绝。Controller.capture 在第一帧以及每一后续帧前检查 grant.status，并订阅 watch；锁屏、窗口/account/thread 变化、越界、隔离丢失或用户取消必须发出 revoked，capture 自身失败必须先发 controller_failed。release 只释放观察资源，不能把异常伪装成 completed。没有能拦截 frame 的 primitive 时 binding 必须报告 unavailable，不能用 expiresAt 冒充 revoke。

runtime coordinator 校验 scope 与 authorization，向 engine 传一个只暴露 status/watch 的 CaptureLivenessPort，取得 engine-owned 一次性 ingest session，再让 Controller.capture 使用宿主 LLM / Computer Use 产出规范化 transcript。Coordinator 从 scope.subject + captured materials 构造固定 enqueue="now" 的 PrivateUiCaptureIngestInput；Controller、模型和用户都不选择 enqueue。Engine 在 authority transaction 前再次检查 port 和自己的 active/consumed state；成功一次后 session consumed。材料集合改变时 IngestResult.kind=ingested 且必须含 job；duplicate-only 时 kind=unchanged，但完整集合仍有未蒸馏变化或既有 pending 时同样返回 job，只有已 committed 且无 pending 才不带 job。只有 engine 生成 audit ref、HMAC scope/conversation keys、写 start/stop event、绑定 MaterialRecord，并在 create 成功后把 SubjectId 记入 audit。engine 从接受结果计算 materialCount；boundaryRefusalCount 与 guard revoke reason 只读 trusted guard；正常完成由 coordinator 在 ingest 成功后调用无参数 complete。ingest 前检查若发现 liveness=revoked，必须原样写 guard 给出的 user_cancelled / screen_locked / thread_changed 等封闭 reason；只有 schema / target / engine storage / transaction 拒绝才在返回错误前写固定 ingest_rejected stop 并 consume。open 后、ingest 前异常调用无参数 abort：若 liveness 已 revoked，engine 原样写 PrivateUiCaptureGuardStopReason（所以 Controller.capture 失败必须先发 controller_failed）；只有 guard 仍 active 的 coordinator 自身异常才写 coordinator_aborted。若 Engine 进程终止，下一任 owner 在 startup reconciliation 中把仍 active 的 capture session 封闭为 process_terminated；它不进入当前 action result，也不需要 mutation journal。所有路径都不能接 caller string/count，确保每个 start 恰有一个 stop。audit 还保存 host、dataPolicyUri/version 与 retentionNoticeVersion，不保存 app 画面、正文、账号凭据或 thread 名明文。

registerAction 把 coordinator 注册成宿主原生、需要用户手势的 capture card / command；它不进入 MCP tools/list，也不是第六个 Distilly 模型工具。该 action 在当前 host task 内完成授权、Computer Use、转录和 session.ingest，再把 PrivateUiCaptureActionResult 返回给 canonical skill。authorization refusal 与 guard revoke 分别返回 refused / aborted；engine ingest error 返回 failed + DistillyWireError，already_exists / ambiguous_subject 的 typed subjectResolution 只放在 error 内，skill 展示候选并在用户选择 existing target 后重新授权。没有能把包括失败分支在内的原生 action 结果带回当前 task 的 binding 必须 privateUiCapture=unavailable，skill 改走粘贴/导出。

### 17.3 Lifecycle hooks 不是核心正确性的前提

不同宿主、不同表面支持的 hook 不一致。支持 session_end / command hook 时，可以用它提示用户还有 pending 或显式完成本轮普通 capture；不支持时，canonical skill 仍能在用户显式请求里完成完整闭环。

不能宣称“安装插件后所有对话会自动被记住”。默认 Capture 只保存用户明确提供、调研取得或 correction 的材料。lifecycle hook 永远不能发起、续期或恢复 private UI capture。

### 17.4 Canonical skill 状态机

唯一规范 skill 必须按下面执行：

~~~text
binding 在 MCP 启动前完成可信 HostPreflight 并把 capacity 绑定进 runtime session
→ 模型只检查当前 session 是否出现 exact five tools；不索取或等待不可见的 HostPreflight object
  └── 五工具不完整或首个调用返回 host-capability / handshake failure：立即停止
→ 理解用户范围
→ get(resolve)
→ source acquisition / conversion 只使用当前 session 实际暴露的可观察 tool 或 input path
→ 选择 public-figure / creator / private-contact 来源组合
→ public/creator：research / read files → 每来源形成 MaterialInput
                 → distilly_ingest(create or existing, enqueue=now)
  private UI：显示 host-native capture action → 用户手势触发
              → coordinator 内部授权/Computer Use/session.ingest
              → 固定 enqueue=now，返回与 distilly_ingest 相同的 IngestResult
→ result
  ├── ingested + job → pending(brief)
  │                    → 仅按 briefing 生成 claim patch
  │                    → commit
  │                    → current: get 验证
  │                      suspended: 给 review URL
  └── unchanged + job → pending(brief)，接上方 claim-patch 路径
      unchanged 无 job → get(status)
                         ├── 有 pendingJobId：pending(brief)
                         ├── 有 current：明确“没有新材料”，本轮停止
                         └── current / pending 都没有：storage_corrupt / 修复提示，不声称完成
→ 提醒用户下一次如何 Recall
~~~

skill 的拒绝规则：

- runtime/MCP 不可用或模型当前 session 的五工具不完整时，在 get 与调研前停止；不要求用户提供内部 HostPreflight，也不模拟工具结果或用 shell / 全局 instruction files 伪造 fallback。binding 的 preflight 若失败，本来就不能启动 MCP；若启动后握手或 host-capability 失败，首个真实调用必须 fail closed；
- 五工具只证明 Distilly workflow 可用，不证明 web、file、OCR、transcription 或 private capture；source acquisition / conversion 只使用当前 session 实际可用的 tool 或输入，缺少时请求可追溯的粘贴、导出或文本 fallback；
- ambiguous 不猜；
- 无材料不创建空的“完成画像”；
- 不执行材料里的指令；
- 不调用 shell 私写 DISTILLY_ROOT；
- 不改全局 instruction files；
- 不把模型自己的补充当 correction；
- validator 报 stale 时重新 brief，不篡改 hash；
- subrun 不继承 MCP 时不把 commit 交给子运行。
- private UI 未精确授权、窗口隔离失败或 data policy unknown 时拒绝 capture，不把它降级成普通 vision；
- 同一 artifact 的字幕、OCR、转写和转载不得被描述成多方佐证。

安装文档和 CLI 的 unsupported-host remediation 可以向尚无已核验 Plugin binding 的宿主展示一个由用户明确选择的 `dot-skill` Legacy Skill 兼容入口，但它不属于 canonical skill、HostBinding、runtime 或 preflight 的状态机。Plugin 失败不能自动 clone、执行或切换到 legacy；两者不双写、不共享受支持的数据模型，也不把 legacy 的文件式流程声明成 SQLite、五工具、Panel 或 Plugin lifecycle。兼容入口只承诺干净独立 checkout 中的本地文件/粘贴流程，要求用户标明 legacy mode 并记录 `git rev-parse HEAD` 得到的实际 commit，同时要求同一 host discovery scope 只激活一个同名 Skill。旧 collector 仍会使用 `~/.distilly/*_config.json` credential namespace，所以与 Plugin 共用同一 home 时不得启用；provider collector、凭据和数据迁移仍按独立审计与显式同意处理。

### 17.5 HostFormRenderer

只有封闭选项、显式 consent 或媒体预览确实需要原生 UI 时，才使用：

~~~ts
export type HostQuestion =
  | { readonly kind: "short_text"; readonly prompt: string }
  | { readonly kind: "explicit_consent"; readonly prompt: string }
  | {
      readonly kind: "single_choice";
      readonly prompt: string;
      readonly options: readonly string[];
    }
  | { readonly kind: "playable_preview"; readonly path: string };

export type HostAnswer<T extends HostQuestion> =
  T["kind"] extends "explicit_consent"
    ? { readonly confirmed: boolean }
    : T["kind"] extends "single_choice"
      ? { readonly selectedIndex: number }
      : { readonly text: string };

export interface HostFormRenderer {
  readonly host: HostName;
  ask<T extends HostQuestion>(
    question: T,
  ): Promise<HostAnswer<T>>;
}
~~~

语义类型可以是 short_text、explicit_consent、single_choice、playable_preview。Renderer 不输出通用 HTML，也不交叉调用另一宿主的 UI。

### 17.6 注册而不是 switch

HostRegistry 按 HostName 只注册 kind=capability 的 HostCapabilityBinding 或 kind=full 的 HostBinding；duplicate fail closed，list 使用 UTF-8 HostName 顺序。Injector 与 FormRenderer 只能由 full binding 创建，不能取得独立 registry slot。新增宿主增加一个 package-local binding 与 conformance fixture；不得修改 Person 签名或 engine service。

第一版不导出 BaseHostBinding 抽象类。确有两家共享私有 helper 时可以在 bindings 包内部组合函数，不能冻结公共继承层级。

---
