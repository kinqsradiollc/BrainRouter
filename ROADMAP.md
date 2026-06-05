# BrainRouter Roadmap

Top-level planning index — kept short. Shipped detail lives in
[`CHANGELOG.md`](CHANGELOG.md) + [`brainrouter-changelog/`](brainrouter-changelog/);
design specs in [`docs/specs/`](docs/specs/).

---

## Shipped

Latest: **0.4.11** (2026-06-04) — worktree isolation that merges back, a
self-hydrating `config.json`, and memory hygiene (`/memory verify` +
churn-weighted decay).

| Version | Theme | Date |
|---|---|---|
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

## Active tracks — 0.4.12 · branch `release/0.4.12`

Every feature lands as its **own PR into `release/0.4.12`**, merged after code
review. Live checklist — ticked as each PR merges.

### The Build Loop · spec `docs/specs/build-loop-workflow.md`

An opt-in plan → implement → verify → review → merge engineering loop on the
0.4.11 isolation substrate. Single-agent stays the default; `/build` is the
explicit trigger; `cli.buildLoop` defaults to `escalate`.

- [x] P1 — `build` workflow template + `/build <task>` command *(shipped in 0.4.11 prep; on `main`)*
- [x] P2 — phase-scoped shared worktree (verify runs against the worker's actual edits) *(PR #300 → review)*
- [x] P2.5 — review-gated merge: the single-worktree gate landed with P2; P2.5 adds **fan-out builds** (`build` template `slices[]` → one held worktree per slice) + a **cross-worktree synthesis review** with overlap-aware gated merge (`finalizeFanOutBuild`), and the **`cli.worktreeMergeReview`** knob extending the hold-for-review gate to ad-hoc `/spawn` workers *(PR — branch `feat/build-loop-p25-merge-gate`)*
- [x] P3 — escalation: `cli.buildLoop` knob + planner classifier *(merged)*
- [x] P4 — surface the active phase in `/ps` · `/agents` · statusline (active-run ledger → `▶ <phase> (n/total)`; new opt-in `phase` statusline segment) *(PR — branch `feat/build-loop-p4-active-phase`)*
- [x] P5 — bounded **loop-until-green** build self-repair: opt-in `cli.buildLoopMaxRepairs` (default **0 = disabled**); when >0 a red Verify re-runs Implement→Verify→Review in the same worktree up to N times until green (`repairUntilGreen`) *(PR — branch `feat/build-loop-p5-loop-until-green`)*. Per-agent thread durability tracked separately (CODEX-THREAD-FORK).

### Carried from 0.4.11

- [x] C1 — spawn-child loop continuation: when a turn ends with timed-out children, the REPL polls their status and auto-fires a synthetic continue (drain + synthesize) once they settle — always on, cancelled by user input (`runtime/childResume.ts`) *(PR — branch `feat/c1-child-loop-resume`)*
- [ ] C2 — input queue while busy (queue / view / remove messages mid-turn)

### Future — design drafted

- [ ] Per-session isolation (two terminals on one repo) — `docs/specs/per-session-isolation.md`

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
| [`docs/specs/`](docs/specs/) | Design specs (per-session isolation, build loop) |
