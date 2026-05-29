# BrainRouter Roadmap

This is the top-level planning index. Keep it short. Detailed release
plans live in [`brainrouter-roadmap/`](brainrouter-roadmap/), and shipped
changes live in [`CHANGELOG.md`](CHANGELOG.md).

---

## Current Status

| Track | Version | State | Read next |
|---|---|---|---|
| Latest | **0.4.1** | Merged to `main` — 2026-05-29 · publish pending | [`brainrouter-changelog/0.4.1.md`](brainrouter-changelog/0.4.1.md) |
| Shipped | **0.4.0** | Shipped — 2026-05-28 | [`brainrouter-changelog/0.4.0.md`](brainrouter-changelog/0.4.0.md) |
| Previous | **0.3.9** | Shipped — 2026-05-28 | [`CHANGELOG.md`](CHANGELOG.md#039---2026-05-28) |
| Previous | **0.3.8** | Shipped — 2026-05-26 | [`CHANGELOG.md`](CHANGELOG.md#038---2026-05-26) |
| Previous | **0.3.7** | Shipped — 2026-05-26 | [`CHANGELOG.md`](CHANGELOG.md#037---2026-05-26) |

---

## Release Sequence

| Release | Theme | Status |
|---|---|---|
| **[0.3.6](brainrouter-roadmap/0.3.6.md)** | CLI UX tranche, multi-workflow, relevance judge, context budget | Shipped — 2026-05-25 |
| **[0.3.7](brainrouter-roadmap/0.3.7.md)** | Terminal UI redesign, in-terminal config wizard, full Ink chat REPL, CLI/server env separation, multi-agent registry foundations | Shipped — 2026-05-26 |
| **[0.3.8](brainrouter-roadmap/0.3.8.md)** | CLI delegation reliability and quick wins | Shipped — 2026-05-26 |
| **[0.3.9](brainrouter-roadmap/0.3.9.md)** | Memory briefing + cache-first loop + CLI knobs → `config.json` | Shipped — 2026-05-28 |
| **[0.4.0](brainrouter-roadmap/0.4.0.md)** | Persona injection + Federation Stages 1-3 + CLI multi-agent Phase 2 + brain-side design pass | Shipped — 2026-05-28 |
| **[0.4.1](brainrouter-roadmap/0.4.x.md)** | A1-A4 augmentations + CLI multi-agent Phase 3-4 + Brain Phase 1 (job queue + agent registry) | Merged — 2026-05-29 · publish pending |
| **[0.4.x](brainrouter-roadmap/0.4.x.md)** (0.4.2–0.4.3) | Federation Stage 5, CLI multi-agent Phases 5-6, brain-side capture/tree/blackboard, **CLI parity (workflows / review / effort / background)** | Planned |
| **[0.5.0](brainrouter-roadmap/0.5.0.md)** | Fullscreen TUI, plugin marketplace, **CLI parity (extensibility polish)** | Sketched |

---

## What Each Upcoming Release Means

> Shipped releases (0.3.x, 0.4.0, 0.4.1) live in [`CHANGELOG.md`](CHANGELOG.md)
> and `brainrouter-changelog/`. This section only describes work that is
> still ahead.

### 0.4.x (0.4.2–0.4.3) — Durable Orchestration and Brain Agents

- Federation Stage 5 (cross-vendor delegation), multi-agent Phases 5–6
  (review fan-out, result handoff, worker threads, packs, memory
  capture + brain awareness), and the agent transcript debugger.
- **Brain-side (MCP server):** token-aware capture (TokenJuice) +
  source chunks + vault mirror (0.4.2); memory tree + blackboard commit
  pipeline (0.4.3).
- Individual brain tasks: `BRAIN-P2-TN` through `BRAIN-P5-TN`.

### 0.5.0 — Power User Surface

- Fullscreen `/focus` TUI.
- Plugin marketplace and trust/signature model.
- Cross-harness handoff UX on top of federation.
- **Brain-side Phase 6:** engineering sync providers (Git, GitHub, local docs,
  terminal logs) and proactive situation reports. Tasks: `BRAIN-P6-TN`.

### CLI Parity (rolling — 0.4.2 → 0.5.0)

Bringing the CLI up to the leading agentic-CLI feature bar. Grouped by
area; each item lands in the version noted.

- **Workflows & orchestration (0.4.2).** A durable workflow engine that
  drives many child agents as one managed, persisted background run; a
  `/workflows` view that shows live run status/output (not just artifact
  folders); and proactive notifications when a background run finishes
  while you're idle.
- **Review & quality (0.4.2).** `/review --fix` to apply review findings to
  the working tree, and a first-class `/simplify` command (cleanup-only:
  reuse / simplification / efficiency).
- **Effort & model (0.4.2).** An extra-high `/effort xhigh` level; a
  `/model` "this session only" option (vs set-as-default); and a runtime
  fallback model when the primary is unavailable.
- **Background & shell UX (0.4.2–0.4.3).** A `!` shell escape from the
  composer (with a backgrounded variant) and `/bg` to push the current
  response to the background.
- **Extensibility polish (0.5.0).** `/reload-skills`; `disallowed-tools` in
  skill/command frontmatter; a message-display hook; first-use approval for
  third-party MCP servers; and real modal vim editing in the composer.

*Out of scope:* remote control / mobile push and first-party browser
control (would arrive only via an external MCP server, not core).

---

## Documentation Map

| File | Purpose |
|---|---|
| [`brainrouter-roadmap/README.md`](brainrouter-roadmap/README.md) | Roadmap index and release table |
| [`brainrouter-roadmap/0.3.9.md`](brainrouter-roadmap/0.3.9.md) | Pre-0.4 memory, cache, repair, cost, and config plan |
| [`brainrouter-roadmap/0.3.8.md`](brainrouter-roadmap/0.3.8.md) | CLI delegation reliability plan |
| [`CHANGELOG.md`](CHANGELOG.md) | Current shipped/in-flight changes |
| [`brainrouter-changelog/README.md`](brainrouter-changelog/README.md) | Per-version changelog index |

---

## Wishlist After 0.5.0

- Docker image for the MCP server.
- Dashboard memory explorer with recall score explanations.
- Dashboard parity with CLI goal, hook, and multi-agent workflows.
- Verified provider matrix for OpenAI, Anthropic, Gemini, OpenRouter,
  LM Studio, and Ollama.
- `@kinqs/brainrouter-sdk` 1.0 public API lock.
