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

## 0.4.12 — The Build Loop · branch `release/0.4.12` (shipped)

All feature work below is **merged into `release/0.4.12`**; what remains is
release prep (version bump + changelog + publish) and optional REPL polish.

### The Build Loop · spec `brainrouter-docs/specs/build-loop-workflow.md`

An opt-in plan → implement → verify → review → merge engineering loop on the
0.4.11 isolation substrate. Single-agent stays the default; `/build` is the
explicit trigger; `cli.buildLoop` defaults to `escalate`.

- [x] P1 — `build` workflow template + `/build <task>` command
- [x] P2 — phase-scoped shared worktree (verify runs against the worker's actual edits) + review-gated merge *(#300)*
- [x] P2.5 — **fan-out builds** (`build` template `slices[]` → one held worktree per slice) + a **cross-worktree synthesis review** with overlap-aware gated merge (`finalizeFanOutBuild`), and the **`cli.worktreeMergeReview`** knob extending the hold-for-review gate to ad-hoc `/spawn` workers
- [x] P3 — escalation: `cli.buildLoop` knob (`off`/`escalate`/`always`) + planner classifier *(#301)*
- [x] P4 — surface the active phase in `/ps` · `/agents` · statusline (active-run ledger → `▶ <phase> (n/total)`; opt-in `phase` statusline segment) *(#303)*
- [x] P5 — bounded **loop-until-green** build self-repair: opt-in `cli.buildLoopMaxRepairs` (default **0 = disabled**); when >0 a red Verify re-runs Implement→Verify→Review in the same worktree up to N times until green *(#304)*. Per-agent thread durability tracked separately.

### Multi-agent run continuity

- [x] C1 — parent-loop continuation: a turn ending with timed-out children polls their status and auto-fires a synthetic continue (drain + synthesize) once they settle — always on, cancelled by user input *(#305)*
- [x] C2 — input queue while busy: a mid-turn prompt is queued (not dropped), drained one-by-one after each turn; `/queue` lists, `/queue remove <n>` / `/queue clear` manage it *(#306)*

### Reliability & accuracy

- [x] Reconnect-with-backoff for model + memory/MCP calls (honors `Retry-After`, connectivity-aware) instead of hard wall-clock timeouts; genuine recall timeouts still fail fast *(#307)*
- [x] Child **and** worker timeouts are parent-wait only — never kill the child/worker; `timeoutMs: 0` waits to completion *(#310)*
- [x] Orphan-worktree GC no longer deletes a running child's worktree *(#307)*
- [x] `grep_search` does real regex matching + ignores build/cache dirs; workflow roles degrade gracefully *(#308)*
- [x] `/tokens` session cost includes child / sub-agent tokens *(#309)*; worker state relocated to the BrainRouter home *(#310)*

### Remaining before release

- [ ] Release prep — version bump across packages + dist-manifest sync, changelog, publish (on go).
- [ ] Optional REPL polish (deferrable to 0.4.13): parallel same-name tool-result display pairing; `file:line` citation escaping; next-action planner latency.

### Future — design drafted

- [ ] Per-session isolation (two terminals on one repo) — `brainrouter-docs/specs/per-session-isolation.md`

---

## 0.4.14 — Memory Accuracy · branch `release/0.4.14` · spec `brainrouter-docs/specs/memory-accuracy.md`

Benchmark-driven recall overhaul (MemBench · LoCoMo · LongMemEval), in two rounds.

**Round 1 — granularity (shipped):** the one-record-per-session granularity wrecked
long-session reranking/judging. Fixed by chunking on import, a length-aware reranker
cap, a judge result-floor, embed-on-import, and a transient-embed retry.
- [x] MEM-AUDIT · MEM-CHUNK · MEM-RERANK · MEM-JUDGE · MEM-VEC · MEM-EMBED-RETRY · ASYNC-1

**Round 2 — recall quality (shipped):** the clean 6-split sweep exposed that the
reranker/judge *replace* the retriever order — collapsing recall and losing to a
plain recency baseline. Fixes follow one rule: *score → sort → take top-N, never
hard-drop.* Old benchmark results cleared; each stage re-benchmarked for its delta.
- [x] MEM-JUDGE2 — judge **reorders** (approved-first), never drops below the retriever
- [x] MEM-BLEND — **blend** reranker score with the recency/RRF score instead of replacing it
- [x] MEM-RERANK2 — two-stage pool (cheap pre-narrow) + adaptive doc budget to cut latency
- [x] MEM-ROUTE — query-type routing (factual vs reflective/synthesis), per-type profile
- [x] MEM-EVAL — per-stage benchmark gate + final 6-split sweep vs the saved baseline

ASYNC-2/3 deferred per ADR-001.

---

## 0.5.0 — Power-user surface

- [ ] Fullscreen `/focus` TUI + plugin marketplace + trust/signature model.
- [ ] Brain Phase 6 — engineering sync providers (Git / GitHub / docs / logs) + proactive situation reports.
- [ ] Dashboard per-agent recall view + drill-down.

---

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
| [`brainrouter-docs/specs/`](brainrouter-docs/specs/) | Design specs (per-session isolation, build loop) |
