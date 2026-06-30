---
name: fleet-migration
description: Apply one change across many repos or packages as N independent agent runs that each end in a verified PR. Use when the same migration (dependency bump, API rename, lint fix, codemod) must land across a fleet, when you'd otherwise hand-apply patches one by one, or when designing a background coding-agent that fans a task out at scale. Use after a single-repo recipe is proven. References migration-skill for the per-repo change itself.
hints: |
  - Prove the recipe on ONE repo first (it must end green); a fleet is just N parallel runs of a proven recipe.
  - Each run is isolated (its own worktree/sandbox), bounded (turns + retries), and ends at a PR — never a hand-apply patch.
  - Use a global concurrency cap + durable queue, not per-session slots; the run must survive a host restart.
  - A failed verify must block that repo's PR, not the whole fleet — isolate failures per repo.
  - Make enqueue idempotent so re-triggering a fleet doesn't double-open PRs.
---

# Fleet Migration (one change → many PRs)

## Overview

When the same change must land across many repos or packages, the slow path is doing it by hand or producing a pile of patches to apply. The scalable path is a **fleet migration**: a proven single-repo recipe, fanned out as N **isolated, bounded** agent runs, each ending in its **own verified PR**. This skill is the orchestration around a per-repo change (the change itself is `migration-skill`).

## When to Use

- One migration (dep bump, API rename, codemod, config/lint fix) must apply across a fleet of repos/packages
- You're about to hand-apply the same patch repo by repo
- You're building a background coding-agent that needs to operate at scale
- A platform change requires coordinated PRs everywhere it's consumed

**When NOT to use:** a one-off change in a single repo (just do it); or a change whose per-repo shape varies so much there's no shared recipe (then it's N bespoke tasks, not a fleet).

## Workflow

1. **Prove the recipe on one repo.** Run the change end-to-end in a single worktree; it must finish **green** (build + test). Capture it as a reusable recipe/workflow (the `build`-style verify→fix→gate loop).
2. **Enumerate the fleet** and the per-repo inputs. Make the enqueue **idempotent** (keyed by task+repo) so re-runs don't double-open PRs.
3. **Fan out under a global cap.** Run N isolated jobs — each its own worktree + sandbox, bounded turns/retries, safe-default sandbox for unattended execution — limited by a **shared** concurrency cap (not per-session slots), backed by a **durable** queue that survives restarts.
4. **End each run at a PR.** On green + gate, push a branch and open a PR per repo (the PR-emit step). On red, that repo stops at its failure — it does not block the others.
5. **Observe + reconcile.** Track queue depth, per-job state, and PR links in a fleet console; re-queue only the failed repos.

## Patterns

- **Recipe-first:** a fleet is N runs of a proven recipe — never debug the recipe at fleet scale.
- **Isolate-per-repo:** failures, secrets, and worktrees are per job; one bad repo can't poison the fleet.
- **PR-per-task:** the run terminates at a PR, not a local patch — that's the whole point of fleet scale.
- **Idempotent enqueue:** triggering twice is a no-op, so retries and external triggers are safe.
- **Global cap + durable queue:** concurrency is accounted org-wide and the run is restart-safe.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "I'll just loop the change over the repos." | A naive loop has no isolation, no concurrency cap, no per-repo failure handling, and ends in patches, not PRs. |
| "Per-session slots are fine." | They cap one parent session, not the fleet — you'll over-run concurrency across jobs. |
| "Skip the single-repo proof, fan out directly." | A broken recipe fails N times; you debug at scale instead of once. Prove on one first. |
| "End at patches, the user can apply them." | N hand-applies defeats the automation. The verified PR is the deliverable. |

## Red Flags

- The recipe wasn't proven green on one repo before fan-out.
- A single repo's failed verify halted or polluted the whole fleet.
- Concurrency is per-session; jobs swamp the machine.
- The fleet emits patches, not PRs; or re-triggering double-opens PRs (enqueue not idempotent).
- The queue is in-memory and a restart loses the run.

## Verification

- Single-repo recipe finishes green before any fan-out.
- A fleet run over N sample repos opens N PRs, each behind its own green verify gate.
- A deliberately-failing repo produces no PR and does not stop the others.
- Re-triggering the same fleet opens zero new PRs (idempotent).
- The run survives a host restart (durable queue) and respects the global concurrency cap.
