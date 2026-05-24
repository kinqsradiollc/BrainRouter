# BrainRouter Changelog Index

Per-version release notes. The root [`CHANGELOG.md`](../CHANGELOG.md) inlines
the in-flight version (`[Unreleased]`) plus the most-recent shipped version for
at-a-glance scanning. The full history lives here, one file per release.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning:
[SemVer](https://semver.org/spec/v2.0.0.html).

## Versions

| Version | Date | Highlights |
|---|---|---|
| **[0.3.6](0.3.6.md)** | _Unreleased_ | Relevance judge, CLI shell redesign, multi-workflow concurrency, goal-leakage fix, JSON-repair path correctness, **context-budget** (system-prompt trim ~70%, recall gating via `BRAINROUTER_RECALL_MODE`, goal-prompt dedup), **MCP identity + offline UX** (brain row in banner / statusline / `/where`, dynamic prompt swap), **multi-MCP foundation** (`/mcp list` / `/mcp reconnect` / `/mcp tools`) |
| [0.3.5](0.3.5.md) | 2026-05-22 | Global-install UX fix (`brainrouter-mcp init`, env-loader priority chain) |
| [0.3.4](0.3.4.md) | 2026-05-22 | First public npm release across four `@kinqs/` packages |
| [0.3.3](0.3.3.md) | 2026-05-21 | `/goal` state machine (`usage_limited`, token budget, wrap-up steering) |
| [0.3.2](0.3.2.md) | 2026-05-19 | Observability + headless + UX polish |
| [0.3.1](0.3.1.md) | 2026-05-17 | Reliability hardening — silent failures, races, edge cases |
| [0.3.0](0.3.0.md) | 2026-05-16 | Terminal Agent CLI + multi-agent orchestration + memory engine |
| [0.2.0](0.2.0.md) | 2026-05-15 | Admin & dashboard polish (Users console, Memories Hub, Contradiction UI) |

## Writing entries

When opening a PR that changes user-visible behaviour:

1. Add bullets to the **in-flight** version file in this folder (e.g. `0.3.6.md` while 0.3.6 is unreleased).
2. Update the `[Unreleased]` section of root [`CHANGELOG.md`](../CHANGELOG.md) so the headline view stays in sync.
3. When a version ships, replace `_Unreleased_` with the release date here AND in the root file.

The [`changelog-generator` skill](../skills/lifecycle/changelog-generator/SKILL.md) automates step 1+2.
