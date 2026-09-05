# docs

Documentation is split by job. Do not dump a second copy of a fact into another folder.

| Folder / file | Job | Read when |
|---|---|---|
| [architecture.md](architecture.md) | What the live tree is *now* | Every session that touches product code |
| [design/](design/README.md) | Approved target design; it does not prove implementation | Implementing or changing product behavior |
| [design/system-v3.md](design/system-v3.md) | The in-force productized host-LLM contract, uncut | First product session; any change to packages, protocol, profile, Panel, plugins, or gates |
| [design/v3/](design/v3/) | Generated topic projections of the in-force contract | Loading one topic without the whole file |
| [development.md](development.md) | Clone, branch, which checks to run | Setup and push |
| [testing.md](testing.md) | What a green test must prove | Writing or reviewing tests |
| `lang/` | Published user translations of the skill README | User-facing skill docs only |

Product work reads **design first**, then architecture to learn what already exists. A pull request that changes a locked decision records its rationale, rejected alternative, and verification alongside the code and current-state documentation.
