# Design

This folder is the approved target contract. It describes what the product must become; it is not evidence that an API is shipped.

[system-v3.md](system-v3.md) is the **only in-force** and self-contained contract. [v3/](v3/) contains generated topic projections for loading one section at a time. Superseded V1/V2 documents remain available in Git history but are not copied into this public Plugin branch.

Edit only a `system-v*.md` parent, then run `python3 scripts/sync_design_chapters.py`. `python3 -B scripts/verify_docs.py` fails if a generated chapter drifts. A new corpus is a `Corpus` entry in that script, never a hand-written folder.

[docs/architecture.md](../architecture.md) is the shipped-state map. It is not a substitute for this folder, and this folder is not a substitute for checking current code.

## Reading order

To understand the product: [00 how to read](v3/00-how-to-read.md) → [01 product](v3/01-product.md) → [02 journeys](v3/02-user-journeys.md) → [03 locked](v3/03-locked-and-superseded.md) → [04 trust](v3/04-trust-and-principles.md) → [05 architecture](v3/05-architecture-and-state.md).

To implement the first productized slice:

1. [03 locked](v3/03-locked-and-superseded.md) and [04 trust](v3/04-trust-and-principles.md)
2. [07 protocol](v3/07-protocol-types.md) and [08 five MCP tools](v3/08-mcp-tools.md)
3. [10 research](v3/10-research-provenance.md) through [14 commit](v3/14-commit-and-quality.md)
4. [15 Panel](v3/15-local-panel.md), [17 bindings](v3/17-host-bindings.md), and [19 plugins](v3/19-cli-and-plugins.md)
5. [25 packages](v3/25-package-and-source-tree.md), [27 tests](v3/27-testing-and-governance.md), and [29 landing order](v3/29-landing-and-evolution.md)

Then load the section that owns the change.

## Sections

| File | Section |
|---|---|
| [00-how-to-read.md](v3/00-how-to-read.md) | Vocabulary, reading paths, contract versus shipped state |
| [01-product.md](v3/01-product.md) | Product promise, surfaces, first usable release |
| [02-user-journeys.md](v3/02-user-journeys.md) | Research, update, file, correction, review, Recall journeys |
| [03-locked-and-superseded.md](v3/03-locked-and-superseded.md) | Locked decisions, open items, V2 supersession |
| [04-trust-and-principles.md](v3/04-trust-and-principles.md) | LLM/engine boundary and product principles |
| [05-architecture-and-state.md](v3/05-architecture-and-state.md) | Layers, processes, main path, state machines |
| [06-storage-authority-and-transactions.md](v3/06-storage-authority-and-transactions.md) | SQLite authority, immutable blobs, transactions, projections, audit, backup |
| [07-protocol-types.md](v3/07-protocol-types.md) | Branded ids, shared values, errors, validation boundaries |
| [08-mcp-tools.md](v3/08-mcp-tools.md) | Exact five model tools and wire envelopes |
| [09-subject-identity.md](v3/09-subject-identity.md) | Subject creation, spaces, identity resolution |
| [10-research-provenance.md](v3/10-research-provenance.md) | Host research, provenance, adapters, parsers |
| [11-ingest-and-queue.md](v3/11-ingest-and-queue.md) | Atomic ingest, hashes, generation, queue repository |
| [12-briefing-and-lease.md](v3/12-briefing-and-lease.md) | Complete incremental briefing, leases, capacity |
| [13-profile-and-claims.md](v3/13-profile-and-claims.md) | Claims, evidence, patches, deterministic rendering |
| [14-commit-and-quality.md](v3/14-commit-and-quality.md) | Commit validation, quality, review reasons, versions |
| [15-local-panel.md](v3/15-local-panel.md) | Library/Subject/Review/Doctor UI and loopback security |
| [16-recall-and-injection.md](v3/16-recall-and-injection.md) | Prompt, subrun injection, install, export |
| [17-host-bindings.md](v3/17-host-bindings.md) | Capabilities, binding, canonical skill, forms |
| [18-public-sdk.md](v3/18-public-sdk.md) | Method map, EngineClient, Distilly, Person |
| [19-cli-and-plugins.md](v3/19-cli-and-plugins.md) | CLI, setup, MCP composition, plugin distribution |
| [20-corrections-and-evolution.md](v3/20-corrections-and-evolution.md) | Correction, review, redistill, rollback, withdrawal |
| [21-background-executor.md](v3/21-background-executor.md) | Optional provider-backed executor |
| [22-relations.md](v3/22-relations.md) | Future additive relation slice and graph complexity |
| [23-index-and-search.md](v3/23-index-and-search.md) | Rebuildable queue, graph, and local Library projections |
| [24-profile-catalog.md](v3/24-profile-catalog.md) | Local bundles and future remote Catalog boundary |
| [25-package-and-source-tree.md](v3/25-package-and-source-tree.md) | Workspace, dependency direction, exports, abstractions |
| [26-security-config-telemetry.md](v3/26-security-config-telemetry.md) | Threat model, privacy, config, logging, network, telemetry |
| [27-testing-and-governance.md](v3/27-testing-and-governance.md) | Contract tests, crash/concurrency tests, gates |
| [28-migration-and-compatibility.md](v3/28-migration-and-compatibility.md) | Legacy migration, protocol/disk compatibility, Python retirement |
| [29-landing-and-evolution.md](v3/29-landing-and-evolution.md) | Vertical slices and release acceptance |

Changing a locked item in §3 requires the pull request to name the rejected alternative, update the parent design, and include executable evidence for the new rule.

Historical contracts can be read from Git history. They are not current requirements or generated outputs.
