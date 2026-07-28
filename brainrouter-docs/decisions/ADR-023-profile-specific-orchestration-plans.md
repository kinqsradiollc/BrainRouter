# ADR-023 — Profile-Specific Orchestration Plans

**Status:** Accepted; implementation in progress for `release/0.4.17` ·
**Builds on** ADR-021 (workspace profiles) and ADR-022 (persona,
orchestration, and context contracts) ·
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

Tool, capability, and skill selection becomes catalog-backed. A workspace
profile owns the primary persona and baseline pack; optional capabilities are
separately selectable specializations; capability-owned packs remain nested
under their capability instead of appearing as duplicate skill-pack choices.
Custom can select individual safe entries, and every effective selection
remains beneath the existing authority and runtime ceilings.

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

At the time of this decision, the bundled role JSON still reflected its
engineering origin:

- `explorer` describes codebase investigation;
- `architect` describes feature and system design;
- `reviewer` described code review and denied web search;
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
11. Onboarding must explain built-in tools and skills through the same catalog
    the runtime validates, rather than requiring users to enter internal IDs.

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
  "fallbackStrategyId": "direct",
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
            "contractId": "explorer",
            "requiredSections": ["headline", "files-read", "facts"]
          }
        },
        {
          "id": "implement",
          "executor": { "kind": "role", "roleId": "worker" },
          "after": ["inspect"],
          "objective": "Implement the reviewed requirement within the assigned ownership.",
          "skillIds": ["incremental-skill", "testing-skill"],
          "fanOut": { "min": 1, "max": 1 },
          "optional": false,
          "expectedOutput": {
            "contractId": "worker",
            "requiredSections": ["files-changed", "summary"]
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
            "requiredSections": ["commands", "pass-fail"]
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
`defaultMode`, `fallbackStrategyId`, `rolePolicy`, `limits`, and `strategies`.
Unknown fields are rejected.

The schema permits:

- a bounded list of strategies;
- an explicit default available/disabled role policy;
- registered activation signal IDs;
- a bounded acyclic stage graph;
- one explicit, validated primary-only fallback strategy;
- `primary` or validated orchestration-role executors;
- bounded stage objectives;
- skill references;
- stage dependencies;
- optional stages;
- bounded fan-out;
- expected-output contracts.

`fallbackStrategyId` must resolve to exactly one strategy in the same
definition. Every stage in that strategy must use the primary executor, use no
fan-out, require no child role, and reference no skill that could make fallback
unavailable. A definition without this safe fallback is invalid rather than
relying on a naming convention such as `direct`.

For a role stage, `expectedOutput.contractId` must equal the output contract
owned by that role definition. `requiredSections` contains only canonical
kebab-case section aliases registered by that contract; the parser validates
every alias against the selected contract rather than accepting arbitrary
section names. A plan can require a subset of an existing role contract, but it
cannot invent or replace the role's output contract. Primary stages do not
declare child output contracts.

A write-capable role may not use `fanOut.max > 1` unless the executor can prove
that every child has an isolated worktree or a disjoint, enforced ownership
boundary before any child starts. The initial Engineering plan therefore uses
one worker for its implementation stage. Read-only investigation may still fan
out within the effective parallel ceiling.

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

CLI and Desktop also present **Skip setup for now** before the write step.
Skipping discards the in-memory proposal and writes no workspace manifest,
plan/tool/skill selection, onboarding completion marker, or partial draft. The
workspace remains a no-manifest workspace with its existing prompts and runtime
behavior. Onboarding can be opened again later and starts from a fresh proposal;
an assisted initializer cannot persist its recommendation after the user skips.

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
   definition's validated `fallbackStrategyId`.

The model cannot return arbitrary role IDs, skill IDs, stage graphs, prompts,
tools, access, concurrency, or budgets. It chooses among already validated
data. If the selected strategy later becomes unavailable, the resolver uses
the already validated fallback strategy; it never guesses a strategy by name.

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

Every role-executed stage declares at least one stage-scoped skill. A role
without a domain workflow is an execution posture, not a complete child task,
so an empty child skill list makes that strategy invalid. Primary stages may
use an empty list when the active persona can handle the bounded step directly.
If a required child skill is unavailable, resolution falls back to the
profile's validated primary-only strategy rather than spawning a generic role.

Parent conversation history is never copied into a child. The child receives
only the bounded task packet and context-envelope layers selected for that
stage.

Role-level denials remain absolute, so reusable role JSON must not deny a tool
that a valid profile stage can require. The reviewer therefore keeps read
access but does not globally deny page fetch or web search. Network access is
available only when the reviewed workspace selects the browser group, the
active stage's intersected skill allowlists retain the tool, and every ordinary
runtime/access gate also permits it. Research citation-review stages keep
source resolution in both citation and review skill allowlists so stacked-skill
least privilege does not accidentally erase the workflow's required evidence
surface. Engineering and Writing review do not gain network access merely from
the reusable role.

Role MCP scopes use exact stable tool identifiers. The matching contract
supports an exact raw name or the exact suffix of a namespaced MCP tool; glob
entries such as `memory_*` are not wildcards and therefore match nothing.
Bundled roles name only the reviewed read-only memory, skill-discovery, and
Project Knowledge tools they may consume. The workspace selection, server
identity, parent authority, role access, and active skill allowlists remain
outer intersections, so this role list cannot grant an unselected surface.

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
- A direct or other primary-only strategy has no child-stage launch path. An
  Engineering `investigate` strategy may use an explorer child only when its
  validated graph explicitly contains that role stage. A router recommendation
  cannot add a child to the compiled strategy.
- A missing active runtime is a terminal lifecycle diagnostic for the affected
  stage, not a retryable tool failure. The runtime emits one deduplicated plan
  error and cancels related unstarted stages.
- Trace/UI terminology reflects accepted state: label a row **Delegated** only
  after a child launch is accepted. A rejected pre-launch call is shown as
  **Delegation not started**, with the bounded lifecycle reason.

This makes the active-turn guard both a security boundary and a useful
diagnostic, rather than a source of repeated failed delegation rows.

### 12. Make tool and skill selection catalog-driven and profile-aware

At the start of this decision, the workspace manifest had `tools.profiles` and
`tools.deny`, but its built-in group registry mapped only five product-level
IDs (`coding`, `terminal`, `browser`, `notes`, and `design`) to concrete tools.
The Desktop and CLI onboarding editors accepted those IDs, denied-tool IDs,
skill-pack IDs, and skill IDs as free-form lists.

That is insufficient for a profile-aware system: it conceals the available
surface, makes Custom unnecessarily dependent on internal names, and lets a
user select a misspelled or unavailable identifier without understanding what
will be effective at runtime.

#### 12.1 One inspectable catalog, not UI-maintained lists

Core exposes a bounded catalog query assembled from the existing authoritative
registries. A catalog entry includes only safe metadata:

```text
id, kind, label, short description, category, source/provenance,
access tier, action kind, required capability or extension,
runtime availability prerequisites, selectable state, and reason when blocked
```

The catalog is the only source for onboarding pickers, CLI review output,
strategy previews, and manifest validation. It must not contain a credential,
absolute path, raw plugin prompt, MCP response, or other sensitive workspace
content.

Catalog entries are classified as follows:

| Entry | Source of truth | Persistable selection | Notes |
|---|---|---|---|
| Built-in local tool | Required core tool catalog | Yes, by stable tool ID | Includes the tool's access/action/runtime metadata; the UI does not duplicate it |
| Built-in tool group | Workspace tool-profile registry | Yes, by stable group ID | A convenience bundle, expanded only by core |
| Built-in or installed skill | Existing skill discovery catalog | Yes, by stable skill ID | Shows description, pack/source, and availability; selection never embeds the skill body in the manifest |
| Trusted plugin tool, group, or skill | Normal plugin discovery plus contribution validation | Yes only when its stable contribution is installed and enabled | Shows plugin provenance and becomes blocked when disabled or unavailable |
| MCP/server-advertised tool | Live MCP discovery | No individual tool-name persistence | The manifest selects the reviewed MCP/capability surface; dynamic server tools remain runtime-discovered and policy-gated |

The selector reads the same discovery result the runtime uses. It must never
scan arbitrary files from the renderer or treat a label, description, or model
proposal as executable authority.

#### 12.2 Version the tool-selection semantic, not an orchestration-plan ID

ADR-023 does not require a manifest version merely to name an orchestration
profile. It *does* require a manifest v3 migration for the distinct,
behavior-changing tool-selection semantic:

```json
{
  "tools": {
    "mode": "explicit-catalog",
    "profiles": ["coding", "terminal"],
    "enabled": ["web_search"],
    "deny": ["computer_use"]
  }
}
```

`profiles` remains a readable convenience bundle. `enabled` is a checked,
stable catalog ID for a specific selectable tool or trusted contribution.
`deny` remains an explicit final subtraction. The reviewed-selection parser
rejects unknown, disabled, or non-persistable entries; onboarding presents
those entries as blocked instead of silently preserving a typo.

For `explicit-catalog`, core computes:

```text
requested = expanded selected groups ∪ individually enabled entries
effective = requested
  ∩ runtime availability
  ∩ capability and extension gates
  ∩ persona/role/tool-scope and parent ceilings
  ∩ access, approval, and user policy
  − explicit deny
```

No selection can widen a role, capability, extension, parent, runtime, or user
policy. A tool that is unavailable in the current session remains visible with
its reason but is neither model-visible nor executable. Runtime checks still
enforce every operation after this selection calculation.

Manifest v2 uses `mode: "legacy-groups"` on read. It preserves today's behavior:
the existing group gate applies to its managed surface while tools outside that
legacy registry retain their present visibility. Migration to
`explicit-catalog` is a reviewed user action; it is never inferred from an old
list. Each onboarding surface continues writing v2 until its catalog picker and
exact review are available, then explicitly writes v3 from the reviewed catalog
snapshot. Core exposes a stale-safe reviewed migration instead of changing an
older writer underneath that surface. A no-manifest workspace remains an exact
no-op.

Task-time capability detection cannot add an unselected tool group under
`explicit-catalog`; capabilities only subtract through their existing runtime
gates. Dynamic MCP/server names also cannot appear in `enabled`. A v3 workspace
opens that live surface through a reviewed stable MCP control entry, after
which individual server tools remain runtime-discovered and subject to the
ordinary access, scope, approval, and dispatch gates.

#### 12.3 Recommended starting selections are defaults, not grants

The first implementation grouped unrelated authority behind convenient names:
`terminal` also includes computer control and connector execution, `notes`
combines research state with artifact production, and `design` combines
artifact production with interactive browser control. Those groups remain
valid compatibility aliases for workspaces that already reviewed them, but
they are too coarse to be new-profile defaults.

Core therefore adds smaller, stable groups. Once persisted, a group ID's
expansion is immutable within the manifest version; a later release may add a
new group but must not silently add tools to an already reviewed group.

| Group | Concrete responsibility | Authority posture |
|---|---|---|
| `workspace-files` | Read, search, create, revise, and patch ordinary files in the selected workspace | Normal folder-backed production surface for Research, Study, and Writing; excludes LSP and notebook execution |
| `coding` | Read/search code, LSP, file edits, patches, and notebook edits | Normal for Engineering and Data Science; still bounded by access mode |
| `shell` | Run, observe, wait for, and stop commands | Normal for Engineering and Data Science; excludes computer control and connectors |
| `browser` | Fetch pages and search public sources | Read/network research surface; not interactive browser control |
| `project-knowledge` | List and search authenticated knowledge linked to the current project | Read-only first-party evidence surface; server identity is verified and same-name third-party tools do not satisfy it |
| `memory-context` | Recall, search, and traverse authenticated project-relevant memory | Read-only first-party context surface; separate from automatic briefing and from memory mutation/governance |
| `research-notes` | Maintain source notes and research briefs | Session/workspace research state, not a document artifact |
| `artifacts` | Produce structured artifact records | Normal production surface for every bundled non-Custom profile |
| `planning-session` | Plans, goals, task tracking, chapter markers, and user-choice requests | Recommended interaction surface; selections do not auto-create a goal or plan |
| `orchestration` | Route tasks and use active-turn child agents, including observe/wait/close/continue operations | Requires an enabled plan/role and the owning active-turn runtime |
| `interactive-browser` | Use installed browser-control extension tools | Capability- and runtime-sensitive; normally proposed for frontend/full-stack work |
| `mcp-resources` | Discover and read configured MCP resources through stable control tools | Opens live discovery only; dynamic server tool names are never persisted |
| `connectors` | List configured connectors and run an explicitly authorized connector | Connector execution retains its shell/network and approval gates |
| `computer-control` | Operate an available computer-control session | High-authority, runtime-sensitive, never a broad profile default |
| `workflow-launch` | Launch reviewed workflows/graphs and observe active workflow progress | High-cost explicit choice; child plans do not imply this grant |
| `background-workers` | Launch and manage durable root-owned worker threads | Root-only explicit choice; not implied by ordinary orchestration |
| `pull-request-observation` | Observe pull-request checks, reviews, and comments without blocking the active turn | Built-in extension with a bounded background watcher; recommended only for Engineering |
| `security-review` | Inspect review traffic and record/finalize security findings | Specialized review surface, never inferred from Engineering alone |

Conditional availability tools such as result expansion and model switching stay
individually selectable in Advanced. Hidden compatibility tools remain
non-selectable. The legacy `terminal`, `notes`, and `design` expansions are not
recommended for a newly reviewed v3 manifest.

The catalog-driven picker presents the following checked recommendations. A
recommendation is still only a request entering the intersection in section
12.2; it is not an access, runtime, extension, role, or approval grant.

| Workspace profile | Recommended checked groups | Capability-sensitive proposal | Advanced, not preselected |
|---|---|---|---|
| Engineering | `coding`, `shell`, `browser`, `project-knowledge`, `memory-context`, `artifacts`, `planning-session`, `orchestration`, `pull-request-observation` | Add `interactive-browser` for reviewed frontend/full-stack work; backend remains the same engineer persona and may add it when browser/API inspection is useful | MCP resources, connectors, computer control, workflow launch, background workers, security review |
| Research | `workspace-files`, `browser`, `project-knowledge`, `memory-context`, `research-notes`, `artifacts`, `planning-session`, `orchestration` | Add `coding` and `shell` for computational/repository research; add interactive browser only when source access needs it | MCP resources/connectors when another reviewed corpus needs them; workflow launch, background workers, computer control, security review |
| Data Science | `coding`, `shell`, `browser`, `project-knowledge`, `memory-context`, `research-notes`, `artifacts`, `planning-session`, `orchestration` | Add interactive browser for dashboard/data-portal work | MCP resources/connectors for reviewed data sources; workflow launch, background workers, computer control, security review |
| Study | `workspace-files`, `browser`, `project-knowledge`, `memory-context`, `research-notes`, `artifacts`, `planning-session`, `orchestration` | Add coding/shell for programming labs; Explorer remains dormant until an explicit source-explanation strategy is selected | MCP resources/connectors for another reviewed course corpus; interactive browser, workflow launch, background workers, computer control, security review |
| Writing | `workspace-files`, `browser`, `project-knowledge`, `memory-context`, `research-notes`, `artifacts`, `planning-session`, `orchestration` | Add coding only for repository-backed documentation; Reviewer remains dormant until an explicit critique strategy is selected | MCP resources/connectors for other reviewed source libraries; interactive browser, shell, workflow launch, background workers, computer control, security review |
| Custom | Empty | A deterministic scan or managed proposal may recommend checked entries, but the user must review them | Everything remains searchable and individually selectable; no hidden bundle |

The first-party `list_skills`, `get_skill`, and `search_skills` discovery tools
remain a managed-workspace baseline rather than a checked profile group. They
expose the reviewed skill library progressively but do not activate a skill,
open arbitrary MCP tools, or widen its tool allowlist. Project Knowledge and
Memory Context remain visible, removable groups because their contents affect
what workspace evidence and recalled context the model may inspect.

This matrix deliberately treats artifacts as a production primitive, not a
frontend-only design feature. Engineering, including backend-only work,
Research, Data Science, Study, and Writing can all create artifacts. Frontend
and full-stack capability detection may additionally recommend interactive
browser control, but task-time capability activation cannot silently add that
group to an `explicit-catalog` workspace. The user reviews and persists the
proposal during onboarding or later workspace editing.

The selected group is only one side of the effective intersection. Bundled
profile skills must retain the concrete tools their documented workflow needs:
all folder-backed skills keep directory discovery; producing Study and Writing
skills keep artifact emission; and Data Science analysis and experiment skills
keep notebook editing, language inspection, command execution, and artifact
emission. These allowlists still only subtract from the workspace, role,
access, extension, and runtime gates. They never make an unselected group
executable.

Backend capability skills retain the common file creation, editing, language
service, bounded command, and artifact operations needed when several backend
workflows are stacked. The shared list prevents skill intersection from
silently removing migrations, tests, new service files, verification, or
deliverables, but remains subordinate to the Engineering workspace's reviewed
coding, shell, and artifact groups and the active role's access ceiling.

Profiles also do not receive every tool merely because a task could eventually
benefit from it. Live connectors depend on configured external systems,
computer control acts outside the repository, workflow/worker launch can incur
substantial cost, and security-review tools have a specialized runtime. These
remain discoverable, explained choices.

The `workspace-files` group is separate from `coding` because folder-backed
work is a baseline production need for research reports, study material, and
long-form drafts, while LSP and notebook mutation are programming-specific.
Adding this new group does not change the immutable expansion of `coding` and
does not silently modify an already reviewed manifest. Existing managed
workspaces see it as a new recommended choice during workspace-settings review
and must explicitly save that revised selection.

The Frontend accessibility, design-quality, and browser-verification skills
share the stable build, artifact, and embedded-browser operations needed for a
stacked build-and-verify turn. This prevents least-privilege intersection from
accidentally erasing file creation, deliverables, state inspection, navigation,
interaction, console/network review, responsive checks, or screenshots.
Selecting the Frontend capability does not make any operation executable unless
the workspace has separately reviewed its tool group and the relevant host
runtime is available.

When an existing workspace opens settings, every selectable recommended catalog
entry that is not in the current manifest is shown as a **Recommended
addition**, its field opens automatically, and the summary reports the pending
addition count. Nothing is selected or saved automatically; the user reviews
the expansion and explicitly checks and saves each accepted change.

#### 12.4 Keep agent tools in extensions and native runtimes in their hosts

An agent-visible integration tool belongs to a required or optional built-in
extension when it has a stable schema, policy metadata, and profile assignment.
The extension does not own operating-system resources. Native terminal PTY
creation, shell discovery, process lifecycle, and rendering remain Desktop/CLI
host responsibilities; the required shell extension receives only a bounded
host port for sessions the user already opened.

The same split applies to pull-request observation. Provider-specific commands,
polling, normalization, and transition detection live in an optional built-in
extension. Core owns only the bounded session-keyed background-result inbox and
safe-boundary Steer contract. Desktop and CLI decide how an idle session resumes
and how queued, steered, and applied states appear. User or workspace extensions
cannot acquire either privileged host port. Automatic steering carries only
normalized transition metadata; titles, comment/review bodies, check labels,
logs, and command errors are never injected into the turn. The agent retrieves
such external content explicitly and treats it as untrusted data.

#### 12.5 Use one visible ownership hierarchy

The common setup flow must not present a profile, its optional capabilities,
and their implementation packs as peers. In particular, **Engineering**,
**Frontend**, and **Backend** are not three interchangeable skill packs:
Engineering is a workspace profile, while Frontend and Backend are optional
task capabilities owned by that profile.

The reviewed UI hierarchy is:

| Surface | Contract | Common-flow presentation |
|---|---|---|
| Workspace profile | Primary domain, persona, orchestration defaults, baseline skills, tools, and memory posture | Choose exactly one profile card |
| Included profile setup | The selected profile's persona and profile-owned skill pack | Read-only summary beneath the selected profile; not a second peer choice |
| Optional capabilities | Profile-compatible task specializations authorized for automatic task-time activation | Selectable checkboxes with contributed skills and recommended tool groups nested in each row |
| Additional skill packs | Reusable packs not owned by the selected profile or an enabled capability | Advanced picker only; selecting one does not change persona or orchestration |
| Individual skills and tools | Fine-grained reviewed additions or denials | Advanced picker only |

The label **Available capabilities** is ambiguous because "available" is also a
runtime state. Desktop and CLI use **Optional capabilities** for the reviewed
checkbox set and distinguish these states:

```text
compatible  = the selected profile permits this capability to be chosen
recommended = the preset, scan, or reviewed proposal suggests it
enabled     = the user has selected it in the workspace manifest
active      = task-time signals selected it for the current turn
available  = its plugin and required runtime surfaces currently exist
blocked    = it cannot be selected or activated, with a bounded reason
```

Only `enabled` and explicit disable choices are durable workspace decisions.
`active` and runtime `available` are recomputed. A checkbox therefore means
"this workspace may use this specialization for matching tasks", not "inject
every capability skill into every turn".

Profile-owned and capability-owned packs remain catalog entries for
validation, provenance, exact review, and runtime resolution. The common skill
pack picker filters them out:

- the chosen profile's pack appears under **Included profile setup**;
- a capability-owned pack appears only inside that capability's expansion;
- unowned or cross-domain packs appear as **Additional skill packs** in
  Advanced, with a warning that they add skills only;
- selecting a cross-domain pack never changes the profile, persona,
  orchestration plan, capability allowlist, or tool authority.

#### 12.6 Separate capability compatibility from defaults

The current preset field `capabilities.enabled` serves two different ideas:
which capabilities a profile contributes and which are selected by default.
That coupling makes every non-Engineering profile look as though the product
has no capability system.

Core separates them:

```ts
capabilities: {
  available: string[];   // compatible checkbox choices for this profile
  recommended: string[]; // initial checked/recommended subset
  enabled: string[];     // deprecated 0.4.17 client alias for recommended
}
```

This is preset/catalog metadata, not a workspace-manifest schema change.
`workspace.json` continues to persist only the reviewed
`capabilities.enabled` and `capabilities.disabled` values. The preset
`capabilities.enabled` alias is transport compatibility only, always mirrors
`recommended`, and must not be used to decide compatibility. It can be removed
only with a separately reviewed client-contract migration.

Custom treats every bundled safe capability as compatible but recommends none.
Installed safe contributions are added to the resolved Custom catalog rather
than becoming static preset defaults. Unknown or unavailable contributions stay
visible and blocked; every profile, including Custom, rejects a capability
outside its resolved compatibility list.

Each capability definition owns bounded, prompt-free onboarding metadata:

```text
id, label, description, compatible profile IDs,
owned skill-pack ID, contributed skill IDs,
recommended tool-group IDs, and task-detection signals
```

The runtime instruction remains internal and never crosses the onboarding
catalog boundary. A capability may recommend a tool group during setup, but
task-time activation cannot add an unreviewed tool, role, extension, connector,
or orchestration mode. Selecting both Frontend and Backend represents
full-stack Engineering; BrainRouter does not add a redundant Full-stack
capability.

The initial cross-profile catalog is:

| Capability | Compatible profiles | Specialization payload | Tool groups proposed during reviewed setup |
|---|---|---|---|
| Frontend | Engineering | Accessibility, component/design-system judgment, responsive behavior, browser and visual verification | `browser`, `artifacts`, optionally `interactive-browser` |
| Backend | Engineering | API/service design, authorization, data integrity, background work, production readiness, backend verification | `coding`, `shell`, `artifacts` |
| Academic paper | Writing | Adds the Research-grade contribution story, claim/evidence map, paper section contracts, citation checks, adversarial paper review, and revision workflow to a Writing workspace | `browser`, `research-notes`, `artifacts` |
| Computational research | Research, Data Science | Reproducible computational investigation, experiment records, result validation, uncertainty and limitation reporting | `coding`, `shell`, `browser`, `research-notes`, `artifacts` |
| Data visualization | Data Science | Chart selection, data-story structure, accessibility, misleading-encoding checks, dashboard/figure verification | `coding`, `artifacts`, optionally `interactive-browser` |
| Programming lab | Study | Executable examples, learner-safe scaffolding, tests, debugging feedback, and progressive exercise difficulty | `coding`, `shell`, `artifacts` |
| Technical documentation | Writing, Engineering | Repository-grounded API/reference/tutorial structure, runnable examples, terminology consistency, and documentation review | `coding`, `browser`, `artifacts` |
| Installed custom capability | Custom | Contribution-defined, schema-validated payload | None unless explicitly reviewed |

The alternatives are:

| Approach | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Keep optional capabilities Engineering-only | Smallest catalog and no new packs | Makes the abstraction profile-specific in practice; Research, Data, Study, and Writing cannot express common specializations | Rejected |
| Rename every profile skill pack as a capability | Reuses existing packages and produces rows quickly | Duplicates the profile itself, mixes persistent domain identity with task-time activation, and repeats the current UI confusion | Rejected |
| Show every installed capability for every profile | Maximum discoverability and fewer compatibility rules | Encourages nonsensical combinations, expands proposal ambiguity, and makes validation less useful | Rejected except for explicit Custom setup |
| Generate arbitrary capabilities from the project description | Highly flexible and needs no bundled catalog | Produces unstable IDs and unreviewed payloads; cannot support deterministic validation, upgrades, or blocked-state explanations | Rejected |
| Separate compatible choices from recommended defaults | Consistent picker across profiles, deterministic validation, safe managed recommendations, and room for installed contributions | Requires explicit capability metadata and several small pack implementations | Accepted |

The profile pack continues to provide the normal domain workflow. Research
therefore owns academic-paper production directly; presenting the same workflow
as an optional Research capability would duplicate its included profile setup.
The Academic paper capability exists to add that narrower workflow to a Writing
workspace without changing its writer persona or primary Writing plan. These
capabilities are narrower additions, not renamed copies of Research, Data,
Study, Writing, or Engineering. A deterministic scan or managed onboarding
proposal may recommend compatible capabilities from project evidence and the
user's description, but the review screen owns the final checked set.

#### 12.7 Reviewed picker UX in Desktop and CLI

The workspace onboarding and later workspace-edit flows replace free-text tool,
skill-pack, and skill-ID list inputs with catalog-backed multi-select controls.
They must:

- show a short description, source, and concrete expansion for every selected
  group, tool, pack, and skill;
- distinguish **recommended**, **selected**, **available**, **blocked**, and
  **denied** states, with the effective-policy reason for a blocked item;
- render roles, tool groups, tools, packs, and skills as selectable catalog
  entries rather than requiring an implementation ID to be typed;
- render profile-compatible capabilities as selectable catalog entries. A
  capability owns its skill pack and tool-profile recommendations, so those
  payloads appear nested under the capability and are not presented as
  duplicate peer choices;
- show **Optional capabilities** for every profile, using the compatibility
  matrix rather than an Engineering-only UI branch; show an explicit empty
  state only when no installed contribution is compatible;
- summarize the selected profile's included persona and pack separately, and
  move additional cross-domain packs, individual skills, and tools under
  **Advanced**;
- offer profile recommendations first, then an "Advanced" view for individual
  tool and skill selections;
- explain whether a recommendation came from the workspace profile, a reviewed
  capability/subtype proposal, repository evidence, or the user;
- allow Custom to begin empty, search/filter the catalog, select a group or
  individual entries, and review the exact manifest diff before save;
- show dynamic MCP tools as live, non-persisted information rather than
  checkboxes that imply a durable tool contract;
- keep selected-but-currently-unavailable entries reviewable and removable, but
  never advertise them to the model as executable;
- for orchestration entries, distinguish "selected for this workspace" from
  "available in this active turn"; an unavailable-turn failure is terminal and
  the UI must not encourage blind retries;
- provide **Skip setup for now** before the final write; skipping discards the
  draft, writes no manifest or instruction change, and preserves no-manifest
  runtime behavior;
- preserve keyboard accessibility and provide the equivalent numbered picker
  and review summary in the CLI;
- re-resolve the proposed selection immediately before write and show any
  catalog/profile drift as a reviewable conflict rather than writing stale IDs.

A catalog-fingerprint mismatch is an expected stale-review condition, not a
generic persistence failure. Desktop reloads the latest catalog and explains
that the available setup choices changed while the dialog was open. This is
especially important during source development, where rebuilding the package
can change the catalog beneath an already-open onboarding review. The stale
draft is never written and the user reviews the refreshed choices before
trying again.

The UI is a discovery and review surface. It does not directly change the
process-global extension registry, bypass the preload/query boundary, or call a
tool merely because its checkbox is selected.

### 13. Research production, Project Knowledge, and isolated candidates

Research needs continuity across evidence sources and iterations, but that does
not justify a second memory system or a broader child-role trust boundary.
Project Knowledge and isolated candidate runs also have different lifecycle
owners from active-turn orchestration and must not be presented as if they were
additional orchestration roles.

#### 13.1 Research uses one bounded, gap-driven evidence loop

The Research profile adds a primary-agent iterative research skill. It owns a
bounded working state for the current research task:

```text
original question
  → reviewed subquestions
  → prior-query ledger
  → source and claim ledger
  → unresolved evidence gaps
  → stop decision
```

Each cycle creates at most three non-duplicate, gap-driven probes, routes each
probe to the most appropriate available source class, updates claims and
conflicts, and stops when the evidence threshold, iteration limit, or user
budget is reached. A follow-up begins from the prior question, findings,
citations, unresolved gaps, and report artifact rather than silently restarting
the research. Report assembly receives only bounded relevant prior sections and
an explicit no-repeat instruction.

Source routing distinguishes project/local material, primary and academic
sources, technical documentation, and broader web material. Source fit,
provenance, recency, and direct support matter more than raw citation counts or
ranking. Unknown source quality remains unknown; the agent must not manufacture
a journal-quality classification or turn a popularity signal into authority.

Project Knowledge is an optional evidence source in this loop, not a new memory
store, authority source, or automatic ingestion path. When authenticated,
linked to the current project, model-visible, and allowed by effective tool
policy, the primary researcher searches the project corpus before expanding
unresolved gaps to external sources. Missing or unavailable Project Knowledge
does not fail ordinary research. Ingestion remains an explicit user action.
Results retain their source origin and citations and never become verified
claims merely because they came from the project corpus.

The primary researcher owns Project Knowledge grounding. The reusable explorer
role keeps its existing read-only scope and does not gain project-wide MCP
authority merely to support one Research strategy. Explorer fan-out handles
independent external evidence questions after the primary grounding stage;
claim reconciliation and final synthesis return to the primary.

| Approach | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Search only the web on every turn | Simple and always follows one path | Repeats work, ignores reviewed project material, and loses follow-up continuity | Rejected |
| Give every explorer Project Knowledge access | Makes all sources available inside fan-out | Widens a reusable child trust boundary and duplicates project context across children | Rejected |
| Copy research state into a new profile store | Profile-specific querying can be optimized independently | Violates the single-memory-system rule and creates conflicting retention and redaction paths | Rejected |
| Primary grounding plus bounded gap-driven fan-out | Reuses reviewed project evidence, preserves child isolation, and stops redundant searches | Requires explicit working-state and stopping contracts | Accepted |

#### 13.2 Academic papers are an included Research workflow

Academic-paper production belongs to the Research profile pack rather than a
second Research persona or a peer skill-pack choice. Two separate skills keep
authority and review intent clear:

- `academic-paper-drafting-skill` owns the contribution story, claim/evidence
  map, section contracts, reverse outline, terminology map, figure/table
  inventory, experiment coverage, and explicit limitations;
- `academic-paper-review-skill` performs an independent adversarial gate and
  returns at most ten deduplicated blocking, material, or advisory findings.

The `academic-paper` strategy is bounded to five stages:

```text
frame on primary
  → freeze claim ledger on primary
  → draft on primary
  → citation + paper audit on one read-only reviewer
  → revise and record dispositions on primary
```

Drafting and accepted edits remain primary-owned. The reviewer cannot write the
paper, widen collection, or turn style preferences into blocking findings.
Citation verification remains a separate skill in the audit stage so a polished
paper cannot pass with unresolved material claims. Missing evidence is preserved
as an explicit gap; the drafting workflow never invents results, method details,
citations, or numerical values.

The same workflow may later be contributed as an optional Academic paper
capability to a Writing workspace. That capability reuses the reviewed skills
and strategy but does not replace the writer persona, enable Research broadly,
or add tools beyond the workspace's reviewed tool selection.

#### 13.3 Project Knowledge has a workspace-scoped query contract

Desktop Project Knowledge queries use the same request/result discipline as
other renderer-to-host queries:

- accept both host-wrapped events and bare development-bridge events;
- match request ID and, when present, the expected workspace root;
- clear the timeout when a terminal result arrives;
- preserve structured unavailable, signed-out, unlinked-project, empty, ready,
  and failed states instead of collapsing them into a generic timeout;
- ignore late or cross-workspace results after the listener is disposed.

The renderer must never report “did not respond” when either bridge already
returned a terminal result. Project resolution remains host-owned because it
uses authenticated project access and repository remotes; the renderer cannot
invent or persist a project ID. Research tools continue to receive a validated
project identifier through the existing authenticated MCP boundary.

#### 13.4 Isolated candidates are not orchestration roles

The **Parallel agent candidates** surface launches independent adapter sessions
in isolated worktrees so a user can compare implementations. It is a durable
root-owned fan-out workflow, not the active-turn explorer/architect/worker/
reviewer/verifier graph. Selecting an adapter therefore does not add an
orchestration role, change the workspace profile, or grant that adapter the
profile's role tools.

Candidate launch is validated before a run or worktree is persisted:

- between two and eight distinct, available adapters are selected;
- every selected adapter's workspace-trust requirement is satisfied by an
  explicit user choice;
- the workspace and remote-host prerequisites resolve;
- a failed preflight creates no partial run, candidate, or worktree.

The UI derives trust requirements from the selected adapter metadata, disables
launch while consent is missing, and explains which adapters require it. Trust
is never checked automatically. A trust failure is a pre-launch validation
state, not a candidate that remains indefinitely in `needs-trust`.

Hosted adapter sessions and PTYs are process-local while fan-out records are
durable. On Desktop startup, the fan-out owner reconciles persisted transient
candidate states whose process-local session no longer exists. Those candidates
become terminal `failed` entries with an actionable restart/cleanup message,
and the parent run becomes terminal when no live candidate remains. BrainRouter
does not pretend to resume a lost process and does not leave a run permanently
in `launching` or `running`.

| Approach | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Treat candidates as orchestration roles | One vocabulary and one selector | Confuses active-turn children with durable isolated worktrees and crosses authority/lifecycle boundaries | Rejected |
| Persist enough PTY state to resume processes | Could retain a running-looking session after restart | A PTY/process cannot be safely reconstructed from metadata; creates false recovery guarantees | Rejected |
| Leave transient records unchanged after restart | Minimal startup work | Produces permanently launching/working cards with no owning session | Rejected |
| Preflight, then reconcile lost sessions to terminal failure | No partial launch, explicit trust, truthful durable history, and clear recovery | The user must start a new run after restart | Accepted |

#### 13.5 Profiles recommend views; they do not authorize panels

The current right-rail chooser presents nearly every panel for every workspace.
That is technically complete but makes a Research or Writing workspace look
like an Engineering workbench. Panel discoverability therefore becomes a
catalog projection using the same resolved workspace profile and capability
snapshot as onboarding.

Each panel descriptor declares:

```text
id, label, group, description,
recommended profile IDs,
recommended capability IDs,
runtime prerequisites, and data-activation signals
```

The chooser renders three ordered sections:

1. **Suggested for this workspace** — profile and enabled-capability matches;
2. **Active and recent** — currently open panels or panels with live/recent
   data, regardless of profile;
3. **More views** — every other installed and available panel, searchable.

This is progressive disclosure, not a security boundary. A profile cannot grant
the host query, tool, connector, authentication, or runtime needed by a panel.
A user can still find and open a non-suggested compatible panel. A previously
opened panel is not force-closed when the profile changes, and a panel with
live data is not hidden merely because it is unusual for the profile.
Unavailable panels remain discoverable in **More views** with a bounded reason
and setup action when one exists; they do not render as broken empty surfaces.

The initial recommendation posture is:

| Profile | Normal suggested views | Added by capability or live state |
|---|---|---|
| Engineering | Files, Changes, Terminal, Plan, Tasks, Artifacts, Review, PR / Checks | Browser, Prototype, and Servers for Frontend/full-stack or detected dev servers; Worktrees for isolated runs; Project Knowledge when linked |
| Research | Project knowledge, Saved knowledge, Context, Plan, Tasks, Artifacts, Annotations | Browser for source research; Files/Terminal for Computational research; Review for citation/adversarial review |
| Data Science | Files, Terminal, Project knowledge, Context, Plan, Tasks, Artifacts | Browser and Prototype for Data visualization; Worktrees for isolated experiments |
| Study | Project knowledge, Saved knowledge, Context, Plan, Tasks, Artifacts | Files/Terminal for Programming lab; Browser for source explanation |
| Writing | Project knowledge, Saved knowledge, Context, Plan, Artifacts, Annotations | Files for Technical documentation; Review for critique; Browser for sourced writing |
| Custom | Context and any panel with live data | Panels proposed by explicitly enabled capabilities; all others remain under More views |

Panel recommendations are contributed metadata with validated IDs, not
hard-coded conditional JSX branches. Unknown contribution panel IDs are
ignored with a diagnostic. The exact open-tab layout remains local presentation
state and never enters the workspace manifest.

#### 13.6 Settings configures preview reservations; Servers owns live status

Runtime preview ports and workspace dev servers are distinct resources:

| Surface | Owns | Does not own |
|---|---|---|
| Settings → Runtime | Default named loopback-port reservations used when an isolated runtime starts a preview | Process status, logs, start/stop, or browser navigation |
| Servers view | Live workspace dev servers and live runtime preview registrations, their source, status, URL, logs when available, and valid lifecycle actions | Global/runtime defaults or port policy |

The current **App-preview ports** label is renamed **Runtime preview port
reservations** and explains that it is configuration, not a running server.
Settings stops duplicating the live-preview list. The Servers view becomes the
single operational surface and groups entries by source:

- **Workspace dev servers** are backed by the reviewed workspace launch
  configuration and support start, stop, logs, and open in Browser.
- **Runtime previews** are registered by an active isolated runtime and support
  open in Browser plus only lifecycle actions owned by that runtime.

The Servers view is suggested when the Engineering profile enables Frontend,
when a valid workspace dev-server definition exists, or when any runtime
preview is live. It remains available under **More views** otherwise. A port
reservation alone does not make the view active and does not imply that a
server is running.

| Approach | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Keep live previews in Settings and dev servers in Servers | No data-contract change | Two operational status surfaces and unclear ownership | Rejected |
| Remove runtime preview reservations | Simplifies Settings | Isolated runtimes lose deterministic named ports | Rejected |
| Put all configuration into Servers | One visible destination | Mixes durable policy with ephemeral process control | Rejected |
| Settings for defaults, unified Servers for live operations | Clear configuration/runtime split and one place to inspect previews | Requires one combined server-view query/model | Accepted |

#### 13.7 Workbench panels preserve state without joining hot render paths

Profile-aware disclosure does not make a panel disposable. Files, Editor, and
other workbench views keep workspace-scoped presentation state when the user
switches tabs, hides the right rail, or moves between workspaces. At minimum,
Files retains expanded directories, filter text, and the current selection;
Editor retains open models, dirty state, view state, and its selected file.
State is keyed by canonical workspace identity and must not leak paths or
expansion state into another workspace.

Keeping every hidden panel inside the root render path is not an acceptable
way to preserve that state. Expensive panels use a stable host boundary:

- high-frequency Editor buffer changes are owned by Monaco models or an
  editor-local external store, not the root `App` component;
- inactive panels do not rerender because chat streaming, agent traces, or
  unrelated workspace state changed;
- hiding a panel preserves its lightweight view model while allowing expensive
  observers, polling, layout work, and native surfaces to suspend;
- reopening a warm Files or Editor panel restores its prior state without a
  full-tree refetch;
- event subscriptions have deterministic ownership and cleanup, so repeatedly
  opening panels cannot grow renderer listener counts.

Editor adds an integrated Explorer backed by the same workspace file query and
status projection as Files. It is a collapsible, keyboard-navigable sidebar,
not a second file cache. Opening a file from either view selects the same
Editor model. Monaco remains lazy-loaded and keeps familiar editor behaviors
such as multi-tab editing, command/keybinding handling, find, diagnostics,
conflict-safe save, and per-file view state. “VS Code-like” is a behavior and
responsiveness target; BrainRouter does not embed the complete VS Code
workbench or extension host.

The Desktop performance harness records warm panel-switch latency and Editor
key-to-paint latency. On the supported reference fixture, the targets are
100 ms p95 for a warm Files/Editor switch and 50 ms p95 key-to-paint while
editing a normal source file. A regression result is evidence to investigate,
not permission to hide correctness failures or discard dirty buffers.

#### 13.8 The human owns visible browser focus and location consent

The embedded browser has two simultaneous clients: a human using it as a
normal browser and an agent performing bounded browser work. They share the
workspace browser session but do not share focus authority.

The selected right-rail panel is the sole owner of native browser-surface
visibility. When Browser stops being the visible panel, the host detaches its
native surface in the same visibility transition. An in-flight agent command
may continue only when its operation is safe headlessly; it cannot keep the
native surface layered above Settings, Atlas, Editor, or another panel. A
visibility epoch prevents a late agent result from reattaching a stale surface.

Agent-created tabs open in the background by default, including child windows
and research-source tabs. Explicit activation is reserved for a step that
requires visible human takeover, such as a challenge, permission prompt, or
user-requested navigation. Human tab selection takes precedence and is not
changed merely because a background agent tab navigated or completed. Agent
tabs and human tabs carry separate ownership metadata so cleanup can close only
agent-owned research tabs.

Browser locale and region signals derive from the host session rather than a
hard-coded search country. Geolocation remains a sensitive per-origin
permission: the user can allow or deny it through a visible prompt and the
workspace browser profile may remember that reviewed decision. BrainRouter
does not silently grant, spoof, or infer precise location. When a site cannot
determine location, the Browser explains whether permission, OS location
services, or network-derived location is unavailable and offers the appropriate
user action. Network reputation and site policy may still prevent location or
challenge-free browsing.

#### 13.9 Research browsing is bounded, source-backed, and Google-first

The built-in interactive research path uses Google Search pages through the
workspace browser. The bundled DuckDuckGo provider, fallback, provider ID, and
tests are removed; legacy configuration selecting it produces an actionable
migration diagnostic instead of silently changing engines. Explicit
administrator-configured search APIs remain separate optional providers, but
the managed browser-research strategy does not mix their ranking with Google
without disclosure.

Research is deliberate rather than a burst of unbounded tab creation:

```text
frame question and coverage ledger
  → form non-duplicate subquestions
  → inspect one Google results page
  → open one source in a background agent tab
  → extract a bounded source note and update claims/gaps
  → close the extracted source tab
  → continue to the next source or Google page only for an unresolved gap
  → verify material claims
  → synthesize a cited artifact
  → close remaining agent-owned research tabs
```

Pagination is explicit. The agent records which query and result page it has
inspected and follows the next-page control only while a named coverage gap
remains and the page, source, time, and token budgets permit it. It does not
rapidly click every result, open duplicate URLs, or treat a search-result
snippet or generated overview as verified evidence.

Every retained source note records title, canonical URL, publisher or author
when available, publication date when available, access time, the supported
claim, evidence excerpt or structured observation, and limitations or
conflicts. Notes are written incrementally to the Research notes/artifacts
contract so compaction or interruption does not erase provenance. The final
artifact includes a deduplicated source ledger and claim-to-source links.
Long-lived memory receives only reviewed stable findings, decisions, and
unresolved gaps; raw browsing noise and page content are not copied into
memory.

Parallel research is optional bounded orchestration. The primary researcher
may assign disjoint subquestions to eligible read-only explorers, each with a
separate query/source budget and structured result contract. The primary
researcher merges and deduplicates their ledgers, resolves conflicts, and owns
the final synthesis. Explorers do not share mutable browser focus, open
unbounded tabs, or write the final report.

Agent-owned tabs close immediately after extraction unless a documented next
step requires the live page. On completion, cancellation, or failure, the
research lifecycle closes every remaining agent-owned tab and preserves all
human-owned tabs. CAPTCHA, consent, login, and other human challenges pause the
affected step and request visible takeover rather than being bypassed or
hammered with retries.

#### 13.10 Steering reconciles the active work contract

Queue and Steer are delivery modes, not separate planning systems. Queue starts
a later user turn in FIFO order. Steer enters the current turn at the next safe
model boundary. Both are evaluated against the same active work contract:

```text
active goal, when present
  + current plan revision
  + accepted requirements and acceptance criteria
  + workspace/profile authority
  + applied-change ledger
```

Every applied input receives one bounded impact disposition:

| Impact | Required behavior |
|---|---|
| Clarification or evidence | Record it against the affected task; keep the plan revision when ordering and acceptance criteria are unchanged |
| Tactical correction | Update the affected plan item or its verification note before the next related action |
| Added or removed scope | Revise the plan, dependencies, acceptance criteria, and estimated remaining work before the next mutating tool |
| Priority/order change | Reorder pending items, preserve completed evidence, and identify any now-obsolete work |
| Goal-compatible constraint | Append it to the active work contract and revise the plan; do not rewrite the goal text silently |
| Goal replacement or contradiction | Stop incompatible work and require an explicit goal edit/replacement or user confirmation before continuing |
| Authority or safety change | Recompute effective policy; text cannot grant tools, permissions, access, or bypass approval boundaries |

The agent may decide that a plan revision is unnecessary, but it must record a
short reason. Material steering cannot be acknowledged in prose and then
ignored by an unchanged plan. The next model call receives the active goal,
current plan revision, and unapplied change ledger together so compaction
cannot separate the correction from the work it changed.

Extension-authored steering is observation, not user authority. A CI failure,
review comment, or background result may add an in-scope remediation or
verification item and revise the plan, but cannot expand the goal, enable a
tool, accept a security disposition, or replace user requirements. Conflicting
extension observations become an explicit unresolved item for the primary
agent.

Desktop and CLI show whether a queued or steered message was applied, whether
it revised the plan, the resulting plan revision, and whether it needs a goal
decision. A `/goal` continuation always resumes from the latest reconciled
plan; it does not regenerate a clean plan that drops accepted steering.

#### 13.11 Planning and decision skills have activation policy, not just availability

Selecting a skill makes it eligible beneath the workspace and tool ceilings.
It does not guarantee the agent will use it at the correct time. Conversely,
including Planning in every profile pack must not force a planning ceremony for
one-step questions. BrainRouter therefore adds a skill-activation policy to the
resolved profile/strategy contract:

```text
skill available and selected
  ∩ task/strategy activation signal
  ∩ stage assignment
  ∩ required tool availability
  → required, recommended, optional, or blocked activation
```

The activation decision is deterministic for hard cases and may use the
bounded planner only for ambiguous cases. At minimum:

- Planning is required for an active goal, multi-stage implementation,
  research with more than one evidence gap, multi-artifact writing/data work,
  or any task that will delegate; it is recommended for medium work and
  unnecessary for a single obvious action.
- ADR is required when the task introduces or reverses a durable architecture,
  public contract, data/authority boundary, cross-surface lifecycle, or
  expensive-to-reverse dependency. It is recommended when competing designs
  have meaningful long-term trade-offs and unnecessary for local mechanical
  fixes.
- A required Planning activation must create or update the durable project plan
  and taskboard used by the repository, then keep the runtime plan projection
  synchronized. A required ADR activation must inspect existing decisions,
  update or supersede the right record, and link implementation tasks to it.
- Planning activation does not invent an approval pause. A plan-only request
  stops after the reviewable plan; an explicit build/change request may proceed
  through its reviewed repository workflow unless an actual approval,
  authority, or material user-choice boundary requires a pause.
- A child stage receives only the skills declared for that stage. The primary
  agent owns final plan and ADR reconciliation; a child may return a proposal
  but cannot accept an architecture decision or rewrite root scope.
- If a required skill is unavailable or its output destination is not writable,
  the runtime reports a blocked prerequisite or uses a profile-declared safe
  primary fallback. It never pretends the skill ran.

Profiles tune normal triggers and outputs without weakening the shared rules:

| Profile | Planning emphasis | ADR/decision emphasis |
|---|---|---|
| Engineering | Vertical slices, dependencies, verification, release sequence | APIs, storage, security, runtime ownership, and cross-package contracts |
| Research | Question decomposition, coverage and source budgets, synthesis checkpoints | Method, evidence, provenance, retention, and reproducibility decisions |
| Data Science | Dataset/experiment lineage, reproducibility, validation checkpoints | Data contracts, statistical assumptions, model/evaluation and deployment boundaries |
| Study | Learning objectives, diagnostic checkpoints, practice/remediation sequence | Curriculum or assessment policy only when durable and consequential |
| Writing | Outline, section contracts, source/revision passes | Publication structure, governance, provenance, or reusable editorial policy |
| Custom | No implicit workflow until selected; show recommended triggers for enabled capabilities | Same cross-profile hard triggers once the relevant skill is selected |

This policy is inspectable in onboarding and workspace settings. The UI explains
why a skill is included, when it activates, what it writes, and which tools it
requires. Users can disable a recommended skill within their authority, but a
task that requires the missing contract becomes visibly limited rather than
silently executed with lower reliability.

#### 13.12 Personality is a user-controlled communication overlay

Persona answers **how the agent reasons and works in a domain**. Personality
answers **how the agent communicates that work**. They remain independent:
switching to Research cannot replace the researcher persona with a writing
style, and choosing concise prose cannot remove citation or planning duties.

Personality resolves in layers:

```text
per-chat override
  → workspace override
  → user global default
  → profile recommendation
  → standard fallback
```

The profile recommendation is used only when no user override exists. Suggested
defaults may include evidence-first communication for Research, Socratic
communication for Study, collaborative technical prose for Engineering,
structured explanatory prose for Data Science, and audience-aware prose for
Writing. Recommendations affect presentation only: they cannot add tools,
skills, roles, memory access, or orchestration.

Settings displays the effective personality and its source. The normal choice
is **Automatic** at workspace scope, followed by explicit styles. It cannot be
labelled **Use profile recommendation** because a global default may be the
winning inherited layer. The complete control exposes explicit **Current
chat**, **This workspace**, and **All workspaces** scopes: chat uses **Inherit**,
workspace uses **Automatic**, and global uses **No global default** as their
respective clear choices. Each scope reports the resulting effective value and
source. A user may set a global default, override one workspace, or temporarily
override the current chat; clearing an override reveals the next layer instead
of writing a copied profile value. Existing stored personality values migrate
as explicit workspace overrides so upgrades do not silently change established
behavior.

| Approach | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Force one personality per profile | Immediately domain-flavored | Overrides user preference and conflates communication with persona | Rejected |
| Keep one opaque workspace value | Matches the current simple setting | Users cannot tell whether profile or preference won; no temporary style | Rejected |
| Let the model choose on every turn | Flexible | Unstable voice and difficult to inspect or reproduce | Rejected |
| Layer chat/workspace/global overrides above a profile recommendation | Stable, inspectable, and user-controlled while still providing useful defaults | Requires provenance UI and compatibility migration | Accepted |

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
| Recommended tool bundles | coding, shell, browser, artifacts, planning-session, orchestration, pull-request-observation | workspace-files, browser, research-notes, artifacts, planning-session, orchestration | coding, shell, browser, research-notes, artifacts, planning-session, orchestration | workspace-files, browser, research-notes, artifacts, planning-session | workspace-files, browser, research-notes, artifacts, planning-session | none |

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
14. A catalog selection is a narrowing request, never a tool, capability,
    extension, role, parent, access, approval, or runtime-authority grant.
15. Dynamic MCP/server tool names are never persisted as a workspace tool
    selection.
16. Manifest v2 keeps its legacy group semantics until a user reviews an
    explicit-catalog migration.
17. Every accepted definition has an explicit validated primary-only fallback
    that cannot become unavailable because of a missing child role or skill.
18. A plan cannot replace a role's output contract or name sections outside
    that contract's registered section aliases.
19. Parallel write-capable children require enforced isolated worktrees or
    disjoint ownership; otherwise write-capable stage fan-out is one.
20. Bundled plan assets must be present in source checkouts and published
    package archives before any installed runtime may depend on them.
21. Skipping onboarding creates no reviewed authority or partial workspace
    state; no-manifest behavior remains unchanged until setup is completed.
22. A persisted tool-group expansion is immutable within the manifest version;
    new authority requires a new reviewed group or individual selection.
23. Selecting an orchestration group cannot make a tool executable outside its
    owning active turn; unavailable entries are not model-visible and produce a
    terminal, non-retryable diagnostic if invoked through a stale path.

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
| Keep free-form tool and skill identifier fields | Small UI change; advanced users can type any string | Users cannot discover the built-ins, typos and unavailable IDs are opaque, and Custom is not safely self-service | Rejected |
| Persist every currently advertised MCP tool name | Familiar checkbox model | Server catalogs and schemas are dynamic; names are not a durable reviewed authority contract | Rejected |
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
- Users can discover available tools and skills, see why an item is blocked,
  and make a reviewed Custom selection without manually entering internal IDs.

### Costs

- A new bounded JSON parser, registry, resolver, and catalog are required.
- Bundled role prompts must be generalized without regressing Engineering.
- `profiles.ts`, onboarding, CLI, Desktop, agent registry, spawn slots,
  delegated-task packets, and trace surfaces need coordinated migrations.
- Profile plans and their referenced roles/skills need cross-catalog parity
  tests.
- Plugin disclosure and publishing validation gain another component kind.
- The manifest, parser, resolver, CLI, Desktop, and compatibility diagnostics
  need a focused v3 tool-selection migration.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plan behaves like hidden authority | Schema excludes authority fields; every stage intersects with manifest, role, parent, and user ceilings |
| Too many children for simple work | Every profile declares a validated primary-only fallback strategy; total and parallel children are bounded |
| Model chooses an unsuitable graph | Model chooses only eligible strategy IDs; deterministic validation and fallback are mandatory |
| Profile JSON and `profiles.ts` drift | JSON becomes the orchestration default source; TypeScript stores only the plan reference during migration |
| Plugin plan changes execution unexpectedly | Explicit plugin enablement, contribution disclosure, first-match resolution, and manifest ceilings |
| Domain-specific needs leak back into role prompts | Persona, capability, stage objective, skill, and expected-output fields carry domain behavior |
| Existing Engineering flow regresses | First implementation plan encodes current Engineering parity and ships before other profiles |
| Published Core package omits plan JSON | Add `orchestration-profiles` to the package allowlist and inspect the packed archive before runtime activation |
| Plan output requirements drift from role contracts | Require the role-owned contract ID and validate every required section against that contract's canonical alias catalog |
| Invalid selection has no usable direct strategy | Require and validate `fallbackStrategyId` as a primary-only, dependency-free strategy |
| Parallel workers race on the same files | Keep write-capable fan-out at one until isolated worktrees or disjoint enforced ownership are proven before launch |
| Generalized role prompts alter no-manifest behavior | Retain the legacy prompt overlay for no-manifest and compatibility-source execution; use generalized prompts only when an authoritative profile plan is active |
| Skipping onboarding accidentally applies inferred defaults | Make skip a write-nothing terminal UI action, discard the proposal, and keep the workspace on the existing no-manifest path until setup is resumed |
| Invalid optional stages hide missing functionality | Structured skip diagnostics and visible onboarding/runtime summaries |
| A deferred plan invokes a child tool after its turn | One lifecycle owner cancels ephemeral stages at turn end; runtime emits one terminal diagnostic and the UI distinguishes pre-launch rejection from delegation |
| Picker suggests a tool the runtime cannot use | Catalog carries availability/provenance; core re-resolves before write and at turn time; blocked entries show a reason and cannot become authority |
| v3 changes a v2 workspace's visible tool surface | Preserve `legacy-groups` on v2 read; require an explicit reviewed migration before applying `explicit-catalog` semantics |

## Compatibility

- Existing manifest v2 files remain valid.
- Existing `packages/core/agents/*.json` role IDs remain stable.
- No-manifest workspaces preserve existing role prompts and runtime behavior;
  domain-neutral role prompts are not selected merely because the package
  contains orchestration-profile JSON.
- A user may skip onboarding without creating a manifest or partial selection;
  reopening setup later creates a fresh proposal and still requires review.
- Manifest v2 files continue using their current group/deny behavior. A v3
  writer adds `tools.mode` and `tools.enabled`; it does not silently rewrite a
  v2 workspace into explicit-catalog mode.
- During migration, before the plan resolver becomes authoritative, runtime
  behavior remains the current manifest-filtered role registry. After
  activation, a missing or invalid plan fails closed to direct primary
  execution.
- Engineering ships first with behavior-parity tests before role prompts are
  generalized.
- Published Core archives include the bundled profile directory before any
  installed CLI or Desktop runtime resolves it.
- `profiles.ts` orchestration defaults remain a compatibility source until all
  onboarding consumers resolve the JSON plan catalog.
- CLI and Desktop onboarding now resolve catalog entries and plan provenance
  from one host-owned plugin/workspace snapshot. They revalidate catalog state
  before write; disabled plugin skills remain visible but blocked, and live MCP
  tool names remain non-persistable.
- The TypeScript fallback emits the content-free
  `typescript_orchestration_defaults` reader code only when bundled plan
  resolution actually falls back.
- Removing the compatibility source requires a separate PR after the complete
  `release/0.4.17` support window. `release/0.4.18` is therefore the earliest
  eligible removal target. That PR must audit every consumer and summarize the
  available local compatibility telemetry; any observed fallback use blocks
  removal. Opt-in telemetry absence alone is not proof of zero use.

## Implementation plan

Each item is a separate small PR and security preview.

### P23-1 — Schema and parser

- Add `orchestrationProfileDefinitionFile.ts`.
- Define strict bounded types, discriminator, graph validation, and no-follow
  file reads.
- Require `fallbackStrategyId` and validate that it resolves to a primary-only
  strategy with no unavailable role or skill dependency.
- Resolve role-owned output contracts and validate canonical required-section
  aliases against the selected contract.
- Reject parallel write-capable stages unless the execution contract declares
  and enforces isolated worktrees or disjoint ownership; v1 has no such
  declaration and therefore caps write-capable fan-out at one.
- Add invalid-shape, oversized, cycle, collision, missing-fallback,
  output-contract/section mismatch, unsafe writer fan-out, and
  unknown-reference tests.

### P23-2 — Bundled catalog and Engineering parity

- Add `packages/core/orchestration-profiles/engineering.json`.
- Add bundled catalog discovery and exact file/ID parity tests.
- Add `orchestration-profiles` to the Core package publish allowlist and verify
  the packed archive contains the Engineering JSON at the path used by the
  installed loader.
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

No orchestration-profile JSON becomes authoritative at runtime until P23-1
through P23-3a are complete together, the packaged-asset check passes, and the
Engineering compatibility gate is green. P23-3 may expose a pure preview
resolver, but it does not activate plan-driven child execution by itself.
P23-3b's tool-selection migration is independently gated and cannot silently
change a workspace merely because orchestration plans are enabled.

### P23-3b — Catalog-backed tool-selection contract

- Build the safe built-in, trusted-contribution, and skill catalog descriptors
  from their authoritative registries; do not create UI-maintained lists.
- Add manifest v3 `tools.mode` and `tools.enabled`, strict stable-ID validation,
  legacy-v2 normalization, and content-free migration diagnostics.
- Resolve explicit selections through all existing policy/availability ceilings;
  retain final deny precedence and runtime enforcement.
- Keep dynamic MCP tools non-persisted and expose their live status separately.
- Add profile-default, Custom-empty, typo/disabled-entry, plugin-provenance,
  v2-compatibility, and no-manifest parity tests.

### P23-4 — Domain-neutral reusable roles

- Generalize explorer, architect, worker, reviewer, and verifier prompts.
- Move Engineering-specific stage objectives and skill choices into the
  Engineering plan.
- Preserve the existing Engineering-oriented prompt overlay for no-manifest
  workspaces and any runtime still using the `profiles.ts` compatibility
  source. Generalized prompts are selected only with an authoritative resolved
  profile plan.
- Run cross-profile role, tool, output-contract, and Engineering-parity tests.

The implementation keeps two deliberately separate prompt sources. The
physical bundled JSON contains the domain-neutral role posture used by an
active resolved profile. A bounded compatibility table contains the exact
pre-P23-4 Engineering descriptions and prompts used by no-manifest workspaces
and `profiles.ts`-sourced execution. Registry and direct-role resolution require
an explicit `{ activation: "active", orchestrationProfileId, strategyId }`
context before selecting the neutral posture; preview, malformed, or absent
context remains on the compatibility path. User, workspace, and pack role
definitions are never rewritten by this selector. Prompt selection does not
alter access, tool scope, disallowed tools, tier, limits, delegation, ownership,
or output contracts.

### P23-5 — Research and Data Science plans

- Add evidence-collection/citation-review strategies.
- Add dataset, experiment, and reproducibility strategies.
- Compile child stages into bounded delegated-task packets.

Research ships with `direct-answer`, `question-decomposition`,
`parallel-evidence`, `citation-review`, and `academic-paper`. Only read-access
roles are available; evidence fan-out is capped at three, paper review uses one
read-only reviewer, and final synthesis or revision remains on the primary
researcher. Data Science ships with `direct-analysis`,
`experiment`, `dataset-audit`, and `reproducibility-check`. Dataset inspection
may fan out read-only, but every worker or verifier stage remains single-child
and the primary data scientist owns interpretation.

The bundled reference catalog validates plan skill IDs against both Core skills
and physically available package-owned profile-plugin skills. Resolution still
requires each referenced skill to be installed and selected in the workspace;
catalog membership alone is not activation. A resolved child stage compiles
into the existing bounded delegated-task packet with profile, strategy, stage,
role, validated stage-skill, expected-output, tool/access-ceiling, and budget
fields. Primary stages cannot compile into child packets, and no parent
conversation is copied. A fan-out assignment is bounded, control-character
checked, and serialized separately as untrusted scope data; it is never
concatenated into the trusted stage objective and cannot override policy,
access, tools, or budgets.

### P23-6 — Study and Writing primary-agent plans

- Add diagnose/teach/check/remediate and outline/draft/critique/revise
  strategies.
- Support primary stages without child creation.
- Verify no normal Study or Writing strategy gains write-capable children.

Study ships with `direct-tutoring`, `diagnose-teach-check`, `remediate`, and
`source-explanation`. Diagnosis, objective mapping, explanation, assessment,
and remediation stay on the primary tutor so the same conversational agent
retains learner context and owns the advance-or-remediate decision. Assessment
is evidence against an objective-specific gate rather than a stage-completion
counter. Source explanation is the exception that may fan out: up to two
read-only explorers can gather bounded source material, after which teaching
and checking return to the primary tutor.

Writing ships with `direct-writing`, `outline-draft-revise`, and
`critique-revision`. Outline, draft, and every accepted edit stay on the
primary writer. A critique strategy freezes the artifact and rubric before up
to two read-only reviewers report findings; their output is advisory and
cannot become an automatic write. The primary writer evaluates feedback
against author intent and surfaces rejected or decision-dependent changes.

Both profiles retain preset mode `explicit`. Matching task signals alone still
resolve to their direct primary fallback until a user-reviewed strategy is
selected; adaptive managed selection belongs to P23-7. Primary stages use the
active-turn lifecycle directly and cannot compile into child packets. Every
role stage in both bundled plans resolves only to a read-access role, so skill
metadata cannot introduce a write-capable child.

### P23-7 — Adaptive managed selection

- Add the bounded strategy-selection response schema and deadline.
- Allow only eligible strategy IDs and stage enablement choices.
- Add deterministic resolution through the definition's validated fallback,
  malformed-response tests, and trace reasons.

Adaptive selection is one low-effort, forced-tool model call with a five-second
deadline and no compatibility retry. The model sees only bounded untrusted task
text plus registered signal matches and eligible strategy/stage IDs with
executor kind and optionality. It does not receive plan objectives or prompts
and cannot return roles, skills, tools, edges, access, concurrency, or budgets.
The response contains exactly `strategyId`, `enabledStageIds`, and a short
display-only rationale. Required stages must remain enabled; optional stages
may only be subtracted.

Core derives the eligible set by previewing signal-matched definitions through
the ordinary authority resolver before the model call, then sends the parsed
choice through that resolver again. Unknown, signal-unmatched, unavailable,
duplicate, over-broad, oversized, malformed, failed, or timed-out choices use
the definition's validated primary-only fallback. Explicit user strategy
requests, mode `off`, mode `explicit`, no-manifest workspaces, and tasks with no
eligible signal match do not call the model. Selection traces record the
bounded source and fallback reason; the free-text rationale is not telemetry
because it may restate user content.

### P23-8 — Onboarding and product surfaces

- Derive profile defaults from the plan catalog.
- Replace free-text tool-profile/tool-deny/skill-list editing with catalog-backed
  Desktop and CLI pickers, including concrete group expansion and policy-state
  explanations.
- Separate capability compatibility from default recommendations, rename the
  selector to **Optional capabilities**, and make it a checkbox catalog for
  every profile.
- Nest profile-owned and capability-owned packs beneath their owner; expose
  only independent or cross-domain packs as **Additional skill packs** in
  Advanced.
- Preview plan, strategy, stages, roles, skills, tools, and effective ceilings
  in CLI and Desktop.
- Add an explicit **Skip setup for now** action that discards the proposal,
  performs no onboarding write, preserves no-manifest behavior, and supports
  starting setup again later.
- Preserve user review before any manifest write.

P23-8 ships as two independently reviewed product slices. The Core/CLI slice
adds the sixth `custom` plan, derives all onboarding orchestration defaults from
the packaged plan catalog, exposes one safe plan/catalog preview, and replaces
CLI free-text skill/tool IDs with catalog multi-select controls. Its final
review shows fallback strategy, stages, effective roles, skills, concrete
tools, and concurrency ceilings, then writes explicit-catalog v3 only after
confirmation. The Desktop slice consumes the same Core preview/catalog through
the active-workspace host bridge, renders searchable catalog checkboxes with
source, provenance, recommendation, expansion, and availability details, and
refreshes the plan/effective-access preview after each draft change. Desktop
requires the reviewed catalog fingerprint before an explicit-catalog v3 save
and lands separately with host/renderer tests and live responsive UI review.
Both retain **Skip setup for now** as a terminal no-write action: Desktop
discards the draft and derives a fresh proposal when setup is reopened, while
the CLI returns before catalog review and remains covered by a filesystem
no-write test.

Capability delivery remains split into narrow PRs: first the shared
compatibility/default contract, compatibility-enforced runtime activation,
picker hierarchy, and actionable stale-catalog reload; then cross-profile
capability packs for Writing academic-paper, computational-research,
data-visualization, programming-lab, and technical-documentation. Research's
included academic-paper skills and strategy ship independently from the future
Writing capability. Each capability pack must ship its own detection,
profile-compatibility, prompt/skill policy, catalog, runtime-resolution, and
blocked/unavailable tests. A pack does not widen the profile tool matrix.

### P23-9 — Plugin and workspace contributions

- Add `orchestrationProfiles` to plugin discovery, summaries, publishing, and
  consent.
- Add workspace/local discovery with first-match precedence.
- Add collision and unavailable-reference diagnostics.
- Surface trusted plugin tool/skill contributions with provenance in the
  catalog; never persist volatile MCP tool names.

Implemented as separate reviewed slices: plugin manifests and disclosure carry
orchestration-profile contributions; whole definitions resolve
workspace-local → workspace → enabled plugin → bundled with fail-closed claims;
the selection catalog projects bounded enabled/disabled plugin skill metadata
and stable extension-tool owner provenance; and CLI/Desktop preview and save
flows consume the same resolved source snapshot. Plan provenance is visible in
both onboarding reviews, while skip remains a terminal no-write action.

### P23-10 — Compatibility telemetry and cleanup

- Record content-free use of the `profiles.ts` orchestration compatibility
  source.
- Review adoption evidence after one supported-release window.
- Remove the duplicate TypeScript orchestration defaults in a separate PR.

The telemetry reader is implemented in `release/0.4.17`. Cleanup is
intentionally not part of this ADR's release implementation: the support
window cannot be simulated during development, and the compatibility table is
the fail-safe for damaged or incomplete package assets. The follow-up removal
gate is recorded in the Compatibility section above.

### P23-13 — Iterative Research evidence and Project Knowledge grounding

- Add one Research-owned iterative evidence skill with a non-duplicate query
  ledger, source routing, evidence-gap updates, bounded stopping, and follow-up
  continuity.
- Add a primary Project Knowledge/local-context grounding stage before optional
  explorer fan-out; do not widen the explorer role.
- Keep project-corpus absence non-fatal, preserve citation provenance, and keep
  ingestion explicit.
- Add parser/catalog/strategy tests and the affected cross-profile parity
  checks.
- Add separate academic-paper drafting and adversarial-review skills to the
  included Research pack, plus a bounded primary-draft/read-only-audit/primary-
  revision strategy that composes citation verification.

### P23-14 — Project Knowledge query transport

- Make the shared Desktop query listener accept both host-wrapped and bare
  development events and enforce request/workspace scoping.
- Preserve terminal bridge states and cancel timers/listeners deterministically.
- Add focused transport tests and verify ready, empty, unlinked, signed-out,
  error, timeout, and workspace-switch behavior in the running Desktop UI.

### P23-15 — Isolated candidate launch and restart lifecycle

- Validate adapter count, uniqueness, availability, remote prerequisites, and
  explicit workspace trust before creating durable state.
- Disable launch and explain missing trust in the candidate picker.
- Reconcile persisted transient candidates with no live hosted session to a
  terminal failed state at startup; aggregate the parent run truthfully.
- Add focused manager/UI tests for no-partial-run preflight, trust consent,
  restart reconciliation, and terminal run status.

### P23-16 — Profile-aware views and unified server operations

- Extend the panel catalog with validated profile/capability recommendations,
  runtime prerequisites, and live-data activation signals.
- Render Suggested, Active and recent, and More views without changing panel
  authority or force-closing a user's open layout.
- Rename App-preview ports to Runtime preview port reservations and remove live
  preview status from Settings.
- Project workspace dev servers and runtime previews into one grouped Servers
  view with source-appropriate lifecycle actions.
- Add catalog/projection tests and live Desktop checks for Engineering,
  Research, Writing, Custom, unavailable panels, profile changes, and both
  server sources.

### P23-17 — Workbench state and Editor responsiveness

- Persist Files and Editor presentation state per workspace while isolating
  hidden panels from unrelated high-frequency renderer updates.
- Move hot Editor buffer ownership out of the root app render path and preserve
  conflict-safe save plus Monaco model/view state.
- Add one shared file-explorer model and a collapsible Explorer inside Editor.
- Add listener-lifecycle checks and warm panel-switch/key-to-paint benchmarks;
  verify the source-started Desktop with real workspace files.

### P23-18 — Browser visibility, focus, and location ownership

- Make selected-panel visibility an explicit host contract and detach the
  native browser surface immediately when Browser is no longer visible.
- Open agent and agent-popup tabs in the background by default; preserve human
  selection and track agent-owned tabs for cleanup.
- Remove hard-coded search-region signals and add reviewed, per-origin
  geolocation permission handling without silent grants or spoofing.
- Add visibility-epoch, background-tab, ownership-cleanup, and permission tests;
  verify Browser-to-Atlas/Settings switching in the source-started Desktop.

### P23-19 — Source-backed browser research

- Remove the bundled DuckDuckGo provider and fallback with an actionable legacy
  configuration diagnostic.
- Compile the Research iterative-evidence contract into a bounded Google
  pagination/source-extraction loop with duplicate-query and duplicate-URL
  suppression.
- Persist incremental source notes and claim links through Research
  notes/artifacts; store only reviewed durable findings in memory.
- Add bounded disjoint explorer fan-out and lifecycle cleanup for agent-owned
  tabs while preserving human tabs and failing closed on challenges.
- Add Core/extension/profile tests plus live source-started research QA with
  citations, pagination, tab-focus preservation, cancellation, and cleanup.

### P23-20 — Steer/goal plan reconciliation

- Add an applied-input impact/disposition contract and durable bounded change
  ledger shared by queue, steer, goal continuation, CLI, and Desktop.
- Require plan revision before further mutation for scope, acceptance,
  dependency, or ordering changes; record why clarification-only input leaves
  the revision unchanged.
- Keep extension steering observational and prevent it from expanding goal or
  authority; pause for explicit goal replacement when input contradicts the
  active goal.
- Show applied state, plan revision, and goal-decision state in CLI/Desktop and
  add safe-boundary, compaction, continuation, and conflicting-input tests.

### P23-21 — Profile-aware skill activation and personality layering

- Add validated required/recommended/optional/blocked activation metadata for
  selected skills, with hard Planning and ADR triggers shared across profiles.
- Enforce stage-scoped skill activation and primary-owned plan/ADR acceptance;
  surface unavailable required outputs instead of pretending success.
- Explain activation triggers, outputs, and tool prerequisites in onboarding
  and workspace settings.
- Separate profile-recommended communication from persona behavior and add
  global, workspace, and chat personality layers with visible provenance and
  compatibility migration.

### P23-22 — Production plan activation and stage execution

- Resolve the selected orchestration profile at the root turn chokepoint from
  the saved workspace manifest, registered task signals, installed/selected
  skills, role availability, delegation policy, and live provider capacity.
- Create one active-turn lifecycle owner for the resolved graph. Primary stages
  activate their stage skills on the root agent; role stages compile through
  `buildOrchestrationStageTaskPacket` and launch only through that owner's
  orchestration port.
- Feed structured terminal stage outputs only to declared dependants, enforce
  required sections before success, and record profile, strategy, stage, role,
  skill, fallback, and lifecycle diagnostics in the shared trace contract.
- Keep ordinary user/model delegation available as bounded ad hoc delegation,
  but do not label it as plan-stage execution or let it satisfy a planned stage
  unless it was launched from the validated stage packet.
- Preserve no-manifest behavior and primary-only fallbacks. Resolver,
  adaptive-selection, lifecycle, and packet helpers are not considered active
  product orchestration merely because their pure modules or previews exist.
- Add Agent-level tests for Engineering, Research, Data Science, Study,
  Writing, Custom, interruption, unavailable required skills, malformed child
  output, and the saved explicit-catalog workspace shape used by Desktop/CLI.

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
14. Every built-in profile uses the same Optional capabilities picker and can
    expose more than one compatible specialization without enabling all of
    them.
15. Profile-owned and capability-owned skill packs are nested under their
    owner, not duplicated as peer choices in the common Skill packs list.
16. Capability activation cannot add a tool group that was not reviewed in an
    explicit-catalog workspace.
17. Hosted CI, cross-workspace parity tests, and automated security review pass
    for every implementation slice.
18. A strategy whose validated graph contains only primary stages cannot invoke
    a child-launch tool; an `investigate` strategy can launch an explorer only
    when that role stage is present in its validated graph.
19. An unstarted ephemeral stage is cancelled when its parent turn ends,
    interrupts, or changes session; no raw orchestration tool call is replayed
    outside `Agent.runTurn`.
20. A missing orchestration runtime creates at most one terminal plan
    diagnostic and no retry loop.
21. Desktop and CLI trace a rejected pre-launch call as a failed-to-start
    delegation, never as delegated work.
22. Onboarding and workspace editing present built-in tools, groups, skill
    packs, and skills as catalog-backed choices rather than free-form ID lists.
23. Every visible catalog entry explains whether it is recommended, selected,
    available, blocked, or denied; a blocked entry cannot become executable by
    selection alone.
24. Custom begins with an empty explicit selection and can select a minimal
    reviewed surface without entering internal IDs manually.
25. A v2 workspace retains its current tool-group behavior until the user
    explicitly reviews a v3 explicit-catalog migration.
26. Dynamic MCP tool names are visible only as live runtime information and
    never written to the workspace manifest.
27. Agent-visible terminal and pull-request observation tools are built-in
    extensions; native runtime lifecycle remains host-owned, and only
    first-party built-ins can receive the corresponding privileged port.
28. Every profile declares a valid `fallbackStrategyId`; its fallback graph is
    primary-only and cannot become unavailable because a child role or skill is
    missing.
29. Every role stage uses the role-owned output contract, and every requested
    section resolves through that contract's canonical section-alias catalog.
30. Engineering implementation uses one worker unless isolated worktrees or
    disjoint enforced ownership make parallel writes provably safe.
31. The published Core package contains every bundled orchestration-profile
    JSON at the path used by the installed loader.
32. Runtime plan activation is impossible before parser, packaged catalog,
    effective ceilings, and active-turn lifecycle gates are complete; enabling
    it does not alter no-manifest behavior or implicitly activate manifest-v3
    tool selection.
33. Choosing **Skip setup for now** in CLI or Desktop creates no manifest,
    selection, completion marker, or partial draft; reopening onboarding later
    starts a fresh reviewed proposal.
34. Use of the TypeScript orchestration-default fallback emits only a bounded
    compatibility code, surface, coarse source, and count; it never emits
    profile IDs, plan contents, prompts, paths, or workspace content.
35. Research can ground from available Project Knowledge, avoid duplicate
    probes, continue from prior findings, and stop at an explicit evidence or
    budget threshold without granting Project Knowledge to explorer children.
36. Desktop Project Knowledge accepts both supported bridge event shapes and
    never converts a received terminal result into a timeout.
37. An invalid or untrusted isolated-candidate selection persists no partial
    fan-out run or worktree.
38. After Desktop restart, a durable candidate with no process-local owner is
    terminal and actionable; no run remains indefinitely launching or working.
39. Every profile receives a useful suggested panel set while all compatible
    installed panels remain searchable under More views.
40. Panel recommendation never grants a tool, host query, connector,
    authentication state, or runtime capability.
41. Settings contains only runtime preview reservation policy; one Servers view
    owns live workspace-server and runtime-preview status without offering
    unsupported lifecycle actions.
42. Research exposes academic-paper drafting and adversarial review as separate
    task-selectable skills; its paper strategy keeps drafting and revision on
    the primary researcher and caps the independent citation/paper audit at one
    read-only reviewer.
43. If the role, capability, skill, or tool catalog changes during onboarding
    review, save fails as a stale conflict, reloads the latest choices, and
    never collapses the condition into an unexplained generic write failure.
44. Files expansion/filter/selection and Editor model/view state survive
    right-panel switching and workspace round-trips without leaking between
    workspaces.
45. Editor buffer changes do not rerender the root app, and the shared Explorer
    opens the same model as Files while conflict-safe save remains intact.
46. A hidden Browser panel has no attached native surface, including while an
    agent action is in flight; a late action cannot re-cover another panel.
47. Agent-created tabs do not steal the human-selected tab by default, and
    research cleanup closes only agent-owned tabs.
48. Browser search locale is not pinned to a false country, and geolocation is
    never granted or spoofed without a reviewed per-origin user decision.
49. Built-in browser research uses Google, has no DuckDuckGo runtime fallback,
    records query/result-page progress, and visits sources within explicit
    budgets.
50. Every material research claim in a final artifact links to a retained
    source record; interruption preserves completed source notes and final
    cleanup preserves human tabs.
51. Parallel research assigns disjoint bounded subquestions and returns
    structured source ledgers to the primary researcher; it never creates
    unbounded browser concurrency or multiple final-report writers.
52. A material queued or steered requirement updates the active plan before the
    next affected mutation, and CLI/Desktop show the resulting plan revision.
53. Goal continuation uses the latest reconciled plan and applied-change ledger;
    a contradictory steer cannot silently replace the active goal.
54. Extension steering may add in-scope remediation evidence but cannot expand
    goal, authority, tool access, or approval policy.
55. Planning and ADR activation is enforced by validated task/stage signals,
    not merely by listing the skills in a profile pack; unavailable required
    outputs are visible and fail safe.
56. Personality changes prose only, exposes its effective source, respects
    chat/workspace/global overrides, and never changes persona, tools, skills,
    roles, or orchestration.
57. Every role-executed stage has at least one stage-scoped skill; removing a
    required child skill makes that strategy unavailable and selects the
    validated primary-only fallback.
58. Every standard profile recommends visible read-only Project Knowledge and
    Memory Context groups, while Custom remains empty; Study and Writing keep
    orchestration selectable so their reviewed explicit strategies can run.
59. Bundled role MCP scopes use exact stable identifiers and no wildcard-like
    entry; namespaced first-party matches remain subordinate to workspace,
    server-identity, parent, access, and active-skill ceilings.
60. Production Agent turns resolve and own one plan lifecycle, activate primary
    stage skills, compile role stages through the validated stage packet, and
    expose terminal stage outcomes in both CLI and Desktop traces. Pure
    resolver/preview availability alone does not satisfy this criterion.

## Non-goals

- Creating a separate persona for every orchestration strategy.
- Creating Research-, Study-, Writing-, or Data-specific copies of every role.
- Allowing plans to grant tools, access, models, or provider capacity.
- Automatically running every stage listed in a profile.
- Replacing the durable workflow engine.
- Persisting full plan graphs or model rationales in the workspace manifest.
- Removing the user delegation policy or explicit confirmation gates.
- Allowing arbitrary executable code or expressions in plan JSON.
