# BrainRouter Roadmap

Top-level planning index — kept short. Shipped detail lives in
[`CHANGELOG.md`](CHANGELOG.md) + [`brainrouter-changelog/`](brainrouter-changelog/);
design specs in [`brainrouter-docs/specs/`](brainrouter-docs/specs/).

---

## Shipped

Latest published: **0.4.13** (2026-06-07) — sub-agent results flow back to the main
agent (poll + event-driven resume, synthesis guard, status-check correlation) + REPL
polish.

| Version | Theme | Date |
|---|---|---|
| 0.4.13 | Sub-agent result delivery (resume + synthesis guard) · REPL polish | 2026-06-07 |
| 0.4.12 | The Build Loop · multi-agent reconnect + parent-wait timeouts · `/queue` · accuracy fixes | 2026-06-05 |
| 0.4.11 | Worktree merge-back isolation · self-hydrating config · memory verify + churn decay | 2026-06-04 |
| 0.4.10 | Memory-home hardening · mobile dashboard · Cloudflare Worker runtime | 2026-06-03 |
| 0.4.9 | Dashboard redesign ("The Memory Instrument") · auth refresh tokens · API hardening | 2026-06-03 |
| 0.4.8 | Deterministic multi-phase workflow orchestration (PhasePlan engine) | 2026-06-02 |
| 0.4.7 | Coding-agent parity · agentic autonomy · staleness-aware recall | 2026-06-02 |
| 0.4.6 | Behavior-preserving structural refactor | 2026-06-01 |
| 0.4.5 | Release hygiene · competitive catch-up · CLI polish | 2026-06-01 |
| ≤ 0.4.4 | Memory depth + pipeline + multi-agent foundations | → changelog |

Full detail: [`brainrouter-changelog/`](brainrouter-changelog/).

---

## 0.4.14 — Memory Accuracy + TUI shell · branch `release/0.4.14` · spec [`memory-accuracy.md`](brainrouter-docs/specs/memory-accuracy.md)

Benchmark-driven recall overhaul (MemBench · LoCoMo · LongMemEval), in two rounds.
**Status: feature-complete on `release/0.4.14`; pending version bump + publish to `main`.**

**Round 1 — granularity (shipped):** the one-record-per-session granularity wrecked
long-session reranking/judging. Fixed by chunking on import, a length-aware reranker
cap, a judge result-floor, embed-on-import, and a transient-embed retry.
- [x] MEM-AUDIT · MEM-CHUNK · MEM-RERANK · MEM-JUDGE · MEM-VEC · MEM-EMBED-RETRY · ASYNC-1

**Round 2 — recall quality (shipped):** the clean 6-split sweep exposed that the
reranker/judge *replaced* the retriever order — collapsing recall and losing to a
plain recency baseline. Fixes follow one rule: *score → sort → take top-N, never
hard-drop.* Results: [`reports/0.4.14-recall-delta.md`](brainrouter-benchmark/reports/0.4.14-recall-delta.md).
- [x] MEM-JUDGE2 — judge **reorders** (approved-first), never drops below the retriever
- [x] MEM-BLEND — **blend** reranker score with the recency/RRF score instead of replacing it
- [x] MEM-RERANK2 — char-budgeted reranker pool to cut long-session latency
- [x] MEM-ROUTE — reflective queries skip the cross-encoder (retriever+judge path)
- [x] MEM-EVAL — per-stage benchmark gate + final 6-split sweep vs the saved baseline

Deferred per [`ADR-001`](brainrouter-docs/decisions/ADR-001-async-store-worker.md): ASYNC-2/3 (worker-thread store).
Follow-up: benchmark importer per-record timestamps so the recency signal is measurable.

**TUI shell + worker orchestration (merged to the release branch 2026-06-09, #344):**
grid TUI (view router · 70/30 workspace split · context sidebar with the running
fleet split into sub-agents / workers / workflows — role, worktree marker, live
elapsed), model-spawned background worker threads (depth/tier-gated), a completion
inbox so detached background work reports its results into the agent's next turn,
and a scrollback overhaul (accurate height packing, scroll mode, live turn timer).

---

## 0.4.15 — CLI ergonomics & coding-agent parity (next)

Gap-driven program; chat ergonomics first (current pain), then session lifecycle,
safety, extensibility. Keeps the 0.4.14 grid/sidebar UI.

- [ ] Chat ergonomics — line-level smooth scrolling, mouse-wheel scroll + scroll-speed knob, collapsible tool results, transcript search, Esc-to-interrupt, `/copy`·`/export`, `Ctrl+R` history search.
- [ ] Session lifecycle — `--continue`/`--resume` + `/resume` picker, `/rewind` turn restore (with optional file restore), `/branch` forks, `/rename`·`/recap`.
- [ ] Safety — plan permission mode (read-only until an approved plan), declarative `cli.permissions` allow/ask/deny rules + "always allow" persistence, network domain rules.
- [ ] Extensibility — markdown slash commands, hook-event breadth (pre/post tool-use gates, prompt-submit, stop, pre-compact), background shell tasks, `!`/`#` composer prefixes.
- [ ] Polish — `/doctor`, `/usage` category breakdown, vim/emacs composer modes + keybindings, image paste, model fallback chain.

---

## 0.5.0 — Power-user surface

- [ ] Fullscreen `/focus` TUI + plugin marketplace + trust/signature model.
- [ ] Brain Phase 6 — engineering sync providers (Git / GitHub / docs / logs) + proactive situation reports.
- [ ] Dashboard per-agent recall view + drill-down.

---

## Designed, not scheduled

- Per-session isolation (two terminals on one repo) — [`per-session-isolation.md`](brainrouter-docs/specs/per-session-isolation.md).

## Wishlist (post-0.5.0)

- Docker image for the MCP server.
- Dashboard memory explorer with recall-score explanations.
- Dashboard parity with CLI goals / hooks / workflows.
- Verified provider matrix (OpenAI, Anthropic, Gemini, OpenRouter, LM Studio, Ollama).
- `@kinqs/brainrouter-sdk` 1.0 public API lock.

---

## Documentation map

| File | Purpose |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Shipped changes |
| [`brainrouter-changelog/`](brainrouter-changelog/) | Per-version changelog detail |
| [`brainrouter-roadmap/`](brainrouter-roadmap/) | Per-release plans |
| [`brainrouter-docs/specs/`](brainrouter-docs/specs/) | Design specs (memory-accuracy, build-loop, per-session isolation, multi-agent result delivery) |
| [`brainrouter-docs/decisions/`](brainrouter-docs/decisions/) | ADRs (async store worker) |
| [`brainrouter-benchmark/reports/`](brainrouter-benchmark/reports/) | Published benchmark results |
