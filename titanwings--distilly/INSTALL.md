# Install Distilly Developer Preview

This document describes the current TypeScript Plugin preview on the `distilly-plugin` branch. The separate Legacy Skill compatibility path is documented below for hosts that do not yet have a verified Plugin binding.

## Requirements

These requirements apply to the native Plugin paths. Legacy Skill mode below does not require Codex, Node, or pnpm; its full older workflow requires an ordinary local Skill host with filesystem/Bash/Python capabilities.

- Node.js `22.19+` or `24`;
- pnpm `10.32+`; and
- a locally installed supported host whose version matches the release evidence: Codex CLI `0.146.0`, OpenClaw `2026.3.24`, or Hermes `v0.9.0`.

An unknown host version fails closed instead of installing an unverified integration.

## Source checkout

```bash
git clone --branch distilly-plugin https://github.com/titanwings/distilly.git
cd distilly
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

## Install for Codex

Run the built lifecycle command from the checkout:

```bash
node packages/cli/lib/bin.js setup --host codex
node packages/cli/lib/bin.js doctor --host codex
```

Restart Codex after setup. The command installs a self-contained runtime under `~/.distilly/`, registers the Plugin through the host's normal lifecycle, and starts the absolute launcher only from the verified installation tree. It does not copy private source material into the Plugin.

To install an approved Person Profile as a persistent Skill:

```bash
node packages/cli/lib/bin.js install subject_<32 lowercase hex characters> --host codex
```

Replace the subject id with the exact value returned by Distilly. Profile installation writes only the self-contained Profile and its digest manifest.

## Remove the host integration

```bash
node packages/cli/lib/bin.js uninstall --host codex
```

This removes Distilly's verified host Plugin and runtime projection. It keeps `~/.distilly/` person data, source materials, profiles, and separately installed person Skills. A modified or foreign installation is left untouched and reported for manual review.

## OpenClaw and Hermes compatibility bindings

The Preview includes local lifecycle bindings for two additional hosts:

- **OpenClaw:** installs a Claude-compatible bundle at `~/.openclaw/extensions/distilly` with an owned `.mcp.json`. Verify discovery with `openclaw plugins inspect distilly --json`.
- **Hermes:** installs the canonical Skill at `~/.hermes/skills/distilly`, a managed wrapper at `~/.distilly/bin/distilly-hermes`, and the `distilly` MCP entry in `~/.hermes/config.yaml`. The optional `resources` and `prompts` surfaces are disabled; verify five tools with `hermes mcp test distilly`.

The CLI accepts `setup --host openclaw` and `setup --host hermes` when their installed versions match the recorded real-host transport fixtures: OpenClaw `2026.3.24` has a 65,536-byte net budget and Hermes `v0.9.0` has a 49,752-byte net budget. These measurements use a deterministic synthetic fixture server through the real host executable, `openai-codex/gpt-5.4`, and MCP transport in an isolated clean session; they prove the recorded briefing/tool-result path, not the complete packaged lifecycle. Unknown versions or changed release/tool tuples return `host_unsupported` before writing files. Setup never falls back to `dot-skill` automatically.

## Run the packaged preview

To assemble a distributable local directory instead of running from the checkout:

```bash
pnpm run package:preview:codex
./artifacts/distilly-0.1.0-preview.1-codex/distilly setup --host codex
./artifacts/distilly-0.1.0-preview.1-codex/distilly doctor --host codex
```

The artifact is local preview output; it is not an npm package or a tagged release.

## Verify the five-tool surface

After restarting Codex, confirm that the installed Plugin exposes exactly:

`distilly_get`, `distilly_ingest`, `distilly_pending`, `distilly_commit`, and `distilly_correct`.

The binding performs host preflight before starting MCP. If capacity evidence, the host version, or the release digest does not match, setup stops without writing an unverified integration.

## Legacy Skill compatibility for hosts without a verified Plugin binding

On a host without a verified Plugin binding, explicitly install the maintained `dot-skill` branch as a Legacy Skill instead of running Plugin setup:

```bash
git clone --single-branch --branch dot-skill --depth 1 \
  https://github.com/titanwings/distilly.git \
  <target-directory>
git -C <target-directory> rev-parse HEAD
```

Create its parent first, then use a new, empty target whose final directory is `distilly`:

| Host | Legacy Skill target |
| --- | --- |
| Claude Code | `~/.claude/skills/distilly` |
| OpenClaw | `~/.openclaw/workspace/skills/distilly` |
| Hermes | `~/.hermes/skills/openclaw-imports/distilly` |
| DeepSeek Harness (DSH) | `~/.dsh/skills/distilly` or `$DSH_HOME/skills/distilly` |
| Pi agent | `~/.pi/agent/skills/distilly` |
| Grok Build | `~/.grok/skills/distilly` |
| OpenCode | `~/.config/opencode/skills/distilly` |
| Grok Bot | No verified local repository import; migrate the workflow manually into a saved/private Skill |

Restart or rescan the host, verify that it discovers exactly one `distilly`, and keep the reported Git commit with any bug report. If another copy is already active in the same discovery scope, leave both copies untouched until you choose manually which one to disable or remove. This route is best-effort until each host receives a native, tested Plugin binding.

Legacy Skill mode is a separate file-based product line. It does not provide the Preview's SQLite authority, exact five MCP tools, Panel lifecycle, setup/doctor guarantees, or automatic migration. The CLI reports this guide for an unsupported non-Codex host request but never installs the Legacy Skill. Any Plugin setup or preflight failure remains fail-closed and never changes modes automatically.

For now, use local files or pasted text in Legacy Skill mode. Do not enable its older provider collectors while the Plugin uses the same home directory: those collectors can write credential configuration into the same `~/.distilly/` namespace, have not passed the Plugin security review, and must not be treated as interoperable with Plugin data. Never install from a working copy that contains private `knowledge/` or generated `skills/`; clone a clean copy directly into the target above.

## Local materials

The Preview's zero-configuration intake accepts explicit TXT, Markdown, JSON, and SRT/VTT files, pasted text, and user-selected public URLs. It does not crawl adjacent paths or silently read chat history. PDF, email containers, provider exports, and hosted source adapters are planned follow-up work.

For the product flow and community host work, see the [root README](README.md), [roadmap](ROADMAP.md), and [updates](UPDATES.md).
