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

## Active tracks

Live checklist — ticked as each part ships.

### Deferred from 0.4.11 → next

- [ ] C1 — spawn-child loop continuation (the parent loop stops when a child runs past the 30s drain timeout; proper fix = async auto-resume on child completion)
- [ ] C2 — input queue while busy (queue / view / remove messages mid-turn)

### 0.4.12 — The Build Loop · spec `docs/specs/build-loop-workflow.md`

An opt-in plan → implement → verify → review → merge engineering loop on the
0.4.11 isolation substrate. Single-agent stays the default; `/build` is the
explicit trigger; `cli.buildLoop` defaults to `escalate`.

- [x] P1 — `build` workflow template + `/build <task>` command
- [ ] P2 — phase-scoped shared worktree (verify runs against the worker's actual edits)
- [ ] P2.5 — review-gated merge: a reviewer reads each worktree's full diff before merge-back; merge only on verify-green + review-approve (+ cross-worktree synthesis review on fan-out; `cli.worktreeMergeReview` extends it to ad-hoc workers)
- [ ] P3 — escalation: `cli.buildLoop` knob + planner classifier
- [ ] P4 — surface the active phase in `/ps` · `/agents` · statusline
- [ ] P5 — (stretch) bounded loop-until-green + per-agent thread durability

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
