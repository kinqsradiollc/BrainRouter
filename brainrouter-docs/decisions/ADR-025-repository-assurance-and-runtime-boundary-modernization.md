# ADR-025 — Repository Assurance and Runtime Boundary Modernization

**Status:** Accepted for phased implementation on `release/0.4.17` ·
**Builds on:** ADR-017 (GitHub App review flows), ADR-022 (profile and
capability contracts), ADR-023 (profile orchestration), and ADR-024 (work,
assurance, code intelligence, and review workbench contracts) ·
**Refines:** the current PR review implementation and the package-boundary work
already tracked in ADR-024. It does not replace their accepted lifecycle or
authority decisions.

## Date

2026-07-29

## Decision in brief

BrainRouter will evolve PR code review, security review, and authorized pentest
from a shared diff-review pipeline into a versioned **Repository Assurance**
product. It will retain one evidence, coverage, finding-lifecycle, and
publication contract while keeping the three programs distinct.

At the same time, it establishes a whole-platform module modernization program.
Every maintained package and host—shared types, protocol, Core, SDK, hooks,
backend, CLI, Desktop, and Dashboard—will converge on stable responsibility
boundaries. Packages will be organized by responsibility—not by a cosmetic
top-level `ai` folder—and public imports will continue through compatibility
entrypoints until each migration is proven. Review and provider/model runtime
are early vertical slices, not the limit of this decision.

No whole-repository model prompt, unbounded autonomous test activity, or
big-bang directory move is authorized by this ADR.

## Context

### Current foundations and the gap

The current core review package contains useful, working primitives:

- separate code, security, and pentest review policy/lens modules;
- structured finding parsing, severity gates, SARIF conversion, synthesis, and
  an in-process latest-review service;
- a backend finding-lifecycle reconciler that does not auto-fix findings from a
  partial result;
- GitHub review jobs with idempotence and stale-job cancellation; and
- an advisory code-review lens alongside a security lens that can gate on
  verified severity policy.

Those foundations are still mostly driven by a unified PR diff. They do not
yet make the following facts first-class across every host:

1. the exact checkout, baseline, analyzer versions, and policy used;
2. what was indexed, analyzed, excluded, unsupported, or unavailable;
3. the changed symbols plus relevant callers, callees, routes, configuration,
   dependencies, and tests used to reach a conclusion;
4. the distinction between a model candidate, a deterministic result, a
   security hotspot, a verified vulnerability, and an authorized dynamic proof;
5. a single durable finding/disposition record used by backend, Desktop, CLI,
   and GitHub publication; or
6. a clean dependency direction from contracts and policy to adapters.

The same boundary problem appears throughout the runtime and host surfaces.
`provider/` already owns catalog, model-family, fallback, policy, budget, and
provider definitions, but some concepts still sit side by side because they
arrived feature by feature. The same risk exists in agent lifecycle, context,
workspace/profile setup, browser, terminal, background work, storage,
connectors, worktrees, editor/Atlas/review panels, and API routes. Adding more
profiles, model routing, review execution, and recovery receipts without a
target ownership model would recreate the same problem in larger files and
host-specific adapters.

### Why a clean structure is not merely a directory change

Folder names only help when each one answers a stable question:

| Boundary | Owns | Does not own |
|---|---|---|
| contracts | versioned, host-neutral records and validation vocabulary | persistence, network calls, UI state |
| domain | pure states, transitions, finding identity, gate decisions | provider SDKs, database clients, GitHub payloads |
| analysis | deterministic repository facts, graph queries, analyzer normalization | publication policy, model prompting |
| policy | enabled programs, thresholds, scope, budgets, redaction rules | execution mechanics |
| orchestration | bounded stage selection, specialist packets, retry/checkpoint decisions | raw transport and storage details |
| ports | interfaces needed by services | provider-specific implementation |
| adapters | Git, GitHub, database, static analyzer, sandbox, model, Desktop, CLI integration | cross-domain policy |
| presentation | API, GitHub check/comment, Desktop, and CLI projections | independent business state |

This avoids two failure modes: a generic `ai/` catch-all where unrelated
concerns accumulate, and a broad source-tree move that changes imports without
making ownership or behavior safer.

## Decision drivers

1. PR results must use whole-repository facts without sending the whole
   repository to a model on each push.
2. A clean result must state its coverage, limitations, and provenance.
3. Security review, code review, and authorized pentest must share lifecycle
   infrastructure without being silently treated as the same product.
4. Blocking conclusions need stronger evidence and an independent verifier or
   deterministic proof; an unsupported automated assertion cannot block alone.
5. Review policy and contracts must be reusable by GitHub App, backend, CLI,
   and Desktop without presentation layers importing one another.
6. Provider routing remains model-neutral, bounded, and auditable.
7. Refactors must be small, behavior-preserving, reversible, and independently
   reviewable.
8. Agent-produced code must consistently follow the same ownership, planning,
   verification, and review contracts rather than relying on a long universal
   prompt or an individual model's taste.

## Decision

### 1. Make Repository Assurance the shared product boundary

One `RepositoryAssuranceRun` is the durable unit of work for a pinned source
revision and policy snapshot. It composes one or more programs, but every
program keeps its own authority and evidence requirements.

| Program | Question | Input scope | Default publication | May block |
|---|---|---|---|---|
| `code_review` | Does the change preserve correctness and maintainability? | Diff plus selected impact context, tests, diagnostics | Advisory summary and opt-in inline findings | No by default |
| `security_review` | Does the change or repository create an unsafe condition? | Code/security analyzers plus reachability, configuration, dependencies, and secret evidence | Check summary; high-confidence, verified inline findings | Policy-gated |
| `authorized_pentest` | Can an authorized target weakness be reproduced safely? | Deep source evidence plus explicit target authorization and sandbox/proxy receipts | Restricted report and lifecycle finding | Only under explicit policy |

`authorized_pentest` never starts because a code or security review found a
candidate. It needs its own persisted authorization, target scope, tool policy,
and cleanup receipt.

The minimum run record is:

```ts
interface RepositoryAssuranceRun {
  id: string;
  repository: RepositoryRef;
  revision: { baseSha?: string; headSha: string };
  program: "code_review" | "security_review" | "authorized_pentest";
  policySnapshot: AssurancePolicySnapshot;
  sourceSnapshot: SourceSnapshot;
  coverage: AssuranceCoverage;
  stages: AssuranceStageReceipt[];
  findings: AssuranceFindingRef[];
  status: AssuranceRunStatus;
}
```

The final concrete schemas belong in `packages/types/src/review/` only when
they are host-neutral and dependency-free. Runtime validation and pure policy
belong in Core; protocol commands/events belong in the protocol package;
database records and wire DTOs remain at their respective adapter boundaries.

### 2. Standardize the assurance campaign

Every run follows a bounded, observable campaign:

```text
authorize and pin revision
  -> checkout/inventory and establish baseline
  -> update code-intelligence index
  -> run deterministic analyzers
  -> calculate coverage and risk map
  -> assemble bounded specialist packets
  -> discover candidates
  -> independently verify or dispute candidates
  -> reconcile lifecycle and calculate policy gate
  -> publish projections and evidence links
```

The model receives risk-ranked packets, not an unbounded repository dump. A
packet can include the diff, changed symbols, selected call/reference paths,
relevant configuration, dependency facts, tests, analyzer diagnostics, and an
explicit coverage gap. Packet limits, redaction, model/tool budgets, and retry
limits are persisted in the policy snapshot.

An analyzer that is disabled, unsupported, unavailable, or fails is a
machine-readable coverage limitation. It cannot contribute to a clean
repository conclusion.

### 3. Strengthen the finding and publication contract

All programs normalize into a shared finding lineage while retaining their
program-specific evidence.

| Candidate state | Meaning | Publication/gate consequence |
|---|---|---|
| `candidate` | An analyzer or model identified a possible issue | Not a merge gate |
| `hotspot` | Security-sensitive area needs a human or verifier decision | Review-required, not called a vulnerability |
| `verified` | Independent verifier or deterministic evidence supports the mechanism | Eligible for policy-gated publication |
| `disputed` | Verification rejected the mechanism or evidence | Retained with rationale; does not gate |
| `insufficient_evidence` | Evidence cannot support the claim | Retained as non-blocking uncertainty |
| `validated` | Authorized reproduction or equivalent strong proof confirms impact | Highest evidence class; policy-gated |

Every published blocking finding must include the source revision, exact
location or logical symbol, mechanism, evidence references, analyzer/model
provenance, confidence, coverage limits, stable fingerprint, and verifier
disposition. A bot rule that cannot point to current-head evidence and an
actionable mechanism is advisory at most; it must not become a required merge
gate merely because it is automated.

Security review is automatically eligible on supported PR events. Code review
is also eligible by default, but remains advisory and avoids inline-comment
flooding: it publishes a concise check summary and only emits inline comments
when the repository policy opts in and an exact current-head anchor exists.
Users with the appropriate review permission can request deeper runs. An
automated run never writes a fix, pushes a branch, or changes a PR.

### 4. Target module ownership across the platform

This is a destination map for the whole maintained codebase, not permission to
create every folder immediately. Each migration creates a thin compatibility
entrypoint, moves one coherent concern, characterizes behavior, and removes the
old internal path only after all consumers migrate. It applies to existing code
as it is touched and to deliberate cleanup slices; it is not limited to new PR
assurance work.

```text
packages/types/src/
  review/                 host-neutral assurance/finding/coverage records
  provider/               host-neutral provider selection records when shared

packages/agent-protocol/src/
  agent/                  turn, queue/steer, lifecycle, and delegation vocabulary
  review/                 commands, progress, receipts, and projections
  workspace/              host-neutral workspace/profile/onboarding vocabulary
  terminal/               host-neutral PTY/session vocabulary

packages/core/src/
  review/
    contracts/            validation and Core-owned schema adapters
    domain/               finding identity, lifecycle, gate decisions
    policy/               lens, threshold, scope, budget, redaction policy
    analysis/             analyzer normalization and graph-query contracts
    orchestration/        bounded campaign/stage coordination
    ports/                Git, index, analyzer, store, and model interfaces
    services/             application use cases
    adapters/             local/in-process implementations only
    index.ts              curated public compatibility surface
  provider/
    contracts/            provider-neutral execution and selection shapes
    catalog/              models, families, and capabilities
    routing/              selection, fallback, cooldown, and budget decisions
    policy/               user/org/workspace constraints
    adapters/             provider transport implementations
    telemetry/            attempt and recovery receipts
    index.ts              curated public compatibility surface
  agent/
    context/              composition and provenance
    loop/                 turn lifecycle and checkpoints
    tool-execution/       permissioned dispatch and receipts
  workspace/              manifest, selection, policy, and resolution concerns
  browser/                browser policy, contracts, and host-neutral action loop
  terminal/               shell policy and host-neutral session contracts
  background/             scheduled/background task domain and service contracts
  connectors/             connector policy and host-neutral contracts
  storage/                storage ports and deterministic services
  worktree/               worktree domain, policy, and port contracts

packages/sdk/src/
  review/                 typed assurance client and DTO adaptation
  workspace/              typed workspace/profile client and DTO adaptation
  connectors/             typed connector client and DTO adaptation
  shared/                 client transport, pagination, and error primitives

packages/hooks/src/
  review/                 query/mutation hooks for review projections
  workspace/              query/mutation hooks for workspace projections
  connectors/             query/mutation hooks for connector projections
  shared/                 query-key, cancellation, and stale-result primitives

brainrouter/src/
  api/                    HTTP transport and route composition only
  services/               backend use-case composition
  adapters/               database, queue, GitHub, provider, filesystem adapters
  jobs/                   durable background job adapters and runners
  projections/            read models for API/Dashboard/GitHub publication

brainrouter-cli/src/
  commands/               command parsing and rendering adapters
  runtime/                CLI host composition and platform adapters
  views/                  terminal presentation components
  features/               thin feature projections by domain

brainrouter-desktop/src/
  main/                   Electron/main-process composition and privileged adapters
  renderer/               presentation shell and feature panels
  features/               panel-local UI grouped by domain
  bridges/                validated IPC contracts and adapters

brainrouter-dashboard/src/
  app/                    routing and page composition
  features/               domain screens and view models
  client/                 Dashboard-specific composition over SDK/hooks
  components/             reusable presentation-only components
```

`llm` is a narrow term: it may name a provider-neutral request/response
execution contract or session-local model interaction, but it must not become a
second provider-routing system. `ai` is not a target package because it does
not express ownership. Features should instead join `agent`, `review`,
`research`, `provider`, or another bounded domain.

The tree describes responsibility, not a prescription to duplicate every
domain in every package. Backend code owns durable jobs, exact source snapshots,
organization policy, database projections, GitHub adapter calls, and
authorization attestations. SDK and hooks adapt stable backend contracts rather
than recasting backend domain rules. Desktop, CLI, and Dashboard own
host/presentation adapters and project the same protocol receipts; they do not
duplicate Core policy, lifecycle transitions, or validation.

### 5. Dependency and import rules

The intended direction is:

```text
types/contracts <- core domain/policy <- core services <- adapters/presentation
```

- `packages/types` is a dependency leaf and never imports Core, backend,
  Desktop, CLI, or provider SDK code.
- Core domain/policy modules are deterministic and do not import GitHub, the
  database, Electron, process execution, or a provider SDK.
- Services depend on ports; adapters implement ports and are composed at the
  host boundary.
- `index.ts` files are curated public surfaces, not a blanket export of every
  internal file. Existing supported imports keep working through a temporary
  façade until an explicit deprecation migration is complete.
- No module is moved solely to satisfy a line-count target. A split must make a
  testable ownership boundary and preserve behavior.

### 6. Whole-platform modernization rules

Every domain migration uses the same rules:

1. Start with an import/ownership inventory for the selected domain across all
   consumers. Identify public entrypoints, runtime composition roots, generated
   code, persistence/wire records, and behavior fixtures before moving files.
2. Split by domain responsibility (`contracts`, `domain`, `policy`, `services`,
   `ports`, `adapters`, or `presentation`) only where that distinction exists;
   never manufacture folders for a one-file feature.
3. Move shared, dependency-free records to `packages/types`; move host events
   and commands to agent protocol; keep runtime validation and policy in Core.
4. Make SDK/hooks thin consumer layers. Keep backend, CLI, Desktop, and
   Dashboard composition at their outer boundary.
5. Preserve public imports with a curated façade. A façade's deletion requires
   an import-graph check and a consumer migration record.
6. Do not combine a structural move with unrelated behavior change unless the
   behavior change is the explicit vertical slice being verified.
7. Add package-boundary checks after the first representative migrations prove
   the convention is workable, rather than freezing an untested folder theory.

Initial modernization domains, in dependency order, are shared contract
ownership; provider/model routing; agent lifecycle/context/tools; review and
assurance; workspace/profile/skills; browser/terminal; storage/connectors/
background/worktree; then the host projections in backend, SDK, hooks, CLI,
Desktop, and Dashboard. The order may change only when the inventory documents
a real dependency or a production-risk reason.

### 7. Documentation, skills, and agent code-quality contract

Code structure will only stay clean if agent behavior makes the same boundaries
visible before and during a change. BrainRouter will therefore maintain a
layered quality contract rather than put every rule in a global instruction:

| Layer | Responsibility | Activation |
|---|---|---|
| `AGENT.md` and pointer files | Short, provider-neutral non-negotiables, read order, ownership boundaries, small-PR discipline, and evidence expectations | Every engineering task |
| Architecture and ADR skills | Require an ADR when a public contract, dependency direction, or durable policy changes; require the agent to link implementation work to the decision | Engineering architecture tasks, selected by task/profile |
| Planning skill | Produce a bounded implementation plan with dependencies, affected contracts, acceptance evidence, and a taskboard update before multi-slice work | Non-trivial implementation and goal work |
| Code-quality/review skill | Inspect existing patterns, preserve public compatibility, avoid god files and deep imports, add focused tests for behavior changes, and perform an evidence-led self-review | Engineering changes; security/review work adds the security capability |
| Profile/capability resolver | Select the relevant skills and allowed tools for Engineering, security/review, and Custom work; keep them off unrelated profiles by default | Runtime-enforced per task |
| Review/verification runtime | Enforce permissions, tool scope, test/verification receipts, review gates, and finding lifecycle independently of prompt compliance | Runtime-enforced |

The global contributor instructions remain deliberately short. They describe
invariants and how to discover the relevant domain rule; they must not grow
into a duplicated checklist for every profile or model. Profile/task skills own
specialized workflows, and runtime contracts own authority, validation, and
side-effect limits.

For engineering work, the quality skill must require the agent to:

1. identify the owning domain and public entrypoints before editing;
2. read the applicable domain rule and related ADR/plan before changing a
   durable boundary;
3. make or update an ADR and taskboard when the change alters architecture,
   public contracts, authority, or migration direction;
4. prefer a coherent module extraction plus compatibility façade over adding to
   a mixed-responsibility file;
5. run only proportionate, focused verification during a small slice and use
   hosted integration gates for broad release confidence;
6. report evidence, remaining limitations, and intentionally deferred work
   without claiming broad verification that did not occur; and
7. use the code/security review capability before merge when the workspace
   policy selects it, while keeping the review evidence separate from the
   authoring agent's assertion.

Skill changes need their own evaluation corpus. Representative tasks must cover
contract placement, a safe compatibility extraction, a cross-package consumer,
an invalid/deep import, a security-sensitive change, and a no-change/plan-only
request. A skill becomes a default only after it improves these outcomes across
supported model families without forcing irrelevant steps on other profiles.

### 8. Review and security tool assignment

Repository assurance is a capability family. It is recommended for Engineering
profiles and selectable for Custom profiles; it is not automatically exposed to
unrelated profiles. The effective tool set is the intersection of profile,
workspace selection, role/delegation packet, user permission, and runtime
environment.

| Tool group | Engineering | Security/review task | Custom | Research/Writing/Study |
|---|---|---|---|---|
| local diff, repository, and code-index reads | Recommended | Required | Selectable | Not default |
| assurance-run read/status | Recommended | Required | Selectable | Not default |
| manual code/security review enqueue | Permission-gated | Permission-gated | Permission-gated | Not default |
| GitHub publication/disposition | Reviewer permission only | Reviewer permission only | Reviewer permission only | Not default |
| authorized dynamic assessment | Off by default | Explicit authorization only | Explicit authorization only | Unavailable by default |

The reviewer orchestration role remains a domain-neutral harness role. Security
expertise is supplied by a selected security capability, persona, skills,
policy, and tools—not by silently making every reviewer a security operator.

## Alternatives considered

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Keep the current diff-led lenses and add prompts | Lowest immediate change cost; existing annotations stay simple | Cannot prove repository coverage or reliably follow cross-file impact; contracts continue to drift | Retain as an explicitly labeled degraded fallback only |
| Send every repository file to a model on every PR | Appears simple and broad | Costly, slow, non-deterministic, leaks unnecessary context, and still cannot prove coverage | Rejected |
| One generic review/pentest program | Fewer visible types | Collapses different authority, evidence, and safety requirements | Rejected |
| Big-bang package/folder reorganization | Fast visual cleanup | High merge conflict and regression risk; obscures behavior changes; makes rollback difficult | Rejected |
| Incremental capability-oriented boundaries with facades | Stable ownership, small PRs, host parity, reversible migration | Requires temporary compatibility layers and disciplined sequencing | Accepted |
| Generic top-level `ai/` and `llm/` folders | Familiar labels | Quickly become ambiguous catch-alls and duplicate provider routing | Rejected |

## Consequences

### Positive

- PR reviews can explain both evidence and missing coverage instead of implying
  that a diff-only pass is repository-wide assurance.
- Security findings gain a reliable distinction between candidate, hotspot,
  verified issue, and authorized proof.
- GitHub App, backend, CLI, and Desktop share run/finding semantics rather than
  independently reconstructing status.
- Provider routing, model interaction, and review orchestration receive
  discoverable ownership boundaries.
- The refactor can be stopped after any slice without breaking public imports
  or requiring a release-wide rewrite.

### Costs and risks

- Durable snapshots, indexes, coverage receipts, and projections add schema and
  operational complexity.
- Compatibility façades temporarily increase source count.
- Analyzer support varies by language and platform; coverage must make gaps
  visible rather than presenting an unsupported language as clean.
- Stronger evidence requirements can reduce noisy findings but can also defer a
  real issue to a human. The workbench must display that uncertainty clearly.

## Security and privacy invariants

1. Every run is pinned to an organization, repository, revision, policy hash,
   and caller authority.
2. Checkouts are isolated inputs; repository credentials are fetch-scoped and
   unavailable to model tools.
3. Package-manager scripts, arbitrary binaries, submodules, and dynamic target
   actions are deny-by-default until their policy permits them.
4. Prompts use bounded, redacted packets. Secrets, credentials, and unneeded
   source files are never included just to obtain a broader model opinion.
5. A partial, failed, superseded, or stale run cannot publish a clean approval
   or auto-fix an existing finding.
6. Authorized dynamic assessment requires persisted target authorization and a
   fail-closed perimeter; it cannot inherit permission from PR review.
7. Human dispositions, policy overrides, and bypasses remain durable evidence;
   they do not erase the original finding.

## Migration plan and taskboard

Each row is a small PR or a very small dependency-ordered series. Completion
requires focused evidence for the changed slice, hosted integration checks, and
the repository's normal security-review process before merge.

| ID | Status | Deliverable | Depends on | Acceptance evidence |
|---|---|---|---|---|
| A25-0 | `[x]` | Accept, revise, or reject this ADR | — | Accepted for phased implementation on 2026-07-29 |
| A25-1 | `[ ]` | Whole-platform ownership/import inventory across types, protocol, Core, SDK, hooks, backend, CLI, Desktop, and Dashboard | A25-0 | Owner map, dependency graph, public-entrypoint list, and keep/move rationale for every selected domain |
| A25-2 | `[ ]` | Define shared-contract placement and package-boundary guard pilot | A25-1 | Dependency-free types/protocol rules and negative import fixtures |
| A25-3 | `[ ]` | Modernize provider/model catalog, routing, policy, adapters, and recovery receipts behind a curated façade | A25-1, A25-2 | Fallback/budget/recovery behavior and public import parity |
| A25-4 | `[ ]` | Modernize agent lifecycle, context, tool execution, queue/steer, and delegation boundaries | A25-2 | Lifecycle, authority, and host-protocol fixture parity |
| A25-5 | `[ ]` | Modernize workspace/profile/skills/capability and onboarding boundaries | A25-2 | Manifest, selection, and no-manifest compatibility matrix |
| A25-6 | `[ ]` | Modernize browser, terminal, background, connectors, storage, and worktree boundaries in domain slices | A25-2 | Host ownership, permission, cancellation, and persistence fixtures per slice |
| A25-7 | `[ ]` | Add dependency-free review contract family under `packages/types/src/review/` with compatibility exports | A25-1, A25-2 | Contract round trips; Core/backend/CLI/Desktop/Dashboard consumer checks |
| A25-8 | `[ ]` | Extract Core review domain/policy/ports/services behind curated `review` façade | A25-7 | Existing lens, parsing, lifecycle, and gate fixture parity |
| A25-9 | `[ ]` | Introduce durable assurance-run, coverage, source-snapshot, and stage receipts in backend/protocol | A25-7 | Idempotent/superseded/partial state matrix |
| A25-10 | `[ ]` | Add exact-SHA checkout, deterministic analysis adapters, and parser-backed PR impact packets | A25-8, A25-9 | Credential isolation plus cross-file caller/config/test and source-to-sink fixtures |
| A25-11 | `[ ]` | Add candidate verification, evidence-aware publication, and coverage-aware gate calculation | A25-9, A25-10 | No-evidence/partial/stale runs cannot block or approve cleanly |
| A25-12 | `[ ]` | Project shared domain contracts through backend API, SDK, hooks, GitHub App, CLI, Desktop, and Dashboard | A25-3 through A25-11 | One state definition, host-specific presentation only |
| A25-13 | `[ ]` | Add explicit deep-review and authorized-assessment policies after telemetry thresholds are accepted | A25-11, A25-12 | Budget, authorization, cancellation, and evidence-retention checks |
| A25-14 | `[ ]` | Update contributor docs, ADR/planning/code-quality skills, and profile/task activation policy for the modernized ownership model | A25-2 through A25-6 | Cross-model quality corpus; plan-only/engineering/security/custom activation matrix; no duplicated global checklist |
| A25-15 | `[ ]` | Remove obsolete internal paths only after consumers leave compatibility façades | A25-3 through A25-14 | Import graph check; no supported deep imports |

### Migration guardrails

- Begin with the inventory and contracts; do not combine extraction with feature
  changes, UI redesign, or broad formatting churn.
- Preserve the current diff-review path until repository-context review proves
  parity on targeted fixtures and reports its coverage correctly.
- Keep one behavior-changing concern per PR. Folder moves are separate from
  policy changes whenever practical.
- A failed analyzer, unavailable checkout, missing code index, or stale head
  produces a visible partial/degraded receipt, not a silent fallback.
- Do not turn a newly discovered internal module into a public package export
  without documenting its owner, versioning responsibility, and consumers.
- Documentation and skill changes describe only shipped contracts. Do not make a
  prompt promise a tool, package boundary, or verification guarantee that the
  runtime does not yet enforce.

## Acceptance criteria

This ADR is implemented only when all of the following are true:

1. A PR review can include changed code, selected unchanged callers/callees,
   relevant tests/configuration, and a coverage receipt without dumping the
   whole repository into a model context.
2. A cross-file security fixture has an exact source-to-sink or equivalent
   mechanism path, independent verification, and a current-head finding anchor.
3. Unsupported, unavailable, partial, stale, and superseded analysis states are
   visible and cannot yield a clean approval or auto-fix lifecycle transition.
4. Code review, security review, and authorized assessment retain distinct
   program names, permissions, evidence requirements, and publication policy.
5. GitHub App, backend, Desktop, and CLI display the same durable run,
   coverage, finding, and disposition states.
6. Security findings cannot block solely on a prompt assertion; blocking policy
   requires recorded evidence and verifier/deterministic support.
7. Provider selection/routing and model interaction have one owner each, with
   no duplicate fallback engines introduced by the reorganization.
8. Every maintained package and host has an ownership/import inventory and
   follows the target dependency direction without duplicating domain policy.
9. `packages/types` remains dependency-free, Core policy remains adapter-free,
   and all public compatibility imports have named owners and deletion plans.
10. Engineering skill activation selects architecture, planning, and code-quality
    guidance only when the task requires it; global instructions remain concise,
    provider-neutral, and do not duplicate specialized skill workflows.
11. The documented quality workflow is evaluated across representative
    architecture, extraction, consumer, security, and plan-only tasks before it
    becomes a default for a profile.
12. Every migration slice remains independently reversible and is delivered in a
   small PR with focused validation and the normal hosted merge gates.
