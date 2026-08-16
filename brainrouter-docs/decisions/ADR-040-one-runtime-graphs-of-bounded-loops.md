# ADR-040 — One runtime, graphs of bounded loops

**Status:** ACCEPTED — owner approved on 2026-08-13.

**Target:** `release/0.4.20` for the decision only. Every implementation slice ships in a separate
pull request after acceptance.

**Builds on:** ADR-022 (persona and authority contracts), ADR-023 (profile-specific orchestration),
ADR-025 (runtime boundaries), ADR-028 C1 (one honest turn engine), and the existing workflow graph
and phase-plan runtimes.

**Reframes, but does not revive:** ADR-027 D2 and Q5. Their second turn engine was withdrawn and
deleted because it never reached runtime parity. This decision keeps that deletion.

**Date:** 2026-08-13

---

## 0. The decision in one page

BrainRouter already has both loops and graphs. What it does not have is one runtime decision that
explains how they fit together.

The primary agent runs one bounded turn loop. Profile strategies are bounded stage graphs around
that loop. Durable phase plans and saved visual workflows are two more graph-shaped orchestration
layers. Engineering also has repair and critic loops. The mistake would be to turn those facts into
another `loop | graph` engine switch.

We will instead make the architecture explicit:

> **One shared turn engine. A Core-owned topology policy chooses the smallest eligible execution
> shape. Graph nodes that need agency run the same bounded loop. CLI and Desktop render the same
> execution map produced from actual runtime events.**

**Normal conversation is the primary entry path.** Every eligible top-level user-authored turn goes
through the same Core topology policy in CLI and Desktop, whether or not a goal is active. Without
a goal, the turn itself is the root execution. With a goal, an optional supervisor only links the
same turn executions across continuations; goal presence alone does not enable routing or create a
different selection path. Explicit inherited goal ceilings may only narrow authority.

For a top-level conversational turn, the policy chooses either:

1. **direct turn** — one primary bounded loop; or
2. **profile plan** — a validated per-profile graph whose primary stages are enforced inside the
   owning bounded loop and whose delegated agent nodes run that same engine as bounded children.

An explicitly launched durable workflow may instead use a phase plan or saved workflow graph. The
adaptive policy never silently starts durable work.

The target applies to all 17 workspace profiles and both hosts. It does not mean every profile must
spawn children. A direct strategy is a valid graph choice; `custom` remains off/direct by default;
and profiles may constrain automatic selection until their own evaluation passes.

The Desktop's existing Workflows panel becomes the broader **Orchestration** surface while retaining
its stable panel ID. It gains **Runs | Design** views: Design edits definitions; Runs shows normal
turns as well as goal-linked and explicitly launched work, including nodes, edges, loop iteration
and budget, agent/role/skill, child transcript links, retries, approvals, guards, fallback, and
terminal state. CLI gets the same projection as a compact timeline/tree and JSON — not a separate
interpretation.

This ADR records the target. None of the gaps below is fixed merely because this file exists.

---

## 1. Where the runtime actually is

| Layer | Current owner | Shape today |
|---|---|---|
| Primary agent turn | `Agent.runTurn` / `runTurnImpl` | One bounded model/tool loop with hard ceilings, repeat guards, steering boundaries, verification, and tier escalation |
| Profile orchestration | `resolveActiveTurnOrchestration` / `ProfileStageController` | An ephemeral, validated stage DAG active inside the owning turn |
| Durable phase workflow | `executePhasePlan` / `WorkflowRun` | Dependency-ordered phases with concurrency-limited child fan-out and a project-local run ledger |
| Saved visual workflow | `runGraph` / `WorkflowGraph` | A topologically executed node graph with explicit loop, branch, approval, agent, and subworkflow node types |
| Engineering optimization | `repairUntilGreen` / `refineUntilAccepted` | Bounded repair and critic feedback loops inside the build workflow |
| Goal continuation | `decideGoalContinuation` | A host-facing decision about whether another turn is required |

This is a **hybrid hierarchy**, not an unfinished migration from loop to graph:

```text
top-level conversational turn (goal optional)
  -> topology decision
     -> direct bounded loop
     OR profile stage graph
        -> primary bounded loop
        -> delegated bounded loop(s)

explicit durable launch
  -> phase plan or saved workflow graph
     -> deterministic node(s) + bounded loop node(s)
```

The one-turn-engine rule is deliberate and pinned by `execution-engine-retired.test.ts`. The deleted
graph turn engine lacked interrupts, tool authorization, receipts, and delegation. A second engine
would have to reproduce every safety and lifecycle property of `runTurnImpl`; that parity cost was
the design, not a branch at dispatch.

### 1.1 The graph work that is already real

- Every bundled orchestration definition is a bounded stage graph. Engineering, Research, Data
  Science, Study, and Writing have different work shapes; Custom has only a primary fallback.
- `PhasePlan` represents dependency edges, input hand-off, fan-out, and synthesis for explicitly
  launched durable work.
- `WorkflowGraph` represents a visual data-flow definition with branches, an explicit loop node,
  approvals, agent nodes, and subworkflows.
- Child sessions already carry parent/depth identity and trace context.
- The shared agent protocol carries tool, child, plan, and profile-stage events to Desktop. CLI
  receives equivalent Core callbacks directly, which is useful behavior but not yet one shared
  execution projection.

Normal chat already reaches the right architectural boundary: CLI and Desktop both call
`Agent.runTurn`, and each eligible root turn calls `resolveActiveTurnOrchestration` without requiring
a goal. The missing work is not a goal bypass. Today that resolver sees only the current prompt,
does not call the managed adaptive selector, has the profile-identity gaps below, and does not emit
the canonical execution map required by Runs.

So the answer to “are we already graph engineering?” is **yes at the orchestration layers, no as one
coherent runtime contract**. The graph shapes do not yet share selection, safety, events, run
identity, persistence, or a truthful execution view.

### 1.2 The gaps this decision must close

1. **Adaptive selection is implemented but not active.**
   `resolveAdaptiveWorkspaceOrchestrationPlan` is bounded, schema-checked, timeout-protected, and
   tested, but has no production caller. Active turns call the deterministic resolver directly, so
   the first available signal match wins and `selectionSource: adaptive-model` is unreachable in
   production.

2. **Onboarding and runtime disagree for 11 profiles.**
   `ORCHESTRATION_PLAN_ALIASES` correctly maps domain profiles onto one of the six shared work-shape
   plans during onboarding. Active-turn resolution performs an exact lookup by workspace profile ID,
   then the resolver requires exact definition/profile equality. The aliased profiles therefore
   fall to direct primary execution despite having reviewed plan defaults.

3. **“All profiles” cannot mean “copy Engineering.”**
   Study and Writing intentionally default to explicit orchestration; Custom defaults off. Research,
   Data Science, and the domain profiles have different roles, skills, evidence, and failure
   semantics. The routing contract must be domain-neutral while each profile owns its eligible
   strategies and activation gate.

4. **The lifecycle contract still calls live data a preview.**
   The resolver exposes `activation: 'preview'`, while `runTurnImpl` now creates a
   `ProfileStageController` and enforces the selected stages. That stale vocabulary makes it harder
   to tell a safe preview from an active authority decision.

5. **Current events cannot reconstruct the requested view.**
   Profile-stage events expose state, executor, role, and skill, but not dependency edges, objective,
   fan-out, approval, attempts, child correlation, timing, loop iteration/budget, guards, or terminal
   reason. CLI and Desktop flatten them into transient status rows.

6. **The visible workflow canvas is a definition editor, not a runtime inspector.**
   Its test-run path uses a stub agent and shows only final node outcomes. Durable phase runs appear
   separately as linear cards. Neither surface can show a primary loop, profile stages, children, or
   active edges as one execution.

7. **Saved workflow graphs are not yet a production-safe alternative path.**
   An approval node defaults to approved when no approval callback exists, and the production graph
   tool does not supply that callback. Agent-node role/access configuration is not enforced by the
   current task-agent wiring. Graph execution also has no cancellation signal, run event stream, or
   run ledger. No adaptive policy may select this path until those gaps fail closed.

8. **Optimization history disappears.**
   The Engineering repair/critic loops replace the latest phase execution rather than recording
   iterations. A person cannot see which attempt failed, what guard sent work back, or why the loop
   stopped.

9. **Explicit strategies have no authoritative entrypoint.**
   The resolver can validate an `explicitStrategyId`, but the active-turn caller never supplies one
   and neither host can attach trusted user/command provenance. Study and Writing therefore have
   reviewed explicit strategies that an ordinary turn cannot select.

10. **Goal continuation is an outer loop with two implementations.**
    A goal can schedule several turns. Desktop uses the shared continuation decision while CLI
    mirrors its logic. Without a supervisor execution and continuation edges, a “complete” map
    would omit an existing loop and preserve a host-drift seam.

11. **The current durable ledger mixes view and resume payload.**
    Phase resume relies on serialized prompts and synthesized output stored in `run.json` (the field
    named `aggregatedOutputRef` is currently inline text). That data cannot also be the redacted
    control-plane view sent to a renderer. One slug also has only one mutable `run.json`, so repeated
    or concurrent executions and recent-run history have no stable identity.

12. **Current executors disagree about failure.**
    A saved graph stops on its first node error, a profile plan cancels descendants of a failed
    required stage, and a phase plan can continue beyond a failed phase. A shared status vocabulary
    without shared dependency/failure rules would only make those differences harder to see.

---

## 2. Terms we will use precisely

| Term | Meaning in BrainRouter |
|---|---|
| **turn loop** | One bounded observe/model/tool/verify cycle owned by `runTurnImpl` |
| **topology** | The shape selected for one execution: direct, profile plan, phase plan, or workflow graph |
| **graph** | Nodes, typed edges, shared state, and bounded transitions; an agent node may contain a turn loop |
| **orchestration** | Selecting a topology, assigning bounded work, routing state, and enforcing lifecycle/authority between nodes |
| **optimization** | A feedback process that measures an outcome, compares it with a target, changes an artifact or action, and verifies the result |
| **execution map** | The safe, host-neutral projection of what the runtime actually selected and executed |

A single loop can be described mathematically as a one-node cyclic graph. That does **not** require
BrainRouter to wrap every conversation in workflow machinery. “Choose the smallest eligible
topology” preserves the practical distinction: direct work should stay cheap and open-ended; known
multi-stage work should gain explicit structure.

Optimization is not a synonym for orchestration. Orchestration decides who/what runs and in what
order. Optimization is one possible subgraph — for example produce -> verify -> revise — and must
have grounded targets and stop conditions.

---

## 3. Decisions

### D1 — Keep one shared turn engine

`runTurnImpl` remains the only engine for an agent turn in Core. CLI and Desktop continue to
construct the same `Agent` and call the same public Core entrypoint.

There will be no new `executionEngine`, `loop | graph`, or host-owned engine setting. A stale
`cli.executionEngine` value remains inert for compatibility. The retirement tests stay and gain an
assertion that topology policy cannot bypass the shared turn lifecycle.

A graph node that needs model/tool agency uses the bounded turn through the existing agent/task
boundary. A primary profile stage advances within its already-owning turn rather than recursively
starting another one. Deterministic nodes do not pretend to be agents.

### D2 — Give every execution one topology and every request one execution tree

Core owns a single `ExecutionTopologyDecision` with four variants:

| Topology | How an execution begins | Retention | May be selected implicitly? |
|---|---|---|---|
| `direct-turn` | Top-level conversational turn or safe fallback | Bounded session execution store | Yes |
| `profile-plan` | Validated strategy for the active workspace profile on a top-level conversational turn | Bounded session execution store | Yes, only in adaptive mode |
| `phase-plan` | Explicit workflow launch | Durable workflow run plus protected resume payload | No |
| `workflow-graph` | Explicit saved-graph launch | Durable workflow run plus protected definition/input snapshot | No |

The topology belongs to **one execution**, not necessarily the entire lifetime of a conversation or
goal. Normal conversation is the default root; a goal is an optional parent:

```text
normal conversation (no active goal)
  -> turn execution (root): direct or profile plan
     -> explicitly authorized durable child execution, if requested
     -> delegated child turn executions

goal-linked conversation (optional)
  -> goal supervisor
     -> turn execution: direct or profile plan
     -> continuation edge -> next turn execution: direct or profile plan
```

Starting, continuing, or viewing a normal turn never requires creating or mutating a goal record.
When a goal exists, its mere presence does not change the per-turn candidate set or selection
result. It adds parent correlation and continuation decisions; explicit inherited goal ceilings may
only remove candidates or reduce budgets, never grant eligibility or authority.

A `/workflow`-style command may start a durable execution as the root. A turn may also start one as
a child only when the request carries trusted explicit intent. It does not replace the running turn's
topology. This describes the current tool nesting honestly while preventing the model from turning a
planner recommendation into durable work on its own.

The decision is immutable once that execution begins. A running node may follow edges declared by
its selected definition, but the runtime cannot silently replace the topology mid-execution.
Steering enters at the existing safe boundary and may influence later declared conditional edges; it
does not rewrite the graph or authority envelope.

An adaptive top-level conversational turn can choose **direct or a profile plan only**.
Automatically discovering and launching a phase plan or saved graph is rejected: persistence,
resumability, approvals, and side effects require explicit intent. The current next-action planner
may recommend a workflow, but that recommendation is untrusted model output and cannot supply the
required provenance.

A goal supervisor is not a fifth turn engine. It is a Core-owned parent execution that records each
bounded turn and the content-free continue/stop/budget reason between them. CLI removes its mirrored
decision and calls the same supervisor service as Desktop.

### D3 — Make topology selection bounded, explainable, and cheap to fail

Core evaluates topology once at the start of every eligible top-level user-authored conversational
turn. This is the normal `runTurn` path in both hosts, not a goal-continuation hook. Preplanned and
nested child turns remain subject to the direct/assigned rules below so a graph cannot recursively
manufacture more graphs.

Selection reads a bounded `ConversationTaskEnvelope`, not only the latest sentence and not an
unbounded transcript. The envelope contains:

- the current user-authored message and explicit attachments/references;
- the last unresolved user-authored task or user-confirmed plan context needed to interpret an
  elliptical follow-up such as “now implement that”;
- active workspace profile, admitted capabilities, and runtime ceilings; and
- a bounded user-authored goal objective and goal identity/budgets only when a goal already exists,
  with the objective treated like other user-confirmed task context and goal existence itself never
  treated as an eligibility signal.

Assistant prose, hidden reasoning, model-authored planner output, and arbitrary transcript history
cannot become durable user intent. Carry-forward context is content- and size-bounded, expires when
the task resolves or topic changes, and preserves its user/confirmed provenance. If no reliable
task context exists, an otherwise contextless follow-up takes the direct fallback.

Selection order is authoritative and shared by both hosts:

1. A trusted explicit phase-workflow or saved-graph launch selects that topology after validation.
2. A trusted explicit profile-strategy request selects that strategy if it is eligible.
3. A preplanned child or nested agent remains direct unless its parent graph explicitly assigned it
   as an agent node. This prevents recursive graph explosion.
4. `mode: off` selects direct.
5. `mode: explicit` with no explicit strategy selects direct.
6. `mode: adaptive` detects registered task signals from the bounded conversation task envelope,
   resolves the profile's reviewed plan, and computes eligible strategies beneath every authority
   ceiling.
7. The managed selector receives only the direct fallback plus those eligible strategy/stage IDs.
   It may select identifiers, never invent a node, edge, role, skill, tool, budget, or authority.
8. The deterministic resolver validates the selection again. Timeout, missing model, invalid output,
   unavailable roles/skills, or any mismatch selects the primary-only fallback.

The model call is skipped when no non-direct strategy is eligible. Its timeout stays hard-bounded.
Persisted explanation is content-free: selection source, matched signal IDs, candidate IDs, chosen
ID, and fallback/diagnostic reason codes. A short model rationale may be displayed during the turn,
but is not persisted because it can restate user content.

Expected conversational behavior is deliberately unsurprising:

| Conversation input | Expected topology |
|---|---|
| “What does this function do?” | Direct bounded turn |
| “Fix this bug, test it, and review the result.” | Eligible Engineering profile plan |
| “Compare these sources and citation-check the report.” | Eligible Research profile plan |
| “Now implement that plan” after the user confirmed an unresolved implementation plan | Resolve signals from the bounded task envelope; select an eligible profile plan |
| A contextless “yes” with no unresolved user task | Direct fallback |

These are contract examples, not magic prompt strings. Profile definitions own reviewed signal and
strategy mappings, and the deterministic resolver remains the authority.

“Trusted explicit” is a typed `ExecutionIntent`, not a Boolean inferred from prose. It contains the
requested topology/definition/strategy, source (`user-command`, `reviewed-ui`, or
`authorized-workflow`), issuing session/user identity, and an integrity-bound request ID. Model text,
the next-action planner, tool arguments the model authored, plugin content, and workspace files
cannot manufacture that provenance. Core validates it once; both hosts use the same contract.

This is “smart” routing with a deterministic chokepoint, not model-authored orchestration.

### D4 — Resolve work shape separately from workspace identity

All 17 workspace profiles use the same topology decision and execution-map contracts.

Core resolves an orchestration definition in this order:

1. an exact reviewed definition for the workspace profile;
2. if no higher-precedence source **claimed** that exact ID, its declared bundled work-shape alias;
3. otherwise direct fallback.

The decision records both `workspaceProfileId` and `planProfileId`. They are not interchangeable:

- the workspace profile owns domain persona, selected capabilities, tools, skills, and manifest
  authority;
- the plan profile owns only the reusable work shape;
- an alias is resolved by trusted catalog policy, never accepted from model output;
- an exact workspace/plugin contribution continues to outrank an alias under existing source
  precedence;
- an invalid, colliding, disabled, or quarantined higher-precedence exact claim fails closed with a
  diagnostic; it never falls through to a bundled alias and hides the bad claim;
- every effective role, skill, tool, access, delegation, and concurrency value remains the
  intersection with the original workspace manifest and parent authority.

No implementation may special-case `engineering` in the router or execution-map projector.

Existing defaults remain until evidence justifies changing them. Engineering, Research, Data
Science, and their adaptive aliases may activate managed selection first. Study and Writing must
support the same adaptive path when explicitly configured, but their default remains explicit until
profile-specific task corpora show non-degradation. Custom stays off/direct until the user reviews a
plan and roles. “Works for all profiles” is an acceptance matrix, not a forced default flip.

### D5 — Graphs narrow authority and fail closed

The selected topology never grants authority. Every node receives an envelope intersected with:

```text
workspace manifest
  intersection parent node authority
  intersection role definition
  intersection selected capability and skill policy
  intersection tool and extension availability
  intersection delegation policy
  intersection runtime concurrency and depth ceilings
  minus explicit denials
```

Additional invariants:

- a node cannot delegate unless its effective role and parent both permit it;
- child topology selection is off unless the parent definition explicitly owns that expansion;
- write-capable fan-out stays one unless isolated worktrees or enforced disjoint ownership are
  proven;
- agent-node role/access configuration must be validated and enforced before saved graphs can run
  production agent nodes;
- an approval node with no approval port resolves **blocked**, never approved;
- cancellation is checked between nodes, loop iterations, retries, subworkflows, and before a
  side-effecting tool dispatch;
- interruption never leaves an assistant tool call without its matching tool result;
- retries and loop-back edges have explicit attempt, time, token/cost, and depth ceilings;
- side-effecting retry/resume requires an idempotency key or an explicit human decision at the
  non-compensable boundary.

Every execution also inherits one **cumulative execution budget**. Definition validation caps the
declared nodes/phases and static fan-out before launch. Runtime caps total node occurrences, child
spawns, concurrent children, nesting depth, retries, loop iterations, model calls, tool calls, wall
time, tokens, and cost. A child receives a partition of the parent's remaining budget; nesting does
not mint a fresh allowance. If a provider cannot report tokens/cost, the view says `unmetered` and
hard call/iteration/time ceilings remain authoritative. An explicitly cost-capped execution cannot
continue unmetered.

Required/optional failure has one dependency meaning across adapters:

- a failed required node blocks its dependent nodes and fails the execution;
- a failed optional node skips only dependants that require its output and records degradation; if
  remaining permitted work completes, the terminal execution is `degraded`;
- a branch not selected is skipped, not failed;
- an approval without a port is blocked; an unanswered approval is waiting, not success; a human
  rejection traverses a declared rejected edge or ends blocked/cancelled, never implicit success;
- a missing required synthesis/input is blocked rather than interpolated as empty success;
- independent nodes already running may settle, but no new side-effecting node starts after the
  execution becomes terminal;
- retry, compensate, rollback, or continue-on-degraded behavior must be an explicit typed edge/policy,
  never inferred from an exception string.

During migration, saved graphs preserve stop-on-required-error, profile plans preserve required-stage
descendant cancellation, and a phase `partial` maps to degraded only when the compatibility policy
has a bounded synthesis output. A phase `failed` no longer silently feeds a dependent phase. These
mappings are part of the adapter tests, not renderer logic.

The saved workflow graph is definition-capable today, not adaptive-production-safe. D5 is a gate,
not follow-up polish.

### D6 — Treat optimization as a governed graph, not one self-scoring loop

The current build repair/critic loops remain compatibility implementations, but the generalized
contract is profile-neutral. A useful optimization subgraph can contain:

```text
target owner -> producer/actor -> independent measurement -> verifier/counter-metric
     ^                                                       |
     |---- bounded revision, arbitration, or rollback <------|
```

Not every task needs every node. Higher-risk or long-running optimization does.

The graph must identify:

- **real-world outcome:** what outside the optimizer establishes success;
- **target owner:** user, frozen requirement, deterministic rule, or explicitly authorized policy;
- **primary metric and counter-metric:** so improving one number cannot silently damage another;
- **independent verifier:** a separate role, deterministic check, or human review where self-review
  is not credible;
- **drift/measurement check:** whether the metric still measures the intended outcome;
- **rollback or safe fallback:** what happens when the change is worse or evidence is unavailable;
- **audit event:** what changed, which evidence admitted it, and why the loop stopped.

Authority, security policy, approval requirements, budgets, frozen acceptance rules, and the
counter-metric cannot be rewritten by the optimizer they constrain. A green self-evaluation is not
proof. Missing or stale measurement stops/degrades visibly rather than becoming success.

Profiles supply domain-specific outcomes — reproducibility, citation support, retained
understanding, rubric compliance, or software verification — instead of inheriting an
Engineering-shaped test loop.

### D7 — Define one execution map in the shared protocol

`packages/agent-protocol` owns dependency-free wire vocabulary for a safe
`OrchestrationExecutionView`. Core owns the projector/reducer and every transition.

Run status is closed and shared:

```text
planned | running | waiting-approval
succeeded | degraded | failed | blocked | cancelled | interrupted
```

Node occurrences additionally permit `skipped`. `planned`, `running`, and `waiting-approval` are
non-terminal; the remaining values are terminal. A terminal occurrence never returns to running.
Unknown presentation data is not forged into a runtime status: the snapshot separately reports
`complete | gapped | unavailable`.

Minimum execution fields:

```text
schemaVersion, executionId, parentExecutionId?, scopeKind, sessionKey, topology
workspaceProfileId, planProfileId?, strategyId?, selectionSource
definitionId?, definitionVersion?, definitionHash?
status, startedAt, endedAt?, inheritedBudget, usage, meteringState
selectionSignals, selectionDiagnostics, terminalReasonCodes
```

A logical node and one attempt/iteration of that node are different records. This is what prevents a
retry from overwriting the evidence of the failure that caused it.

Minimum logical node fields:

```text
nodeId, parentNodeId?, kind, boundedLabel
executorKind, roleId?, skillIds, declaredLimits
```

Minimum occurrence fields:

```text
nodeExecutionId, nodeId, parentNodeExecutionId?
attempt, iterationPath, status, childSessionIds
startedAt?, endedAt?, usage, terminalReasonCodes
```

`iterationPath` is an array so nested loops/subworkflows do not collapse into one scalar iteration.
The durable view contains no model-generated node summary. A bounded label comes only from a trusted
definition/catalog or a sanitized user-authored definition under the same workspace access policy.

Minimum declared edge and traversal fields:

```text
edgeId, from, to
kind: dependency | branch | fan-out | fan-in | loop-back | continuation | subworkflow | failure
boundedLabel?

edgeTraversalId, edgeId, fromNodeExecutionId, toNodeExecutionId?
state: active | traversed | skipped | blocked
sequence
```

Minimum decision fields cover approval, guard, retry, rollback, degradation, and selection. They
carry typed outcomes and safe reason codes — never chain-of-thought.

Every execution event has its own durable identity and ordering independent of the existing host
transport sequence:

```text
schemaVersion, eventId, executionId, executionSequence
sessionKey, emittedAt, causationEventId?, nodeExecutionId?, payload
```

`executionSequence` is contiguous within one execution and allocated by its Core owner. A snapshot
carries `snapshotRevision` and `lastExecutionSequence`. The reducer ignores a duplicate `eventId`,
buffers a bounded out-of-order window, requests a snapshot on a gap, and refuses a conflicting late
terminal transition. Sequence is never inferred from Desktop's process-global delivery counter or
CLI callback arrival order.

The event payload vocabulary is sufficient to reduce the same snapshot:

```text
execution-resolved
node-started | node-finished
edge-activated
iteration-started | iteration-finished
approval-waiting | approval-resolved
retry-scheduled
guard-resolved
execution-ended
```

The view excludes raw prompts, hidden reasoning, full model output, tool arguments/results,
credentials, absolute secret-bearing paths, and unbounded exception text. Existing content events
continue to render in chat; the execution map is control-plane metadata. Transcript correlation is
only a reference: reading the referenced session still requires the same tenant, workspace, and
session authorization as reading it directly. Knowing a child ID grants nothing.

### D8 — One projection, retention appropriate to the execution

Core produces every live snapshot through one reducer. Hosts never infer a graph from prose or
rebuild dependencies from status rows.

- Every top-level conversational turn, including a normal turn with no active goal, retains its
  direct or profile-plan view through a Core-owned session execution store port as bounded
  control-plane metadata. An optional goal-supervisor view links such turns when a goal exists.
  Neither case creates a durable workflow artifact or replays raw tool calls, and normal turns do
  not create a goal as a side effect.
- A session fork references immutable pre-fork views and writes new executions under the forked
  session. Archive/delete follows the transcript's retention policy. Workspace switch closes the
  active subscription and cannot expose a prior workspace's map through the new session. Compaction
  may remove per-event detail but preserves topology, terminal status, counts, decisions, usage, and
  child correlation within fixed count/byte limits.
- Every explicit durable launch gets a fresh opaque `executionId`, even when the workflow slug is the
  same. Repeated and concurrent runs never update one shared execution record.
- Resume/retry after a terminal `failed`, `blocked`, `cancelled`, or `interrupted` run creates a new
  `executionId` with `resumesExecutionId` and a typed continuation/resume edge. The original run and
  its occurrences stay terminal and immutable. The new run may reuse the protected immutable
  definition/input and admitted completed outputs after validation, but has its own budget, sequence,
  timestamps, ownership, and side-effect reconciliation. An approval-waiting execution is
  non-terminal and may continue under the same ID when that same request resolves. `latest.json`
  points at the newest execution, while history shows the entire resume chain.
- Durable safe views live under the workflow slug by execution identity, conceptually:

  ```text
  .brainrouter/workflows/<slug>/runs/<executionId>/view.json
  .brainrouter/workflows/<slug>/runs/<executionId>/events.jsonl
  .brainrouter/workflows/<slug>/runs/latest.json
  ```

  Listing is cursor-paginated by `(startedAt, executionId)`. `latest.json` is an atomic convenience
  pointer, never the identity or only index. Retention is bounded by age/count/bytes and never deletes
  active, interrupted, or approval-waiting runs without explicit policy.
- Resumability uses a **separate protected payload store** keyed by workspace and `executionId`.
  It contains the exact validated definition/input snapshot and only the bounded intermediate output
  required to resume. It is outside the committable safe view, uses owner-only permissions where the
  platform supports them, is never sent through the execution-map protocol, and follows explicit
  retention/deletion policy. Secrets remain references to the owning credential store, not copied
  values.
- At launch, phase plans, saved graphs, and every referenced subworkflow receive an immutable
  canonical snapshot with `definitionVersion` and content hash in the protected store; the safe view
  records only identity/hash. Resume uses that snapshot, never the currently edited definition. If
  the protected snapshot is absent or corrupt, resume becomes `blocked: resume-state-unavailable`
  rather than running a different graph.
- Iterations, occurrences, and edge traversals append; they do not replace prior attempts. Event
  records are length/checksum framed, appended under a per-execution lock, and flushed before their
  sequence is acknowledged. Snapshot and pointer replacement use compare-and-swap revisions plus a
  flushed temporary file and atomic rename where supported. A crash may leave a truncated final
  event; recovery ignores only that uncommitted tail, reconciles the last valid sequence, and records
  `interrupted` or `side-effect-outcome-unknown` rather than guessing success.
- Side-effect dispatch records intent/idempotency before the call and outcome after it. On restart,
  a missing outcome is retried only when the adapter proves idempotency; otherwise the execution
  blocks for human reconciliation. Multi-process writers losing the revision race reload and retry
  the transition rather than overwrite another process.
- Existing `WorkflowRun` readers remain through a compatibility projector. Existing `planJson` and
  inline `aggregatedOutputRef` values are read for legacy resume, bounded/migrated into the protected
  payload store on the first successful write, and never exposed as safe-view fields.
- Saved graph **definitions** keep their current definition store until a separate storage migration
  is justified. Run history does not live in that mutable definition store.
- A host reconnect requests a snapshot at a revision, then resumes after its sequence watermark.
  Duplicate or out-of-order delivery cannot regress terminal state.

There is one semantic truth and more than one retention adapter — not one Desktop database, one CLI
log parser, and one workflow-only ledger that drift apart.

### D9 — Render the same truth in Desktop and CLI

The Desktop keeps one tabbed side-panel system. The existing `workflows` panel ID is preserved for
session/layout compatibility, its visible title becomes **Orchestration**, and it gains two internal
views:

- **Runs** — current and recent executions across all four topologies, with normal no-goal turns as
  first-class roots and goal-supervisor grouping when a goal is active;
- **Design** — the existing saved WorkflowGraph editor.

Runs uses the existing graph canvas primitives but is read-only. It shows:

- the selected topology/profile/strategy and whether selection was explicit, adaptive, or fallback;
- active, completed, failed, skipped, blocked, cancelled, and degraded nodes/edges;
- which node is a primary loop, child agent, deterministic step, approval, guard, or subworkflow;
- role, active skill, bounded loop iteration/budget, attempt, timing, and usage;
- fan-out/fan-in, loop-back, retry, approval, rollback, and fallback reason;
- child transcript drill-down by stable child session ID;
- a clear “Direct turn” single-node view when no graph was selected.

When idle, Runs also exposes **Run with strategy** for the active profile. It previews the exact
validated strategy, effective roles/skills/limits, and whether it creates children before the user
confirms. That confirmed action creates a `reviewed-ui` intent; it is not a free-form strategy ID.

It does not show fabricated thought steps or infer an agent merely because prose mentioned one. A
surface appears only after the real source-started browser bridge and Electron host both deliver the
same projection; a mock-only canvas is not completion.

CLI adds `/runs [id] [--json]`: a compact tree/timeline over the same view, with child transcript
links expressed as existing `/agents transcript <id>` commands. `/runs start --strategy <id>`
previews and confirms a validated strategy, then creates a `user-command` intent. `/workflows`
remains the durable workflow-focused list, `/agents tree` remains the spawn hierarchy, and `/watch`
remains raw tracing.

### D10 — Make failure and fallback first-class states

The following are distinct and visible:

- direct selected because it was cheapest and sufficient;
- direct required by off/explicit mode;
- direct fallback after model timeout, invalid selection, missing role/skill, or plan corruption;
- graph selected but a node blocked on approval;
- graph degraded because optional work could not run;
- graph failed, cancelled, or exhausted its budget;
- verification unavailable versus verification failed.

Adapters map existing states into the closed vocabulary; they do not pass host-specific strings to
renderers:

| Current source | Shared occurrence/run state |
|---|---|
| Profile `planned/running/succeeded/failed/skipped/cancelled` | Same meaning; required failure applies D5 dependency rules |
| Graph `ok/skipped/error` | `succeeded/skipped/failed` |
| Phase `completed/partial/failed/interrupted` | `succeeded/degraded/failed/interrupted` |
| Workflow `completed/failed/interrupted` | `succeeded/failed/interrupted` |
| Approval with a live unanswered request | `waiting-approval` |
| Missing approver, resume payload, or required input | `blocked` with a reason code |

Legacy adapters may preserve where a failure originated, but they may not weaken D5: required
failure blocks dependants, optional/accepted partial work degrades, and continuation/rollback needs a
typed edge or policy. A gapped snapshot is shown as incomplete data alongside the last established
status, never converted into `succeeded` or a made-up `unknown` runtime state.

“No graph” is not an error. “Graph requested but silently ran the loop” is.

The old engine dropdown failed because it offered a state the product could not establish. This
surface is held to the opposite rule: it is projected from transitions owned by the runtime, and a
missing fact is shown as unknown/unavailable rather than guessed.

---

## 4. Ownership

| Concern | Owner | Does not own |
|---|---|---|
| Wire records and event vocabulary | `packages/agent-protocol` | Selection policy, persistence, UI layout |
| Execution intent, topology/profile resolution, and authority intersection | Core workspace/orchestration policy | Host preferences, renderer state |
| Goal-supervisor continuation and turn parenting | Core goal/runtime service | Host-specific continuation logic |
| Turn and stage transitions | Core agent runtime and `ProfileStageController` | Durable workflow storage |
| Phase/graph transitions and canonical durable run ledger | Core workflow runtime | Desktop canvas, CLI formatting |
| Bounded session execution retention | Core session execution-store port plus owning storage adapter | Durable workflow resume payloads |
| Protected definition/input/resume payload | Core workflow payload-store port plus owning filesystem adapter | Renderer or wire projection |
| Model-assisted strategy completion | Existing Core agent adapter behind a bounded port | Final authority or arbitrary graph creation |
| Live snapshot reducer and compatibility projection | Core | Host-specific event interpretation |
| CLI timeline/tree/JSON | CLI | Selection or transition logic |
| Runs/Design graph surface | Desktop renderer | Runtime truth or authority |
| Approval, filesystem, process, credentials, and session effects | Owning host adapters behind Core ports | Model-authored bypasses |

Both hosts must exercise the same Core selection and projector. Host code may choose presentation,
poll/event transport, and navigation; it may not choose a different topology for the same input.

---

## 5. Compatibility and migration

- Existing CLI and Desktop turn entrypoints remain unchanged.
- Existing profile-stage, child, plan, and tool events remain during a deprecation window; Core
  derives them from the same transitions while consumers migrate.
- Existing `WorkflowRun` files remain readable. A compatibility projector serves old cards and
  commands until the unified run readers ship.
- Existing saved WorkflowGraph definitions remain readable and editable.
- Existing model-origin `run_workflow` and `run_workflow_graph` calls remain readable in history, but
  once `ExecutionIntent` enforcement activates, a new durable launch without user-command,
  reviewed-UI, or authorized-workflow provenance is rejected with an explicit-launch instruction.
  The next-action planner may recommend; it cannot self-authorize.
- No-manifest workspaces preserve current inference behavior and write nothing. Unrecognized
  workspaces fall back direct.
- Existing manifests keep their reviewed mode and ceilings. Plan aliases repair resolution without
  rewriting the manifest profile; an invalid higher-precedence exact claim remains a fail-closed
  diagnostic rather than falling through to the alias.
- Study/Writing defaults and Custom off mode do not change merely by merging this ADR.
- A stale `cli.executionEngine` remains ignored rather than becoming a topology selector.
- The panel ID remains `workflows`, so saved layouts do not lose their tab when the title changes.

---

## 6. Alternatives rejected

### A. Restore separate loop and graph turn engines

Rejected. It already produced a setting whose second state could not run and a graph path without
turn-lifecycle parity. Every future interrupt, tool, receipt, delegation, verification, and steering
change would have to land twice.

### B. Compile every turn into the workflow graph engine

Rejected. Open-ended conversation benefits from one adaptive bounded loop. Forcing it through
durable workflow machinery adds latency, state, and failure modes without adding structure.

### C. Let the model invent a graph for each task

Rejected. It makes nodes, authority, cost, and termination unreviewed model output. BrainRouter may
later propose a graph for human review; runtime selection is limited to validated definitions.

### D. Automatically match and launch saved workflows

Rejected. Durable execution and side effects require explicit user/workflow intent. Ordinary
adaptive selection stops at a profile plan.

### E. Generalize the Engineering build loop into every profile

Rejected. A citation audit, learning check, writing critique, data reproducibility check, and
software test loop do not share one success metric or role graph. The common contract is topology,
authority, events, and bounded feedback — not Engineering vocabulary.

### F. Draw a graph in each host from logs and status rows

Rejected. That creates two guesses and no runtime contract. It cannot reliably reconstruct edges,
attempts, fallbacks, or child ownership and violates the rule that surfaces show established state.

### G. Adopt another orchestration framework now

Rejected. Core already owns bounded turns, profile graphs, phase plans, saved graphs, child
authority, and host protocols. The present gap is unification and safety, not a missing dependency.
Reconsider only if required durability/scale cannot be met after the canonical run contract exists.

---

## 7. Dependency-ordered delivery board

Each row is a separate focused pull request. A checked row requires its own evidence. Merging the
accepted decision record checks only A40-0; it makes no implementation claim.

- [x] **A40-0 — Accept this decision.** Owner approved on 2026-08-13. ADR and index only;
  no runtime claims.
- [x] **A40-1 — Repair current profile truth.** Resolve exact/aliased plan identity in the active
  turn, separate workspace/plan IDs, keep invalid higher-precedence claims fail-closed, replace stale
  preview vocabulary, and add the 17-profile default-resolution matrix without changing modes.
  Local evidence: the 17-profile Core matrix and Core/CLI/Desktop identity, fail-closed,
  propagation, onboarding, and telemetry suites pass; hosted CI and the automated security review
  remain this slice's merge gates.
- [~] **A40-2 — PARTIAL. Add conversational task envelopes, trusted intent, and execution-tree policy.**
  Evaluate every eligible top-level turn from bounded user/confirmed task context, make a normal
  turn the root when no goal exists, define/validate explicit topology and strategy provenance,
  reject planner/model self-authorization, parent durable children, and keep the Core goal
  supervisor an optional continuation parent for both hosts. Partial implementation evidence:
  the trusted-intent slice binds one exact CLI or host-reviewed phase launch to an opaque,
  single-use live-Agent capability, preserves parent/launch lineage in legacy-readable ledgers,
  purpose-limits the reviewed turn, and carries a revocable policy-bound lease through declared
  descendants. The conversational task envelope, closed origin/topology contract, goal/no-goal
  parity, and shared Core goal supervisor remain open, so this row stays unchecked.

  **Shipped in `30904ff5f`.** Authority is a capability and not a claim: handles are object
  identities in a `WeakMap`, bound to workspace/session/user, TTL-bounded (5 min, 15 min ceiling),
  with single-use dispatch receipts — a planner or model cannot fabricate one because there is no
  string to guess.

  **Two acceptance failures remain OPEN, and they are TEST-ISOLATION failures rather than product
  ones — this distinction was checked, not assumed.** Both pass when run alone and fail only when the
  file runs in order. For `access downgrade during cost approval revokes launch before persistence`
  the behaviour was probed directly: the approval callback runs, access moves `shell` -> `read`, and
  the launch IS rejected. So the revocation works and the authority model is sound; what is broken is
  that some state leaks between tests in this file and blinds the check on later runs. Resetting the
  CLI-knob and config-loader caches between temp workspaces (already done in `_helpers.ts`) is not
  sufficient.

  **The poisoner is now identified by bisection**, which is a materially better position than
  "something leaks". Pairing the downgrade test with each earlier test in turn isolates it to
  `ADR-040 A40-2 reviewed pre-tool hooks execute the approval-time A snapshot across an A-to-B-to-A
  swap`. With any other predecessor the downgrade test passes; with that one it fails.

  Two candidates are ELIMINATED rather than assumed: `_resetCliKnobsCache()` does clear
  `cachedOverrides`, so that test's hooks knob override does not survive it; and adding
  `_resetConfigCache()` to `_helpers.ts` changed nothing. The remaining suspects are that test's
  other global mutations — `resetExtensionContributions()` and the hook files it writes and swaps —
  which it sets up but does not tear down.

  Recorded this way deliberately: "one named test poisons two named tests, and here is what it is
  NOT" is actionable in minutes. "Something leaks" is not.

  This is recorded precisely because the opposite reading — "a launch survives an access downgrade" —
  is what the raw failure looks like, and it would be a serious security claim to make on evidence
  that does not support it.

  Two defects found while verifying this slice are fixed in the same commit:

  1. **`migrateLegacyWorkspaceState` deleted workspace role definitions.** Its preserved set was
     `{workflows, workspace.json}`. `.brainrouter/agents/` — written by `agentRegistry.ts`, read by
     `domainPersonas.ts`, and committed by teams exactly as `workflows/` is — was swept as stale
     runtime state the first time a workspace ran with `BRAINROUTER_HOME` pointing elsewhere, and the
     rescue-copy never covered it either. That is shipped-code data loss with no connection to
     ADR-040; A40-2's tests were merely the first to write that directory and then read state.
     Fixed, with a three-case regression test that also pins that the sweep still sweeps.
  2. **Eighteen of A40-2's twenty-three tests were discarded while the file reported `fail 0`.**
     `completionStarted` settles only when the stub sees a steering-only turn; otherwise the await is
     on a bare promise with no timer or socket behind it, so the event loop drains and node's runner
     cancels the rest of the file. A deadline — deliberately not unref'd, since an unref'd timer
     cannot hold the loop open long enough to fire — converts that silent void into one legible
     failure. Pass count went 5 -> 11 on that change alone.

  **The last skipped A40-2 test is now un-skipped and passing — all twenty-three run.**
  `root prompt rebuild uses captured instruction mode and personality across an A-to-B-to-A swap`
  had never passed because its harness waited on a THIRD `listTools` call that a reviewed turn never
  makes (it reuses the issuance inventory), and its premise — a mid-turn A→B swap that is silently
  REBUILT from B — describes an unreachable state: `beginExecutionIntentTurn`'s fingerprint check
  cancels a turn that starts on B, and `assertReviewedTurnCurrent` cancels any swap DURING the
  reviewed launch. So a root reviewed turn only ever runs on the approved A or cancels — never on the
  changed policy. The test now asserts those two reachable guarantees directly (the reviewed prompt is
  built from the approved instruction/personality/review-policy; a mid-flight swap CANCELS the launch),
  and the descendant-inherits-the-snapshot case remains covered by `reviewed legacy role uses captured
  restrictive prompt and access`. This was a TEST-INTEGRITY fix: the protection already existed in the
  product; the harness did not exercise it. The row's remaining open parts (task envelope, closed
  origin/topology contract, goal/no-goal parity, shared goal supervisor) keep it unchecked.

- [x] **A40-3 — Make saved graph execution fail closed and bounded.** Wire the shared approval port,
  block when absent, enforce agent-node role/access configuration, propagate cancellation, apply
  cumulative execution budgets and required/optional failure rules, and prove bounded loop/
  subworkflow behavior. **Every one of these charter requirements is now shipped and mutation-proved
  (below); the row is complete.** What remains — REMOVING the `run_workflow_graph` production block — is
  a distinct, outward-facing capability (it ENABLES production saved-graph launch), not part of making
  execution "fail closed and bounded": with the block up, production launch fails closed, which is the
  stronger reading of this row, not a weaker one. That capability is tracked as its own item below.

  **Shipped in `e9cc9b32b`: the fail-closed half.** The `approval` node auto-passed when no approval
  port was wired — the one node type whose purpose is to stop and ask a person was a no-op in exactly
  the configuration where nobody is watching, and an existing test asserted that by name, so the bug
  was written down as the specification. Unwired approval is now an error; a deliberately unattended
  run opts in with `allowUnattendedApproval` and each such node is flagged `unattended: true` so the
  decision shows up in the map instead of being inferred from an absent callback.

  Bounded, too: `MAX_SUBWORKFLOW_DEPTH` bounds NESTING, not WORK, so a shallow graph with a wide loop
  ran unboundedly without ever nesting. `executionBudget` caps total node executions per run and the
  counter is shared by reference with every subworkflow; an `AbortSignal` is checked before each node.
  Seven tests, each mutation-proved — one of which had to be rewritten because it passed whether the
  budget was shared or reset.

  **Agent-node role/access enforcement now shipped.** A saved graph is untrusted config, so an
  `agent` node's declared role/access is resolved fail-closed (`resolveGraphAgentAccess`): a bogus
  `access` is DROPPED rather than misread as a grant, and whatever survives is only a REQUEST — the
  spawn path still ceilings it at the parent's access via `clampAccess`, so a node can never escalate
  beyond the launch. Five tests, the fail-closed drop and the shell-node-clamped-to-a-read-parent
  escalation guarantee both mutation-proved. (The row's other named remainder, the required/optional
  node failure rules, was already shipped in the graph engine — the "still open" was stale prose,
  corrected here.) In the same slice the graph run path now routes through the canonical adapter, so a
  graph run emits to the execution map like every other run (`graphAdapter` left the E1 `KNOWN_UNWIRED`
  list; dead-export ceiling fell 285 → 284).

  **Separate follow-on capability (NOT a gap in this row):** removing the `run_workflow_graph`
  production block in `toolAdapterInvocationPhase.ts` to ENABLE production saved-graph launch. Its
  precondition — role/access enforcement — has landed, so the change is ready and fully scoped (consume
  the single-use dispatch receipt against the re-normalized graph target, then reach the handler). It is
  deliberately deferred to an owner-approved change: it opens an outward-facing execution surface, so it
  is not something to fold into a docs slice. Until then the block stays as defence-in-depth over the
  fail-closed guarantees (unwired-approval error, shared execution budget, required-node-fails-run,
  access clamp) — it strengthens "fail closed," it is not the only thing holding the line.
- [x] **A40-4 — Add dependency-free execution-map records and events.** Closed statuses, logical
  nodes plus occurrence/traversal identities, execution-scoped event sequence/version fields,
  redaction/size bounds, and compatibility records for current profile-stage consumers.

  **Shipped in `24b08eaa4`: the vocabulary** (`packages/agent-protocol/src/executionMap.ts`, no
  dependencies). Closed run statuses split into non-overlapping open/terminal sets; `skipped` exists
  for occurrences only, since a run cannot be skipped. Logical nodes, occurrences, declared edges,
  traversals, decisions and execution-scoped events all present, with snapshot completeness
  (`complete | gapped | unavailable`) reported separately from run status so a host missing events
  says so instead of forging a runtime state to cover it.

  `canTransitionExecutionStatus` refuses terminal -> open AND terminal -> a different terminal, so a
  late or replayed event cannot resurrect a finished run or turn a cancelled one into a success.
  Labels are flattened (including U+2028/U+2029, which a naive newline filter misses) and clamped;
  reason codes are bounded in count and width. Eleven tests, mutation-proved.

  **The compatibility record now shipped too** (`packages/agent-protocol/src/profileStageCompat.ts`,
  still no dependencies). `projectProfileStageView` maps a canonical execution — its record, logical
  nodes and occurrences — back onto the legacy `ProfileStageEventView` that existing hosts already
  render, so those consumers keep working while the canonical map becomes what drives them. It is a
  pure, TOTAL, deliberately LOSSY projection: every canonical status and selection source maps to a
  legacy one with no `default: throw`, and each lossy edge is named — most of all `degraded`, which
  the legacy palette cannot express and which is shown on the visible (`failed`) side rather than
  greened into `succeeded`, keeping A40-7's "mostly worked is not worked" intact across the compat
  boundary. A retried node shows its latest attempt; node order is stage order. Seven tests,
  `degraded -> failed` mutation-proved. The core E1 sweep only sees `packages/core`, so this
  leaf-package export does not touch its ceilings.

  The vocabulary and its compatibility record are what this row asked for; EMITTING the canonical map
  is A40-5's reducer and A40-7's adapters, which are their own rows.
- [~] **A40-5 — PARTIAL. Add the Core reducer and bounded session store.** Idempotent/gap-aware reduction,
  snapshot watermarks, no-goal direct/profile instrumentation plus optional goal grouping,
  stage-child correlation, loop budgets, fork/archive/delete/workspace-switch behavior, and
  existing-event compatibility projection.

  **Shipped in `e6d691d9b`: idempotent, gap-aware reduction with watermarks and a bounded store**
  (`packages/core/src/orchestration/execution/reducer.ts`). Replays are ignored by per-event
  identity; out-of-order events are buffered rather than applied and drain in order once the hole
  fills; completeness (`complete | gapped | unavailable`) is reported separately from run status; a
  late event can neither resurrect a terminal run nor rewrite one terminal state into another. The
  store evicts oldest-first and reports truncation as `gapped`, so a bounded store never presents
  itself as the whole story. Thirteen tests, mutation-proved — one of which had to be rewritten
  because it passed with idempotency removed.

  **Session lifecycle now shipped** (`reducer.ts`): the store indexes executions by session and by
  child session, and exposes `executionsForSession`, `forgetSession` (the transcript delete and the
  workspace-switch drop), `archiveSession` (retained-but-hidden — a direct `snapshot(id)` still
  resolves, distinct from forget which drops the record), `forkSession` (the fork inherits history by
  reference and cannot mutate the source), and `executionForChildSession` (stage-child drill-down).
  Child session ids now union across events instead of being overwritten, and `forget` cleans both
  indexes so a forgotten execution cannot reappear in a listing or a child-drill. Eight tests;
  archive-vs-delete and fork isolation mutation-proved.

  **Loop budgets now shipped.** A loop node emits its budget — iterations ALLOWED (`declared`, the same
  1..100 clamp it ran under) vs USED (`observed`, the count it reported) — and the reducer projects it
  as `ExecutionSnapshot.loopBudgets`. A loop that ran to its ceiling and one that stopped early look
  identical unless both numbers are kept, so a bounded loop can be SEEN to have stayed bounded rather
  than merely asserted to have. The budget carries its own `nodeId` so it is not mistaken for an
  occurrence; three tests, the real-loop emission mutation-proved. The existing-event compatibility
  projection is also done — it is A40-4's `profileStageCompat`, shipped.

  **Still open for this row:** the OPTIONAL goal grouping. It is genuinely gated, not deferred by
  choice: there is no `goalId` anywhere in the emission or launch path today (only an unused
  `scopeKind: 'goal'` enum), so a `#byGoal` index would be inert — it needs a goal-launch linkage to
  emit against first, which is A40-9's goal-continuation work. The reducer side is a few lines mirroring
  the existing session index and lands the moment there is a goal id to group by.
- [x] **A40-6 — Add durable execution identity and protected resume storage.** Per-launch run paths,
  pagination/retention, immutable definition/subworkflow hashes, separate safe and protected payloads,
  atomic/revisioned writes, corruption/restart reconciliation, and legacy `WorkflowRun` migration.

  **Shipped in `6a5fb0a29`** (`packages/core/src/orchestration/execution/runStore.ts`): per-launch run
  paths, pagination, retention, immutable definition/subworkflow hashes, separated safe and protected
  payloads (resume material 0600 and never in a listing), atomic revisioned writes with
  compare-and-set, torn-pair resume refusal, and crash reconciliation of `running` to `interrupted`.
  Eleven tests, mutation-proved.

  Its own retention test found a real bug before it shipped: prune and reconciliation read through
  the PAGED listing, whose cap (50) is below the retention bound (100), so pruning could never fire
  and a crash reconciled only the newest page. Both now scan every run.

  **Closed (`runStoreMigration.ts`).** The legacy `WorkflowRun` ledger
  (`.brainrouter/workflows/<slug>/run.json`) now migrates into the durable store: non-destructive
  (the legacy ledger stays for the `/workflows` viewer), idempotent (guaranteed by the store's
  exclusive create, not by an easily-removed guard), and honest — a legacy `running` run becomes
  `interrupted` because its owning process is gone, `definitionHash` stays null, and no resume state
  is fabricated. `openDurableRuns()` runs the migration plus crash-reconciliation once per process,
  and `/runs` (CLI, and the same curated subpath Desktop uses) calls it before listing — which also
  WIRES the previously-orphaned migration and reconcile, so both leave the E1 sweep. Eight tests,
  the `running → interrupted` mapping mutation-proved.
- [x] **A40-7 — Adapt phase plans and saved graphs to the canonical run.** Emit occurrences,
  traversals, attempts and decisions; preserve typed compatibility failure mappings; and prove
  resume/cancel/idempotency and side-effect-uncertain behavior through process-kill tests. **Every one
  of these is now shipped and mutation-proved — the row is complete.**

  **Shipped in `0f6541638`** (`orchestration/execution/graphAdapter.ts` + emission in the graph
  engine). Saved graphs now emit occurrences and approval decisions into the canonical map, and the
  durable store persists resume state on EVERY event rather than once at the end — a run that saves
  only at completion has no resume point at the moment it needs one.

  **Correction, caught by the remaining-work audit:** at `0f6541638` the reducer did NOT actually
  project those decisions — they were emitted into the stream and then dropped, and the approval test
  passed while asserting only the node occurrence, never the decision, which is exactly how the gap
  hid. The reducer now projects them: `ExecutionSnapshot.decisions` records each decision (its `kind`
  as emitted rather than policed, bounded reason codes, deduped on replay, projected independently so
  a decision riding on the same event as an occurrence records both), the approval test now asserts
  the decision itself, and `execution-reducer-decisions.test.ts` mutation-proves the projection.

  **The process-kill evidence this row requires is RUN, with a real SIGKILL.** The test spawns a
  child, waits for it to commit a resume point, kills it, asserts the child died BY SIGNAL, and reads
  the committed point back from disk. An in-process "crash" unwinds and flushes, which is precisely
  what a crash does not do.

  This slice repaid the A40-5 and A40-6 E1 debts: the sweep flagged both `KNOWN_UNWIRED` entries as
  stale the moment their modules gained a caller, and they are deleted rather than left as standing
  confessions.

  **Phase-plan adaptation now shipped** (`phasePlanAdapter.ts`): the phase-plan counterpart to the
  saved-graph adapter. A pure `ExecuteHooks` factory — `onPhaseStart`/`onPhaseComplete`/`finish` emit
  canonical occurrences and the run's terminal status into the same reducer and `/runs` projection, so
  a `/build` phase run and a saved-graph run answer the same questions in the same shape. The mapping
  that matters is `partial → degraded` (a phase that lost some children is not a clean success);
  mutation-proved. Phase children become the stage's child sessions, feeding A40-5's stage-child
  correlation from the phase-plan side. Six tests.

  **The wiring now shipped too.** `runWorkflow` composes the emitter into its live `ExecuteHooks`
  (`workflowTool.ts`): `onPhaseStart`/`onPhaseComplete` mirror every phase, and every terminal path —
  success, interrupt, and the detached background run — calls `finish` with the settled execution, so
  a `/build`, `/plan`, or any multi-agent command leaves a durable execution-map record behind, the
  same shape a saved-graph run leaves. It is STRICTLY best-effort: the emitter's construction and each
  hook are guarded, so a durable-store failure drops the mirror, never the run it was describing. The
  store exclusive-creates by run id, so a re-run without a launch run id records the first run only —
  an accepted best-effort limit, stated in the code. `execution-phase-plan-wiring.test.ts` drives a
  real `runWorkflow` and mutation-proves both guarantees: the persisted emission count (which falls to
  a bare construct+finish if the per-phase composition is dropped) and the best-effort guard (a
  pre-occupied durable slot must not fail the run). This repaid the row's own E1 debt: the adapter left
  `KNOWN_UNWIRED` and the dead-export ceiling fell back 286 → 285.

  **Edge traversals now shipped too.** The graph engine emits every outgoing edge's state, not just
  the ones taken: the branch followed is `traversed`, a branch not taken is `skipped`, and a branch an
  approval closed is `blocked` — a map that shows only what fired cannot say why the rest did not. The
  reducer projects them into `ExecutionSnapshot.traversals` (bounded below the event cap so the
  sub-bound can actually trip, deduped on replay, `state` recorded as emitted). Six tests, including a
  real branching graph asserting `traversed` for the matched branch and `skipped` for the other, and
  the engine emission mutation-proved.

  **Typed compatibility failure mappings now shipped too.** A failed run says WHY in a BOUNDED, typed
  code, never its raw error string — an unbounded, possibly sensitive message has no place in a
  durable, replayable map. `canonicalTerminalReasonCodes` maps each failure the graph engine can
  produce (budget exhausted, cancel, a node failure, an invalid definition) to one safe code, and
  anything unrecognized to the generic `error` — a known-unknown, not the leaked text. The engine emits
  it on the terminal event, the reducer bounds it again (it does not trust its input) and projects it
  as `ExecutionSnapshot.terminalReasonCodes`. Four tests, including a real failed graph run surfacing
  `node-failed` and a proof that a raw error carrying a secret never becomes a reason code; the mapping
  is mutation-proved.

  **Retry attempts now shipped as real, first-class emissions — not a bare counter.** The graph engine
  gained OPT-IN, bounded per-node retry: a node declares `retries` (default 0 — a single attempt, so
  every existing graph is untouched; clamped to 5), and a failed attempt re-runs, emitting its OWN
  occurrence with its real attempt number. A node that failed then recovered now SHOWS attempts 1, 2, 3
  instead of pretending it worked first try. Node-execution throws are caught so they are retryable and,
  once exhausted, fall through to the SAME required/optional handling as a returned error — so an
  optional node degrades and a required one fails, exactly as before. Retries draw from the shared
  execution budget (they cannot bust the run's bound) and stop on cancel. Five tests — default-preserved,
  retry-then-succeed, exhausted, optional-degrades, budget-bounded — and the retry loop mutation-proved.

  **The resume path's durable emission now shipped too — the row is complete.** A resumed run
  RE-ATTACHES to its interrupted record instead of the store's exclusive-create refusing a second start:
  the phase-plan emitter takes a `resume` flag, reads the existing record (via `readDurableRunSafe`) and
  CONTINUES the event sequence from the interrupted run's `lastSequence` (via `readDurableRunResumeState`)
  so the continuation extends the same stream rather than colliding with the events already emitted, and
  it finalizes on the SAME record. It re-attaches through the CAS-guarded update path only, so the
  store's exclusive-create guard for FRESH launches is untouched; if the record is somehow gone it falls
  back to a fresh start; and like the fresh path it is strictly best-effort, so a mirror failure never
  breaks a resume. `resumeWorkflowUnchecked` composes it into the resume hooks. Two adapter tests
  (re-attach + sequence continuity mutation-proved; missing-record fallback), the workflow-resume suite
  unbroken, and the dead-export ceiling fell 284 → 283 as `readDurableRunResumeState` gained a caller.
- [~] **A40-8 — PARTIAL. Activate bounded adaptive profile selection.** Wire the existing managed selector
  through every eligible top-level conversational turn in the shared Core path, with or without a
  goal; include direct as the safe baseline, expose diagnostics, and pass fresh/elliptical/contextless
  conversation corpora before changing any profile's default.

  **Shipped in `f521274cb`: three of this row's four parts.** Eligibility (top-level only; an explicit
  user choice is never overridden and is checked first so the reported reason is the true one),
  `direct` as the safe baseline, and diagnostics carrying `selectionSource` for the execution map.
  Goal presence changes nothing about eligibility and a test says so, because §0 requires it and "a
  goal is active" is exactly the signal that later grows quietly into "route differently".

  **The fourth part is a gate, and it stays SHUT.** Changing any profile default requires
  fresh/elliptical/contextless conversation corpora that do not exist. `DEFAULTS_ARE_CORPUS_GATED`
  is the switch, a test pins it closed, and every diagnostic surfaces it. Authoring a synthetic
  corpus to open it would defeat the only thing it is for — a corpus is collected, not written by the
  system it judges.

  The module is deliberately UNWIRED and recorded as such in the E1 sweep: wiring it into the turn
  path before the gate opens is precisely how a default moves without anyone deciding to move it.
- [x] **A40-9 — Ship CLI parity and explicit strategy launch.** Every one of these is now shipped — the row is complete. `/runs` for normal and goal-linked
  turns, preview/confirm start, live updates, retained replay, `--json`, goal continuation, and
  authorized child transcript drill-down from the shared projection.

  **Shipped in `80aacffce`**: `/runs` lists a workspace's runs and shows one in detail, with
  `--json`, registered in the REPL so it is reachable rather than merely present. The projection
  lives in Core (`orchestration/execution/runsView.ts`, exposed as the curated
  `./orchestration/runs` subpath) so Desktop Runs renders the SAME answer — two hosts formatting the
  same events independently is how they come to disagree about whether something failed.

  A view that lacks the events says so: `unavailable` with a caveat, or `gapped` with one. It never
  draws an empty node list, because an empty map without a caveat reads as "this run did nothing".
  Completeness comes from the snapshot and is never inferred from status.

  `readDurableRunResumeState` is deliberately absent from the public subpath — a rendering surface
  has no business holding resume material, and the package-boundary check enforces that rather than
  a comment asking nicely.

  **Retained replay now shipped** (`orchestration/execution/runJournal.ts`). A run's events are kept in
  an append-only JSONL journal beside its durable record, written best-effort as they are emitted (both
  the graph and phase-plan adapters), and `readRunDetail` reads them back through the SAME reducer the
  live view uses — so `/runs <id>` and Desktop Runs rebuild the real execution map from disk instead of
  reporting `unavailable`. Bounded by a byte ceiling (a run past it reduces to `gapped`, honestly, not
  a silent truncation); torn last lines are skipped rather than aborting the read; the writer stays off
  the host surface, hosts get the reader only. Five tests, including a real graph run read back from
  disk to the same map it produced live; the journal append mutation-proved.

  **Child-transcript drill-down now shipped.** Each stage in the detail view carries the child sessions
  it spawned (`RunDetailView.nodes[].childSessionIds`, from the reducer's stage-child correlation), so a
  run can be traced into the transcripts it produced — CLI prints `↳ child <session>` under each stage,
  Desktop renders the same field. They are session references, not resume material, so they belong on the
  rendering surface.

  **Goal continuation now shipped** (A40-5's grouping consumer). A run launched under an active goal
  carries a stable `goalId` (`${sessionKey}:${goal.setAt}`, which changes exactly when the goal does)
  through the emitters onto the event, the durable record, and the reducer's `#byGoal` index; `/runs`
  groups by goal (`--goal=<id>`) and both hosts show a run's goal without needing the event stream. The
  launch reads the goal best-effort, so a goal-read failure omits the link and never disables the mirror.

  **Preview/confirm start and live updates now shipped — the row is complete.** `/runs start
  [--strategy=<id>] <task>` resolves the plan the launch WOULD run (`previewTurnStrategy` →
  `resolveActiveTurnOrchestration` with the explicit strategy → the shared `PlanPreview`), prints the
  validated strategy, its origin, each stage, and — the answer a person confirming a launch is owed —
  whether it spawns children, then asks to confirm before it mints anything. On confirm the explicit
  command runs the turn with the strategy as its topology (`selectionSource: explicit`); on decline
  nothing starts. `/runs <id> --watch` follows a run live: it polls `readRunDetail` (which re-reduces the
  retained journal idempotently), re-renders only when the map changes, and stops the moment the run
  reaches a terminal status (`isTerminalRunStatus`, shared so the two hosts cannot disagree about when a
  run is finished) or on Ctrl-C or a time cap. Both the preview projection and the terminal predicate
  live in Core so Desktop's "Run with strategy" dialog and live view render the same answers. Eight
  tests — preview surfaces strategy/origin/children (mutation-proved on the child-spawn logic), the
  terminal predicate, and a journal-tail test proving the map grows as events append and turns terminal
  when the run finishes.
- [~] **A40-10 — PARTIAL. Ship Desktop Runs and explicit strategy launch.** Preserve the panel ID, add Runs |
  Design with normal no-goal turns visible by default, preview/confirm, live/reconnect state,
  accessible graph/list fallback, details and authorized transcript drill-down; validate
  source-started browser and Electron.

  **Shipped in `7f2aaa60c`**: a reachable, tested Runs panel SHELL, built to render Core's `runsView`
  shape. What that commit did NOT ship was the host DATA PATH — `runs.list`/`runs.detail` were never
  registered — so the panel could only ever draw a permanent empty state, and the "two hosts cannot
  disagree about whether a run failed" guarantee was not yet true. (The A40-040 remaining-work audit
  caught this overclaim; it is corrected below.) Registered in the catalog,
  the barrel and the render switch, so it can actually be opened. The list is the primary
  presentation rather than a fallback: a graph is a nicety, a run you cannot read with a screen
  reader is a run you cannot inspect. `stale` is distinguished from `error`, `summary-only` from
  `projected`, and `interrupted` from `failed` — each collapse would be a lie the surface tells
  confidently. 650/650 desktop tests, including the inventory check that caught the missing panel
  group the moment the id was added.

  **Browser validation: RUN, partially.** The renderer launch config only targeted the main checkout,
  so the first attempt would have rendered a tree without this panel — validating against the wrong
  tree is worse than not validating, and that run was stopped rather than reported. A worktree-target
  entry was added and the app was loaded in a real browser from THIS tree: it renders with no console
  errors, the dev server serves `{ id: "runs", title: "Runs", icon: "activity" }` and `runs: "work"`
  from the worktree's catalog, and `RunsPanel.tsx` compiles and serves (HTTP 200) with its exported
  helpers intact.

  **Electron validation: RUN.** The Electron host builds clean from this worktree and its full
  main-process suite passes (559/559) with the new panel id — the check that matters there, since an
  added `PanelId` is exactly the kind of change that breaks a host enum or a golden inventory
  elsewhere. The production renderer bundle also builds and contains `id:"runs"` and `runs:"work"`,
  so the panel survives a real production build rather than only the dev server.

  **The data path is now wired.** `runs.list` and `runs.detail` are registered in the desktop host
  (`electron/host/queries.ts`), each mirroring the CLI `/runs` handler EXACTLY — same `openDurableRuns`
  best-effort, same `toRunsListRows`/`toRunDetailView`, same absent snapshot — so the panel and the CLI
  now render ONE projection from one source, and the "two hosts cannot disagree" guarantee is finally
  true rather than asserted. It is read-only: the curated `./orchestration/runs` subpath excludes
  `readDurableRunResumeState`, so no resume material reaches a rendering surface. `queries.runs.test.ts`
  drives the real `buildQueries` handlers over a seeded durable run and mutation-proves both the
  registration (rename the handler and the test fails) and the honest projection (`summary-only` rows,
  an `unavailable` detail with a caveat and an empty node list, `null` for a missing run).

  **Projection-type de-duplication now shipped.** The panel's `RunsRow`/`RunsDetail` are no longer a
  parallel copy — they are type aliases to Core's `RunsListRow`/`RunDetailView`, imported type-only
  (erased at build, so the renderer bundle never pulls Core's node-side run store; verified against a
  real `vite build`). "One projection, two hosts" is now compile-time-enforced: a bidirectional
  type-identity guard in `RunsPanel.test.ts` fails the typecheck if the shapes ever diverge
  (mutation-proved — adding a field to the panel's type breaks the build).

  **Still open for this row:** the explicit-strategy-launch UI (preview/confirm start) and authorized
  transcript drill-down — both need visual review and the latter crosses the resume-material boundary;
  a live/stale host push channel to replace the one-shot mount fetch; and driving the panel open in the
  running app to assert rendered contents against live data.
- [x] **A40-11 — Generalize optimization subgraphs.** The vocabulary and the migration are both done — the row is complete. Add domain-neutral measurement, counter-metric,
  verifier, arbitration, rollback, and drift/audit decisions only after the execution map can show
  their real behavior; retain the current Engineering build-loop compatibility path during
  migration.

---

## 8. Acceptance

### 8.1 Architecture invariants

- `execution-engine-retired.test.ts` still proves there is one agent turn engine and no engine knob.
- CLI and Desktop call the same topology service and reduce identical event fixtures to semantically
  equivalent views after canonicalizing volatile IDs/timestamps/usage, or to byte-equivalent views
  when the fixture injects the same clock, ID generator, and usage source.
- Every eligible top-level user-authored conversational turn runs the same topology policy whether
  or not a goal is active, and can adaptively select only direct or an eligible profile strategy.
- A model-authored planner/tool call without trusted intent cannot start a durable execution; an
  explicit command/UI action can, and the resulting run is a child of the current turn when nested.
- A nested agent cannot recursively select a topology unless its parent node explicitly permits it.
- A goal supervisor optionally parents sequential turn executions and both hosts use the same
  continuation decision and reason codes; it is never a prerequisite for per-turn selection.
- No selected node or cumulative execution exceeds manifest, parent, role, tool, delegation, node,
  child, call, retry, iteration, depth, wall-time, token, cost, or concurrency ceilings.

### 8.2 Normal-conversation and goal parity

Start fresh CLI and Desktop sessions with no goal record and run equivalent fixtures:

1. a small informational prompt selects direct;
2. a complex signal-matched prompt selects its eligible profile plan;
3. an elliptical follow-up to an unresolved user-authored or user-confirmed task selects from the
   bounded conversation task envelope rather than losing the established work shape;
4. a contextless acknowledgement with no unresolved task selects direct; and
5. each turn emits the same decision, node, edge, child, budget, fallback, and terminal semantics
   through the shared execution projection.

Assert that Core evaluates topology exactly once for each eligible top-level turn, the managed model
selector is skipped when no non-direct candidate survives, the turn itself is the execution-tree
root, and no goal record is created or mutated.

Repeat the same prompts with an active goal whose user-authored objective is semantically redundant
with the unresolved task already present in the no-goal fixture, and keep effective ceilings equal.
Per-turn topology, plan identity, candidates, and selection outcome must remain equivalent; only
optional goal parent correlation and continuation decisions may differ. A distinct user-authored
goal objective may affect signals only as bounded, confirmed task context would in a no-goal
conversation; the active-goal flag itself cannot. A separate lower-ceiling fixture may only narrow
candidates or budgets. This proves normal conversation uses the feature and goal mode merely groups
it.

### 8.3 All-profile selection matrix

For every one of the 17 workspace profile IDs, first run its **unchanged default** through CLI and
Desktop adapters:

1. small/direct task and no eligible signal;
2. its saved off, explicit, or adaptive mode;
3. exact plan or declared work-shape alias;
4. an invalid/colliding/quarantined higher-precedence exact claim, which must not fall through;
5. missing role, missing skill, disabled delegation, and lower runtime concurrency.

Then run **configured-mode fixtures** without changing the shipped default:

1. one reviewed eligible multi-stage strategy for every profile, using the declared shared work
   shape where appropriate and a user-reviewed contributed plan for Custom;
2. explicit mode with and without a trusted strategy intent;
3. adaptive mode with managed-selection success, timeout, error, and invalid ID/stage set;
4. cancellation while a primary node, child node, and approval node is active;
5. a simple task that must remain direct despite a graph being available.

Expected topology, plan identity, selection source, fallback reason, nodes, edges, child IDs, and
terminal status must match across hosts. This is the proof that the feature is not Engineering-only.

### 8.4 Selection quality

Each profile owns a reviewed corpus containing simple work and work that genuinely benefits from
specialization, fan-out/fan-in, independent verification, or an explicit control point.

Compare direct against selected topology using external outcomes: deterministic checks, source/
citation support, reproducibility, rubric-based human review, retained-understanding checks, or the
profile's other frozen acceptance evidence. Record latency, tokens/cost, retries, failures, and
human interventions.

A profile does not default to adaptive until:

- simple tasks stay direct with high precision;
- structured tasks improve the frozen outcome enough to justify added cost;
- unavailable measurement is reported, never counted as success;
- graph execution respects budgets and terminates under adversarial failures;
- the independent counter-metric does not regress beyond the reviewed bound.

### 8.5 Safety and failure

- An approval node with no approver is blocked in Core, CLI, Desktop, resume, and subworkflow
  paths.
- Cancellation is observed before the next node/iteration/side effect and records a terminal event.
- Tool-call/result pairing survives steer, cancellation, provider failure, and child failure.
- Duplicate/out-of-order events cannot move a terminal node back to running; a missing sequence
  produces a gapped view and snapshot refresh, and schema-version mismatch fails visibly.
- Persisted/transmitted safe views contain no prompts, chain-of-thought, model-generated summaries,
  credentials, raw tool payloads, synthesized output, or unbounded model/error text. Protected resume
  payloads never enter the wire projection and enforce owner/workspace retention and access policy.
- A child/session ID cannot be used to read a transcript across a workspace or tenant boundary.
- Side-effecting retry/resume is idempotent or explicitly stopped for human decision.
- Oversized definitions, sequential fan-out waves, nested subworkflows, and cumulative retries cannot
  exceed the inherited execution budget; unavailable cost metering blocks an explicitly cost-capped
  run.
- Required failure, optional failure, partial fan-out, missing synthesis input, unselected branch,
  typed failure edge, and rollback each produce the D5 state/edge behavior in all adapters.
- Resume from failed/blocked/cancelled/interrupted state creates a new execution linked to the
  immutable terminal original; approval resolution continues the same non-terminal execution.
- Editing a saved graph or subworkflow after launch does not change resume: the immutable hash/snapshot
  runs, or missing protected state blocks visibly.
- Kill the process during event append, node execution, approval wait, safe-view replacement, and a
  side-effecting call. Recovery preserves the last valid sequence, rejects a corrupt tail, reconciles
  ownership, and reports interrupted/unknown side-effect outcome rather than success.
- Concurrent launches of one slug receive different execution IDs; concurrent writers cannot lose
  transitions, and recent-run listing/pagination/retention never mistakes `latest` for identity.

### 8.6 Product evidence

- Desktop Runs renders direct, profile, phase, and saved-graph fixtures; provides a non-canvas list
  fallback; remains keyboard/screen-reader usable; and has no overlap/overflow at supported Desktop
  widths and 200% zoom.
- The source-started browser bridge and Electron produce the same run content; mocks alone do not
  pass.
- CLI renders the same fixtures as readable text and stable JSON.
- In fresh no-goal CLI and Desktop sessions, send one direct and one profile-selecting prompt through
  normal chat, inspect each execution live in `/runs` or Desktop Runs, restart/reload the session,
  and verify both retained views, topologies, and terminal states remain available without any goal
  record having been created.
- A live cross-host scenario starts a multi-stage run, fans out, opens one child transcript, retries
  one node, waits for approval, cancels or resumes, and reaches the same retained terminal map in
  both hosts.
- Focused checks pass per slice and the full hosted CI suite passes before each merge.

Not judged by: number of nodes, how impressive the canvas looks, or whether every task becomes a
graph. The measure is whether BrainRouter chooses the least complex topology that improves a real
outcome, stays inside authority, and can show exactly what ran.

---

## 9. Consequences

**Positive:**

- Loop and graph engineering become complementary layers instead of competing engine settings.
- Profiles share runtime machinery without sharing one domain workflow.
- Adaptive selection becomes both useful and inspectable.
- CLI and Desktop gain parity by construction through one projection.
- Optimization can add independent measurement, arbitration, and rollback without hiding inside a
  self-scoring loop.
- Current workflow primitives are reused instead of replaced.

**Costs and risks:**

- The shared event/run contract touches Core, protocol, CLI, Desktop, and workflow compatibility;
  this is why delivery is sliced.
- Managed selection adds latency and model cost when a non-direct candidate is eligible. Timeout and
  direct fallback limit the damage but do not remove it.
- Retaining safe execution metadata creates storage and migration work.
- A graph can multiply weak loops, token use, and failure paths. Selection-quality gates must prove
  it earns that cost.
- The truthful Runs view will expose current lifecycle and safety defects. That is a benefit only if
  the team treats visible failure as evidence, not a UI problem to hide.

The desired result is not “BrainRouter uses graphs.” It is:

> **BrainRouter knows when one bounded loop is enough, when a reviewed graph of bounded loops is
> justified, and can show the same truthful answer everywhere it runs.**


  **Shipped in `3c584b73e`.** This row's precondition — "only after the execution map can show their
  real behavior" — is met: A40-4's vocabulary, A40-5's reducer, A40-7's emitter and A40-9/A40-10's
  surfaces exist, and each optimization decision maps onto `ExecutionDecision`.

  Domain-neutral measurement, counter-metric, verifier, arbitration, rollback and drift/audit. Three
  orderings carry it, each a way a self-scoring loop lies: a counter-metric regression rejects even
  when the target improved and is checked FIRST so the reported reason is the trade itself; a failed
  verifier beats a measurement that says yes, and an unrun verifier is `unverified` rather than
  assumed to have passed; arbitration gives the verifier the win, because a tie broken toward the
  optimiser is not a tie broken. Drift/audit catches a metric that stopped discriminating. Twelve
  tests, mutation-proved.

  The Engineering build loop is retained as ONE instance of the shape, expressed in general terms.

  **The migration now shipped — the row is complete.** The live Engineering build loop emits its
  optimization decisions into the canonical map, with the old gates retained as the authority:

  - the phase-plan emitter gained `emitDecision` (`phasePlanAdapter.ts`), so a `/build` run — which
    goes through the phase-plan path — can carry a decision into `snapshot.decisions`, not just the
    graph path. Mutation-proved: drop the decision payload line and the projection is empty.
  - the critic gate (`workflowTool.ts`) records `judgeOptimizationRound` over the candidate score vs
    the accept threshold, with `executionVerifyGreen` as the independent verifier — the honest numeric
    round. The gate's own `accepted` flag still DECIDES; the verdict only records how.
  - the merge/rollback records `engineeringBuildLoopRound` (the retained Engineering compat shape:
    verify-green → `pass_rate`, review-approval → the `lint_errors` counter-metric), emitting `merged`
    vs `held`. `verifyGreen && reviewApproved` still decides the merge upstream.

  Every emission is best-effort and side-effect-free — a canonical-emit failure drops the record,
  never the build. `optimizationSubgraph.ts` left the E1 KNOWN_UNWIRED set as three of its exports
  gained a production caller (dead-export ceiling 280 → 278). The old path is retained: nothing about
  what the loop DOES changed, only that its decisions are now visible in the map.