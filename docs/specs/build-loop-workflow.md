# Spec: The Build Loop — a default engineering workflow

> Status: **DRAFT — design only, not yet approved.** No code until sign-off.
> Target: 0.4.12 (sequel to the 0.4.11 worktree isolation + merge-back work).
> Owner: TBD.

## Objective

Compose BrainRouter's existing orchestration parts — roles, the phase engine,
auto-chain, the next-action planner, and the new (0.4.11) per-child worktree
isolation + merge-back — into **one coherent engineering loop** for the
bread-and-butter "implement / fix / refactor X" request:

```
Plan ──▶ Implement ──▶ Verify ──▶ Review ──▶ Merge-back
(read)    (write, in     (shell, in      (read,      (only if verify
          worktree W)    SAME W)         diff of W)   green + review ok)
```

Today the parts exist but aren't composed: the phase engine only fires for
multi-phase work, the templates cover compare/review/research (not *build*),
auto-chain is a hidden toggle, and the 0.4.11 worktree isolation merges back on a
single worker's completion with no verify/review gate. A software engineer
expects the roles to behave like a *pipeline*, not a menu. This spec defines that
pipeline and the one new mechanic it needs.

### Why opt-in, not default-on

The reliable default is a **strong single-agent loop** with good tools +
approvals; heavy orchestration is the *exception*, reserved for work that
benefits. So the build loop is **escalated into**, never forced on every task — a
one-line fix should not spawn a 4-phase pipeline.

## Current Behavior (what already exists — reuse, don't rebuild)

- **Roles** (`orchestration/roles.ts`): explorer/architect (read), worker (write),
  verifier (shell), reviewer (read), each with a memory-first overlay + least-
  privilege access.
- **Phase engine** (`orchestration/phaseOrchestrator.ts` `executePhasePlan`):
  runs a `PhasePlan` phase-by-phase (topological by `dependsOn`), each phase
  fans out children in parallel waves, barrier-waits, synthesizes, feeds
  `{{input}}` forward. Resumable (`state/workflowRun.ts`, WF-RESUME).
- **Templates** (`orchestration/workflowTemplates.ts`): compare / review-wide /
  research.
- **Auto-chain** (`orchestration/autoChain.ts`): worker→reviewer/verifier
  follow-ups (modes off/review/verify/both).
- **Next-action planner** (`prompt/nextAction.ts`): pre-flight classify →
  answer-direct / investigate / fan-out / workflow (+ a prepared `PhasePlan`).
- **Worktree isolation + merge-back** (0.4.11, `orchestration/worktreeIsolation.ts`):
  a write/shell child works in a detached worktree `W`; on clean completion its
  diff is `git apply --check`-gated and merged onto the parent tree, else
  preserved as a recovery patch (`/agents diff <id>`).

## The Gap (why composition needs one new mechanic)

The 0.4.11 merge-back is **per-child**: a worker completes → its worktree merges
immediately. A build loop needs the worktree to **outlive the worker** so the
verifier runs the tests *against the worker's actual changes* and the reviewer
reviews that diff — and merge-back happens **once, at the end, gated**. Two
concrete problems with naive composition:

1. **Stale-tree verify** (already observed in 0.4.11 A1): a separately-spawned
   verifier gets a *fresh* worktree off `HEAD`, so it can't see the worker's
   un-merged edits. Verifying the wrong tree is worse than not verifying.
2. **Premature merge:** merging on worker completion means unverified,
   unreviewed code lands in your tree.

**The one new mechanic: a phase-scoped (shared) worktree.** The worker, verifier,
and reviewer of a build run all operate on the **same** worktree `W`; `W` is
created when the loop's Implement phase starts and merged back only after the
Verify + Review gates pass.

## Proposed Design

### The loop (a `build` PhasePlan)

| Phase | Role (access) | Runs in | Output / gate |
|---|---|---|---|
| 1 · Plan | architect (read) | parent tree | a short plan + the first vertical slice (reuses the next-action planner's reasoning) |
| 2 · Implement | worker (write) | **shared worktree `W`** | edits captured in `W`; nothing merged yet |
| 3 · Verify | verifier (shell) | **the same `W`** | runs build/tests; emits **green/red** + evidence |
| 4 · Review | reviewer (read) | the **diff of `W`** | findings; clean / `Ask first` to merge on blockers |
| 5 · Merge-back | — | `W` → your tree | applies **iff** verify green AND review ok; else preserve patch + report |

- Phases 2–4 share `W` (the new phase-scoped worktree). Phase 5 is the gated
  merge, reusing the 0.4.11 check-then-apply machinery (`applyPatchFile`).
- A red verify or a blocker review **stops the merge** and leaves `W`'s work as a
  recovery patch — same no-loss fallback as 0.4.11, surfaced via `/agents diff`.

### Escalation (opt-in)

A new knob `cli.buildLoop: 'off' | 'escalate' | 'always'` (default **`escalate`**):

- **`off`** — never automatic; only the explicit `/build <task>` command.
- **`escalate`** (default) — the next-action planner enters the loop **only** when
  it classifies the task as multi-file / feature-scale; single-agent loop
  otherwise. `/build` always works.
- **`always`** — every implementation verb routes through the loop.

`/build <task>` is the explicit manual trigger in every mode.

## Architecture Changes

- **New** `orchestration/workflowTemplates.ts` → `buildLoopTemplate(task)` — the
  `build` `PhasePlan` (plan→implement→verify→review) with a `mergeGate` marker.
- **New** `/build <task>` CLI command (mirror the `/spawn` / `run_workflow` path).
- **Extend** `worktreeIsolation.ts` + `phaseOrchestrator.ts` with a **phase-scoped
  worktree**: create on Implement-phase start, attach the Verify + Review children
  to it (pass `workspaceRoot = W` instead of preparing a fresh one), merge-gate at
  the end. This is the core new code; everything else is composition.
- **Extend** `prompt/nextAction.ts` with a `build` strategy + the escalation
  classifier (multi-file/feature detection), gated by `cli.buildLoop`.
- **Config** `cli.buildLoop` knob (+ interface doc + `resolveCliKnobs` default +
  `/debug-config`).
- **Reuse unchanged**: roles, the phase engine's wave/barrier/synthesis, WF-RESUME
  persistence, the 0.4.11 check-then-apply + recovery-patch + `/agents diff`.

## In Scope

- The `build` template + `/build` command.
- The phase-scoped shared worktree (Implement→Verify→Review on one `W`).
- Verify-green + review-ok merge gate, with the 0.4.11 no-loss fallback.
- `cli.buildLoop` escalation knob (default `escalate`).
- Planner escalation classifier for multi-file/feature tasks.

## Out of Scope

- Per-session isolation (separate spec, `per-session-isolation.md`).
- Non-git workspaces (the loop degrades to the shared tree, no isolated `W`).
- Durable/resumable per-agent threads (tracked separately; a build run is still
  resumable at the *phase* level via WF-RESUME).
- Auto-fixing a red verify (the loop reports; it doesn't loop-until-green in v1).

## Boundaries

- **Always:** keep the single-agent loop as the default; run Verify in the **same**
  worktree the worker edited; preserve `W`'s work as a recovery patch on any
  non-merge; show the active phase in the UI.
- **Ask first:** before merging when Review raises a blocker; before entering the
  loop automatically when `buildLoop: 'escalate'` and confidence is borderline.
- **Never:** merge on a red verify; merge unreviewed code when review is enabled;
  tear down `W` before its work is either merged or saved as a patch; force the
  loop on a trivial / single-file change under `escalate`.

## Success Criteria (Definition of Done)

- [ ] `/build "<task>"` runs plan→implement→verify→review→merge end-to-end in a
      git repo; the worker's changes are verified **in their own worktree** before
      landing.
- [ ] A **red verify** blocks merge-back; the work is recoverable via
      `/agents diff <id>`; nothing lands in the user's tree.
- [ ] A **clean run** lands the changes in the user's tree exactly once, after
      verify + review pass.
- [ ] `cli.buildLoop: 'off'` → only `/build` triggers it; `'escalate'` → a
      single-file fix stays single-agent while a multi-file feature enters the
      loop; `'always'` → every implementation verb enters it.
- [ ] The active phase is visible in `/ps` / `/agents` and the statusline.
- [ ] A killed build run reconciles on next boot (WF-RESUME) and `W` is GC'd
      (reuses the 0.4.11 worktree + patch reconcile).
- [ ] Deterministic tests: template shape, phase-scoped worktree lifecycle,
      merge-gate (green vs red), escalation classifier, non-git fallback.

## Risks & Mitigations

- **Shared-worktree lifecycle bugs** (W leaks if a phase crashes) → reuse the
  0.4.11 `reconcileOrphanWorktrees` + patch GC; cover with lifecycle tests.
- **Slowness** (4 phases for small work) → that's exactly why the default is
  `escalate`, not `always`; `/build` is explicit.
- **Verifier needs deps installed in `W`** — a fresh worktree shares the repo but
  not `node_modules`/build caches. Mitigation: `W` is a *linked* worktree of the
  same repo, so symlinked/ignored artifacts are visible; document the caveat and
  let the verify phase run install if needed.
- **Review subjectivity blocking merges** → review gate is `Ask first`, not a hard
  block; the user/parent decides.

## Open Questions

1. Loop-until-green: should a red verify auto-spawn a follow-up worker to fix
   (bounded retries), or just report? (v1: report. v2: bounded retry.)
2. Does Plan (Phase 1) reuse the existing next-action planner output directly, or
   run a dedicated architect child? (Leaning: reuse planner; architect only for
   genuinely ambiguous design.)
3. Where does the merge gate live — in the phase engine (a `mergeGate` phase kind)
   or in a build-loop-specific runner? (Leaning: a small `mergeGate` phase kind so
   other templates can reuse it.)
4. Interaction with `childWorkspaceIsolation: 'off'` — does `/build` force a
   worktree, or honor `off` and run in the shared tree (no isolation, immediate
   edits)? (Leaning: honor `off` = shared tree, skip the merge gate.)

## Phased Plan

1. **P1 — `build` template + `/build` command.** Pure composition over the
   existing phase engine (no shared worktree yet — phases run as today). Ships a
   visible plan→implement→verify→review pipeline. *Smallest first slice.*
2. **P2 — Phase-scoped shared worktree + merge gate.** The core new mechanic:
   Implement/Verify/Review share `W`; merge only on verify-green + review-ok. Fixes
   the stale-tree verify gap.
3. **P3 — Escalation.** `cli.buildLoop` knob + planner classifier for
   multi-file/feature tasks (default `escalate`).
4. **P4 — Surface it.** Statusline phase indicator + `/ps` / `/agents` show the
   active build phase.
5. **P5 — (stretch)** bounded loop-until-green retries + per-agent thread
   durability so a build run resumes mid-phase, not just between phases.
