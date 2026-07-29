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
| A25-1 | `[x]` | Whole-platform ownership/import inventory across types, protocol, Core, SDK, hooks, backend, CLI, Desktop, and Dashboard | A25-0 | `brainrouter-docs/adr-025-package-boundary-inventory.md`: owner map, dependency graph, public entrypoints, triage, and keep/move rationale |
| A25-2 | `[x]` | Define shared-contract placement and package-boundary guard pilot | A25-1 | `scripts/check-package-boundaries.mjs` enforces the graph during lint and staged-source checks; negative fixtures cover leaves, application back-edges, browser safety, Dashboard isolation, curated Core exports, and the renderer exception |
| A25-3 | `[x]` | Modernize provider/model catalog, routing, policy, adapters, and recovery receipts behind a curated façade | A25-1, A25-2 | Provider owns catalog/model policy plus canonical `provider/routing`; bounded recovery receipts cover gateway and agent calls; router exports are tested compatibility façades |
| A25-4 | `[x]` | Modernize agent lifecycle, context, tool execution, queue/steer, and delegation boundaries | A25-2 | Lifecycle, authority, and host-protocol fixture parity |
| A25-5 | `[ ]` | Modernize workspace/profile/skills/capability and onboarding boundaries | A25-2 | Manifest, selection, and no-manifest compatibility matrix |
| A25-6 | `[ ]` | Modernize browser, terminal, background, connectors, storage, and worktree boundaries in domain slices | A25-2 | Host ownership, permission, cancellation, and persistence fixtures per slice |
| A25-7 | `[x]` | Add dependency-free review contract family under `packages/types/src/review/` with compatibility exports | A25-1, A25-2 | Exact-revision run, program, policy, source-snapshot, coverage/limitation, stage, evidence, finding-lineage, and verifier records build in the leaf package; round-trip, explicit partial/verified-state, program-authority, and compatibility-entrypoint fixtures pass; runtime validation and gate policy remain assigned to A25-8 Core |
| A25-8 | `[x]` | Extract Core review domain/policy/ports/services behind curated `review` façade | A25-7 | Validation/gate fixtures, backend lifecycle compatibility, program-authority defaults, and in-memory campaign/port fixtures cover exact-revision idempotency, stage transitions, cancellation, partial/complete failure boundaries, candidate verification, and lifecycle reconciliation |
| A25-9 | `[x]` | Introduce durable assurance-run, coverage, source-snapshot, and stage receipts in backend/protocol | A25-7 | Normalized tenant-scoped persistence, protocol projection, Core campaign adoption, explicit diff-only coverage, semantic retries, and ordered same-PR newer-head supersession fixtures |
| A25-10 | `[x]` | Add exact-SHA checkout, deterministic analysis adapters, and parser-backed PR impact packets | A25-8, A25-9 | Credential isolation plus cross-file caller/config/test and source-to-sink fixtures |
| A25-11 | `[x]` | Add candidate verification, evidence-aware publication, and coverage-aware gate calculation | A25-9, A25-10 | No-evidence/partial/stale runs cannot block or approve cleanly |
| A25-12 | `[x]` | Project shared domain contracts through backend API, SDK, hooks, GitHub App, CLI, Desktop, and Dashboard | A25-3 through A25-11 | One versioned publication projection is validated from the stored gate and consumed by forge, backend, Dashboard, Desktop, and CLI without host-owned authority decisions |
| A25-13 | `[x]` | Add explicit deep-review and authorized-assessment policies after telemetry thresholds are accepted | A25-11, A25-12 | Budget, authorization, cancellation, and evidence-retention checks |
| A25-14 | `[ ]` | Update contributor docs, ADR/planning/code-quality skills, and profile/task activation policy for the modernized ownership model | A25-2 through A25-6 | Cross-model quality corpus; plan-only/engineering/security/custom activation matrix; no duplicated global checklist |
| A25-15 | `[ ]` | Remove obsolete internal paths only after consumers leave compatibility façades | A25-3 through A25-14 | Import graph check; no supported deep imports |

### A25-3 provider/model delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-3a | `[x]` | Add a dependency-free, secret-free provider recovery receipt and one bounded Core executor; adopt it in non-streaming router gateway calls | Types/Core consumer typechecks; retryable, non-retryable, exhausted, fallback, immutability, and secret-exclusion fixtures |
| A25-3b | `[x]` | Adopt the executor in the agent turn loop without changing transcript, trace, cooldown, model-fallback, or interruption behavior | The runtime adapter includes the failed primary attempt, de-duplicates routes per turn, preserves fallback presentation, and publishes one receipt; focused executor, adapter, and run-turn fixtures cover the campaign |
| A25-3c | `[x]` | Adopt the receipt contract for streaming calls while preserving the no-fallback-after-output rule | Gateway streaming uses the bounded executor; pre-output fallback and post-output terminal-stream fixtures preserve one receipt per campaign |
| A25-3d | `[x]` | Consolidate catalog, routing, policy/budget, adapters, and telemetry ownership behind the provider façade while retaining router compatibility exports | Canonical implementations live under `provider/routing` and the curated provider entrypoint; maintained consumers use that owner, identity fixtures prove router façade parity, and the boundary checker prevents new internal router ownership |

### A25-4 agent runtime delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-4a | `[x]` | Split the dependency-free agent protocol into event, command, interaction, callback-bridge, and envelope owners behind its unchanged root entrypoint | The package emits declarations and JavaScript successfully; callback, steering, envelope, guard, and interaction-broker fixtures pass without adding a runtime dependency |
| A25-4b | `[x]` | Pin lifecycle, tool-call pairing, interruption, bounded-loop, and safe-boundary steering order before extracting the turn runtime | Existing Core fixtures cover the run-turn success/error paths, interrupted multi-tool batches, queued and extension steering at model-safe boundaries, steering revisions, orphan/duplicate/malformed tool-call pairing, repeat guards, and adaptive/task-budget termination |
| A25-4c | `[x]` | Extract prompt/context, tool execution, steering, recovery, and completion phases behind the existing Agent facade | Core and CLI/Desktop host fixtures retain callback order, authority ceilings, transcript behavior, and protocol event parity |
| A25-4c1 | `[x]` | Extract pending-input application into a host-neutral safe-boundary steering phase | Core typecheck and the in-flight extension-steer fixture prove reconciliation, untrusted-input framing, receipt lifecycle, transcript order, and continuation before the next model request |
| A25-4c2 | `[x]` | Extract model invocation and bounded provider recovery behind a typed phase boundary | Core model-phase and agent-runtime fixtures preserve request pairing, stream callbacks, route recovery, interruption, and transcript behavior |
| A25-4c3 | `[x]` | Extract final-answer normalization before turn capture while retaining lifecycle side effects in the Agent facade | Focused completion-phase fixtures cover normal, bounded-loop, goal-proof, goal-blockage, and empty-answer outcomes; existing runtime fixtures preserve capture and callback order |
| A25-4c4 | `[x]` | Extract pre-turn compaction, recall, prompt hooks, planning hints, goal/skill anchors, and completion feedback into a context-preparation phase | Core runtime, hook, required-skill, and completion-inbox fixtures preserve model-visible ordering, blocking hooks, injected context, goal state, and pending child feedback |
| A25-4c5 | `[x]` | Extract permissioned tool-call repair, dispatch, result pairing, and cancellation into a tool-execution phase | Core fixtures preserve model-visible schemas, authority ceilings, approval order, parallel-safe batches, malformed-call recovery, exact result order, and interruption behavior |
| A25-4c5a | `[x]` | Extract duplicate-id repair, truncated/scavenged call recovery, storm suppression, assistant recording, and synthetic result pairing before dispatch | Agent runtime recovery fixtures preserve duplicate-id handling, malformed arguments, repeat guards, assistant/tool-result ordering, status callbacks, and continued model execution |
| A25-4c5b | `[x]` | Extract permission, required-skill, extension, and approval gates plus local/MCP/orchestration dispatch behind typed authorization and adapter phases | Tool fixtures preserve fail-closed authority, exact callback order, profile/skill ceilings, and error projection |
| A25-4c5b1 | `[x]` | Extract the fail-closed skill, workspace, permission, access-mode, shell, approval, external-path, and required-workflow authorization intersection before dispatch | Agent runtime, permission, execution-policy, shell-safety, required-skill, and workspace-tool fixtures preserve denial precedence, attended/unattended behavior, audit callbacks, and authority ceilings |
| A25-4c5b2 | `[x]` | Extract local, orchestration, and MCP adapter invocation plus result/error projection | Agent runtime, orchestration, hook, skill, and MCP fixtures preserve active-turn lifecycle, approval timing, skill loading, extension adaptation, summaries, and denial classification |
| A25-4c5c | `[x]` | Extract parallel-safe batch scheduling, ordered result publication, interruption fill, and orphan repair | Batch fixtures preserve concurrency limits, original result order, cancellation, and complete tool-call pairing |
| A25-4c6 | `[x]` | Extract bounded turn-loop checkpoints, guard recovery, and terminal cleanup into a lifecycle coordinator | Core plus CLI/Desktop host fixtures preserve callbacks, traces, usage, transcript capture, cancellation, loop limits, and protocol event parity |
| A25-4c6a | `[x]` | Extract answer capture, hooks, trace closure, usage accounting, telemetry, result shrinking, and termination-reason selection into one terminal phase | Completion, hook, usage, loop-limit, interruption, and agent-runtime fixtures preserve terminal ordering and side effects |
| A25-4c6b | `[x]` | Extract bounded loop checkpoints and guard recovery decisions from the turn runner | Guard and runtime fixtures preserve budget stops, child draining, verification, plan synchronization, cancellation, and continuation order |
| A25-4c6b1 | `[x]` | Extract child auto-drain and required profile-stage recovery behind one bounded guard phase | Child lifecycle, orchestration, profile-stage, interruption, and agent-runtime fixtures preserve wait callbacks, timeout projection, synthesis input, and fail-closed stage order |
| A25-4c6b2 | `[x]` | Extract the remaining bounded loop checkpoint and terminal guard coordinator | Guard and runtime fixtures preserve steering, budget, synthesis, verification, plan synchronization, cancellation, and final-answer selection |
| A25-4d | `[x]` | Consolidate local and cross-host delegation packets, authority attenuation, cancellation, and child-result projection | Delegation fixtures prove parent ceilings, explicit capability subsets, bounded fan-out, cancellation propagation, and identical CLI/Desktop receipts |
| A25-4d1 | `[x]` | Use one bounded task-packet contract for local children and cross-host delivery while retaining read compatibility for legacy queued rows | Types/Core builds plus Core, backend, and CLI fixtures prove one packet shape, authoritative sender identity, server-clamped cross-host capability/tool ceilings and budgets, tool-free legacy normalization, and dependency-light host adoption |
| A25-4d2 | `[x]` | Make parent interruption a truthful child lifecycle transition and project one receipt through protocol, CLI, and Desktop | Fixtures prove descendant cancellation propagation, no interrupted child is reported completed or detached, and CLI/Desktop consume the same projected receipt |

### A25-5 workspace and onboarding delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-5a | `[x]` | Move onboarding transaction contracts and fixed storage limits out of the coordinator without changing its public entrypoint | Core typecheck and pair-transaction fixtures preserve the exported contract identities, phase transitions, recovery behavior, filesystem limits, and caller imports |
| A25-5b | `[x]` | Extract workspace-file snapshots, encoding, and exact-match validation behind a focused file adapter | Snapshot and adversarial filesystem fixtures retain no-follow, inode, size, timestamp, hash, concurrent-replacement, and encoded-content integrity checks; pair-transaction fixtures preserve recovery behavior |
| A25-5c | `[x]` | Extract receipt persistence, validation, ownership, and recovery services behind the existing transaction facade | Receipt-store and recovery fixtures preserve safe-directory, bounded receipt, active-owner, ambiguous-state, rollback, staged-file handling, and idempotent cleanup behavior |
| A25-5d | `[x]` | Separate profile manifest/catalog/policy resolution from filesystem trust and onboarding transaction composition | No-manifest, explicit-catalog, compatibility, precedence, diagnostic, and safe-write fixtures preserve current behavior |
| A25-5d1 | `[x]` | Move the committable manifest vocabulary and fixed bounds out of the mixed manifest owner behind its existing facade | Core typecheck and manifest fixtures preserve every exported contract identity, caller import, serialized version, and fixed normalization limit |
| A25-5d2 | `[x]` | Extract manifest normalization, profile-default resolution, compatibility translation, and safe serialization into a pure policy module | Manifest, hardening, compatibility, and selection-catalog fixtures preserve profile precedence, explicit-catalog selection, secret/path redaction, forward-compatible extras, diagnostics, and byte bounds without filesystem access |
| A25-5d3 | `[x]` | Extract trusted manifest load/save and transaction recovery composition into a filesystem store | Manifest, hardening, claim, and onboarding-pair fixtures preserve fixed paths, bounded/no-follow reads, guarded writes, claim-before-pair recovery, diagnostic recording, absent/corrupt compatibility, and the public facade |

### A25-6 infrastructure domain delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-6a | `[x]` | Extract embedded-browser DNS and private-destination policy from Electron view lifecycle | Desktop host fixtures prove human/private and agent/exact-origin authority, metadata/link-local denial, mixed DNS fail-closed behavior, and resolver failure handling |
| A25-6b | `[x]` | Separate embedded-browser tab lifecycle, permissions, downloads, persistence, and agent-control managers behind the existing facade | Desktop host fixtures preserve workspace/session ownership, permission, cancellation, view attachment, persistence, and event order |
| A25-6b1 | `[x]` | Extract workspace-scoped browser tab and permission-decision persistence behind an injected store | Store fixtures preserve opaque workspace identity, atomic writes, credential/query/fragment exclusion, permission round trips, corrupt-state fallback, and the BrowserViewManager facade |
| A25-6b2 | `[x]` | Extract permission and dialog prompting behind a bounded manager | Permission fixtures preserve saved decisions, grants, timeout/cancel behavior, selected-tab presentation, and event order |
| A25-6b3 | `[x]` | Extract download ownership and lifecycle behind a workspace-scoped manager | Download fixtures preserve workspace scope, one-shot agent gesture authority, progress events, cancellation, path selection, and listener cleanup |
| A25-6b4 | `[x]` | Extract tab/view lifecycle and attachment behind a live-state manager | Desktop fixtures preserve tab ordering, active selection, view attachment, crash/navigation events, workspace rotation, and cleanup |
| A25-6b4a | `[x]` | Extract tab identity, ordering, active selection, close/reopen state, and bounded snapshots behind a live collection manager | Tab-state fixtures preserve nearest-neighbor selection, blank replacement, recently closed policy, overflow errors, ordering, and unknown-tab failures |
| A25-6b4b | `[x]` | Extract native view creation, event wiring, attachment, and destruction behind the tab facade | Desktop host fixtures preserve sandbox preferences, navigation/crash events, surface attachment, workspace rotation, and cleanup |
| A25-6b4b1 | `[x]` | Extract native view allocation, lookup, bounded console state, surface attachment, and destruction behind an injected host | Native-view fixtures preserve sandbox-host allocation, failed-registration cleanup, no-flash rebounding, active-view switching, bounded console rows, lookup removal, and cleanup-before-close order |
| A25-6b4b2 | `[x]` | Extract navigation, loading, media, input, authentication, certificate, dialog, and popup event wiring behind the native-view owner | Desktop host fixtures preserve event order, state mutations, destination gates, takeover behavior, prompt lifecycle, popup authority inheritance, and crash recovery |
| A25-6b5 | `[x]` | Extract agent-control ownership, visible pinning, input, uploads, and navigation leases behind a session-scoped manager | Agent browser fixtures preserve chat ownership, user takeover, cancellation, private-origin authority, staged-upload cleanup, and deterministic event order |
| A25-6b5a | `[x]` | Frame every browser tool result as untrusted external evidence before model history and transcript persistence | Core fixtures prove page-controlled console text remains a nested payload, unsafe text formatting is neutralized, non-browser results remain byte-identical, and future browser tools inherit the boundary |
| A25-6b5b | `[x]` | Extract session ownership, visible-operation leases, cancellation, user takeover, uploads, and navigation authority behind the browser agent-control manager | Desktop agent-control fixtures preserve per-chat tab isolation, exact visible pinning, cancellation settlement, private-origin authority, staged-upload cleanup, and event order |
| A25-6c | `[ ]` | Separate terminal, background, connector, storage, and worktree policy/services from privileged host adapters | Per-domain fixtures preserve workspace/session scope, authority, cancellation, persistence, and cleanup |
| A25-6c1 | `[x]` | Move worktree isolation contracts and merge-back presentation behind the unchanged Core facade before separating the privileged Git/filesystem host | Types, protocol, and Core builds plus 44 worktree, runtime, and fleet fixtures preserve public imports, isolation authority, recovery refs, patch persistence, merge-back, cleanup, and presentation |
| A25-6c2 | `[x]` | Move worktree Git, filesystem, configuration, and state-path capabilities behind one privileged Node host adapter | Core build plus 47 worktree, runtime, fleet, and structural-boundary fixtures preserve public imports and every isolation/recovery behavior while proving the service no longer imports privileged owners directly |

### A25-8 Core review delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-8a | `[x]` | Add Core-owned assurance-record validation and evidence/coverage-aware gate policy | Validation rejects authority, revision, lifecycle, counter, stage, and finding-reference mismatches; gate fixtures prove candidate-only, partial, missing, mismatched, stale, superseded, and wrong-head evidence cannot become clean or blocking, while independently supported current-head findings follow explicit program policy |
| A25-8b | `[x]` | Extract finding identity/lifecycle and program authority defaults behind the curated review façade while preserving the backend compatibility path | Existing backend lifecycle fixtures retain behavior; Core fixtures pin line-stable/program-separated fingerprints, conservative paraphrase reconciliation, complete-only auto-fix, reopen/ignored disposition behavior, legacy-lens mapping, and distinct authorization/publication/evidence/blocking defaults |
| A25-8c | `[x]` | Introduce review ports and campaign services without importing Git, database, queue, provider SDK, or hosts into Core policy | In-memory port fixtures cover exact-revision idempotent start, stage receipts, fail-closed complete/partial termination, cancellation before tool work, thrown-stage failure, same-scope supersession, current-revision candidate verification, and idempotent lifecycle application |

### A25-9 durable assurance delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-9a | `[x]` | Add normalized, tenant-scoped assurance run, source snapshot, coverage, and stage-attempt receipts beside the existing memory-job ledger | Migration and Postgres adapter preserve exact revision and policy identity; focused pure and scratch-Postgres fixtures cover equivalent-run idempotency, monotonic receipt transitions, explicit partial completion, cross-tenant isolation, terminal immutability, and same-scope supersession |
| A25-9b | `[x]` | Add a dependency-free protocol event projection for durable runs and receipts without duplicating domain policy or promising an unimplemented host command | Protocol build and structural-guard fixtures cover every explicit program, run, source, coverage, analyzer, and stage state; partial counters and stale/superseded lifecycle evidence remain visible |
| A25-9c | `[x]` | Adopt the durable run adapter in backend review scheduling/execution and newer-head cancellation | Existing review behavior remains intact while exact-head start, idempotent retry, partial analyzer, and same-PR older-head supersession fixtures emit durable records |

### A25-9c backend adoption slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-9c1 | `[x]` | Bind the Core assurance-run port to the existing Postgres store capability for one worker job and tenant | Adapter fixtures cover job/tenant forwarding, semantic-idempotency return, lifecycle forwarding, and cross-tenant policy rejection without widening the shared memory-store contract |
| A25-9c2 | `[x]` | Run the current diff-review fallback through the Core campaign service and project its known coverage limits | Existing executor behavior remains intact; focused fixtures prove exact-head partial runs, semantic retry idempotency, analyzer-failure receipts, and explicit diff-only repository-context limitations |
| A25-9c3 | `[x]` | Link newer-head cancellation to durable same-scope supersession | Pure and scratch-Postgres fixtures select only older active heads by tenant, repository, PR, program, and job creation order; Core records the replacement link without crossing scope |

### A25-10 repository analysis delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-10a | `[x]` | Add dependency-free exact-source, parser-index, relationship, and bounded impact-packet contracts plus Core ports and validation | Types/Core builds and fixtures reject stale evidence, invalid graph distance, missing path proof, unknown limitations, and packet/file/byte limit violations without exposing checkout paths, source bodies, credentials, or parser handles |
| A25-10b | `[x]` | Add an isolated exact-SHA checkout and inventory adapter with opaque receipts and deterministic cleanup | Adapter fixtures prove fetch-scoped credentials, disabled prompts/hooks/submodules/scripts and redirects, exact-head verification, bounded inventory, cancellation, cleanup, and secret-free errors |
| A25-10c | `[x]` | Add a parser-backed TypeScript/JavaScript symbol and relationship index with explicit unsupported-language coverage | Cross-file fixtures resolve imports, callers, callees, references, inheritance, configuration, and tests; parse failures, unreadable/oversized files, and unsupported languages remain visible limitations |
| A25-10d | `[x]` | Assemble deterministic, risk-ranked impact packets from changed anchors and the index | Packet fixtures prove caller/callee/config/test/dependency selection, current-head call-path source-to-sink evidence, stable retries, mandatory redaction, deduplication, cancellation, artifact cleanup, and hard packet/file/byte limits |
| A25-10e | `[x]` | Adopt exact source, index, and packet stages in the durable review campaign while retaining the labeled diff-only fallback | Exact-head campaign fixtures publish stage, source, index, packet, coverage, cleanup, cancellation, and degraded-fallback receipts without sending an unbounded repository context |

A25-10 now uses one exact-head campaign path from scheduled review execution
through checkout, parser indexing, impact-packet assembly, bounded untrusted
model evidence, and cleanup. Fetch authorization is a non-serializable,
single-use capability consumed by the isolated Git adapter. Unsupported,
failed, canceled, superseded, and diff-only paths remain explicit durable
coverage states rather than clean repository conclusions.

### A25-11 finding assurance delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-11a | `[x]` | Persist tenant- and run-bound candidate records with normalized exact-revision evidence behind the Core finding port | Core validation rejects secret-bearing, stale, or unsupported verifier records; backend fixtures pin tenant/run scope, monotonic disposition, bounded payloads, evidence round trips, and run references |
| A25-11b | `[x]` | Normalize model and deterministic analyzer candidates into the shared finding contract | Candidate fixtures retain exact anchors, provenance, coverage limitations, and stable fingerprints without granting blocking authority |
| A25-11b1 | `[x]` | Persist bounded model findings as exact-head, candidate-only records before any forge publication attempt | Executor, scheduled-composition, normalization, and campaign fixtures prove full candidate details do not enter job output, persistence failure prevents publication, revision mismatch is rejected, and candidates retain stable identity, model provenance, limitations, and no invented verifier evidence |
| A25-11b2 | `[x]` | Normalize deterministic analyzer discoveries and their exact-revision evidence into the same finding identity | Cross-file mechanism fixtures retain analyzer provenance, exact anchors, evidence references, and stable fingerprints; same-fingerprint discoveries are de-duplicated without upgrading candidates into verifier authority |
| A25-11c | `[x]` | Add an independent bounded verifier adapter and record its evidence-bound disposition | Separate forced-structure verification fixtures reject stale or unsupported references, cap context and timeout, enforce the remaining campaign model-call budget, turn malformed/missing/provider-unavailable verification into `insufficient_evidence`, and persist discovery plus verification receipts before completion |
| A25-11d | `[x]` | Calculate the coverage-aware gate and apply evidence-aware publication before forge output | No-evidence, partial, stale, mismatched, or superseded runs cannot publish clean or blocking conclusions |

### A25-12 assurance projection delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-12a | `[x]` | Add one shared assurance-detail DTO and tenant-scoped backend projection for a review job | The API reuses the durable run and finding contracts without redefining lifecycle states; query and route fixtures prove organization/job/run scoping plus evidence and verifier-disposition projection |
| A25-12b | `[x]` | Add typed SDK and hook consumers and render durable coverage, stages, findings, and dispositions in Dashboard review detail | SDK/hook contracts preserve the shared DTO; loading/error/cache fixtures and Dashboard presentation fixtures cover complete, partial, stale, superseded, and unresolved states |
| A25-12c | `[x]` | Project the same detail through the agent protocol to CLI and Desktop review surfaces | Protocol, host-query, dev-bridge, CLI, and Desktop fixtures render the same run, coverage, stage, finding, and disposition values without duplicating policy |
| A25-12d | `[x]` | Reconcile forge summary/check output with the shared host projections and prove cross-host parity | Forge and backend fixtures consume the canonical gate projection; protocol, Dashboard, Desktop, and CLI fixtures preserve its exact label, conclusion, and reason, while contradictory partial-to-success projections fail validation |

### A25-13 deep-review and authorized-assessment delivery slices

| ID | Status | Deliverable | Acceptance evidence |
|---|---|---|---|
| A25-13a | `[x]` | Require every dynamic or source-only pentest to carry one versioned, hashed policy snapshot bound to an active persisted target | Types/Core fixtures cover authority, exact target perimeter, budget, fail-closed cancellation, and evidence-retention fields; backend route and scheduler fixtures reject missing, changed, revoked, cross-tenant, or mismatched target authority |
| A25-13b | `[x]` | Enforce retained-evidence expiry and raw-workspace cleanup for authorized assessments | Domain findings persist through a bounded redacted allowlist; disposable workspaces are removed after every exit path; an hourly store-capability sweep expires detailed job timelines, normalized evidence, verifier payloads, and artifact references while retaining audit metadata; focused unit and scratch-Postgres fixtures prove active/fresh protection and idempotence |
| A25-13c | `[x]` | Add an explicit whole-repository deep-review policy with accepted telemetry thresholds and bounded opt-in activation | Policy fixtures prove program-specific thresholds, cost/time ceilings, cancellation, coverage labeling, and no automatic escalation from diff review |
| A25-13c1 | `[x]` | Define the dependency-free deep-review policy, accepted telemetry threshold receipt, and activation decision | Types/Core fixtures pin tenant/repository/program scope, explicit-manual-only activation, program-specific accepted thresholds within immutable platform ceilings, cost/time/model/tool budgets, malformed-telemetry rejection, fail-closed cancellation, bounded coverage labeling, tamper detection, and diff-review non-escalation |
| A25-13c2 | `[x]` | Bind explicit deep-review requests to backend execution and host selection without weakening normal diff-review behavior | Backend and host fixtures prove server-built policy, manual opt-in, preflight telemetry enforcement, cancellation, honest bounded-whole-repository coverage, and no webhook/automatic activation |
| A25-13c2a | `[x]` | Derive the persisted manual deep-review policy from authenticated backend context and caller-selected numeric limits | Backend fixtures prove tenant, repository, program, requester, acceptance time, and automatic-escalation denial cannot be supplied or widened by a host |
| A25-13c2b | `[x]` | Enforce deep-review preflight and bounded execution before exposing manual host selection | Manual API jobs carry one server-built policy and a single attempt; the scheduler rejects diff/webhook/scope mismatches, evaluates exact-source file and parser-index telemetry before model work, enforces accepted model/time/tool/cost reservations, selects deterministic risk-ranked repository anchors, and records bounded-whole-repository limitations; focused fixtures preserve ordinary diff review |
| A25-13c2b1 | `[x]` | Add exact-source preflight, deterministic risk-ranked repository anchors, and bounded coverage projection behind the existing assurance session | Session and parser fixtures prove accepted file/index telemetry, platform budget receipts, fail-closed denial before model context, deterministic one-anchor-per-file selection, and an explicit bounded-whole-repository limitation |
| A25-13c2b2 | `[x]` | Bind the manual API and scheduler to single-attempt deep execution without changing ordinary diff or assessment paths | Route, scheduler, and executor fixtures prove server-built policy, request-source/scope validation, model/time ceilings, cancellation, and no webhook/implicit activation |
| A25-13c2c | `[x]` | Expose explicit deep-review selection and accepted limits in maintained review hosts | Shared host preset plus Dashboard presentation and Desktop renderer/privileged-host fixtures prove deliberate one-run acceptance, visible preflight/execution/context limits, bounded-whole-repository labeling, and no implicit or pentest activation; live Desktop QA verifies disabled-before-acceptance behavior and a clean console |

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
