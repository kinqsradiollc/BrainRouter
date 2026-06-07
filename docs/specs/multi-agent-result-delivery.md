# Spec: Multi-agent result delivery — completed children flow back to the main agent

> Status: **DRAFT.** Target: 0.4.13.
> Sequel to C1 (0.4.12 auto-resume) and a prerequisite for the CODEX-CHILD-TRANSPORT event channel.

## Problem

When a spawned / delegated sub-agent (or a workflow phase) finishes, its result is
not reliably delivered back to the **main** agent as a continuation — so the user
gets no follow-up response after the child completes.

Observed (real session, weak local model, 2026-06-06):

- A `delegate_explorer` returned real findings, but the model answered "I've
  launched an exploration agent… I will summarize when complete" and ended the turn
  without synthesizing the returned result.
- A background `spawn_agent` explorer printed "🏁 completed" **after** the turn, yet
  the main agent produced no synthesis.
- Asked "has it completed?", the main agent called `list_agents`, could not
  correlate the finished child, and kept insisting it was "still working".

The user's framing: *"When sub-agents / tasks / workflows respond back to the main
agent, should it be treated as messages?"* — **Yes.** Today it isn't.

## Current behavior (traced)

| Path | Where | Behavior |
|---|---|---|
| Foreground delegate / `task_agent` (`wait: true`) | `orchestration/tools.ts` `handleWait` → `summarize(includeOutput)` | Returns the child's full result **inline**. Correct — but a weak model may ignore it. |
| Background `spawn_agent` (`wait: false`) | `orchestration/tools.ts` `handleSpawn` | Returns metadata only (`status: 'running'`). Result lands in the session store. |
| Turn-end drain guardrail | `agent/agent.ts` `runTurn` L1547–1599 | Fires **only** when the model ends with no tool calls AND has unobserved children. Auto-drains them with `childDrainTimeoutMs`. On **timeout** → sets `lastTurnPendingChildIds` (arms C1) + answers "still draining". On success → injects results, forces synthesis. |
| C1 auto-resume | `runtime/childResume.ts` + `runChat.tsx` `scheduleChildResume` (L470, called L848) | Polls the ids in `lastTurnPendingChildIds`; on settle, fires a synthetic continue. **No-ops when that array is empty.** |
| Child-completion event | `runChat.tsx` `onChildComplete` L753–772 | Pushes a cosmetic scrollback row. **No continuation, no re-entry into the main loop.** |

### Root-cause gaps

1. **Resume arms only on timeout.** `lastTurnPendingChildIds` is populated **only**
   in the timeout branch (`agent.ts:1578`). A background child that is still running
   at natural turn end — but did **not** trip the drain timeout path — is never
   recorded, so `scheduleChildResume()` (L848) no-ops and the child is orphaned.
2. **Completion is cosmetic.** `onChildComplete` never feeds the result back into the
   main loop, so when a child finishes after the turn (and nothing is polling) there
   is no event-driven path to a synthesis response.

## Design

Generalize "pending child synthesis" from *timed-out* to *any child spawned this
turn that the main agent never synthesized*, and drive the resume both ways: by
poll (existing C1 timer) **and** by completion event.

- **MAR-1 — arm the resume for unsynthesized children, not just timeouts.**
  At natural turn end, compute the spawned-this-turn children that were never
  observed/synthesized (`spawnedChildIdsThisTurn − waitedChildIdsThisTurn`, still
  alive) and record them in `lastTurnPendingChildIds` (in addition to the existing
  timeout case). `scheduleChildResume()` then arms for them. Pure helper for the
  set difference so it is unit-testable; no behavior change when the set is empty.

- **MAR-2 — make child completion an event-driven continuation.**
  When `onChildComplete` fires for a child that is in the pending-synthesis set and
  **no turn is in flight**, trigger the resume immediately (reuse
  `scheduleChildResume` / `buildChildResumePrompt`, serialized through the C2 input
  queue so it never collides with user input or a goal continuation). This is the
  fast path; the C1 poll remains the fallback.

- **MAR-3 — weak-model synthesis guard.** When a `delegate_*` / `task_agent` result
  was returned this turn but the model's final answer does not consume it (e.g.
  "I'll summarize later"), a bounded turn-end guardrail (sibling of the child-drain
  and preamble guards) forces one synthesis pass. Bounded to avoid loops.

- **MAR-4 — result correlation on status checks.** Thread the tracked pending ids
  into the status/resume path so "is it done?" resolves the just-spawned child(ren)
  via `wait_agents` / `read_agent_transcript` on those exact ids instead of the
  model guessing an id out of a long `list_agents` array.

### Ordering & branches

Each lands as its **own** branch → PR into `release/0.4.13`:
`fix/mar1-arm-resume-on-complete`, `fix/mar2-completion-continuation`,
`fix/mar3-synthesis-guard`, `fix/mar4-status-correlation`. MAR-1 + MAR-2 are the
core delivery fix; MAR-3 + MAR-4 are robustness follow-ons.

## Non-goals

- A structured child→parent streaming transport (that is CODEX-CHILD-TRANSPORT).
- Changing the foreground delegate/`task_agent` return contract (already correct).
- Fixing weak-model quality generally — only the deterministic delivery + a bounded
  synthesis nudge.

## Test plan

- Pure unit: the set-difference helper (spawned − observed, alive only) — empty,
  partial, all-settled.
- `childResume` already covered; add: a normally-completed (non-timeout) child arms
  the resume; a child that vanished does not block it.
- MAR-2: `onChildComplete` with no turn in flight enqueues exactly one continuation;
  with a turn in flight, it defers to the poll.
- Guardrail (MAR-3): result returned but not consumed → one forced synthesis pass,
  then stop.

## Success criteria

1. A background `spawn_agent` that finishes after the turn produces a visible
   main-agent synthesis with no manual `/continue`.
2. "Has it completed?" resolves the tracked child(ren) without guessing ids.
3. No duplicate continuations (poll + event must not both fire).
4. Single-agent chat and existing C1/C2 behavior unchanged; suite green.
