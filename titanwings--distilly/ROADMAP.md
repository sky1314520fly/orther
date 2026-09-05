<div align="center">

# Distilly roadmap

### From a single Skill to a reliable Person Profile Plugin for Agents

*Last updated: 2026-09-03*

[README](README.md) · [Updates](UPDATES.md) · [Design](docs/design/README.md)

</div>

Distilly is turning the original `colleague-skill` idea into a dependable local step in an agent workflow: collect user-selected evidence, distill a versioned Person Profile, review changes, and make the approved profile available to an agent. The callable interface remains a Skill; the product around it is a Plugin with storage, runtime, host bindings, and review boundaries.

`[x]` means implemented and covered by the current regression suite. `[ ]` means it is not shipped yet.

## Delivered in the Codex Developer Preview

- [x] Install, diagnose, restart, and uninstall the Codex Plugin while preserving `~/.distilly/` person data.
- [x] Expose exactly five MCP tools: `distilly_get`, `distilly_ingest`, `distilly_pending`, `distilly_commit`, and `distilly_correct`.
- [x] Create a person, ingest explicit TXT, Markdown, JSON, and SRT/VTT material, and commit a versioned Person Profile.
- [x] Recall a complete profile or temporary prompt, submit corrections, and promote, reject, or roll back candidates in the local Panel.
- [x] Install an approved profile as a self-contained long-lived Person Skill without copying private raw material.
- [x] Assemble and verify the self-contained `0.1.0-preview.1` Codex package with canonical Skill bytes, release digests, and an absolute launcher.
- [x] Add OpenClaw and Hermes compatibility bindings: real bundle/Skill installation, host discovery checks, managed MCP configuration, and five-tool smoke coverage.
- [x] Run real-host transport-capacity sessions for OpenClaw `2026.3.24` and Hermes `v0.9.0` through a deterministic synthetic fixture server, and commit separate content-free fixtures for their measured net budgets.
- [x] Document an explicit, isolated `dot-skill` Legacy Skill compatibility route for non-Codex hosts without weakening Plugin preflight.

This work lives on the repository's default public [`distilly-plugin`](https://github.com/titanwings/distilly/tree/distilly-plugin) branch. It is a Developer Preview, not a tagged release or an npm publication. The Plugin instructions do not call or bundle the separate legacy implementation; its explicit compatibility route is documented independently.

## P0 — make the Codex Preview easy to run and recover

- [ ] **Standalone Panel command.** Done when one documented `distilly panel` command starts the loopback-only Panel for the same `DISTILLY_ROOT`, reports its URL, shuts down cleanly, and passes a packaged browser smoke test.
- [ ] **Crash-safe orphan cleanup.** Done when failed or interrupted ingestion can be followed by an exclusive maintenance run that deletes only unreferenced private blobs and is safe to retry after another interruption.
- [ ] **Clean-machine Codex matrix.** Done when Node 22.19 and 24 fixtures prove setup → restart discovery → five tools → person creation → persistent Person Skill → Plugin uninstall with person data retained.
- [ ] **Preview upgrade and rollback.** Done when an installed Preview can move between two signed release fixtures without overwriting modified files or losing local person data.

## P1 — verified host Plugins

Each host is complete only when it has its own binding, absolute launcher, setup/doctor/restart/uninstall lifecycle, exact-version capacity fixture, five-tool discovery proof, persistent Person Skill test, and packaged smoke test. A copied Skill directory or logo is not host support.

- [ ] Claude Code (binding included; exact capacity fixture and restart evidence pending)
- [ ] OpenClaw (real `2026.3.24` capacity fixture recorded; full restart, persistent-Skill, and packaged acceptance evidence pending)
- [ ] Hermes (real `v0.9.0` capacity fixture recorded; full restart, persistent-Skill, and packaged acceptance evidence pending)
- [ ] Grok Build
- [ ] Grok Bot
- [ ] OpenCode
- [ ] Pi agent
- [ ] DeepSeek Harness (DSH)

## P1 — local Panel marketplace

- [ ] **Profile library.** Search and inspect approved Person Profiles, their versions, evidence citations, and digest status from the local Panel.
- [ ] **Install controls.** Install or uninstall a Person Skill through the existing Engine-authorized path with an explicit confirmation and visible result.
- [ ] **Portable profile packages.** Export and import a self-contained Profile, provenance summary, and digest without private raw materials.
- [ ] **Remote catalog decision.** Specify consent, moderation, licensing, account, and upload boundaries before adding any network marketplace. No profile or material is uploaded by default.

## P1 — more user-selected sources

- [ ] Add deterministic PDF, EML/MBOX, and provider-export parsers with real-format fixtures and explicit completeness reporting.
- [ ] Add Lark, DingTalk, Slack, and public X adapters with consent, scope, secret references, pagination, limit, and retry fixtures.
- [ ] Keep DingTalk message history explicitly unsupported unless an authorized API contract can be tested; do not replace it with hidden browser capture.

## P2 — migration and operations

- [ ] Two-stage `dot-skill` data migration with a read-only preview, explicit apply, atomic retry, and `imported_unverified` marking when sentence-level evidence cannot be recovered. The documented Legacy Skill compatibility install is not data migration.
- [ ] Deep doctor diagnostics, verified backup/restore, projection rebuild, and maintenance reporting.
- [ ] Cross-process single-writer hardening and the remaining crash/recovery matrix.

## Non-negotiable product rules

- Local-first storage and zero required extra model API keys.
- Only user-selected source scope; no background reading of chats, accounts, or adjacent files.
- Complete profiles and prompts are delivered or rejected visibly, never silently truncated.
- A host is called supported only after reproducible setup, restart discovery, five-tool, capacity, and uninstall checks.

Have a host you can test? Open a focused issue or pull request against [`distilly-plugin`](https://github.com/titanwings/distilly/tree/distilly-plugin). Use an independent branch or worktree, add a reproducible fixture, and keep the five-tool contract. I will actively review these contributions.
