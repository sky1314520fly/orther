# Contributing to Distilly

Distilly has two deliberate product lines:

- `distilly-plugin` is the repository's default public TypeScript Developer Preview.
- `dot-skill` is the separate published legacy Skill maintenance line.

Preview work belongs on `distilly-plugin` or a branch based on it. Legacy maintenance belongs on `dot-skill`; do not mix the two product lines.

## Start here

Read the [design index](docs/design/README.md), [architecture map](docs/architecture.md), and [development workflow](docs/development.md). Product code is TypeScript and targets Node.js `22.19+` or `24`.

```bash
git clone --branch distilly-plugin https://github.com/titanwings/distilly.git
cd distilly
corepack enable
pnpm install --frozen-lockfile
pnpm run gates:fast
pnpm run typecheck
```

Keep each change focused and explain its acceptance checks and rejected alternatives in the pull request. Tests should sit beside their TypeScript source and use offline fixtures; never put secrets, personal material, local Agent instructions, or generated product data in the repository.

## Host Plugin contributions

The next community priority is a real, tested binding for **Grok Bot, Claude Code, OpenCode, Pi agent, and DeepSeek Harness (DSH)**. A useful host contribution includes:

- an isolated binding and launcher;
- setup, doctor, restart/discovery, and uninstall checks;
- exact host/version/release/capacity evidence;
- the unchanged five-tool contract; and
- a focused pull-request rationale and reproducible local test.

A copied Skill directory or a logo-only entry is not host verification. Keep provider credentials in the system keychain or environment variables; configuration files may store only secret references.

## Checks

Run the narrowest checks that cover your diff, then report exactly what ran:

| Change | Minimum check |
| --- | --- |
| Markdown | `python3 -B scripts/verify_docs.py` |
| TypeScript formatting and lint | `pnpm run gates:fast` |
| TypeScript behavior and types | `pnpm run test` and `pnpm run typecheck` |
| Plugin assembly | `python3 -B scripts/assemble_plugins.py --check` |
| Built Preview | `pnpm run build` and the relevant packaged smoke |

Do not claim a host is verified until a clean local HOME has completed setup, restart discovery, the five-tool check, and uninstall with user data retained.

## Branches and publication

Use a separate worktree for independent features and make one reviewable local commit per feature. Open Preview pull requests against `distilly-plugin`; keep the legacy `dot-skill` branch scoped to maintenance. Never push credentials or private source material.

For questions, open a focused issue or start a discussion. See [UPDATES.md](UPDATES.md) for the current host-contributor call.
