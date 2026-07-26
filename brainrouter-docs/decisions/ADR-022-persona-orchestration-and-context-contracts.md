# ADR-022 — Persona, Orchestration, and Context Contracts

**Status:** Accepted for `release/0.4.17` · **Builds on** ADR-003 (agent
architecture), ADR-020 (memory self-improvement), and ADR-021 (typed workspace
profiles) · **Supersedes** ADR-021 sections 3, 4, 6, and 7 only
where they define domain personas, same-ID specialist executors, or the
`agents.default` / `agents.enabled` manifest contract.

## Date

2026-07-26

## TL;DR

BrainRouter will treat persona, capability, orchestration, skill, and tool
authority as separate concepts:

```text
persona          which domain responsibilities and decision priorities apply
capability       which task-specific expertise is active
orchestration    how work may be decomposed, delegated, reviewed, and verified
skill            which bounded workflow is available for the current task
tool policy      which actions are permitted
context envelope which selected information reaches this execution
```

Bundled personas move from Markdown files in `packages/core/agents/` to
schema-validated JSON files in `packages/core/personas/`. Executable
orchestration definitions remain JSON in `packages/core/agents/`.

A persona is not presentation configuration, model configuration, tool policy,
or delegation policy. It defines domain responsibilities, decision priorities,
quality criteria, and durable behavioral instructions. Exactly one persona is
active for an execution. Capabilities and skills are selected independently for
the task.

The engineering profile keeps one `engineer` persona. Frontend and backend are
dynamic capabilities, not additional personas. Implementation-minimization
methods may be a task-selected engineering skill. Compressed response formatting
is an explicit user preference and is not a backend capability or persona.

## Context

ADR-021 established typed workspace profiles and correctly separated the
engineering persona from the frontend capability. Its implementation exposed a
broader naming and runtime problem:

- `packages/core/agents/*.md` contains domain personas;
- `packages/core/agents/*.json` contains executable orchestration roles;
- profile plugins can contribute same-ID JSON specialist executors;
- `.brainrouter/workspace.json` uses `agents.default` and `agents.enabled` for
  both persona selection and executable-agent exposure;
- the same word, “agent”, therefore means identity, specialist execution
  policy, and orchestration harness role in different code paths.

This makes it difficult to answer basic questions safely:

- Does enabling `researcher` select domain behavior, grant an executable child,
  or both?
- Does a profile make every orchestration role active, merely available, or
  model-visible?
- Should a frontend or backend task change the engineer persona?
- Which context should a delegated child inherit, recompute, or never receive?
- Which fields are trusted identity guidance and which fields cross an
  executable tool-authority boundary?

The mixed directory also makes format and validation behavior surprising.
Markdown personas use frontmatter plus an untyped body, while neighboring JSON
files pass through the executable-agent trust boundary. A file move or naming
collision can therefore change meaning.

Research and study profiles reveal a second issue. Their current persona
definitions are intentionally compact, but effective research and tutoring need
task workflows, source manifests, progress state, assessment state, and
selective tools. Putting those concerns into persona instructions would create
large prompts, duplicate state, and make every turn pay for workflows that most
turns do not need.

Finally, BrainRouter already has durable memory, typed tools, access policies,
workspace manifests, and task-scoped capability selection. Context management
must build on those systems rather than introduce a parallel memory store or
unbounded prompt inheritance mechanism.

## Decision drivers

1. Persona selection must not implicitly grant tools or delegation authority.
2. Executable agent definitions must remain a clear trust boundary.
3. Profiles must expose only appropriate orchestration without running every
   available role.
4. Root and delegated executions need the same composition model.
5. Research and tutoring should gain stronger workflows without oversized
   persona prompts.
6. Long-running work needs bounded, inspectable context composition and
   compaction.
7. Existing workspaces and plugin packages need a safe compatibility window.
8. Implementation must ship as small independently reviewable PRs.

## Decision

### 1. Use five independent runtime contracts

The runtime composes an execution from five independently validated inputs:

| Contract | Answers | May contain | Must not contain |
|---|---|---|---|
| Persona | What domain responsibilities and judgment apply? | Domain instructions, priorities, quality criteria | Tools, access mode, model, timeouts, subagents |
| Capability | What task-specific expertise is active? | Activation signals, prompt overlay, skill and tool-group references | Persistent identity, unrestricted authority |
| Orchestration role | How may work be performed? | Model policy, access scope, ownership, limits, delegation, output contract | Domain persona duplication |
| Skill | Which bounded workflow is useful? | Procedures, examples, allowed/disallowed tools | Process-global permissions |
| Tool policy | What action is authorized? | Access mode and intersected allow/deny rules | Persona or presentation preferences |

The resolved execution is:

```text
persona
  + zero or more active capabilities
  + one orchestration role
  + selected skills
  + effective tool policy
  + bounded context envelope
```

For a root conversational turn, the orchestration role is `primary`. It follows
the same validation and context rules as delegated roles even when no child is
created.

### 2. Separate persona and orchestration storage

First-party definitions use:

```text
packages/core/
├── personas/
│   ├── engineer.json
│   ├── researcher.json
│   ├── tutor.json
│   ├── writer.json
│   └── data-scientist.json
└── agents/
    ├── primary.json
    ├── architect.json
    ├── explorer.json
    ├── fleet.json
    ├── intake.json
    ├── reviewer.json
    ├── verifier.json
    └── worker.json
```

Profile plugins use distinct contribution points:

```text
profile-plugins/<pack>/
├── personas/*.json
├── capabilities/*
├── skills/*
└── agents/*.json
```

`personas/` is for domain contracts. `agents/` is reserved for executable
orchestration definitions. A plugin may contribute either without contributing
the other.

Workspace overrides use:

```text
<workspace>/personas/*.json
<workspace>/.brainrouter/personas/*.json
<workspace>/.brainrouter/agents/*.json
```

The committable persona location is team-owned project configuration. The
`.brainrouter/personas` location is a local override. Executable workspace
agents remain under `.brainrouter/agents` because they can change tool and
delegation behavior.

No loader follows symlinks. Existing size, count, path-containment, duplicate,
and schema bounds remain required.

### 3. Personas use a bounded JSON schema

The initial persona schema is deliberately small:

```json
{
  "schemaVersion": 1,
  "kind": "persona",
  "id": "engineer",
  "displayName": "Engineer",
  "description": "Builds and maintains software systems.",
  "instructions": [
    "Prefer the smallest change that completely satisfies the requirement.",
    "Preserve security, compatibility, and maintainability constraints.",
    "Verify behavior in proportion to risk."
  ],
  "priorities": [
    "correctness",
    "security",
    "maintainability",
    "delivery"
  ]
}
```

Required fields are `schemaVersion`, `kind`, `id`, `displayName`,
`description`, and `instructions`. Instructions and priorities are bounded
arrays of bounded strings. Unknown fields are rejected for first-party schemas
until an explicit forward-compatibility policy is added.

The schema has no presentation-style, model, reasoning-effort, tool, access,
capability, skill, delegation, timeout, or iteration field. Presentation
preferences belong to user/session settings. Execution authority belongs to
orchestration and tool policy.

### 4. Orchestration definitions are executable policies

Files in `packages/core/agents/` retain the existing executable definition
surface: model/effort policy, default access, tool scope, denied tools,
ownership, iteration and timeout limits, delegation rules, tier, and output
contract.

They gain an explicit discriminator:

```json
{
  "schemaVersion": 1,
  "kind": "orchestration-role",
  "id": "worker"
}
```

An orchestration role does not carry researcher, tutor, writer, frontend, or
backend identity. When specialist child behavior is required, the runtime
creates a child from a generic role plus a persona, capabilities, and task
packet.

Same-ID persona/executor pairing is deprecated. A profile may still contribute
a genuinely distinct executable role, but it must use a role-oriented ID and
must be enabled separately from its persona.

### 5. Workspace manifests select personas and orchestration separately

A manifest schema revision replaces the overloaded `agents` selection:

```json
{
  "version": 2,
  "profile": "engineering",
  "persona": {
    "default": "engineer",
    "enabled": ["engineer"]
  },
  "capabilities": {
    "enabled": ["frontend", "backend"],
    "disabled": []
  },
  "orchestration": {
    "mode": "adaptive",
    "availableRoles": [
      "architect",
      "explorer",
      "worker",
      "reviewer",
      "verifier"
    ],
    "disabledRoles": ["fleet"],
    "maxParallel": 4
  }
}
```

`availableRoles` is an upper bound, not an instruction to start those roles.
The runtime activates a role only when the mode and task permit it:

- `off` — no delegated orchestration;
- `explicit` — only a user or trusted workflow may request a role;
- `adaptive` — the runtime may select an available role from task evidence.

`disabledRoles` always wins. Required access and security gates always win.
`fleet` and high-parallel execution are explicit by default.

Profile defaults are:

| Profile | Default mode | Default available roles | Notes |
|---|---|---|---|
| Engineering | Adaptive | Explorer, architect, worker, reviewer, verifier | Fleet remains explicit |
| Research | Adaptive | Explorer, reviewer | Read-oriented tools unless explicitly expanded |
| Study | Explicit | Explorer | Direct tutoring is the normal path |
| Writing | Explicit | Reviewer | Review activates for critique or revision work |
| Data science | Adaptive | Explorer, worker, verifier | Tool policy still gates code and data writes |
| Custom | Off | None | User enables each part |

These are editable presets. They do not create permanent profile silos.

### 6. Engineering keeps one persona with frontend and backend capabilities

There is no default `frontend-engineer`, `frontend-builder`, or
`backend-engineer` persona. The active persona remains `engineer`.

The shared resolver activates `frontend` or `backend` using the delegated task,
relevant file signals, explicit user intent, enabled capabilities, and live
skill/tool catalogs.

The backend capability may select bounded skills for:

- API and service design;
- authentication and authorization;
- domain modeling;
- persistence and migrations;
- background jobs and distributed work;
- containers and deployment boundaries;
- performance and observability;
- backend-focused testing.

Capabilities do not automatically grant shell, network, database, or write
access. Their tool groups still intersect with the active orchestration and
security policies.

Implementation-minimization methods belong in an optional engineering skill.
That skill can prefer existing platform features, installed dependencies, and
small custom changes while explicitly excluding security, accessibility, data
integrity, and required compatibility from minimization.

A compressed-response mode is a user/session presentation preference. It is
never inferred from backend work and must not silently reduce detail for
security findings, architecture decisions, onboarding, tutoring, or requested
explanations.

### 7. Research and tutoring grow through capabilities and skills

The `researcher` persona owns evidence discipline, uncertainty handling,
source-quality judgment, and the requirement to distinguish evidence from
inference. It does not embed a complete research pipeline.

The research pack should provide independently selectable skills:

| Skill | Responsibility | Typical tools |
|---|---|---|
| Question decomposition | Turn a broad request into answerable questions | Notes/artifact tools |
| Source strategy | Choose web, scholarly, repository, or attached-source paths | Search and source catalogs |
| Evidence collection | Gather bounded evidence with provenance | Search, fetch, knowledge search |
| Claim ledger | Track claims, support, conflicts, and uncertainty | Structured artifact storage |
| Synthesis | Reconcile sources and answer the question | Read-only evidence set |
| Citation verification | Confirm every important citation supports its claim | Source reads |
| Research review | Challenge omissions, weak evidence, and unsupported conclusions | Reviewer orchestration |

The default research tool posture is read-oriented. Code or shell becomes
available only when the task requires bounded data extraction or analysis and
the active policy permits it.

The `tutor` persona owns learner-centered judgment: diagnose before assuming,
teach one tractable objective at a time, check understanding, and adapt from
evidence. Teaching workflows remain skills:

| Skill | Responsibility | Persisted state |
|---|---|---|
| Diagnostic assessment | Establish current knowledge before instruction | Observed strengths and gaps |
| Objective map | Order learning objectives and prerequisites | Objective status |
| Explanation | Use definitions, examples, analogies, and misconceptions | Material used |
| Socratic check | Probe reasoning without immediately supplying the answer | Learner response |
| Teach-back assessment | Ask the learner to explain the concept | Evaluation evidence |
| Error diagnosis | Classify and remediate misconceptions | Error type and remediation |
| Retrieval practice | Revisit learned material over time | Review schedule and result |
| Source-grounded lesson | Teach from attached or retrieved material | Source citations |

The tutor uses knowledge/source reads, assessment artifacts, notes, calculators,
and optional diagrams where enabled. Shell and workspace writes are not
defaults. Durable learner facts pass through the existing memory system; lesson
sources remain in the knowledge subsystem. Persona instructions do not become a
second progress database.

### 8. Build every execution from a typed context envelope

The runtime replaces ad hoc prompt accumulation with a typed
`ContextEnvelope`. It contains independently budgeted, inspectable layers:

```text
1. required system and security policy
2. persona
3. active capability overlays
4. orchestration role and task packet
5. current plan and execution state
6. memory briefing
7. selected skill instructions or skill manifest
8. source manifest and selected source excerpts
9. conversation summary
10. recent messages
11. relevant tool results and tool state
```

Each layer records:

- stable layer and replacement keys;
- provenance;
- priority;
- token/character budget;
- compaction policy;
- whether it may be inherited by a child;
- whether it may contain secrets or untrusted content.

Required policy is never summarized away. Persona, capability, role, and skill
layers replace prior versions with the same key instead of accumulating
duplicates. Source content remains distinguishable from instructions.

History compaction proceeds in bounded stages:

1. discard superseded transient tool state;
2. replace oversized tool output with a structured result summary;
3. summarize older conversation while retaining recent turns;
4. compact completed plan steps into outcomes and evidence;
5. retain unresolved decisions, user constraints, citations, and failure state;
6. fail closed or request a new turn if required context still cannot fit.

Every compaction stage must make measurable size progress and has an iteration
limit. The envelope may hold session summaries, but it does not introduce a
parallel durable memory system. Reusable facts continue through the existing
memory engine, and project sources continue through the knowledge subsystem.

### 9. Delegated children receive explicit task packets

A delegated child receives a `DelegatedTaskPacket` containing:

- the bounded task and expected output;
- selected persona;
- permitted orchestration role;
- recomputed capabilities for the delegated task;
- inherited user constraints;
- relevant plan state;
- a bounded memory briefing;
- a source manifest or selected evidence;
- the effective tool-policy ceiling;
- time, iteration, depth, and output budgets.

Children do not inherit the parent’s entire transcript or active capability
overlay. The child resolver recomputes task capabilities and can only narrow the
parent policy ceiling. Parent and child use the same execution loop and context
envelope types, but delegation depth and parallelism are bounded.

The parent must consume the child’s structured result instead of repeating
sufficient completed work. Child results distinguish conclusions, evidence,
changes, verification, unresolved questions, and failures.

### 10. Migrate compatibly and remove ambiguity deliberately

The compatibility reader supports the current layout for a bounded deprecation
window:

1. Load new JSON personas from the new persona locations.
2. If no new definition exists, load a legacy Markdown persona and normalize it
   to an in-memory persona object.
3. Treat JSON files in agent locations only as orchestration definitions.
4. Translate legacy manifest `agents.default` / `agents.enabled` into persona
   selection plus explicitly mapped specialist roles.
5. Emit diagnostics for collisions, implicit same-ID pairing, and legacy
   Markdown use.
6. Write only the new manifest and persona formats after the migration ships.

No automatic migration grants a new role, tool group, or access mode. Ambiguous
legacy specialist executors stay unavailable until a deterministic mapping or
user confirmation exists.

## Alternatives considered

| Approach | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Keep Markdown personas and JSON executors in one directory | No migration; existing loaders remain | Format and namespace ambiguity persists; weak persona validation | Rejected |
| Convert personas to JSON but keep one directory | Consistent serialization | File location still does not communicate the trust boundary | Rejected |
| Separate JSON personas and JSON orchestration definitions | Clear ownership, validation, review, and security boundaries | Requires schema and compatibility migration | Accepted |
| Store persona, tools, model, skills, and delegation in one agent bundle | One object is easy to transport | Enabling identity can grant authority; task capabilities become permanent | Rejected |
| Use unrestricted layered prompt/profile inheritance | Flexible customization | Implicit precedence, hard audits, prompt growth, unsafe override behavior | Rejected |
| Use only a single non-delegating agent | Simple context and authority model | Loses bounded parallel discovery, review, and verification | Rejected |

## Context-management approaches

| Approach | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Append selected prompts to conversation text | Simple and compatible | Duplicates layers, weak provenance, unpredictable growth | Replace incrementally |
| Recursive agents with layered persistent and temporary context | Uniform parent/child loop; useful progressive compaction | Can become implicit or unbounded without typed policy | Adopt the bounded recursive structure |
| Session context object with separate persona, capability, source, skill, and history fields | Inspectable composition and selective loading | Requires a shared builder and migration | Adopt |
| New independent long-term context store | Isolated implementation | Duplicates memory and knowledge truth | Reject |
| Typed envelope over existing memory and knowledge systems | Clear budgets, provenance, replacement, and delegation | More initial implementation work | Accepted |

## Consequences

### Positive

- Selecting a persona cannot silently grant execution authority.
- JSON schemas make persona errors bounded and machine-validatable.
- Directory boundaries communicate the executable trust boundary.
- Profiles can make orchestration available without invoking every role.
- Frontend and backend work share one coherent engineering persona.
- Research and tutoring gain richer behavior without permanently larger
  persona prompts.
- Parent and child context becomes inspectable, bounded, and reproducible.
- Existing memory and knowledge systems remain the durable sources of truth.

### Negative

- Manifest, loader, plugin, CLI, Desktop, and tests require coordinated schema
  migration.
- A compatibility reader must exist temporarily.
- Generic role plus persona composition is more explicit than same-ID executor
  lookup.
- Context-envelope observability and compaction tests add implementation cost.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migration changes effective tools | Compatibility translation can only preserve or narrow authority |
| Persona instructions leak into executable fields | Separate schemas, loaders, paths, and tests |
| Adaptive orchestration creates unnecessary work | Available-role ceilings, task evidence, budgets, and explicit fleet activation |
| Context summaries lose critical constraints | Protected layers, preservation lists, structured summaries, fail-closed limits |
| Research/tutor packs become monolithic | Small skills with manifests and on-demand loading |
| Backend capability activates too broadly | Manifest enablement plus task and file signals; explicit disable always wins |
| Plugin collisions create hidden precedence | Deterministic ordering, duplicate rejection, provenance diagnostics |

## Non-goals

- Replacing the model router or provider configuration.
- Creating a second memory system.
- Making every task multi-agent.
- Automatically granting tools from a persona or capability.
- Creating separate personas for each programming specialization.
- Encoding user response style in persona definitions.
- Removing legacy loaders before a measured compatibility window.

## Delivery plan and taskboard

Every row is a separate small PR with its own automated security preview and
focused local checks. Hosted CI remains the full workspace merge gate.

| ID | PR scope | Depends on | Status |
|---|---|---|---|
| A22-0 | Accept this ADR and reconcile ADR-021 references | — | Proposed |
| A22-1 | Add persona schema, bounded parser, registry, and fixtures | A22-0 | Not started |
| A22-2 | Add `personas/` contribution paths and legacy Markdown compatibility reader | A22-1 | Not started |
| A22-3 | Convert bundled personas from Markdown to JSON | A22-2 | Not started |
| A22-4 | Add orchestration-role discriminator and reject persona fields in agent JSON | A22-1 | Not started |
| A22-5 | Add manifest v2 persona/orchestration contracts and safe legacy normalization | A22-3, A22-4 | Not started |
| A22-6 | Update deterministic onboarding, CLI, and Desktop review models for manifest v2 | A22-5 | Not started |
| A22-7 | Migrate profile plugins and remove implicit same-ID specialist pairing | A22-5 | Not started |
| A22-8 | Add task-scoped backend capability under `engineer` | A22-7 | Not started |
| A22-9 | Split research workflows into evidence, synthesis, citation, and review skills | A22-7 | Not started |
| A22-10 | Split tutor workflows into diagnostic, mastery, explanation, assessment, and review skills | A22-7 | Not started |
| A22-11 | Introduce typed context envelope, budgets, provenance, and compaction | A22-5 | Not started |
| A22-12 | Introduce bounded delegated-task packets and child context recomputation | A22-11 | Not started |
| A22-13 | Add migration diagnostics and compatibility telemetry | A22-5 | Not started |
| A22-14 | Remove legacy Markdown and manifest readers after the compatibility gate | A22-13 | Not started |

## Acceptance criteria

This ADR is implemented only when:

1. `packages/core/personas/` contains schema-valid JSON personas and
   `packages/core/agents/` contains only schema-valid orchestration roles.
2. Persona selection alone cannot change model, access, tools, delegation, or
   limits.
3. Manifest persona and orchestration selections are independent.
4. Profile tests prove unavailable roles are not model-visible or spawnable.
5. Engineering backend and frontend tasks retain the same `engineer` persona
   while activating different task capabilities.
6. Research and tutor tests load only the skills required for the current
   workflow.
7. Root and delegated executions use the typed context envelope.
8. Context compaction is bounded, preserves protected constraints and
   provenance, and never writes a second durable memory store.
9. Legacy manifests and Markdown personas preserve behavior without widening
   authority during the compatibility window.
10. CLI and Desktop show the same reviewed persona, capability, and
    orchestration configuration.

## Open questions for acceptance

1. Should `<workspace>/personas/*.json` be enabled by default as a committable
   team surface, or should the first release support only
   `.brainrouter/personas/*.json` local overrides?
2. Is one release sufficient for legacy Markdown compatibility, or must removal
   wait for two release lines?
3. Should research use adaptive `reviewer` orchestration by default, or require
   explicit review until activation quality is measured?
4. Should compressed response formatting be addressed in a separate
   user-preferences ADR rather than this migration program?
