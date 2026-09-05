# Distilly — Developer Preview

このページは現在のプレビューを要約しています。完全で正式な手順は[ルート README](../../README.md)を参照してください。

Distilly は、ユーザーが明示的に提供した資料を、バージョン管理された **Person Profiles for Agents** に変換します。呼び出し面は Skill のままですが、ストレージ、ランタイム、レビュー、ホストのライフサイクルをローカル Plugin として提供します。

## インストール

プレビューは `distilly-plugin` ブランチにあります。Codex は完全なフローを検証済みで、OpenClaw `2026.3.24` と Hermes `v0.9.0` には実ホストの transport-capacity fixture もあります（完全な lifecycle acceptance は別検証です）。以下のコマンドは Codex のインストール例です。Node.js `22.19+` または `24`、pnpm `10.32+`、ローカルの Codex CLI が必要です。

```bash
git clone --branch distilly-plugin https://github.com/titanwings/distilly.git
cd distilly
corepack enable
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js setup --host codex
node packages/cli/lib/bin.js doctor --host codex
```

セットアップ後に Codex を再起動してください。ホスト連携を削除しても人物、Profile、資料は保持されます。

```bash
node packages/cli/lib/bin.js uninstall --host codex
```

OpenClaw と Hermes にはローカル互換 binding があります。OpenClaw は Claude 互換 bundle をインストールして検出し、Hermes は管理対象 Skill をインストールし、wrapper と設定を通じて同じ MCP サーバーを登録します。両 binding はインストール、検出、5 ツールの smoke check を実行し、下記の正確なバージョンについては実ホストの transport-capacity fixture も記録済みです。測定は決定的な合成 fixture server を実ホストの実行ファイル・モデル・MCP transport 経由で行い、完全な package/lifecycle acceptance は別検証です。未記録のバージョン、または release/tool tuple が変わった場合、setup は引き続き fail closed します。

モデル向けの MCP 契約は次の5ツールのみです: `distilly_get`、`distilly_ingest`、`distilly_pending`、`distilly_commit`、`distilly_correct`。

## Legacy Skill 互換

上記の Node.js、pnpm、Codex の前提条件はネイティブ Codex Plugin にのみ適用され、Legacy モードに Codex、Node.js、pnpm は不要ですが、完全な旧フローにはホストの通常の Skill 対応と filesystem、Bash、Python の機能が必要です。

Codex、OpenClaw `2026.3.24`、Hermes `v0.9.0` には、`distilly-plugin` Plugin の検証済み実ホスト transport-capacity fixture があります。`openai-codex/gpt-5.4` の隔離 clean session で測定した net budget は OpenClaw が 65,536 serialized bytes、Hermes が 49,752 です。まだ検証済みの Plugin binding がないローカル Skill ホストでは、ユーザーが明示的に `dot-skill` ブランチで保守されている Legacy Skill をインストールできます。

```bash
git clone --single-branch --branch dot-skill --depth 1 \
  https://github.com/titanwings/distilly.git <host-skills-dir>/distilly
git -C <host-skills-dir>/distilly rev-parse HEAD
```

これは独立した実装で、サポートされた共有データモデルはありません。Legacy の collector が `~/.distilly` 名前空間を使う場合があるため、その相互作用を分離・監査するまで Legacy と Plugin の経路を併用しないでください。現在の互換範囲はローカルファイルと貼り付けテキストだけです。Preview の SQLite authority、5つの MCP ツール、Panel、Plugin lifecycle は提供しません。Plugin の setup または preflight が失敗しても自動で切り替えません。同じホストの discovery scope には active な `distilly` を1つだけ置き、再起動前に他のコピーを無効化または削除してください。Grok Bot のローカル Skill リポジトリ import はまだ検証されていないため、現時点では saved/private Skill として手動で保存する方法だけを推奨します。

## 現在の範囲

ユーザーが選択した TXT、Markdown、JSON、SRT/VTT ファイル、貼り付けテキスト、公開 URL に対応します。Codex、OpenClaw `2026.3.24`、Hermes `v0.9.0` は容量検証済みです。完全な package/lifecycle acceptance は別の検査として残ります。Claude Code、DeepSeek Harness (DSH)、Pi agent、Grok Build、OpenCode、Grok Bot のネイティブ Plugin binding にはコミュニティの fixture が必要で、Grok Bot には検証済みのローカルリポジトリ import もありません。

[ロードマップ](../../ROADMAP.md)と[2026-09 更新](../../UPDATES.md)をご覧ください。
