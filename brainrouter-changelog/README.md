# BrainRouter Changelog Index

Per-version release notes live here. The root
[`CHANGELOG.md`](../CHANGELOG.md) stays short and only inlines the
current in-flight release plus the latest shipped release.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) ·
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

---

## Versions

| Version | Date | State | Highlights |
|---|---:|---|---|
| **[0.4.0](0.4.0.md)** | — | Unreleased | Persona injection, federation foundations, CLI multi-agent Phase 2 |
| **[0.3.9](0.3.9.md)** | 2026-05-28 | Shipped | Memory briefing, cache-first loop, tool repair, cost panel, CLI knobs → `config.json` |
| **[0.3.8](0.3.8.md)** | 2026-05-26 | Shipped | Delegation reliability, parallel reads, CLI quick wins, briefing prefix fix |
| **[0.3.7](0.3.7.md)** | 2026-05-26 | Shipped | Ink chat REPL, wizard, `/config`, `/login`, CLI/server env separation |
| **[0.3.6](0.3.6.md)** | 2026-05-25 | Shipped | Context budget, MCP identity/offline UX, multi-MCP foundation, multi-workflow |
| [0.3.5](0.3.5.md) | 2026-05-22 | Shipped | Global-install UX fix |
| [0.3.4](0.3.4.md) | 2026-05-22 | Shipped | First public npm release |
| [0.3.3](0.3.3.md) | 2026-05-21 | Shipped | `/goal` state machine and token budget |
| [0.3.2](0.3.2.md) | 2026-05-19 | Shipped | Observability, headless behavior, statusline polish |
| [0.3.1](0.3.1.md) | 2026-05-17 | Shipped | Reliability hardening |
| [0.3.0](0.3.0.md) | 2026-05-16 | Shipped | Terminal Agent CLI, multi-agent orchestration, memory engine |
| [0.2.0](0.2.0.md) | 2026-05-15 | Shipped | Admin console, Memories Hub, contradiction UI |

---

## Writing Rules

1. Add user-visible changes to the in-flight version file in this
   folder.
2. Keep root [`CHANGELOG.md`](../CHANGELOG.md) as a concise summary,
   not a duplicate of the full release file.
3. When a version ships, replace `Unreleased` with the release date in
   both places.
4. Future planned work belongs in [`ROADMAP.md`](../ROADMAP.md), not in
   changelog files.
5. Start new per-version notes from
   [`CHANGELOG_TEMPLATE.md`](CHANGELOG_TEMPLATE.md).

The [`changelog-generator` skill](../skills/lifecycle/changelog-generator/SKILL.md)
can help assemble release notes from commits and task files.
