# oh-my-claudecode v5.2.0: close the loop, show Claude Code, bound retained matches

## Release Notes

Release with **4 new features**, **36 bug fixes**, **9 other changes** across **23 merged PRs**.

### Highlights

- **feat(shipyard): close the loop — yard gate + C5 sediment pass** (#3943)
- **feat(hud): show Claude Code update and paste-ready update hints; run update check outside workspaces**
- **perf(session-search): bound retained matches**
- **perf(hooks): bound per-tool state and worker spawns**

### New Features

- **feat(shipyard): close the loop — yard gate + C5 sediment pass** (#3943)
- **feat(hud): show Claude Code update and paste-ready update hints; run update check outside workspaces**
- **perf(session-search): bound retained matches**
- **perf(hooks): bound per-tool state and worker spawns**

### Bug Fixes

- **fix(hooks): make SessionEnd foreground ceilings and worker timeouts runner-aware (#3945)** (#3945)
- **fix(hud): bound git calls in worktree-paths (#3946)** (#3946)
- **fix(hud): bound the three unbounded git calls in worktree-paths (#3946)** (#3946)
- **fix(inventory): rebaseline inventory-graph provenance.head onto dev** (#3944)
- **fix(hooks): serialize detached update cache refreshes**
- **fix(hooks): keep no-workspace SessionStart response immediate; refresh update cache in a detached child**
- **fix(dev): regenerate inventory graph with provenance anchored to dev head** (#3941)
- **fix(state): symmetric dual-dir warning on legacy branch via settings.json discovery (#3937)** (#3937)
- **fix(hud): reclaim stale non-empty stdin tmp orphans and bounded per-session caches (#3938)** (#3938)
- **fix: sync Git cache fix with final dev**
- **fix(lsp): cancel retired document queues**
- **fix(lsp): bound directory diagnostics lifecycle**
- **fix(hud): pid-aware lock recovery and bounded .err reclamation (fix #3933)** (#3935)
- **fix(team): platform-aware worker launch wrapper for POSIX hosts (issue #3931)**
- **fix(hooks): preserve verifier semantics in Worker path**
- **fix: preserve notepad wisdom regex escapes**
- **fix: preserve three-second Windows hook budgets**
- **fix: close completed hook supervisor handles**
- **fix: terminate stalled successful hook output**
- **fix: preserve successful hook output through slow drains**
- **fix(hooks): reap a generic child at most once on Windows**
- **fix(hooks): reap the tree before destroying sources on dest EPIPE**
- **fix(hooks): unpipe source from matching PassThrough on dest EPIPE**
- **fix(hooks): tear down PassThrough taps on destination EPIPE**
- **fix(hooks): fit Windows git hooks, drop queued stdio, reap on cancel**
- **fix(hooks): only group-kill a confirmed-dead POSIX leader**
- **fix(hooks): reap POSIX process group before timeout diagnostic yield**
- **fix(hooks): keep closed-dest guards after timeout diagnostic writes**
- **fix(hooks): await timeout diagnostics before dropping sink guards**
- **fix(hooks): keep 3s Windows inner timeout above nested git ceiling**
- **fix(hooks): guard all run.cjs protocol writes against closed consumers**
- **fix(hooks): fail-open when the protocol consumer closes stdout/stderr**
- **fix(hooks): fail-open before Windows tree reap and harden stdio tests**
- **fix(hooks): keep a usable inner timeout on short Windows hook budgets**
- **fix(hooks): close protocol stdio after successful generic hook exits**
- **fix(hooks): isolate run.cjs protocol stdio from leaked Windows supervisors**

### Other Changes

- **chore: refresh inventory graph for dev post-merge**
- **chore: refresh inventory graph**
- **chore: refresh queue cancellation inventory**
- **chore: refresh inventory graph**
- **chore(inventory): refresh after dev sync**
- **chore(inventory): record verifier Worker proof**
- **chore(inventory): record hook runner test update**
- **chore(inventory): refresh hook performance graph**
- **chore: refresh issue 3920 inventory provenance**

### Stats

- **23 PRs merged** | **4 new features** | **36 bug fixes** | **0 security/hardening improvements** | **9 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.2.0
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.1.0...v5.2.0

## Contributors

Thank you to the contributors whose merged work is included in this release:

@Arvinb1386 @devseunggwan @pangpang778 @Yeachan-Heo
