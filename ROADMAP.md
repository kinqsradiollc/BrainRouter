# BrainRouter Roadmap

Top-level planning index — kept short. Shipped detail lives in
[`CHANGELOG.md`](CHANGELOG.md) + [`brainrouter-changelog/`](brainrouter-changelog/);
design specs in [`brainrouter-docs/specs/`](brainrouter-docs/specs/).

---

## Shipped

Latest published: **0.4.14** (2026-06-10) — benchmark-driven recall overhaul + the
grid TUI (live fleet sidebar, scroll mode) + model-spawned background workers with
a completion inbox that reports results back into the conversation.

| Version | Theme | Date |
|---|---|---|
| 0.4.14 | Memory accuracy (2 rounds) · grid TUI + fleet sidebar · workers that report back | 2026-06-10 |
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
**Status: SHIPPED 2026-06-10 — merged to `main`, tagged `v0.4.14`, published to npm.**

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

## 0.4.15 — The Agent Behind the Glass · plan [`brainrouter-roadmap/0.4.15.md`](brainrouter-roadmap/0.4.15.md)

A **complete reverse-engineering of the strongest reference coding agent** —
decomposed into twelve subsystems, each mapped against what BrainRouter has and
rebuilt as testable contracts. Keeps the 0.4.14 UI. Threads: **A** chat ergonomics
· **B** prompt OS + turn-engine contracts (deliverable guard, batching, autonomy/
assessment rules, denied-tool semantics, verification gate) · **C** per-tool
contracts (read-before-edit, unique-match edits) · **D** context OS (stable cached
prefix, reminder channel, structured compaction) · **E** first-class task tracker
· **F** programmable workflows (scripted stages, schema-validated child outputs,
budgets, resume) · **G** background runtime (bg shell + output polling, wait-until,
cron agents, recurring loop) · **H** session lifecycle (resume, rewind, branch,
chapters) · **I** plan mode + declarative permissions + hook gates · **J**
interaction layer (structured multi-choice questions, side-task chips, skill
auto-trigger, md commands) · **K** headless stream-json surface · **L** the
agent-behavior benchmark that gates it all. · **M** BrainRouter Desktop — native macOS/Windows app (Electron + React over the unchanged agent runtime; chat, approvals, fleet sidebar, sessions as real UI; signed installers + auto-update; ships as alpha beside the TUI).

---

## Delivered in 0.4.15 — The unified workspace: **Chat · Track · Code**

One app, three modes over the *same* workspace + the *same* memory, so planning,
coordination, and implementation never leave the building. A mode switcher (top
of the **left sidebar**) flips the surface; the project, the memory, and the agent
are shared across all three. **Shipped in 0.4.15.**

- **Chat** — conversational/assistant mode: ask, explore, design, and draft
  without the full coding-agent loop. Lightweight and **read-only** (the agent is
  pinned to look-only access — no writes or shell); promotes a thread into a Code
  turn or a Track item when it's ready.
- **Track** — a first-party, **Jira-class project-management surface**, fully
  in-app so everything stays in one place. **Each workspace is a project** with its
  own management. Target scope (everything an engineering team needs):
  - **Work items** — issues / stories / bugs / tasks / sub-tasks, **epics**, and
    custom types; configurable workflow states + transitions; priority, labels,
    components, assignees, watchers, estimates, due dates, comments, attachments,
    activity history.
  - **Planning** — **backlog**, **sprints/iterations** (start/complete, capacity,
    burndown), **boards** (kanban + scrum, swimlanes, WIP limits), and **roadmap**
    (epics over time, dependencies).
  - **Views & query** — board / list / table / timeline, saved filters, and a
    JQL-style query language; reports (velocity, cumulative flow, cycle/lead time).
  - **Automation & process** — rules/triggers, templates, required fields/gates,
    SLAs; per-project configuration and permissions.
  - **Code-aware (the differentiator)** — the agent **reads and writes the tracker
    as a first-class tool**: items link to branches / commits / PRs / review
    findings / artifacts; status moves with the work; the existing requirement →
    plan → task → review → verify flow maps onto Track items; everything captures
    into BrainRouter memory with full provenance. Each project's board is queryable
    by the agent so it can pick up, update, and close work itself.
- **Code** — today's agentic coding mode (the desktop + TUI), unchanged.

Shared substrate: one memory pipeline, one workspace/session model, one provider
config; Track items, Chat threads, and Code turns all reference the same
provenance-tracked records. **Delivered** across the full stack: data model +
per-workspace store (`packages/types/track.ts` + `packages/core/src/track/`), the
`track_query`/`track_update` agent tools, the `/track` CLI, and the desktop Track
surface (nine views — Board · List · Backlog · Sprint · Roadmap · Reports ·
Automation · Members · Sync) with a JQL-style query language, automation rules,
per-project roles/permissions, and two-way GitHub Issues sync.

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
