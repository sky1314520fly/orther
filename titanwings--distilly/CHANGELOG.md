# Changelog

This file records notable user-facing changes to the Distilly TypeScript Plugin. Dates use ISO 8601 (`YYYY-MM-DD`). The legacy `dot-skill` maintenance line is documented separately.

## [Unreleased]

No unreleased changes.

## [0.1.0-preview.1] — 2026-09-04

### Added

- Local-first TypeScript/SQLite Developer Preview with versioned Person Profiles.
- Exactly five model-facing MCP tools: `distilly_get`, `distilly_ingest`, `distilly_pending`, `distilly_commit`, and `distilly_correct`.
- Explicit local material intake for TXT, Markdown, JSON, and SRT/VTT, together with pasted text and public-URL research paths.
- Evidence-bound briefing, correction review, promote/reject/rollback, and explicit installation of an approved profile as a long-lived Person Skill.
- Codex Plugin packaging with an absolute launcher, local Panel, doctor checks, and uninstall that preserves person data.
- OpenClaw `2026.3.24` and Hermes `v0.9.0` bindings, host-compatible schema projections, and separate real-host transport-capacity fixtures.
- An explicit `dot-skill` Legacy Skill compatibility route for hosts without a verified native Plugin binding.

### Changed

- `distilly-plugin` is the public Developer Preview line; `dot-skill` remains a separate legacy maintenance line.
- Unknown host versions and mismatched release, tool, schema, probe, or serializer digests fail closed before setup writes an integration.

### Security and privacy

- The default path requires no additional model API key.
- Capacity fixtures contain only de-identified metadata and normalized digests; credentials, raw transcripts, and personal source material are not committed.
