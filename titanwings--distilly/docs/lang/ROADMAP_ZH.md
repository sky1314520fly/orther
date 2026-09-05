# Distilly 路线图

*最后更新：2026-09-03*

完整路线图请看 [ROADMAP.md](../../ROADMAP.md)。本页只概括 `distilly-plugin` 分支的 Developer Preview。

## 当前

Codex 的本地 TypeScript/SQLite 主流程已经端到端核验：导入本地材料、生成版本、纠正、审核、恰好五个 MCP 工具、安装 Plugin，以及安全卸载并保留人物数据。

过渡兼容入口现已写入文档：尚无已核验 Plugin binding 的本地 Skill 宿主可以明确使用独立的 `dot-skill` Legacy Skill；原生 Plugin binding 仍列为 P1。

## P0

- 增加独立的 `distilly panel` 命令，并用打包产物跑浏览器 smoke test。
- 增加崩溃安全的孤儿数据清理，只删除没有引用的 blob。
- 在 Node 22.19 和 24 的干净环境完成整条 Codex 链路，并补齐可验证的 Preview 升级与回滚。

## P1：更多宿主与本地 Marketplace

我们需要社区一起补齐并核验 **Claude Code、OpenClaw、Hermes、Grok Build、Grok Bot、OpenCode、Pi agent 和 DeepSeek Harness（DSH）** 的 Plugin binding。每个宿主都应有独立 launcher、setup/doctor/重启发现/卸载测试，以及准确的宿主版本和容量证据。我会积极 review 这些贡献。

本地 Panel Marketplace 要能搜索 Profile、查看证据和版本、确认后安装人物 Skill，并导入或导出不含私人原始材料的可移植包。在同意、审核、授权和上传边界确定前，不做联网目录。

## P2

Preview 稳定后，再补 PDF、EML/MBOX 和平台导出 parser，Lark/飞书、钉钉、Slack、公开 X adapter，两阶段 `dot-skill` 迁移，以及 backup/restore 和深度 doctor。
