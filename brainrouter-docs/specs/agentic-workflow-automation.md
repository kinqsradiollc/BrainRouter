<!--
  Implementation brief for an autonomous coding agent (Codex).
  Scope: agentic automation of the Requirement → Plan → Track workflow.
  Authoritative file pointers were spot-checked against the codebase on 2026-06-21.
  Ship the auto-behavior phases (2–5) DEFAULT-OFF behind cli.automation.* and dogfood before enabling.
-->

# Implementation Brief: Agentic Automation for the SWE Workflow

## Goal & principles

Make BrainRouter's existing **Requirement → Plan → Track** chain drive itself. Today every link is hand-cranked: the user runs `/requirement`, then `/requirement seed-plan`, then `track_update create`, then `track_update transition`. We want the agent to do this end to end — detect intent, structure a Requirement Record, plan against its acceptance criteria, materialise Track work items, walk them across states as real code lands, and decide sprint lifecycle — while staying out of the user's way.

Non-negotiables:

- **Reuse stores/tools.** No new persistence formats. Build on `requirementStore.ts`, `taskStore.ts`, `trackStore.ts`, and the `track_update`/`track_query` tools. Extend, don't fork.
- **Capture to memory with provenance.** Every auto-action emits through `emitAgentEvent` (`memoryEvents.ts`) carrying a `ProvenanceRef` (`sourceEventId`, `linkedMemoryIds`, `actor:'agent'`, `reason`) per the wire protocol in `agent-protocol/src/index.ts`. The chain brain→requirement→plan→work-item→commit must be traceable.
- **Deterministic guardrails, not prompting.** New automation lands as bounded turn-end seams next to `planSyncGuard` (agent.ts:2164), each with a `*_GUARD_MAX` budget. We add code that *acts*, not paragraphs that *ask the model to act*.
- **Ask only when genuinely ambiguous.** Clarifying questions are a last resort, gated by a confidence threshold; otherwise the agent proceeds on a best-guess draft the user can correct.
- **Everything reversible and visible.** Auto-created records are tagged `auto`, surfaced in the CLI/desktop, and easy to delete or override. A single `cli.automation.*` opt-out kills it.

## Current state

**Requirements** (`requirementStore.ts`, types in `packages/types/src/requirement.ts`) — durable `RequirementRecord` at `.brainrouter/cli/requirements.json` with states `draft→clarifying→ready→in-progress→done→archived`, `acceptanceCriteria[]`, clarifying Q&A, `sourceEventId`, `linkedMemoryIds`. CRUD + clarification helpers exist; `createRequirement`/`updateRequirement` already accept the provenance fields. Mutations capture via `captureRequirementNote()` → `emitAgentEvent`. **Gap:** nothing auto-creates a requirement from conversation.

**Planning** (`taskStore.ts`) — `seedPlanFromRequirement(workspaceRoot, {id, acceptanceCriteria}, sessionKey)` makes one pending plan item per criterion and anchors `plan.requirementId`. `updatePlan` preserves the anchor. `maybeAutoApprovePlan` (agent.ts:3817) auto-approves in fast mode with `planStepSignature` dedup. **Gap:** plan completion never reconciles requirement status or Track items.

**Track** (`trackStore.ts`, types in `packages/types/src/track.ts`) — one project/workspace; `WorkItem` (carries `requirementId`, `sessionKey`, `taskIds`, `codeLinks`, `sprintId`), `Sprint` (`future|active|completed`), `runAutomations` on `created`/`transitioned`. Agent tools `track_query` (`list|get|board`) and `track_update` (`create|transition|comment|link`) at specs.ts:375/391; executor branches in agent.ts. `createSprint`/`listSprints`/`setSprintState` exist but no agent tool reaches them. **Gap:** no commit→item heuristic, no bulk transition, no sprint-lifecycle action.

**Turn loop** (agent.ts:1023) — bounded guardrails at 2021–2233: `preambleGuard`, `promised-tools`, `fanOutGuard`, `deliverableGuard`, `planSyncGuard` (2164), `synthesisGuard`. Each follows: detect → inject system/user nudge → bump counter → `continue`. `this.lastTurnToolCalls` tracks activity. **This is the seam we extend.**

## Target flow

```
user/agent signal → Requirement (draft) → clarify? → ready → Plan → Track items → progress transitions → sprint decisions
        ↑                                                                                                    ↓
        └──────────────────────── memory capture w/ provenance at every edge ─────────────────────────────┘
```

**Signal → Requirement.** A pre-turn detector classifies the user prompt as requirement-shaped (imperative build/create/fix/add intent + a concrete object). If confidence ≥ `autoCreateThreshold` (default 0.7) **and** no open requirement already covers it (dedup, below), auto-create a `draft` requirement with `actor:'agent'`, `sourceEventId` from the detector's `emitAgentEvent`, and acceptance criteria parsed from the prompt. Confidence in `[lowAct, threshold)` → store a silent candidate, surfaced but not acted on. Below `lowAct` → nothing.

**Clarify (only if ambiguous).** A requirement is *underspecified* when it has < 1 acceptance criterion or the detector flags missing scope. Move it to `clarifying` and let the turn-end guard inject **at most one** batched clarifying question. If the user's prompt already answers it, skip. Never block the reply on an answer — the requirement waits in `clarifying`.

**Ready → Plan.** When a requirement has ≥ 1 criterion and no open clarifying questions, it's `ready`. A turn-end guard calls `seedPlanFromRequirement` (one plan item per criterion) and advances the requirement to `in-progress`. Dedup via `planStepSignature` so re-runs don't duplicate.

**Plan → Track items.** Each *seeded* plan item gets a `WorkItem` (`type:'task'`, `requirementId`, `sessionKey`, `actor:'agent'`, plan-item id in `taskIds`). One epic per requirement when criteria ≥ 3 (stories hang off it); otherwise flat tasks. Dedup on `(requirementId, planItemId)`.

**Progress transitions.** Item moves are driven by *real signals*, not guesses:
- **todo → in-progress** when a `codeLink` (branch/commit) is attached to the item this turn, or its plan item flips to in-progress.
- **in-progress → review** when a PR codeLink is attached.
- **review → done** when the linked plan item is `completed` (and, if present, a merged-PR codeLink exists). On `goal_complete`, reconcile all of the requirement's items whose plan items are completed.

**Sprint decisions.** Heuristic, conservative: ensure exactly one `active` sprint. If none active and there are ≥ `sprintMinItems` (default 3) ready/in-progress items, **create** a sprint and assign them. If an active sprint exists and is under capacity, **extend** it (assign new items). **Complete** when all its items are `done` *or* its `endDate` passed — then compute velocity from done items' story points and emit a retrospective memory note. Never auto-create a second active sprint.

## Architecture & hooks

**1. Requirement auto-capture (pre-turn).** New pure module `packages/core/src/requirement/requirementDetector.ts`: `detectRequirementShapedPrompt(prompt, context) → { detected, confidence, input: CreateRequirementInput, clarify?: string }`. Heuristic-first (imperative-verb + object regex, reusing `extractFilePathHints` from `memory-type-config.ts`); optionally upgraded by the existing next-action planner's classification (`nextAction.ts` already returns a strategy — `build`/`workflow` raises confidence). Wire into runTurn before the planner (agent.ts ~1242). On fire: `createRequirement` + `emitAgentEvent({ kind:'requirement-event', action:'created', provenance:{actor:'agent', reason:'auto-detect'} })`, then `callbacks.onMemoryEvent`. Read-only/idempotent; never blocks.

**2. New `track_update` actions + `track_query` reads.** Extend specs.ts:391 schema and the agent.ts executor branch:
- `assign-sprint` (`key`+`sprintId`) → `updateWorkItem`.
- `batch-transition` (`query`+`toStatus`) → `listWorkItems` filtered by `parseTrackQuery`, `transitionWorkItem` each.
- `sprint-start` (`sprintId`, optional `capacity`) → `setSprintState('active')` + start date.
- `sprint-complete` (`sprintId`) → `setSprintState('completed')` + velocity compute.

Extend `track_query` (specs.ts:379) with `sprints`, `sprint-detail`, `velocity`. Keep `track_update` `parallelSafe=false`, `track_query` `parallelSafe=true` (registry.ts).

**3. Requirement/Track sync guardrail (turn-end).** New seam after `planSyncGuard` (agent.ts:2164), pattern-identical, budget `SYNC_GUARD_MAX = 1`. Runs only when `this.lastTurnToolCalls > 0`. Logic (deterministic, in code — not a model nudge unless the model must supply a title):
- ready requirement w/o plan → `seedPlanFromRequirement` + advance to `in-progress`.
- seeded plan items w/o work items → create items (dedup on `requirementId`+planItemId).
- plan items completed this turn whose linked items aren't `done` → `transitionWorkItem`.
- codeLink attached this turn to a `todo` item → transition to `in-progress`.
- sprint heuristic eval (create/extend/complete per rules above).

Each action emits provenance. The guard only injects a *model* message when it needs a human-readable title/criterion it can't derive.

**4. Fulfillment cross-link (tool-call decorator).** In `processOneToolCall` (agent.ts ~2308), after arg parse, when `track_update.action==='transition'` to a done-category status, find matching open requirements and `updateRequirement` + `linkRequirement`. Non-blocking, inline.

**5. Post-turn durability.** Before runTurn's return (agent.ts ~2830), a fire-and-forget capture summarising auto-actions taken this turn, so headless/silent agents don't lose provenance.

## Phased implementation

**Phase 1 — Track sprint & batch tools (independently shippable).**
Files: `packages/core/src/tool/specs.ts`, `agent/agent.ts` (track_update/track_query branches), `track/trackStore.ts` (add `updateSprint` for startDate/capacity/velocity if absent), `cli/commands/track.ts`.
Contracts: new actions `assign-sprint|batch-transition|sprint-start|sprint-complete`; new queries `sprints|sprint-detail|velocity`.
Tests: unit on each new branch (Vitest) — `batch-transition` respects `parseTrackQuery`; `sprint-complete` computes velocity from done story points; one-active-sprint invariant.
Acceptance: agent can drive the full sprint lifecycle manually via tools; no auto-behavior yet.

**Phase 2 — Requirement auto-detection (pre-turn, off by default).**
Files: new `requirement/requirementDetector.ts`; `agent/agent.ts` wiring; `config` reader for `cli.automation.*`.
Contracts: `detectRequirementShapedPrompt`; `cli.automation.requirements.enabled` (default false initially), `autoCreateThreshold`, `lowActThreshold`.
Tests: detector truth-table (imperative+object → detected; question/chit-chat → not); dedup against existing open requirements; provenance stamped.
Acceptance: with flag on, "add a rate-limiter to the gateway" creates a `draft` requirement tagged `auto` with parsed criteria; "what does X do?" creates nothing.

**Phase 3 — Plan + Track sync guardrail (turn-end).**
Files: `agent/agent.ts` (new guard seam), reusing `seedPlanFromRequirement`, `createWorkItem`, `transitionWorkItem`.
Contracts: `SYNC_GUARD_MAX=1`; guard config under `cli.automation.sync.enabled`.
Tests: ready-req → plan seeded + status `in-progress`; seeded items → work items (no dupes on re-run); completed plan item → linked item `done`; budget caps at 1 fire/turn.
Acceptance: a `ready` requirement, with no manual commands, produces a plan and a board column of items in one turn.

**Phase 4 — Progress transitions from code signals + fulfillment cross-link.**
Files: `agent/agent.ts` (`processOneToolCall` decorator), sync guard (codeLink→in-progress/review rules), `track/trackStore.ts` (helper to find items by codeLink).
Tests: branch codeLink moves `todo`→`in-progress`; PR codeLink moves to `review`; transition-to-done back-links the requirement.
Acceptance: linking a commit/PR via `track_update link` advances the board without a separate transition call.

**Phase 5 — Sprint decision heuristic + goal_complete cascade.**
Files: sync guard (sprint create/extend/complete), `goal/goalStore.ts` completion path, agent.ts goal_complete handler.
Contracts: `cli.automation.sprints.{enabled,minItems,respectCapacity}`.
Tests: ≥minItems ready → sprint created+assigned; existing active sprint → extend not create; all-done → completed + velocity note; goal_complete reconciles requirement→`done`.
Acceptance: end-to-end — a prompt becomes requirement→plan→items→sprint→done with provenance at each edge, no manual commands.

**Phase 6 — Surfacing + opt-out polish.**
Files: `RequirementsPanel.tsx`, `requirementsView.ts` (auto badge, dismiss), desktop `host.ts` (`requirement-link` endpoint, `sourceEventId`/`priority` passthrough — extension points already noted), CLI `track.ts`/`requirement.ts` listing of auto items.
Tests: view helpers render auto/provenance badges; dismiss reverts.

## Guardrails & safety

- **Confidence thresholds.** Auto-create only ≥ `autoCreateThreshold` (0.7). `[0.4,0.7)` → silent candidate, surfaced, not acted on. < 0.4 → ignored.
- **Dedup everywhere.** Before create: requirement match by normalised title/criteria over open records; plan via `planStepSignature`; work items keyed on `(requirementId, planItemId)`; sprints by the one-active invariant. Re-running a turn is a no-op.
- **Bounded.** Each guard has `*_GUARD_MAX` (1 except detection). They run only when `lastTurnToolCalls > 0`, mirroring `planSyncGuard`. They can never loop or stack.
- **Never blocks the reply.** Detection is pre-turn read-only; capture is best-effort via `emitAgentEvent` (already swallows failures); the clarify question is injected, not awaited.
- **Visible + reversible.** Auto records carry `actor:'agent'` + `reason`, render with an "auto" badge, and are deletable (`deleteRequirement`, `deleteWorkItem`). Provenance lets the user trace and undo any cascade.
- **One opt-out knob.** `cli.automation.enabled` (and per-stage `requirements`/`sync`/`sprints` sub-flags) in config.json's `cli.*`. No new `BRAINROUTER_*` env vars. Ship Phases 2–5 default-**off**; flip on after dogfooding.

## Risks & open questions

1. **Sprint-creation heuristics are the genuinely hard call.** `minItems=3` and capacity rules are guesses. Should a sprint auto-start, or only be *proposed* for one-click confirmation? Auto-completing on a passed `endDate` could close a sprint with in-flight work — do we require all-done, or all-done-or-expired? **Product owner decision needed.**
2. **False-positive requirement detection.** Heuristic intent parsing will misfire on rhetorical/exploratory prompts ("maybe we should rewrite the parser"). Default-off + silent-candidate band mitigates, but the threshold needs tuning against real transcripts. Do we want a per-workspace learned threshold, or a fixed global one to start?
3. **Acceptance-criteria parsing quality.** One plan item per criterion is only as good as the criteria the detector extracts from prose. Poor extraction yields noisy plans/boards. Should Phase 2 require the model to confirm extracted criteria before they harden into a `ready` requirement?
4. **Code-signal reliability for transitions.** todo→in-progress→review→done assumes branches/PRs are linked via `track_update link`. If the agent forgets to link, the board stalls. Do we add a complementary commit-message `BR-123` scanner (noted as a Track gap) to catch unlinked work?
5. **Cross-session affinity.** Requirements anchor to a `sessionKey`, but a long feature spans sessions. How aggressively should sync reconcile requirements from *prior* sessions in the same workspace?

---

Key file pointers for Codex: guard seam to copy — `packages/core/src/agent/agent.ts:2164` (`planSyncGuard`); tool schemas — `packages/core/src/tool/specs.ts:375,391`; sprint store — `packages/core/src/track/trackStore.ts:391+`; requirement provenance fields — `packages/core/src/requirement/requirementStore.ts` + `packages/types/src/requirement.ts`; memory capture — `packages/core/src/memory/memoryEvents.ts` (`emitAgentEvent`); plan seeding — `seedPlanFromRequirement` in `packages/core/src/task/taskStore.ts`.
