# ADR-023 — Profile-Specific Orchestration Plans

**Status:** Proposed for `release/0.4.17` · **Builds on** ADR-021 (workspace
profiles) and ADR-022 (persona, orchestration, and context contracts) ·
**Refines** ADR-022 sections 4, 5, 7, and 9 without changing their authority
boundaries.

## Date

2026-07-26

## TL;DR

`packages/core/agents/*.json` is the executable **orchestration-role registry**.
Those files answer what one reusable child role may do: its access posture,
tool ceiling, tier, limits, delegation behavior, and output contract. They are
not complete orchestration definitions for Engineering, Research, Study,
Writing, Data Science, or Custom workspaces.

BrainRouter will add a separate bounded JSON contract:

```text
packages/core/orchestration-profiles/
├── engineering.json
├── research.json
├── data-science.json
├── study.json
├── writing.json
└── custom.json
```

An orchestration profile references reusable roles, skills, stage dependencies,
fan-out limits, expected outputs, and eligible strategies. It never defines a
model, grants tools or access, embeds a persona, or bypasses the workspace
manifest.

The effective runtime composition becomes:

```text
workspace profile
  → orchestration-profile JSON
  → selected eligible strategy
  → bounded stage graph
  → reusable role JSON for each child stage
  + active persona
  + task capabilities and selected skills
  + delegated-task packet and context envelope
  ∩ workspace manifest ceilings
  ∩ parent authority and user delegation policy
  ∩ runtime/provider concurrency limits
```

Engineering keeps the current investigate/design/build/review/verify behavior.
Research, Study, Writing, and Data Science receive different plans rather than
being forced through an engineering-shaped child-agent loop.

## Context

ADR-022 correctly separated domain persona from executable orchestration role
and added profile-specific manifest defaults. The current code now has three
useful layers:

| Current layer | Location | What it owns |
|---|---|---|
| Workspace profile preset | `packages/core/src/workspace/profiles.ts` | Persona, capabilities, skill packs, tool groups, memory posture, and a small orchestration allowlist |
| Workspace orchestration ceiling | `.brainrouter/workspace.json` | Mode, available roles, disabled roles, and maximum parallel children |
| Executable role definition | `packages/core/agents/*.json` | Role prompt, access, tool scope, limits, tier, delegation, and output contract |

The profile presets already differ:

| Profile | Mode | Available roles | Parallel ceiling |
|---|---|---|---:|
| Engineering | Adaptive | Explorer, architect, worker, reviewer, verifier | 4 |
| Research | Adaptive | Explorer, reviewer | 3 |
| Data Science | Adaptive | Explorer, worker, verifier | 4 |
| Study | Explicit | Explorer | 2 |
| Writing | Explicit | Reviewer | 2 |
| Custom | Off | None | 1 |

That is a useful authorization boundary, but it is not yet a profile-specific
orchestration plan. It does not answer:

- which strategies are appropriate for the task;
- which stages run on the primary agent and which use children;
- which stages may fan out;
- which stage depends on which earlier result;
- which skills and expected-output contract apply to each stage;
- when a review, citation check, assessment, remediation, or reproducibility
  pass is needed;
- how the runtime should fall back when a role or skill is unavailable.

The bundled role JSON also still reflects its engineering origin:

- `explorer` describes codebase investigation;
- `architect` describes feature and system design;
- `reviewer` describes code review and currently denies web search;
- `worker` describes implementation and file edits;
- `verifier` describes tests and build checks.

Those definitions work well for Engineering. Reusing them unchanged for every
profile creates incorrect behavior. A Research reviewer may need source reads
and citation verification. A Study workspace should usually keep the tutor on
the primary conversational path rather than spawn a worker. A Writing reviewer
critiques structure and clarity, not a code diff. A Data Science verifier checks
reproducibility, assumptions, and experiment evidence in addition to tests.

Copying each role into profile-specific `agents/*.json` files would solve the
surface problem by recreating the identity/execution coupling that ADR-022
removed. The missing abstraction is a profile orchestration plan.

There is also an enforcement gap. The active role registry applies
`availableRoles` and `disabledRoles`, while the spawn chokepoint applies the
global CLI concurrent-child cap. The manifest's `maxParallel` is reviewed and
serialized but is not yet part of the single effective spawn-slot calculation.
A profile-plan resolver must close that gap rather than add another advisory
limit.

## Decision drivers

1. Every workspace profile needs behavior appropriate to its domain and normal
   interaction pattern.
2. Role JSON must remain a reusable execution-policy trust boundary, not become
   a second persona or a complete workflow.
3. Profile plans must be data-driven, schema-validated, inspectable, and
   overridable without hardcoding every topology in TypeScript.
4. A plan may narrow authority and consumption but must never widen tools,
   access, role availability, delegation, or concurrency.
5. Adaptive selection may use a managed model, but the model must choose among
   validated strategies and may not invent roles or graphs.
6. Direct primary-agent handling must remain a valid strategy. Orchestration is
   not synonymous with spawning children.
7. Existing workspace manifests must remain stable and committable.
8. Plugins and workspaces need an extension point with bounded discovery,
   collision diagnostics, and explicit onboarding disclosure.
9. Execution traces must explain which plan, strategy, stage, and role were
   selected.
10. Implementation must ship through small, independently reviewable PRs.

## Decision

### 1. Keep reusable role definitions in `packages/core/agents`

`packages/core/agents/*.json` remains the correct location for bundled
executable child-role definitions.

An orchestration-role definition answers:

```text
What execution posture does this child have?
What is its maximum authority?
What resource limits and output contract apply?
May it delegate?
```

It does not answer:

```text
Which workspace profile is active?
Which domain workflow should run?
Which role should run before or after another role?
Which research, tutoring, writing, data, or engineering skill applies?
```

The bundled roles will become domain-neutral:

| Role | Domain-neutral responsibility |
|---|---|
| `explorer` | Read-only investigation of the assigned sources; return bounded findings with evidence |
| `architect` | Compare designs and trade-offs; return a decision-ready recommendation |
| `worker` | Produce the assigned artifact or change within granted write authority |
| `reviewer` | Critique an artifact against the supplied criteria; return prioritized findings |
| `verifier` | Execute permitted checks and report evidence for pass, fail, or uncertainty |
| `intake` | Convert a vague request into a bounded requirement and acceptance criteria |
| `fleet` | Execute an explicitly authorized unattended delivery packet |

Domain-specific judgment enters through the active persona, selected skills,
capabilities, stage objective, expected output, and context envelope.

Role definitions still own hard execution policy. An orchestration profile
cannot override a role's model, effort, access, tool scope, disallowed tools,
tier, timeout, iteration limit, delegation policy, or ownership boundary.

### 2. Add a separate `orchestration-profile` JSON schema

Bundled plans live under:

```text
packages/core/orchestration-profiles/<profile-id>.json
```

The first schema is:

```json
{
  "schemaVersion": 1,
  "kind": "orchestration-profile",
  "id": "engineering",
  "displayName": "Engineering orchestration",
  "defaultMode": "adaptive",
  "rolePolicy": {
    "availableRoles": ["explorer", "architect", "worker", "reviewer", "verifier"],
    "disabledRoles": ["fleet"]
  },
  "limits": {
    "maxParallel": 4,
    "maxStages": 6,
    "maxChildrenPerStage": 3,
    "maxTotalChildren": 8,
    "maxDepth": 2,
    "maxRetries": 1
  },
  "strategies": [
    {
      "id": "direct",
      "description": "Keep a small or conversational task on the primary agent.",
      "activation": {
        "signals": ["small-scope"],
        "explicitOnly": false
      },
      "stages": [
        {
          "id": "complete",
          "executor": { "kind": "primary" },
          "after": [],
          "objective": "Complete the bounded task directly.",
          "skillIds": [],
          "optional": false
        }
      ]
    },
    {
      "id": "delivery",
      "description": "Investigate, implement, review, and verify a software change.",
      "activation": {
        "signals": ["implementation", "bug-fix", "multi-surface-change"],
        "explicitOnly": false
      },
      "stages": [
        {
          "id": "inspect",
          "executor": { "kind": "role", "roleId": "explorer" },
          "after": [],
          "objective": "Map the affected surfaces, constraints, and existing behavior.",
          "skillIds": ["planning-skill"],
          "fanOut": { "min": 1, "max": 2 },
          "optional": true,
          "expectedOutput": {
            "contractId": "findings",
            "requiredSections": ["scope", "evidence", "risks"]
          }
        },
        {
          "id": "implement",
          "executor": { "kind": "role", "roleId": "worker" },
          "after": ["inspect"],
          "objective": "Implement the reviewed requirement within the assigned ownership.",
          "skillIds": ["incremental-skill", "testing-skill"],
          "fanOut": { "min": 1, "max": 2 },
          "optional": false,
          "expectedOutput": {
            "contractId": "worker",
            "requiredSections": ["changes", "verification"]
          }
        },
        {
          "id": "review",
          "executor": { "kind": "role", "roleId": "reviewer" },
          "after": ["implement"],
          "objective": "Review the resulting artifact against the requirement and policy.",
          "skillIds": ["code-review-and-quality"],
          "fanOut": { "min": 1, "max": 1 },
          "optional": true,
          "expectedOutput": {
            "contractId": "reviewer",
            "requiredSections": ["findings"]
          }
        },
        {
          "id": "verify",
          "executor": { "kind": "role", "roleId": "verifier" },
          "after": ["implement"],
          "objective": "Verify the requested behavior with proportionate checks.",
          "skillIds": ["verify-loop"],
          "fanOut": { "min": 1, "max": 1 },
          "optional": true,
          "expectedOutput": {
            "contractId": "verifier",
            "requiredSections": ["result", "evidence"]
          }
        },
        {
          "id": "deliver",
          "executor": { "kind": "primary" },
          "after": ["review", "verify"],
          "objective": "Resolve blocking findings and deliver the final result.",
          "skillIds": ["shipping-skill"],
          "optional": false
        }
      ]
    }
  ]
}
```

This example is illustrative. The implemented schema must remain smaller than
the maximum shown here and use shared parsers for repeated structures.

Required top-level fields are `schemaVersion`, `kind`, `id`, `displayName`,
`defaultMode`, `rolePolicy`, `limits`, and `strategies`. Unknown fields are
rejected.

The schema permits:

- a bounded list of strategies;
- an explicit default available/disabled role policy;
- registered activation signal IDs;
- a bounded acyclic stage graph;
- `primary` or validated orchestration-role executors;
- bounded stage objectives;
- skill references;
- stage dependencies;
- optional stages;
- bounded fan-out;
- expected-output contracts.

The schema does not permit:

- personas or persona instructions;
- models or reasoning effort;
- access modes;
- tool grants or tool denials;
- raw shell commands;
- arbitrary MCP calls;
- credentials, paths, tenant IDs, or user IDs;
- unbounded loops, recursion, retries, stages, fan-out, or output;
- executable JavaScript or expression strings;
- regular expressions over user prompts;
- authority overrides.

### 3. Give every built-in profile its own plan

The six bundled plans have different defaults and strategy shapes:

| Profile | Default behavior | Eligible child roles | Representative strategies |
|---|---|---|---|
| Engineering | Adaptive delivery with direct handling for small work | Explorer, architect, worker, reviewer, verifier | `direct`, `investigate`, `design`, `delivery`, `review-only` |
| Research | Read-oriented evidence work with parallel collection only when useful | Explorer, reviewer | `direct-answer`, `question-decomposition`, `parallel-evidence`, `citation-review` |
| Data Science | Inspect data, run bounded analysis, verify reproducibility, synthesize | Explorer, worker, verifier | `direct-analysis`, `experiment`, `dataset-audit`, `reproducibility-check` |
| Study | Primary tutor remains conversational; children are exceptional | Explorer | `direct-tutoring`, `diagnose-teach-check`, `remediate`, `source-explanation` |
| Writing | Primary writer owns outline/draft/revision; critique may be delegated | Reviewer | `direct-writing`, `outline-draft-revise`, `critique-revision` |
| Custom | No automatic child orchestration | None until enabled | `direct` only |

#### Engineering

Engineering preserves the behavior that already works: inspect unfamiliar
surfaces, optionally compare architecture, implement bounded slices, then
review and verify in proportion to risk. Frontend and backend remain
task-selected capabilities under the `engineer` persona; they may select
different skills without selecting another persona or orchestration profile.

#### Research

Research normally stays read-oriented. Independent source questions may fan out
to explorers, followed by a reviewer using citation-verification and
research-review skills. The primary researcher owns final synthesis and clearly
separates evidence from inference. A plan cannot enable network access; source
tools must already survive the effective tool-policy intersection.

#### Data Science

Data Science may use an explorer to inspect datasets or prior experiment
artifacts, a worker for permitted analysis, and a verifier for reproducibility,
assumption checks, or metric validation. The primary data-scientist persona owns
the final interpretation. Shell or data writes remain separately authorized.

#### Study

Study is not modeled as an engineering pipeline. The tutor on the primary path
diagnoses, teaches, checks understanding, and remediates using the existing
study skills. An explorer may be used only for bounded external or repository
source gathering. Normal tutoring does not spawn a worker or reviewer.

#### Writing

Writing keeps authorship on the primary writer. A reviewer child may critique
structure, consistency, evidence, or style against an explicit rubric. The
primary writer performs revision. The plan never turns reviewer output into an
automatic write.

#### Custom

Custom defaults to direct primary execution with orchestration mode `off`. A
user must explicitly enable roles and review a contributed custom plan before
adaptive selection becomes possible.

### 4. Resolve plans independently from workspace authority

The workspace profile selects the orchestration profile with the same ID.
`WorkspaceProfilePreset` will reference an `orchestrationPlanId` rather than
duplicate the full role/default topology in TypeScript.

During onboarding:

1. the selected workspace profile resolves its plan;
2. the plan's default mode, roles, disables, and parallel ceiling populate the
   reviewed workspace-manifest draft;
3. the user or assisted initializer may narrow or edit those manifest fields;
4. only the reviewed manifest is persisted.

At runtime:

```text
effective roles =
  strategy role references
  ∩ plan role set
  ∩ manifest availableRoles
  − manifest disabledRoles
  ∩ active role registry

effective parallelism =
  min(
    strategy fan-out,
    plan limits.maxParallel,
    manifest orchestration.maxParallel,
    CLI concurrent-child limit,
    provider/runtime semaphore capacity
  )

effective skills =
  stage skill references
  ∩ installed and enabled workspace skills
  ∩ active capability skill selections

effective tools and access =
  role ceiling
  ∩ workspace tool policy
  ∩ parent authority
  ∩ user delegation policy
  ∩ runtime security gates
```

Missing roles or skills narrow or skip an optional stage. A missing requirement
for a mandatory stage makes that strategy unavailable; it never falls back to a
more privileged role.

The workspace manifest remains the user-reviewed execution ceiling. The plan is
an eligible behavior description, not authority.

### 5. Do not add a manifest version solely for the plan ID

For the built-in profiles, `manifest.profile` deterministically selects the
same-ID orchestration plan. The manifest continues storing its reviewed
orchestration snapshot:

```json
{
  "profile": "research",
  "orchestration": {
    "mode": "adaptive",
    "availableRoles": ["explorer", "reviewer"],
    "disabledRoles": ["fleet"],
    "maxParallel": 3
  }
}
```

The full strategy graph is not copied into `.brainrouter/workspace.json`.
Embedding it would make the manifest large, noisy, difficult to review, and
capable of drifting from installed role and skill catalogs.

An explicit `orchestration.planId` is deferred until BrainRouter supports
multiple plans for one profile or user-defined profile IDs. That change would
require its own manifest compatibility decision. The initial implementation
does not need manifest v3.

### 6. Select strategies through a bounded planner

The runtime adds one pure resolution chokepoint:

```text
resolveWorkspaceOrchestrationPlan(
  profile,
  manifestCeilings,
  taskSignals,
  capabilities,
  roleCatalog,
  skillCatalog,
  delegationPolicy,
  runtimeLimits
) → resolved plan or direct-primary fallback
```

Strategy selection follows this order:

1. `mode: off` returns direct primary execution with no children.
2. A trusted explicit user/workflow strategy request is accepted only if that
   strategy is valid and available.
3. `mode: explicit` otherwise remains on the primary agent.
4. `mode: adaptive` considers strategies whose registered activation signals
   match the task and available catalogs.
5. A managed model may choose one of those strategy IDs using a bounded
   structured response containing only `strategyId`, stage enablement choices,
   and a short rationale.
6. The deterministic resolver validates the choice and applies every ceiling.
7. Invalid, unavailable, uncertain, or timed-out selection falls back to the
   profile's `direct` strategy.

The model cannot return arbitrary role IDs, skill IDs, stage graphs, prompts,
tools, access, concurrency, or budgets. It chooses among already validated
data.

Task signals come from a registered catalog. Plan JSON cannot supply regexes or
execute expressions over raw user text. The resolver may use existing
capability and repository-signal infrastructure, but signal extraction remains
separate from plan data.

### 7. Compile a selected strategy into delegated-task packets

Each child stage compiles into the ADR-022 delegated-task contract:

```text
stage objective
  + active workspace persona
  + task-recomputed capabilities
  + validated stage skill references
  + expected output contract
  + selected parent context references
  + tool/access ceilings
  + bounded execution budgets
```

Parent conversation history is never copied into a child. The child receives
only the bounded task packet and context-envelope layers selected for that
stage.

A `primary` stage does not create a child. It tells the root agent which prior
stage results and skills are relevant for the next step. This is necessary for
Study and Writing, where the normal orchestration is a structured primary-agent
loop rather than child fan-out.

The graph executor:

- rejects cycles and missing dependencies;
- caps stages, children per stage, total children, depth, retries, and result
  size;
- never starts a stage until its required predecessors are terminal;
- skips unavailable optional stages with a diagnostic;
- fails closed when a mandatory stage cannot be satisfied;
- preserves structured child results instead of concatenating raw transcripts.

### 8. Add bounded plugin and workspace contribution points

After the bundled schema and resolver are stable, plugins may contribute:

```text
<plugin>/orchestration-profiles/*.json
```

The plugin manifest gains:

```json
{
  "contributes": {
    "orchestrationProfiles": "orchestration-profiles"
  }
}
```

Workspace sources are:

```text
<workspace>/orchestration-profiles/*.json
<workspace>/.brainrouter/orchestration-profiles/*.json
```

Resolution is whole-definition, first-match-wins:

```text
local workspace override
  → committable workspace definition
  → enabled plugin
  → bundled
```

Definitions are never deep-merged across sources. Deep merging stage graphs
would make authority and dependency order difficult to review.

All sources use one parser and the same:

- regular-file and no-symlink policy;
- realpath containment checks;
- file, string, array, graph-node, edge, and total-definition limits;
- filename/ID matching;
- discriminator and schema-version validation;
- unknown-field rejection;
- duplicate and collision diagnostics;
- exact role, skill, signal, and output-contract reference validation.

Onboarding and plugin consent surfaces disclose that a package contributes an
orchestration profile because it can influence child selection, compute usage,
and execution order. Enabling a contribution does not activate it unless the
workspace profile and manifest also permit it.

### 9. Make orchestration selection inspectable

Every resolved execution records bounded structured trace data:

```text
orchestrationProfileId
strategyId
selectionSource: explicit | adaptive-model | deterministic | fallback
matchedSignalIds
stageId
executorKind
roleId, when applicable
skillIds that survived resolution
skippedStage reason
effective parallel ceiling
authority-intersection summary
```

Do not persist user prompt content, stage objectives from untrusted workspace
files, filesystem paths, credentials, tenant IDs, or full child outputs in
selection telemetry.

The CLI and Desktop review surfaces show:

- selected plan and strategy;
- why it was selected;
- which stages may spawn children;
- maximum parallel children;
- roles and skills that are unavailable or disabled;
- which field is a user-reviewed ceiling versus a plan default.

### 10. Keep workflows and orchestration profiles distinct

A workflow is an explicitly launched, durable run with artifacts, lifecycle,
resume behavior, and operational status.

An orchestration profile is an eligible per-task strategy and policy template.
It may compile a selected strategy into the existing phase/workflow machinery,
but loading a profile never creates a workflow run.

This distinction prevents profile selection from silently starting durable or
write-capable work.

### 11. Bind selected-plan execution to a live orchestration lifecycle

`route_task` and strategy selection are advisory. They may recommend an
eligible strategy; they do not themselves launch a child or queue raw
`delegate_agent` calls for later replay.

The core runtime deliberately exposes orchestration tools only while an
`Agent.runTurn` invocation owns an active orchestration runtime. That boundary
must remain fail-closed: a direct or deferred call outside that lifecycle must
not acquire the port, retry until it succeeds, or create work with an unclear
parent authority.

The plan executor therefore has one lifecycle owner and records each stage as
`planned`, `running`, `succeeded`, `failed`, `skipped`, or `cancelled`.

- A child stage launches only from the active parent turn that owns its
  orchestration runtime, or from an explicitly created durable workflow run
  with its own persisted lifecycle and authority context.
- The executor cancels unstarted ephemeral stages when that parent turn ends,
  is interrupted, or changes session. It never replays their raw tool calls
  after the turn.
- Detached work is created by the supported background-worker or durable
  workflow paths. Its completion is delivered through the existing completion
  contract, not by invoking an orchestration tool after the parent turn.
- A direct or `investigate` strategy has no child-stage launch path. A router
  recommendation cannot override that compiled strategy.
- A missing active runtime is a terminal lifecycle diagnostic for the affected
  stage, not a retryable tool failure. The runtime emits one deduplicated plan
  error and cancels related unstarted stages.
- Trace/UI terminology reflects accepted state: label a row **Delegated** only
  after a child launch is accepted. A rejected pre-launch call is shown as
  **Delegation not started**, with the bounded lifecycle reason.

This makes the active-turn guard both a security boundary and a useful
diagnostic, rather than a source of repeated failed delegation rows.

## Profile behavior summary

| Concern | Engineering | Research | Data Science | Study | Writing | Custom |
|---|---|---|---|---|---|---|
| Normal owner | Primary engineer | Primary researcher | Primary data scientist | Primary tutor | Primary writer | Primary |
| Default mode | Adaptive | Adaptive | Adaptive | Explicit | Explicit | Off |
| Normal child fan-out | Investigation and implementation slices | Independent evidence questions | Dataset/experiment partitions | None | None | None |
| Review meaning | Code/design correctness | Evidence and citation quality | Assumptions and reproducibility | Learner understanding checked by primary | Editorial critique | User-defined |
| Verification meaning | Tests/build/runtime evidence | Citation support and source consistency | Reproduction and metric checks | Assessment and retrieval practice | Requirement/style conformance | User-defined |
| Write-capable role | Worker when authorized | None by default | Worker when authorized | None | Primary only | None by default |
| Final synthesis | Primary engineer | Primary researcher | Primary data scientist | Primary tutor | Primary writer | Primary |

## Security and authority invariants

1. Plan JSON is never an authority source.
2. `disabledRoles` always wins.
3. A plan cannot make an unavailable role model-visible.
4. A plan cannot override agent-role access, tools, model, limits, tier, or
   delegation.
5. A stage cannot receive more access or tools than its parent.
6. Plan parallelism is a ceiling and participates in the single spawn-slot
   calculation.
7. A plan cannot activate disabled skills or capabilities.
8. A plugin plan requires normal plugin installation, enablement, and
   contribution disclosure.
9. Missing or invalid plan data falls back to direct primary execution, not the
   Engineering plan.
10. No manifest preserves the existing no-manifest runtime behavior.
11. Strategy selection never blocks an interactive turn indefinitely; managed
    selection has a bounded deadline and deterministic fallback.
12. Plan resolution and task-packet construction are pure/testable before any
    child or workflow is created.
13. An orchestration tool never executes after its owning active turn ends;
    pending ephemeral stages are cancelled rather than replayed.

## Alternatives considered

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Keep only `profiles.ts` role allowlists | Smallest change; current onboarding already edits the fields | No topology, stage contract, skill binding, fallback, or profile workflow; behavior stays engineering-shaped | Rejected |
| Duplicate `agents/*.json` for every profile | Easy to visualize; every profile can customize prompts and tools | Recreates persona/executor coupling, duplicates security policy, causes role-ID explosion, and lets domain packages drift in authority | Rejected |
| Add profile-specific fields directly to each role JSON | Fewer files; one registry | One role becomes a matrix of profiles; collisions and overrides become ambiguous; executable trust boundary grows rapidly | Rejected |
| Let the managed model invent a plan on every task | Maximum flexibility; no schema authoring | Unbounded, difficult to review, inconsistent, expensive, and capable of inventing unavailable roles or unsafe fan-out | Rejected |
| Store the complete graph in each workspace manifest | Fully portable and user-editable | Large/noisy manifest, hard migrations, duplicated plans, poor plugin reuse, and an oversized committable execution surface | Rejected |
| Reuse durable workflow definitions as the profile contract | Existing graph/run infrastructure | Loading a profile is not launching a durable workflow; lifecycle, writes, artifacts, and resume semantics are too strong for task eligibility | Rejected as the public contract; selected plans may compile to internal phases |
| Retry or defer raw orchestration tool calls after the parent turn | Can appear to continue a selected strategy without another model turn | Bypasses the active-turn authority boundary, duplicates launches, and produces misleading failed delegation traces | Rejected |
| Add bounded orchestration-profile JSON referencing reusable roles | Separates topology from authority, supports all profiles, remains inspectable and extensible, and composes with ADR-022 packets | Adds a schema, loader, resolver, plan catalog, and migration work | Accepted |

## Consequences

### Positive

- Each profile gains orchestration appropriate to its domain.
- Engineering behavior remains strong without becoming the implicit template
  for every project.
- Reusable role policy has one security-review surface.
- Research and tutoring skills become executable workflow components without
  bloating persona prompts.
- Primary-agent strategies avoid unnecessary child cost and latency.
- Managed selection stays flexible while deterministic validation retains
  control.
- Plugins and projects gain a reviewable data extension point.
- Manifest `maxParallel` becomes an enforced runtime ceiling.
- Traces can explain plan and stage selection rather than merely showing that a
  child appeared.
- Rejected launches are distinguishable from real delegated work, without
  weakening the active-turn security boundary.

### Costs

- A new bounded JSON parser, registry, resolver, and catalog are required.
- Bundled role prompts must be generalized without regressing Engineering.
- `profiles.ts`, onboarding, CLI, Desktop, agent registry, spawn slots,
  delegated-task packets, and trace surfaces need coordinated migrations.
- Profile plans and their referenced roles/skills need cross-catalog parity
  tests.
- Plugin disclosure and publishing validation gain another component kind.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plan behaves like hidden authority | Schema excludes authority fields; every stage intersects with manifest, role, parent, and user ceilings |
| Too many children for simple work | Every profile has a direct strategy; adaptive fallback is direct; total and parallel children are bounded |
| Model chooses an unsuitable graph | Model chooses only eligible strategy IDs; deterministic validation and fallback are mandatory |
| Profile JSON and `profiles.ts` drift | JSON becomes the orchestration default source; TypeScript stores only the plan reference during migration |
| Plugin plan changes execution unexpectedly | Explicit plugin enablement, contribution disclosure, first-match resolution, and manifest ceilings |
| Domain-specific needs leak back into role prompts | Persona, capability, stage objective, skill, and expected-output fields carry domain behavior |
| Existing Engineering flow regresses | First implementation plan encodes current Engineering parity and ships before other profiles |
| Invalid optional stages hide missing functionality | Structured skip diagnostics and visible onboarding/runtime summaries |
| A deferred plan invokes a child tool after its turn | One lifecycle owner cancels ephemeral stages at turn end; runtime emits one terminal diagnostic and the UI distinguishes pre-launch rejection from delegation |

## Compatibility

- Existing manifest v2 files remain valid.
- Existing `packages/core/agents/*.json` role IDs remain stable.
- No-manifest workspaces preserve existing behavior.
- During migration, before the plan resolver becomes authoritative, runtime
  behavior remains the current manifest-filtered role registry. After
  activation, a missing or invalid plan fails closed to direct primary
  execution.
- Engineering ships first with behavior-parity tests before role prompts are
  generalized.
- `profiles.ts` orchestration defaults remain a compatibility source until all
  onboarding consumers resolve the JSON plan catalog.
- Removing the compatibility source requires one release of diagnostics and a
  separate PR.

## Implementation plan

Each item is a separate small PR and security preview.

### P23-1 — Schema and parser

- Add `orchestrationProfileDefinitionFile.ts`.
- Define strict bounded types, discriminator, graph validation, and no-follow
  file reads.
- Add invalid-shape, oversized, cycle, collision, and unknown-reference tests.

### P23-2 — Bundled catalog and Engineering parity

- Add `packages/core/orchestration-profiles/engineering.json`.
- Add bundled catalog discovery and exact file/ID parity tests.
- Encode current direct and delivery behavior without changing runtime
  activation.

### P23-3 — Pure resolver and effective ceilings

- Add `resolveWorkspaceOrchestrationPlan`.
- Intersect plan, manifest, role, skill, delegation, and runtime limits.
- Enforce `manifest.orchestration.maxParallel` in the spawn chokepoint.
- Add deterministic fallback and reason codes.

### P23-3a — Active-turn plan lifecycle

- Give every compiled stage a single lifecycle owner and terminal state.
- Cancel unstarted ephemeral stages at turn/session termination; never replay
  raw orchestration tool calls outside `Agent.runTurn`.
- Treat a missing orchestration runtime as one terminal, deduplicated plan
  diagnostic; do not retry it.
- Render rejected pre-launch attempts as `Delegation not started`, not as a
  completed delegation.
- Add direct/investigate, interruption, session-switch, duplicate-error, and
  trace-label regression tests.

### P23-4 — Domain-neutral reusable roles

- Generalize explorer, architect, worker, reviewer, and verifier prompts.
- Move Engineering-specific stage objectives and skill choices into the
  Engineering plan.
- Run cross-profile role, tool, output-contract, and Engineering-parity tests.

### P23-5 — Research and Data Science plans

- Add evidence-collection/citation-review strategies.
- Add dataset, experiment, and reproducibility strategies.
- Compile child stages into bounded delegated-task packets.

### P23-6 — Study and Writing primary-agent plans

- Add diagnose/teach/check/remediate and outline/draft/critique/revise
  strategies.
- Support primary stages without child creation.
- Verify no normal Study or Writing strategy gains write-capable children.

### P23-7 — Adaptive managed selection

- Add the bounded strategy-selection response schema and deadline.
- Allow only eligible strategy IDs and stage enablement choices.
- Add deterministic direct fallback, malformed-response tests, and trace
  reasons.

### P23-8 — Onboarding and product surfaces

- Derive profile defaults from the plan catalog.
- Preview plan, strategy, stages, roles, skills, and effective ceilings in CLI
  and Desktop.
- Preserve user review before any manifest write.

### P23-9 — Plugin and workspace contributions

- Add `orchestrationProfiles` to plugin discovery, summaries, publishing, and
  consent.
- Add workspace/local discovery with first-match precedence.
- Add collision and unavailable-reference diagnostics.

### P23-10 — Compatibility telemetry and cleanup

- Record content-free use of the `profiles.ts` orchestration compatibility
  source.
- Review adoption evidence after one supported-release window.
- Remove the duplicate TypeScript orchestration defaults in a separate PR.

## Acceptance criteria

1. All six built-in profiles resolve distinct orchestration-profile JSON.
2. Engineering retains its current direct and delivery behavior.
3. Research can parallelize evidence and review citations without gaining write
   authority.
4. Study and Writing normally remain on the primary persona path.
5. Data Science can analyze and verify reproducibility within explicit tool and
   access ceilings.
6. Custom remains off/direct until explicitly configured.
7. A plan cannot grant a role, skill, tool, access mode, model, or concurrency
   that another active policy forbids.
8. Manifest `maxParallel` is enforced at the spawn chokepoint.
9. Adaptive selection can choose only eligible strategy IDs.
10. Every child stage receives a bounded delegated-task packet; no raw parent
    history is copied.
11. CLI and Desktop explain the selected plan and effective ceilings before
    reviewed onboarding writes.
12. Invalid or unavailable plans fail closed to direct primary execution.
13. Plugin/workspace definitions obey the same bounded no-follow parser and
    produce collision diagnostics.
14. Hosted CI, cross-workspace parity tests, and automated security review pass
    for every implementation slice.
15. A direct or `investigate` strategy cannot invoke a child-launch tool.
16. An unstarted ephemeral stage is cancelled when its parent turn ends,
    interrupts, or changes session; no raw orchestration tool call is replayed
    outside `Agent.runTurn`.
17. A missing orchestration runtime creates at most one terminal plan
    diagnostic and no retry loop.
18. Desktop and CLI trace a rejected pre-launch call as a failed-to-start
    delegation, never as delegated work.

## Non-goals

- Creating a separate persona for every orchestration strategy.
- Creating Research-, Study-, Writing-, or Data-specific copies of every role.
- Allowing plans to grant tools, access, models, or provider capacity.
- Automatically running every stage listed in a profile.
- Replacing the durable workflow engine.
- Persisting full plan graphs or model rationales in the workspace manifest.
- Removing the user delegation policy or explicit confirmation gates.
- Allowing arbitrary executable code or expressions in plan JSON.
