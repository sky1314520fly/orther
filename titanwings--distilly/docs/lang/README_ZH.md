# Distilly —— Developer Preview

这是当前预览版的中文说明。完整且唯一有效的安装步骤请看[根目录 README](../../README.md)。

Distilly 把用户明确提供的材料蒸馏成可供 Agent 使用的 **Person Profile**。调用层仍然是 Skill，但产品本身包含本地存储、运行时、审核和宿主生命周期，因此以 Plugin 形式交付。

## 安装

预览版位于 `distilly-plugin` 分支。Codex 已完成完整流程核验；OpenClaw `2026.3.24` 和 Hermes `v0.9.0` 另外已有真实宿主传输容量 fixture，完整生命周期验收仍是独立检查。下面命令展示 Codex 的安装方式。需要 Node.js `22.19+` 或 `24`、pnpm `10.32+` 和本机 Codex CLI：

```bash
git clone --branch distilly-plugin https://github.com/titanwings/distilly.git
cd distilly
corepack enable
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js setup --host codex
node packages/cli/lib/bin.js doctor --host codex
```

安装后重启 Codex。卸载宿主集成不会删除人物、Profile 或材料：

```bash
node packages/cli/lib/bin.js uninstall --host codex
```

OpenClaw 和 Hermes 现在都有本地 compatibility binding：OpenClaw 安装并发现 Claude-compatible bundle；Hermes 安装 managed Skill，并通过 wrapper 和配置注册同一个 MCP server。两个 binding 都会运行安装、发现和五工具 smoke 检查，也已经为下述精确版本完成真实宿主传输容量测试。测试通过真实宿主可执行文件、模型和 MCP transport 调用确定性的合成 fixture server；完整打包生命周期验收仍是独立检查。任何未记录版本或变化后的 release/tool tuple 仍会 fail closed。

面向模型的 MCP 合同固定为五个工具：`distilly_get`、`distilly_ingest`、`distilly_pending`、`distilly_commit`、`distilly_correct`。

## Legacy Skill 兼容模式

上面的 Node.js、pnpm 和 Codex 前置条件只适用于原生 Codex Plugin；Legacy 模式不需要 Codex、Node.js 或 pnpm，但完整旧流程依赖宿主对普通 Skill 的支持，以及 filesystem、Bash 和 Python 能力。

Codex、OpenClaw `2026.3.24` 和 Hermes `v0.9.0` 现在都有已核验的 `distilly-plugin` 真实宿主传输容量 fixture。在隔离 clean session 中使用 `openai-codex/gpt-5.4` 测得的净预算是：OpenClaw 65,536 serialized bytes，Hermes 49,752。其他尚无已核验 Plugin binding 的本地 Skill 宿主，可以由用户明确选择维护中的 `dot-skill` 分支安装 Legacy Skill：

```bash
git clone --single-branch --branch dot-skill --depth 1 \
  https://github.com/titanwings/distilly.git <host-skills-dir>/distilly
git -C <host-skills-dir>/distilly rev-parse HEAD
```

这是独立的实现，没有受支持的共享数据模型。旧版 collectors 可能使用 `~/.distilly` 命名空间；在这部分交互完成隔离和审计前，不要同时使用 Legacy 与 Plugin 路径。当前兼容只承诺本地文件或粘贴文本。它不提供预览版的 SQLite 权威存储、五个 MCP 工具、Panel 或 Plugin 生命周期。Plugin setup 或 preflight 失败后不会自动切换到这条路径。同一个宿主的发现范围内只保留一个 active 的 `distilly` 安装；重启前停用或移除其他副本。Grok Bot 的本地 Skill 仓库导入尚未核验；当前只建议手动保存或迁移为 saved/private Skill。

## 当前范围

预览版支持用户明确选择的 TXT、Markdown、JSON、SRT/VTT 文件、粘贴文本和公开 URL。它可以创建人物、生成完整临时 prompt、接收纠正、审核版本，并在确认后安装长期人物 Skill。Codex、OpenClaw `2026.3.24` 和 Hermes `v0.9.0` 已完成容量核验；完整打包生命周期验收仍是独立检查。Claude Code、DeepSeek Harness（DSH）、Pi agent、Grok Build、OpenCode 和 Grok Bot 的原生 Plugin binding 仍需社区补充 fixture，其中 Grok Bot 还没有核验的本地仓库导入。

请查看[路线图](../../ROADMAP.md)和[2026-09 更新](../../UPDATES.md)。
