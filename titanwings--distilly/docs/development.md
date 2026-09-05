# Development

The public Developer Preview and repository default branch are `distilly-plugin`. The separate `dot-skill` branch remains the legacy maintenance line.

## Local setup

Use Node.js `22.19+` or `24`, pnpm `10.32+`, and Python `3.9+` for the repository-only assembly and documentation scripts.

```bash
git clone --branch distilly-plugin https://github.com/titanwings/distilly.git
cd distilly
corepack enable
pnpm install --frozen-lockfile
```

The production code is TypeScript under `packages/`. The canonical orchestration Skill and host manifests are under `plugins/`. Python under `scripts/` exists only for repository verification and Plugin assembly; it is not part of the installed runtime.

## Checks

Run the narrowest checks that cover a change, then run the full gate before publishing a release candidate.

| Change | Minimum check |
| --- | --- |
| TypeScript formatting or lint | `pnpm run gates:fast` |
| TypeScript behavior or public types | `pnpm run typecheck && pnpm run test` |
| Protocol/public exports | `pnpm run snapshots` |
| Documentation or generated design chapters | `pnpm run docs` |
| Plugin Skill or manifests | `pnpm run test:plugins` |
| Build/package graph | `pnpm run build && pnpm run hygiene` |
| Repository Python scripts | `python3 -B scripts/run_tests.py && ruff check scripts tests` |
| Full outgoing candidate | `pnpm run gates` |

The package acceptance check covers the verified Codex path. OpenClaw and Hermes capacity evidence is a separate real-host transport check: the verifier uses the installed executable, model, and MCP transport with a deterministic synthetic fixture server in an isolated clean session. It does not replace packaged restart or lifecycle acceptance:

```bash
pnpm run package:preview:codex
pnpm --filter @distilly/cli run verify:package:codex
```

The package check uses temporary homes and a self-contained package. It must not depend on an existing Distilly installation or a checkout path after setup. The real-host capacity commands are run only when the corresponding local host and credentials are available:

```bash
node packages/cli/scripts/verify-real-host-capacity-fixture.mjs openclaw
node packages/cli/scripts/verify-real-host-capacity-fixture.mjs hermes
```

## Contribution workflow

Keep each feature focused, with its implementation, tests, generated artifacts, and current-state documentation in one reviewable commit. Use an independent branch or worktree for unrelated work. Pull requests for the Preview target `distilly-plugin`; do not mix legacy maintenance into it.

Never commit local person data, source material, environment files, credentials, Agent-specific instructions, generated databases, or host state. The root `.gitignore` covers the standard local paths, but contributors must still inspect the complete outgoing diff. Compatibility tests may use temporary homes and fake host executables; they must not add personal `.agents` files or real host state.

Before calling a host capacity-verified, run the corresponding real-host verifier with the supported Node runtime and local host credentials. The verifier records only a content-free fixture: exact host version, release/tool digests, measured net budgets, structured/text equality, tail-marker observation, and a normalized transcript digest. It never stores credentials or transcripts; its synthetic server is not the product Engine. The recorded OpenClaw/Hermes runs use `openai-codex/gpt-5.4` and are transport/value measurements, not a guarantee for every model or user session. Setup, doctor, restart discovery, exactly five MCP tools, profile prompt/install, and uninstall with person data retained still require a clean-home lifecycle check; unknown host/version tuples remain fail-closed.
