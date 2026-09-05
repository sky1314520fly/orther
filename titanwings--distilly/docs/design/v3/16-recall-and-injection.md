> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 16. Recall、注入、安装与导出

### 16.1 四条读取路径

| 路径 | 用途 | 写宿主目录 |
|---|---|---:|
| Person.get | SDK / UI 读取结构化 Profile | 否 |
| Person.prompt | 一次 run / subrun 的完整中性文本 | 否 |
| Person.install | 长期可发现的宿主 skill 投影 | 是 |
| Person.export | 用户选择的单个身份文件或 bundle | 是 |

所有路径默认读取 current；指定 versionId 可以读取 historical 或 suspended，但使用 suspended 必须显式。

### 16.2 Prompt contract

renderPrompt 只从不可变 version 的 Profile 生成，不查询当前 SubjectSummary/SubjectRecord：

- subject display name、version、maturity；
- active claims 按 core / domain 稳定排序；
- voice 例句与 boundaries；
- contested claims 的明确警告；
- 固定行为说明：“这是证据约束的模拟，不是本人，也不要编造未记录事实”。

Profile.displayName 与 VersionRecord.subjectDisplayName 是同一个 version-time 值并进入 VersionId preimage；主体以后改名不改变历史 prompt。精确模板、JSON escaping 与单 LF 规则由 §13.4 的 `profile-renderer-v1` 定义，本节不另造第二套 renderer。

第一版整份注入。若序列化后超过 HostCapabilities.maxContextTokens 或调用方给的 limit，抛 context_too_large，列出字节、估算 token 与可用 remediation。不能悄悄删掉 boundaries、conflicts 或低频细节。

### 16.3 HostInjector

~~~ts
export type HostEnvironment = "desktop" | "cli" | "ci";

export interface HostContext {
  readonly sessionId: string;
  readonly workingDirectory?: string;
  readonly environment: HostEnvironment;
}

export interface Injection {
  readonly subjectId: SubjectId;
  readonly versionId: VersionId;
  readonly prompt: string;
}

export interface HostSpawnRequest {
  readonly instructions: readonly string[];
  readonly input: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface HostInjector {
  readonly host: HostName;
  injectSubrun(
    injection: Injection,
    request: HostSpawnRequest,
  ): HostSpawnRequest;
  install(
    profile: Profile,
    options: InstallOptions,
  ): Promise<InstallRef>;
  uninstall(ref: InstallRef): Promise<void>;
  exportIdentity(
    profile: Profile,
    options: ExportOptions,
  ): Promise<ExportRef>;
}
~~~

HostInjector 是 full HostBinding 创建的 interface，不单独注册，也不做 capability preflight。它只能包装中性 profile，不重新蒸馏一份“Claude 版”、 “Codex 版”、 “OpenClaw 版”或 “Hermes 版”人物。Codex、Claude Code、OpenClaw 与 Hermes full binding 各创建 concrete injector 与 form renderer；injector 的长期投影只含自包含 Profile Skill 与 digest manifest，不复制原始材料。production Runtime 仍必须通过 `hosts.install` / `hosts.uninstall` transaction 持有安装记录与 RequestId 语义，不能让模型或 Panel 绕过 EngineClient 直接调用 injector。

### 16.4 禁止写全局指令

AGENTS.md、CLAUDE.md、agent.md 和项目级系统说明属于整个运行或仓库，不属于一个临时人物。injectSubrun 只能改变当前 subrun / run 的 instructions；install 只能写宿主明确的 skill / persona 目录；export 只写用户指定文件。

十个临时人物就是十次带不同 Injection 的 subrun，不是来回改一个全局文件。子运行没有 MCP 时，父运行先 prompt，再把纯文本放进去。

### 16.5 Projection manifest

每个 install 产出 manifest：

~~~ts
export interface InstallRef {
  readonly id: string;
  readonly host: HostName;
  readonly subjectId: SubjectId;
  readonly versionId: VersionId;
  readonly path: string;
  readonly contentDigest: ContentDigest;
  readonly installedAt: IsoDateTime;
}
~~~

uninstall 只删除由 manifest 精确拥有且 digest 未被外部修改的投影；用户已修改时拒绝并提示备份，不删除事实。current 更新不会偷偷覆盖已 pin 的 install；用户明确 upgrade install 才变版本。

### 16.6 Bot

Bot 是以后的一种 HostBinding：进程启动时 prompt 指定 subject + version，每轮只把用户明确标记为材料的内容 ingest。它不自建 persona 文件，也不默认把所有聊天当记忆。

---
