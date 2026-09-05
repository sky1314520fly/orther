# Distilly ロードマップ

*最終更新: 2026-09-03*

正式なロードマップは [ROADMAP.md](../../ROADMAP.md) にあります。ここでは `distilly-plugin` ブランチの Developer Preview を要約します。

## 現在

Codex のローカル TypeScript/SQLite フローは、ローカル資料、バージョン、修正、レビュー、5つの MCP ツール、Plugin のインストール、安全なアンインストールまで検証済みです。

移行期間の互換パスも文書化しています。検証済みの Plugin binding がないローカル Skill ホストは、独立した `dot-skill` の Legacy Skill を明示的に利用できます。ネイティブ Plugin binding は引き続き P1 です。

## P0

- パッケージ済みブラウザ smoke test を含む独立した `distilly panel` コマンド。
- 参照されていない blob だけを削除する、クラッシュ後も安全なクリーンアップ。
- Node 22.19 と 24 のクリーンマシン検証、および検証可能な Preview の upgrade/rollback。

## P1：Host Plugin とローカル marketplace

**Claude Code、OpenClaw、Hermes、Grok Build、Grok Bot、OpenCode、Pi agent、DeepSeek Harness (DSH)** 向けの Plugin binding をコミュニティと開発・検証したいと考えています。各統合には独立した launcher、setup/doctor/再起動/アンインストールのテスト、正確な host と容量の証拠が必要です。これらの貢献を積極的に review します。

ローカル Panel marketplace では、Profile の検索、証拠と version の確認、承認済み Person Skill の install、非公開の原資料を含まない portable package の import/export を可能にします。Network catalog は、同意、moderation、license、upload の境界を決めるまで追加しません。

## P2

Preview が安定した後に、PDF、EML/MBOX、export parser、Lark、DingTalk、Slack、公開 X の認可済み adapter、2段階の `dot-skill` 移行、backup/restore、詳細 doctor を進めます。
