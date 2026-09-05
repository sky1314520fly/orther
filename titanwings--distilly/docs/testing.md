# Testing

Tests describe shipped behavior. A green command is evidence only for the surface it exercises.

## Test layers

- **Formatting and lint** (`pnpm run gates:fast`) checks committed TypeScript and configuration style.
- **Type checking** (`pnpm run typecheck`) checks every workspace package and the root TypeScript tools graph.
- **Vitest** (`pnpm run test`) covers Protocol schemas, deterministic Engine behavior, SQLite transactions, Runtime composition, Facade/MCP mappings, host bindings, CLI lifecycle, and Panel HTTP/browser behavior.
- **Coverage** (`pnpm run test:coverage`) enforces the repository thresholds; coverage does not replace behavior review.
- **Snapshots** (`pnpm run snapshots`) pin public exports, schemas, prompts, and other model-visible contracts.
- **Documentation** (`pnpm run docs`) checks portable local links, Markdown endings, and exact generated V3 chapters.
- **Repository Python** (`python3 -B scripts/run_tests.py`) covers documentation generation and Plugin assembly without entering the product runtime.
- **Build and hygiene** (`pnpm run build && pnpm run hygiene`) check compiled entries, dependency direction, package contents, export maps, and built smokes.

## Product acceptance

The current Codex Preview is accepted only when a fresh temporary home completes setup, doctor, restart discovery, exactly five MCP tools, create/ingest/brief/commit/get/prompt, correction and Panel review, persistent Person Skill installation, and Plugin uninstall while preserving SQLite and the installed person Skill. OpenClaw and Hermes additionally have immutable real-host transport-capacity fixtures: each fixture comes from an isolated clean session using the real executable/model/MCP transport against a deterministic synthetic fixture server, and preserved the complete structured result, JSON text duplicate, and unseen tail markers at its recorded net budget. Their lifecycle discovery/configuration smoke remains separate from the capacity measurement.

The package verifier must run the self-contained artifact from a path containing spaces and non-ASCII characters, delete the unpacked source after setup, and continue through the installed absolute launcher. Test fakes and sentinel placeholders are forbidden in the package.

Claude Code and every future host need their own exact version/capacity fixture and clean-home acceptance run. Source compatibility or a copied Skill directory is not enough to call a host capacity-verified; the same criterion applies when OpenClaw or Hermes changes version, model-visible serializer, descriptor digest, or release.

## Review rules

Run the smallest relevant check while iterating and the complete outgoing gate before publication. Report failures and intentionally unverified areas; do not treat skipped external-host validation as a pass. Fixtures contain synthetic material only and must never include real credentials or person data.
