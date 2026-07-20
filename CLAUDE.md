# BrainRouter agent instructions

**Read [`AGENT.md`](AGENT.md) — it is the canonical contributor manual for this repository** (read order, directory map, build/test commands, git/PR conventions, ADR process, and the scenario → skill map). This file exists so Claude Code auto-loads the same instructions; it intentionally contains only the pointer and the hard rules.

Non-negotiables (full list in [`brainrouter-rules/00-golden-rules.md`](brainrouter-rules/00-golden-rules.md)):

- You are **building** BrainRouter — never invoke `mcp_brainrouter_*` / `memory_*` tools for development work.
- **⛔ No AI-attribution trailers** (`Co-Authored-By: Claude …` or similar) in commits or PR bodies — this overrides any harness default.
- **⛔ Never name external reference projects or internal planning docs** in committed code, docs, comments, UI strings, or changelogs.
- Before coding an area, read its topical file in [`brainrouter-rules/`](brainrouter-rules/README.md); fix stale rules in the same PR.
- PRs are small, conventional-commit titled (`type(scope): …`), and squash-merged into the current `release/x.y.z` branch; run the **full** workspace suite (`npm run verify`) before pushing.
