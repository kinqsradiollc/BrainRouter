# BrainRouter Roadmap

This is the top-level planning index. Keep it short. Detailed release
plans live in [`brainrouter-roadmap/`](brainrouter-roadmap/), execution
tasks live in [`FULL_TASKS.MD`](FULL_TASKS.MD), and shipped changes live
in [`CHANGELOG.md`](CHANGELOG.md).

---

## Current Status

| Track | Version | State | Read next |
|---|---|---|---|
| Latest shipped | **0.3.7** | Shipped — 2026-05-25 | [`CHANGELOG.md`](CHANGELOG.md#037---2026-05-25) |
| Current release | **0.3.8** | Planned | [`brainrouter-roadmap/0.3.8.md`](brainrouter-roadmap/0.3.8.md) |
| Next patch | **0.3.8** | Planned | [`brainrouter-roadmap/0.3.8.md`](brainrouter-roadmap/0.3.8.md) |
| Next major | **0.4.0** | Designed | [`brainrouter-roadmap/0.4.0.md`](brainrouter-roadmap/0.4.0.md) |

---

## Release Sequence

| Release | Theme | Status |
|---|---|---|
| **[0.3.6](brainrouter-roadmap/0.3.6.md)** | CLI UX tranche, multi-workflow, relevance judge, context budget | Shipped — 2026-05-25 |
| **[0.3.7](brainrouter-roadmap/0.3.7.md)** | Terminal UI redesign, in-terminal config wizard, full Ink chat REPL, CLI/server env separation, multi-agent registry foundations | Shipped — 2026-05-25 |
| **[0.3.8](brainrouter-roadmap/0.3.8.md)** | CLI delegation reliability and quick wins | Planned |
| **[0.4.0](brainrouter-roadmap/0.4.0.md)** | Federation: many agents, one memory; CLI multi-agent Phase 2 | Designed |
| **[0.4.x](brainrouter-roadmap/0.4.x.md)** | Post-federation polish, CLI multi-agent Phases 3-6, brain-side multi-agent roadmap | Planned |
| **[0.5.0](brainrouter-roadmap/0.5.0.md)** | Fullscreen TUI and plugin marketplace | Sketched |

---

## What Each Upcoming Release Means

### 0.3.7 — Finish the CLI Shell

- Full Ink chat REPL.
- In-REPL first-run wizard.
- `/config`, `/login`, `/init`, and `/model` picker flows.
- CLI/server env separation.
- Small additive multi-agent registry foundations if the cycle allows.

### 0.3.8 — Fix Delegation Reliability

- Runtime child-drain guardrail for the "I am waiting" failure mode.
- Clear foreground `task_agent` vs background `delegate_agent`
  semantics.
- Visible child-agent progress in Ink.
- Safe parallel execution for independent read tools.
- Quick wins carried from 0.3.7: `/schedule`, `/release-notes`, hooks
  JSON docs, Strict Tool-Call Recovery, per-vendor MCP snippets.

### 0.4.0 — Federation + Typed Delegation

- Shared memory across BrainRouter CLI, Claude Code, Codex, Cursor,
  Gemini CLI, and other MCP-aware clients.
- Active-session registry, session heartbeat, and cross-session inbox.
- CLI multi-agent Phase 2: synthesized `delegate_*` tools, `route_task`,
  parent execution context snapshots, output-contract scaffolding.

### 0.4.x — Durable Orchestration and Brain Agents

- Ownership contracts, tool budgeting, supervisor gates, review fan-out,
  worker threads, packs, and transcript debugger.
- **Brain-side (MCP server):** job queue + brain-agent registry (0.4.1);
  token-aware capture (TokenJuice) + source chunks + vault mirror (0.4.2);
  memory tree + blackboard commit pipeline (0.4.3).
- Individual brain tasks: `BRAIN-P1-TN` through `BRAIN-P5-TN` in
  [`FULL_TASKS.MD`](FULL_TASKS.MD) §5.6, §6.6–6.7, §7.1–7.2.
- Full spec: [`FEATURE_OPENHUMAN_BRAINROUTER.md`](FEATURE_OPENHUMAN_BRAINROUTER.md).

### 0.5.0 — Power User Surface

- Fullscreen `/focus` TUI.
- Plugin marketplace and trust/signature model.
- Cross-harness handoff UX on top of federation.
- **Brain-side Phase 6:** engineering sync providers (Git, GitHub, local docs,
  terminal logs) and proactive situation reports. Tasks: `BRAIN-P6-TN` in
  [`FULL_TASKS.MD`](FULL_TASKS.MD) §8.3.

---

## Documentation Map

| File | Purpose |
|---|---|
| [`brainrouter-roadmap/README.md`](brainrouter-roadmap/README.md) | Roadmap index and release table |
| [`brainrouter-roadmap/0.3.8.md`](brainrouter-roadmap/0.3.8.md) | Immediate CLI delegation reliability plan |
| [`FEATURE_CLI_MULTI_AGENTS_LOGIC_ENHANCEMENT.md`](FEATURE_CLI_MULTI_AGENTS_LOGIC_ENHANCEMENT.md) | CLI multi-agent architecture and rationale |
| [`FEATURE_CLI_MULTI_AGENTS_LOGIC_ENHANCEMENT_TASKS.md`](FEATURE_CLI_MULTI_AGENTS_LOGIC_ENHANCEMENT_TASKS.md) | CLI multi-agent implementation checklist |
| [`FEATURE_OPENHUMAN_BRAINROUTER.md`](FEATURE_OPENHUMAN_BRAINROUTER.md) | MCP brain-side memory-agent roadmap |
| [`FULL_TASKS.MD`](FULL_TASKS.MD) | Master execution queue |
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
