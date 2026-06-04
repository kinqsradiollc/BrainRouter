# BrainRouter Roadmap

Top-level planning index — kept short. Shipped detail lives in
[`CHANGELOG.md`](CHANGELOG.md) + [`brainrouter-changelog/`](brainrouter-changelog/);
design specs in [`docs/specs/`](docs/specs/).

---

## Shipped

Latest: **0.4.10** (2026-06-03) — memory-home hardening, a mobile dashboard, a
real Cloudflare (OpenNext) Worker runtime, the web favicon, and
`@kinqs/brainrouter-hooks` published.

| Version | Theme | Date |
|---|---|---|
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

### 0.4.11 — Child worktree isolation, finished · branch `release/0.4.11`

- [x] Worktree merge-back + default `childWorkspaceIsolation` → `auto`
- [x] A1 — merge-back surfaced in the child-completion notice (+ fixes auto-chain reading a pre-merge tree)
- [x] A3 — recovery-patch GC / retention
- [x] A2 — `/agents diff <id>` show · apply · discard
- [x] A4 — per-session isolation spec (`docs/specs/per-session-isolation.md`)
- [x] **A5 — relocate worktrees to `~/.brainrouter/worktrees/` (realpath'd base kills the `$TMPDIR` /var→/private/var drift behind `Path escapes workspace root`)**
- [x] A5.1 — `cli.worktreeRoot` knob so the worktree path is user-customizable
- [x] A6 — RESOLVED (decision): auto-chain stays OFF by default (rate-limit-safe); enable per workspace via `/auto-chain review|both`
- [x] A7 — config.json auto-hydrates missing `cli.*` knobs (visible + editable; excludes /theme·/effort·/quiet)
- [ ] C1 — spawn-child loop continuation (parent loop stops while a child runs)
- [ ] C2 — input queue while busy (queue / view / remove messages mid-turn)
- [ ] B6 — `/memory verify` reconciliation sweep
- [ ] B7 — churn-weighted decay
- [ ] Release: version bump · changelog · roadmap · dist-manifest sync · publish

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
