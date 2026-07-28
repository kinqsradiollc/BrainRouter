# ADR-024 — Agent Work Contracts, Repository Assurance, and Browser Reliability

**Status:** Accepted for phased implementation on `release/0.4.17` ·
**Builds on** ADR-017 (GitHub App review flows), ADR-021 (typed workspace
profiles), ADR-022 (persona, capability, orchestration, skill, tool, and context
contracts), and ADR-023 (profile-specific orchestration plans) ·
**Refines** their execution and evidence contracts without widening authority.

## Date

2026-07-28

## TL;DR

BrainRouter already has the right lower-level pieces, but several product flows
compose them too loosely:

- GitHub App code, security, and repository pentest reviews analyze a bounded PR
  diff without a checked-out repository, so they cannot reliably follow a
  changed source through unchanged callers, sinks, configuration, or dependency
  context.
- Atlas builds a useful file/import graph, but its regex-based symbol extraction
  is not a parser-backed symbol, reference, and call graph.
- Queue and Steer enter the agent loop safely, but a material steer is not yet a
  durable, revisioned change to the requirement/decision/plan contract.
- Some shared runtime contracts still sit beside validation, persistence, and
  orchestration in large core modules. Adding new profile, planning, steering,
  assurance, and browser shapes there would grow package-level god files and
  make CLI/Desktop reuse depend on core implementation details.
- The built-in browser exposes semantic references and real Chromium tabs, but
  the agent has no single action policy for observing, locating, acting,
  verifying, recovering, and handing an incompatible site to a human or an
  attached external browser.
- Provider failures are retried and can use the optional router, but exhausted
  recovery reaches the user as a generic terminal error without a resumable
  recovery choice or a provider-attempt receipt.
- Agent-created plans, changes, findings, and evidence are spread across panels.
  Humans need one review surface that explains what changed, why, what evidence
  supports it, what remains uncertain, and which decisions are still required.

This ADR introduces five connected, independently shippable contracts:

1. a revisioned **Work Contract** connecting intent, requirements, decisions,
   plans, tasks, evidence, artifacts, reviews, and steering;
2. a local, incremental **Code Intelligence Index** that upgrades Atlas with
   parser-backed symbols, references, calls, imports, routes, and impact queries;
3. a durable **Repository Assurance Run** for code review, security review, and
   authorized pentest campaigns;
4. an **Observe → Locate → Act → Verify → Recover** browser action loop with
   explicit session compatibility and handoff;
5. a shared **Human Review Workbench** and **Provider Recovery Receipt** for
   Desktop and CLI.

The GitHub App will not send an entire repository to one model on every push.
Instead, it will maintain a full-repository baseline keyed by commit and analyzer
versions, incrementally update that baseline, and review the changed code plus
the affected graph neighborhood. An explicit deep assessment can still scan the
whole repository and, when separately authorized, validate a deployed target.
Every result reports what was and was not covered.

Security expertise is a capability and persona, not a sixth generic child role.
The reusable `explorer`, `architect`, `worker`, `reviewer`, and `verifier`
orchestration roles remain domain-neutral. A background GitHub assurance run is
a durable workflow, not an active-turn child-agent graph.

## Context

### 1. Current implementation

| Surface | Current behavior | Useful foundation | Missing contract |
|---|---|---|---|
| PR code review | Splits and reviews a unified diff | Bounded chunks, exact inline anchors, coverage counters, durable findings | No checkout, callers, tests, config, or unchanged context |
| PR security review | Diff-only source/sink prompt | Security taxonomy, CWE labels, severity gate, vulnerability intelligence | Cannot establish cross-file reachability or whole-repository coverage |
| PR pentest lens | White-box language over the same diff path | Shared audit and merge-gate infrastructure | It is not a repository pentest and cannot run static tools or a target |
| Domain pentest | Authorized target in a proxy-pinned Docker perimeter | Fail-closed sandbox, finding evidence, SARIF, durable background job | No linked repository checkout; no combined source/runtime campaign |
| Atlas | Workspace scan, regex symbols, relative imports, blast radius | Local deterministic graph, persisted per workspace, Desktop visualization | No AST identity, references, calls, overrides, route handlers, or incremental freshness |
| Queue / Steer | FIFO Queue and safe-boundary Steer | CLI/Desktop parity, trusted user vs evidence-only extension distinction | No persisted steer classification, impacted requirement refs, or plan revision |
| Plan review | Plan snapshots and approval/change decisions | Durable review history and revision task | Plan items have content-derived identity and weak ADR/criterion lineage |
| Browser | Real Chromium, semantic snapshot, stale refs, tabs, downloads, permissions | Per-workspace session, user-focus ownership, challenge handoff | No multi-strategy locator, action receipt, verification policy, or external-browser compatibility lane |
| Provider calls | Reconnects transient failures; optional model router | Backoff, offline wait, model fallback, cooldown | Final error lacks attempt history, resumable checkpoint, and recovery actions |
| Review UI | Findings, trace, diff, plan decisions, evidence exist in separate surfaces | Useful primitives and lifecycle states | No task-to-evidence-to-decision review narrative |

The screenshot error:

```text
OpenAI API error: 502 Bad Gateway
code: upstream_unavailable
```

means the BrainRouter gateway reached a provider path that could not complete
the request. The interactive runtime already classifies `502` as transient and
reconnects within its configured budget. The defect is not “no retry exists.”
The defect is that exhausted recovery loses the operational explanation and
offers no safe resume or route choice in the error surface.

### 2. Why diff-only review is insufficient

A diff is the correct annotation surface but not a sufficient analysis surface.
A vulnerability or regression may depend on:

- an unchanged caller passing newly unsafe data;
- a changed helper reaching an unchanged command, query, template, or file sink;
- authentication or authorization middleware registered elsewhere;
- generated routes, framework conventions, dependency resolution, or runtime
  configuration;
- an unchanged test whose assumptions the change violates;
- a repository-level secret, dependency exposure, or insecure default unrelated
  to one hunk;
- a source and sink separated by several calls or languages.

Conversely, “send every file to a model on every push” is expensive, slow,
non-deterministic, and still does not prove coverage. BrainRouter needs
repository-wide deterministic context and bounded model synthesis.

### 3. Why the three assurance products remain distinct

| Product | Primary question | Normal evidence | May mutate? |
|---|---|---|---|
| Code review | Does this change preserve correctness, maintainability, architecture, performance, and tests? | Diff, impacted symbols, callers/callees, tests, static diagnostics | No |
| Security review | Does this repository or change introduce an exploitable weakness or unsafe control? | Sources/sinks, configuration, dependencies, secrets, reachability, static diagnostics | No |
| Authorized pentest | Can an in-scope weakness be reproduced and what is its concrete impact? | All security-review evidence plus sandbox/proxy/browser/runtime receipts and a proof of concept | Only inside the authorized test perimeter |

A finding may flow from one product to another, but the products do not silently
escalate. A security review suspicion is not a validated pentest finding.

### 4. Planning differs by workspace profile

“Plan” is a shared lifecycle concept, not one universal document template.

| Workspace profile | Primary planning artifact | Typical gate |
|---|---|---|
| Engineering | Requirement/specification, ADR when needed, implementation plan, verification matrix | Acceptance criteria and architecture decision |
| Research | Research brief, question tree, source strategy, evidence ledger | Source coverage and contradiction review |
| Data Science | Hypothesis, data contract, experiment plan, evaluation protocol | Reproducibility and leakage/bias review |
| Study | Learning objective, diagnostic, lesson sequence, mastery checks | Learner comprehension and progression |
| Writing | Audience/intent brief, outline, source or continuity ledger, revision plan | Editorial or factual review |
| Custom | User-selected artifact schema from an allowed catalog | Explicit user-selected gate |

ADR and planning skills therefore cannot be injected unconditionally. Their
activation must be profile- and task-aware while remaining visible and
overridable.

## Decision drivers

1. Repository review must use whole-repository context without re-sending the
   whole repository to a model on every push.
2. Analysis, coverage, uncertainty, and unsupported-language gaps must be
   explicit and machine-readable.
3. Static analyzers, graph queries, and models complement one another; none is a
   complete security proof.
4. Dynamic testing must require persisted target authorization and remain inside
   a fail-closed perimeter.
5. Findings require reproducible evidence and an independent disposition or
   verification stage before blocking.
6. Background GitHub work must be durable, resumable, supersedable, idempotent,
   cost-bounded, and protected from push/review loops.
7. Workspace profile, persona, capability, skill, orchestration, tool, and
   provider concerns remain separate.
8. User steering may change work intent; extension observations and retrieved
   content may not.
9. Humans must be able to understand and review agent work without reconstructing
   it from chat history.
10. Browser automation must use the same visible session as the human when
    possible and must never claim to bypass human verification.
11. Provider recovery must not duplicate tool side effects.
12. Desktop and CLI must expose the same domain state and lifecycle, even when
    presentation differs.
13. The design must work across supported model providers. Model-specific tuning
    is an evaluated adapter, not a core work-contract assumption.
14. Delivery must be split into small, independently reviewable PRs.

## Decision

### 1. Introduce a revisioned Work Contract

The Work Contract is the durable source of truth for one user outcome. Chat
history remains conversation context; it is not the work database.

```ts
interface WorkContract {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  sessionKey: string;
  profileId: string;
  revision: number;
  goal?: GoalRef;
  requirements: RequirementRef[];
  decisions: DecisionRef[];
  plan: PlanRef;
  tasks: WorkTaskRef[];
  evidence: EvidenceRef[];
  artifacts: ArtifactRef[];
  reviews: ReviewRef[];
  steering: SteeringReceipt[];
  status: "draft" | "approved" | "active" | "blocked" | "review" | "complete";
}
```

The contract stores references and hashes, not arbitrary duplicated document
content. Existing requirement, goal, plan, Track, artifact, review, memory, and
evidence stores remain authoritative for their own records.

#### 1.1 Stable task identity and lineage

Every plan task receives an opaque stable ID at creation. Rewording or reordering
a task does not change its identity. Each task can link:

- requirement and acceptance-criterion IDs;
- an ADR section or decision ID when architecture is involved;
- dependencies and affected workspace paths;
- expected artifact and evidence types;
- assigned stage, persona, role, skills, and tool policy snapshot;
- completion and review disposition.

A task without a requirement, criterion, or explicit exploratory parent cannot
be marked implementation-ready.

#### 1.1.1 Contract placement and module ownership

Reusable plain-data contracts that cross package or process boundaries belong
in `@kinqs/brainrouter-types`, except agent-host commands and events, which
remain in `@kinqs/brainrouter-agent-protocol`. Core owns validation, domain
transitions, services, and adapters; it may expose a thin compatibility
entrypoint but must not duplicate the shared interfaces.

The package audit is behavior-led rather than a bulk folder move:

| Current shape to scan | Correct destination | Migration rule |
|---|---|---|
| Cross-package records, refs, status unions, and stable payload constants | `packages/types` | Move only dependency-free public data contracts; add a browser-safe subpath when renderer use is expected |
| Agent-host commands, events, and delivery receipts | `packages/agent-protocol` | Keep backward-compatible guards and wire vocabulary together |
| Validation mixed with shared interfaces | Owning package `contracts/` or focused validation module | Import the shared type; keep bounds and persistence invariants beside the owner |
| Filesystem, process, provider, or Electron interfaces | Owning package `ports/` | Move only when more than one adapter consumes the port; never put side-effect APIs in the types leaf |
| Large services or runtime dispatchers | Domain/service/adapter modules behind a thin entrypoint | Split by responsibility with behavior tests; do not disguise orchestration as types |
| Large test files | Feature-aligned test modules and shared test helpers | Split independently from production refactors so coverage remains reviewable |

The first audit covers `packages/core`, then follows the dependency direction
through protocol/types consumers. Each remediation is a small PR with an
unchanged public surface or an explicit migration. File size alone is a signal,
not an automatic move: a cohesive validator may remain local, while a short
cross-package interface is misplaced even if its source file is small.

The initial core scan establishes this review queue:

| Area | Boundary question | Intended review |
|---|---|---|
| `task/workContract` | Shared records were mixed with validation and storage | Move dependency-free data shapes to types; retain focused validation and store modules in core |
| `config/configTypes` | Many exported shapes are core configuration, but some are consumed as public snapshots | Separate internal resolved/runtime shapes from genuinely shared data contracts; do not move secrets or config loading |
| `workspace/manifest` and onboarding | Persisted manifest payloads, normalization, validation, and filesystem transactions are adjacent | Isolate the stable manifest contract from normalization services and guarded persistence adapters |
| orchestration profile definition/resolution | Definition payloads, source diagnostics, validation, and resolution have different owners | Put shared definition payloads in contracts/types only when external consumers need them; keep authority resolution in core |
| browser control and target receipts | Cross-host commands/results coexist with core action policy | Put wire vocabulary in agent protocol, stable data receipts in types, policy in core, and Electron behavior in its adapter |
| requirement trace, research evidence, and review records | Records are increasingly shared across CLI, Desktop, backend, and Workbench | Consolidate public records in types while keeping indexing, persistence, and workflow transitions in their owning packages |
| provider/runner clients and large runtime dispatchers | Port interfaces and concrete transport behavior are interleaved | Extract reusable ports and focused adapters; never move Node/process APIs into the browser-safe types leaf |
| large test suites | Feature coverage is concentrated around historic god modules | Split after production seams are stable, preserving fixtures and hosted parity coverage |

#### 1.2 Profile-specific planning schemas

The profile orchestration plan selects a planning schema from a validated
catalog. It may narrow required sections but cannot invent an unvalidated schema.

The primary agent must activate the applicable planning skill when:

- the selected schema requires it;
- a task meets its declared complexity or irreversibility trigger; or
- the user explicitly invokes it.

For Engineering, an ADR is required when the change crosses a public contract,
security boundary, persistence model, provider/runtime boundary, or expensive-
to-reverse architecture. Routine fixes do not create ceremonial ADRs.

#### 1.3 Steer becomes a revisioned work event

Queue and Steer retain their current delivery meaning:

- **Queue** is a future user turn and does not interrupt or mutate the active
  Work Contract.
- **User Steer** enters at the next model-safe boundary and may refine active
  work.
- **Extension Observation** enters at a model-safe boundary as untrusted
  evidence only.
- **Parent-to-child Steer** is a bounded task refinement within the delegated
  packet. It cannot widen tools, access, target scope, cost, or delegation.

Before acting on a user or parent steer, the runtime records:

```ts
interface SteeringReceipt {
  id: string;
  source: "user" | "parent" | "extension";
  classification:
    | "clarification"
    | "plan_change"
    | "evidence"
    | "goal_conflict";
  receivedAt: string;
  appliedAt?: string;
  priorRevision: number;
  resultingRevision?: number;
  affectedRequirementIds: string[];
  affectedTaskIds: string[];
  summary: string;
  status: "pending" | "applied" | "rejected" | "needs_user";
}
```

Rules:

1. Clarification can continue without a plan revision.
2. Evidence attaches to existing tasks/findings and cannot change authority.
3. A material scope, order, acceptance, diagnosis, or verification change
   creates a new plan revision before the related mutation.
4. Completed work remains truthful; only affected pending/in-progress tasks are
   revised.
5. A goal conflict stops for an explicit goal edit rather than silently
   replacing the goal.
6. A parent can steer only descendants it owns, and the child receipt is also
   linked into the parent Work Contract.

Background CI, review, deployment, and other observer extensions do not keep a
model turn open while polling. They run as durable background observations and
publish one evidence-only extension event when state changes or a terminal
result arrives. The event links to the relevant task and evidence receipt. A
failure can cause the agent to revise affected pending work at the next safe
boundary, but the observer cannot edit the plan, restart work, or grant authority
by itself.

### 2. Upgrade Atlas into a parser-backed Code Intelligence Index

Atlas remains the user-facing codebase map and service boundary. Its
deterministic extractor becomes a layered index rather than a parallel product.

#### 2.1 Index layers

| Layer | Contents | Authority |
|---|---|---|
| File inventory | Language, generated/vendor/test/config classification, content hash | Deterministic |
| Syntax | Symbols, ranges, signatures, imports, exports, inheritance/implementation | Parser-backed |
| Reference | Definitions, references, call sites, callers/callees, type use | Parser-backed where supported |
| Framework | Routes, handlers, middleware, jobs, commands, schemas, tests | Deterministic adapters |
| Repository | Packages, dependencies, owners, build targets, entry points | Manifest/build adapters |
| Semantic | Summaries, domain tags, candidate relationships | Model-derived, always labeled |

Model-derived edges never masquerade as parser-derived edges. Every node and edge
records its extractor, version, source commit, confidence class, and freshness.

#### 2.2 Incremental freshness

The index is keyed by:

```text
repository identity
+ commit SHA
+ analyzer bundle version
+ language grammar versions
+ configuration hash
```

On a local workspace, file watching queues hash-based incremental updates. On a
GitHub job, the worker obtains the exact head commit and reuses a compatible base
index when available. A preflight reconciliation must complete before queries are
declared fresh.

Responses that touch pending or unsupported files carry a stale/unsupported
warning and direct the agent to read those files. A stale graph may enrich a
review but may not support a complete-coverage claim.

#### 2.3 Minimum queries

The shared core service will expose bounded queries used by CLI, Desktop, Atlas,
review workflows, and agents:

- symbol definition and references;
- callers, callees, and bounded paths between symbols;
- file and symbol impact radius;
- route/handler/middleware chain;
- tests and fixtures related to a symbol;
- changed-code context;
- candidate source-to-sink paths;
- repository/package entry points;
- index status, freshness, coverage, and unsupported language report.

Graph output is evidence selection, not proof. Security data-flow claims still
require source reads or analyzer evidence.

### 3. Add a durable Repository Assurance Run

Repository assurance runs execute in the backend queue for GitHub App and hosted
work, and through the same core contract for local CLI/Desktop work.

```ts
interface RepositoryAssuranceRun {
  id: string;
  orgId: string;
  repository: string;
  baseSha: string;
  headSha: string;
  mode: "pr" | "branch" | "deep";
  program: "code_review" | "security_review" | "authorized_pentest";
  authorizationRef?: string;
  policySnapshot: AssurancePolicySnapshot;
  indexSnapshot: CodeIndexSnapshot;
  campaign: AssuranceStageRun[];
  findings: FindingRef[];
  coverage: AssuranceCoverage;
  status:
    | "queued"
    | "indexing"
    | "analyzing"
    | "validating"
    | "publishing"
    | "complete"
    | "partial"
    | "failed"
    | "superseded";
}
```

#### 3.1 Exact source checkout

The worker checks out the exact head SHA into an isolated, immutable input
workspace. Repository credentials are scoped to fetching the selected repository
and are not exposed to model tools. Submodules, large files, and package-manager
scripts are disabled by default and require explicit policy.

The webhook head SHA remains authoritative. If the PR advances, the old run is
marked superseded and cannot publish a current check.

#### 3.2 Analysis scope by mode

| Mode | Deterministic scope | Model scope | Normal use |
|---|---|---|---|
| PR | Full baseline/index + incremental head analysis | Diff + changed symbols + affected graph neighborhood + relevant config/tests | Every PR push |
| Branch | Full branch analyzers with incremental reuse | Risk-ranked repository slices | Scheduled or manual branch health |
| Deep | Full repository analyzers and bounded specialist campaign | Multiple risk areas with independent validation | Explicit full code/security review |
| Authorized pentest | Deep source scope plus separately authorized deployed target | Source-guided dynamic hypotheses and validated findings | Manual/approved security assessment |

“Full baseline” means the repository has been deterministically indexed and
analyzed at a known commit. It does not mean every source line is copied into
each model context.

#### 3.3 Assurance campaign stages

Programs compose validated stages; the adaptive model may select eligible
specialists but may not invent stages or tools.

```text
Authorize and pin scope
  → checkout and inventory
  → build/update code index
  → run deterministic analyzers
  → derive risk map and coverage gaps
  → parallel bounded hypotheses by independent concern
  → verify/refute candidate findings
  → deduplicate and reconcile prior dispositions
  → calculate gate from policy
  → publish GitHub annotations, summary, SARIF, and workbench state
```

Deterministic analyzers may include, subject to installed adapters and policy:

- parser-backed structural and reference analysis;
- language-specific lint/static analysis;
- secrets scanning;
- dependency and container/filesystem composition analysis;
- configuration and infrastructure analysis;
- test/coverage import;
- repository policy and architecture checks.

Analyzer absence is a coverage gap, never a silent pass.

#### 3.4 Finding evidence contract

Every blocking finding requires:

- exact repository, commit, file, and line or logical location;
- program and analyzer/model provenance;
- category, severity, confidence, and affected component;
- concrete source, sink, invariant, or failure mechanism;
- relevant call/reference path when the claim crosses files;
- reproduction or verification receipt where applicable;
- remediation;
- coverage and uncertainty notes;
- stable fingerprint and prior finding lineage.

A verifier attempts to refute each blocking candidate. The verifier cannot
delete it silently; it records `confirmed`, `disputed`, `insufficient_evidence`,
or `duplicate` with reasons. Policy decides which states block.

Security results distinguish:

| Kind | Meaning | Default gate |
|---|---|---|
| `security_hotspot` | Security-sensitive code requiring a human or verifier decision; exploitability is not established | Review required, not automatically blocking as a vulnerability |
| `vulnerability` | Evidence establishes an unsafe condition and credible impact | Policy severity threshold |
| `validated_vulnerability` | Authorized reproduction or equivalent deterministic proof confirms impact | Policy severity threshold, highest evidence class |

Labeling an unverified hotspot as a vulnerability is a contract violation.

#### 3.5 Coverage contract

```ts
interface AssuranceCoverage {
  complete: boolean;
  repositoryFiles: number;
  indexedFiles: number;
  analyzedFiles: number;
  unsupportedFiles: number;
  generatedOrExcludedFiles: number;
  changedFiles: number;
  impactedFilesSelected: number;
  analyzerRuns: Array<{
    id: string;
    version: string;
    status: "complete" | "partial" | "failed" | "unavailable";
  }>;
  dynamicValidation: "not_applicable" | "not_authorized" | "partial" | "complete";
  limitations: string[];
}
```

`complete: true` means the selected policy's declared coverage floor passed. It
never means “the repository contains no undiscovered defect.”

#### 3.6 Cost and loop controls

- One active run per repository, head SHA, program, and policy hash.
- Repeated webhook delivery returns the same run.
- A new head supersedes pending/active older-head runs.
- Bot-created commits do not recursively trigger automated fix/review loops
  unless an explicit bounded policy allows one follow-up.
- Per-run model, tool, time, parallelism, and retry budgets are persisted.
- A root coordinator reserves budget for validation and final synthesis.
- Partial results remain reviewable but cannot produce a clean approval.
- Autofix is a separate, user-authorized workflow and never runs inside the
  read-only review program.

### 4. Keep persona, capability, role, skill, and tool responsibilities separate

#### 4.1 Persona

Add a `security-auditor` persona for threat-oriented judgment, exploitability,
evidence quality, and remediation priority. It does not grant pentest authority,
tools, models, or delegation.

The existing engineering persona remains correct for general code review.

#### 4.2 Orchestration roles

Do not add `pentester`, `security-reviewer`, or `browser-agent` as new generic
role kinds. The reusable role registry remains:

| Role | Assurance use |
|---|---|
| Explorer | Map repository, attack surface, or evidence |
| Architect | Threat model or compare remediation designs |
| Worker | Apply an explicitly authorized fix in a separate workflow |
| Reviewer | Judge code, security, methodology, or output against a contract |
| Verifier | Reproduce, refute, run checks, or confirm remediation |

The selected persona, skill, and tool policy give those roles their domain.

#### 4.3 Capabilities and skills

New catalog entries:

| Kind | ID | Purpose |
|---|---|---|
| Capability | `repository-code-review` | Whole-context correctness and maintainability review |
| Capability | `repository-security-review` | Threat-oriented source/config/dependency review |
| Capability | `authorized-pentest` | Explicitly authorized source-guided dynamic validation |
| Skill | `repository-assurance` | Common campaign and coverage workflow |
| Skill | `secure-code-review` | Source/sink, auth, config, dependency, and evidence workflow |
| Skill | `finding-verification` | Reproduce/refute/deduplicate candidates |
| Skill | `authorized-pentest` | Scope, recon, validation, proof, reporting, and cleanup |
| Skill | `browser-research` | Source-led browse/evidence workflow using the browser action loop |

The duplicated capability and skill label is acceptable only if their manifests
declare distinct `kind` values and the UI labels them as “Capability” and
“Workflow skill.” If the catalog cannot display that distinction, the skill uses
the suffix `-workflow`.

#### 4.4 Tool groups

| Tool group | Contains | Allowed by default |
|---|---|---|
| `code-intelligence` | Index status, symbol, references, calls, impact, routes, tests | Engineering, Data Science, Custom |
| `repository-review` | Read/search, code intelligence, read-only analyzer runner, findings | Engineering; selectable Custom |
| `security-analysis` | Repository review plus secrets/dependency/config/security analyzers | Engineering security capability; selectable Custom |
| `pentest-sandbox` | Isolated command, scoped proxy, target browser, finding/report tools | Only authorized-pentest runs |
| `interactive-browser` | Visible tabs, snapshots, actions, screenshots, downloads, permission handoff | Profiles whose manifest and task allow browser use |
| `evidence-ledger` | Create/link source evidence, artifacts, contradictions, citations | Research, Writing, Data Science; optional Engineering |

Tool-group membership is validated in one catalog. Onboarding and Settings render
selectable tools from that catalog; users do not type internal IDs. Effective
tools remain the intersection required by ADR-022/023.

#### 4.5 Profile defaults

| Profile | Default assurance/tools | Selectable additions | Explicitly absent by default |
|---|---|---|---|
| Engineering | Code intelligence, repository review, artifacts | Security review, interactive browser, evidence ledger | Pentest sandbox |
| Research | Interactive browser, evidence ledger, artifacts | Code intelligence for software research | Repository mutation, pentest |
| Data Science | Code intelligence, artifacts, evidence ledger | Repository review, browser | Pentest |
| Study | Artifacts and approved knowledge/browser tools | Browser, evidence ledger | Repository/security/pentest |
| Writing | Artifacts and evidence ledger | Browser, code intelligence for technical writing | Repository/security/pentest |
| Custom | User-selected safe catalog entries | Any capability beneath workspace policy | Everything not explicitly selected |

GitHub App assurance is an organization/repository automation policy. It does not
inherit whichever interactive workspace profile happens to be open on a Desktop.
Its analyzer rules and gate thresholds live in a separately named assurance
policy snapshot; they are not another `WorkspaceProfile`.

Presentation personality remains outside this composition. It may change prose
style, but it cannot change assurance depth, finding severity, evidence,
planning schema, tool selection, or gate outcomes.

### 5. Define one browser action loop

The browser agent must not jump directly from intent to a guessed click.

```text
Observe current tab and revision
  → Locate candidate targets
  → Select one target with evidence
  → Act once
  → Verify the expected state transition
  → Recover, request human action, hand off, or stop
```

#### 5.1 Observe

An observation contains:

- concrete tab ID and page revision;
- URL, title, load/challenge state, and session lane;
- bounded semantic snapshot;
- screenshot only when semantic evidence is insufficient;
- active human tab and focus ownership;
- pending dialog, permission, download, or authentication prompt.

#### 5.2 Locate

Target strategies are attempted in order:

1. fresh opaque semantic reference;
2. stable test ID;
3. accessibility role and exact accessible name;
4. exact visible text or form label;
5. bounded DOM relationship query;
6. screenshot/vision coordinate candidate with a post-hit semantic check.

The result is a target receipt with strategy, selector/ref, revision, bounding
box, and confidence class. Vision coordinates never bypass stale-page checks.

#### 5.3 Act and verify

One mutating browser action produces:

```ts
interface BrowserActionReceipt {
  id: string;
  tabId: string;
  beforeRevision: number;
  action: string;
  target?: BrowserTargetReceipt;
  startedAt: string;
  endedAt: string;
  result: "succeeded" | "no_effect" | "stale" | "blocked" | "failed";
  afterRevision?: number;
  observedChanges: string[];
  recovery?: string;
}
```

After an action, the agent verifies an explicit expectation: URL, text, element,
dialog, download, network response, or revision change. “Click returned no
error” is not success.

Retries must re-observe and re-locate. They may not replay a stale coordinate or
semantic ref.

#### 5.4 Session lanes and compatibility

BrainRouter supports three explicit lanes:

| Lane | Session | Use |
|---|---|---|
| Built-in | Per-workspace embedded Chromium profile | Normal human/agent shared browsing |
| Attached | User-approved control of an existing supported external browser session | Sites requiring the user's existing sign-in or full browser environment |
| Handoff | Open/select externally and wait for a human result | Unsupported challenge, extension/DRM requirement, or policy restriction |

Cookies or credential databases are never silently copied between lanes.
Attaching requires a visible user grant and displays which browser/profile is
controlled. A site may still reject automation; BrainRouter will not promise
CAPTCHA bypass, spoof a human identity, or weaken browser security controls.

Locale, timezone, proxy, and geolocation are session settings with visible
origin-scoped permission. Geolocation failure reports which permission or
provider is missing rather than inventing a location.

#### 5.5 Human focus

Agent-created tabs default to background. The agent may pin a visible tab only
for an action that requires human observation or takeover. A human tab/panel
switch wins immediately and cancels or backgrounds the agent action according to
its safety class.

Research workflows maintain their own tab set and close agent-created tabs when
the source is captured or the research task ends. Human-created tabs are never
closed by cleanup.

### 6. Add provider recovery receipts and resumable turn checkpoints

#### 6.1 Failure taxonomy

| Class | Examples | Default response |
|---|---|---|
| Transient provider | 408, 429, 500, 502, 503, 504, overload | Bounded retry; then eligible route fallback |
| Connectivity | DNS, reset, offline | Wait/probe within interactive budget |
| Authentication | 401, 403 | Do not repeat same route; request configuration or eligible provider |
| Model lockout | missing/unsupported model | Try allowed fallback model |
| Context | token/window overflow | Compact once, preserve work checkpoint |
| Request contract | invalid input/tool schema | Compatibility adapter only when semantically safe |
| Stream interrupted after side effect | response lost after a tool/action | Never blindly replay; reconcile receipts first |

#### 6.2 Checkpoint

Before every model call, the runtime persists or can reconstruct:

- Work Contract revision;
- committed transcript boundary;
- completed tool/action receipts;
- pending tool call state;
- provider/model/effort;
- route attempts and retry count;
- resumability classification.

If no tool call was accepted after the checkpoint, a provider retry is
idempotent. If side effects may have occurred, recovery asks the relevant tool
adapter to reconcile by idempotency key before another model call.

#### 6.3 User surface

An exhausted error shows:

- plain-language classification;
- provider/model route attempted, without secrets;
- retries and fallback outcomes;
- whether the turn is safe to resume;
- actions: **Retry same route**, **Use an eligible fallback**, **Resume from
  checkpoint**, **Copy diagnostic**, or **Stop**.

Desktop and CLI use the same recovery record. The draft remains intact.

### 7. Add a Human Review Workbench

The Workbench is a shared projection, not a new source-of-truth store.

#### 7.1 Review hierarchy

```text
Outcome
  → requirements and decisions
    → plan revision and tasks
      → changes and artifacts
        → evidence and verification
          → findings, uncertainty, and required human decisions
```

#### 7.2 Required views

1. **Executive view** — outcome, risk, gate, coverage, missing evidence.
2. **Change view** — changed files/artifacts grouped by requirement and task.
3. **Impact view** — callers, dependents, routes, tests, and affected contracts.
4. **Evidence view** — commands, tests, source reads, browser receipts, analyzer
   results, citations, and provenance.
5. **Finding view** — mechanism, trace, reproduction, remediation, verifier
   disposition, and prior lifecycle.
6. **Decision view** — approve, request changes, acknowledge, dispute,
   out-of-scope, defer, or require more evidence.
7. **History view** — Work Contract and plan revisions, Steer receipts, and who
   made each decision.

Progressive disclosure is mandatory: the default view is short, but every claim
can be expanded to its evidence and source.

#### 7.3 Finding lifecycle

Existing finding states remain compatible. The Workbench additionally records
who changed the state, why, against which commit, and with what evidence. A
dismissal is not deletion. A previously disputed finding can be reopened by new
evidence; a finding absent from a partial run is not auto-fixed.

### 8. Model-neutral harness policy

Repository contributor instructions remain short and provider-neutral:

- define scope, authority, required artifacts, and output contracts;
- use runtime-enforced tool/permission/budget gates for deterministic limits;
- activate profile/task skills instead of embedding every workflow in the
  global prompt;
- avoid duplicated “always verify,” “double-check,” or “spawn a verifier”
  instructions when the selected workflow already owns verification;
- separate broad candidate discovery from filtering/verification so a
  “be conservative” instruction does not suppress real findings;
- bound document length, scope expansion, delegation, and commentary;
- evaluate prompt/model changes on representative profile workflows before
  making them defaults.

`AGENT.md` remains canonical. `CLAUDE.md` and `AGENTS.md` remain thin pointers.
Templates expose the same Work Contract concepts without naming one model vendor.

### 9. UI and API contract

#### Desktop

- Workspace setup shows built-in capabilities, workflows, tools, and their
  effective authority as selectable catalog entries.
- Settings explain profile defaults separately from per-workspace overrides.
- Planning displays the selected profile schema, criterion/ADR links, revision,
  and pending Steer impact.
- Browser displays session lane, action target, verification state, and human
  takeover.
- Review Workbench is available from Review, Plan, Artifacts, Atlas, and GitHub
  job links without duplicating state.

#### CLI

- `/workspace capabilities`, `/workspace tools`, and onboarding use the same
  catalog descriptions and effective-selection resolver.
- `/plan` shows stable task IDs and requirement/decision links.
- `/queue` and `/steer` show pending/applied receipts and affected plan revision.
- assurance commands show program, commit, coverage, stage progress, findings,
  and disposition actions.
- browser commands show lane and action receipts when an interactive browser port
  exists; headless CLI fails closed or uses an explicitly configured attached
  browser adapter.
- provider recovery offers the same choices using prompts/flags suitable for a
  terminal.

#### Backend

The backend owns durable GitHub assurance jobs, repository snapshots, analyzer
execution, organization policy, authorization attestations, job supersession,
finding lifecycle, coverage, and review projections.

Core owns schemas, pure policy, graph/query contracts, campaign validation,
finding/coverage models, and presentation-neutral recovery state.

Desktop and CLI own presentation and local adapters. They do not reimplement
assurance policy.

## Alternatives considered

### A. Repository review scope

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Diff-only model review | Fast, cheap, easy inline anchors | Misses unchanged context and cannot claim repository coverage | Retain only as degraded fallback |
| Send full repository to a model on every push | Superficially simple whole-context story | High cost/latency, context pressure, weak coverage proof, repeated unchanged work | Rejected |
| Fresh full checkout and full analyzer/model scan on every push | Strong isolation and deterministic tools | Wasteful for large repos and frequent pushes | Available as explicit deep mode |
| Full baseline + incremental index/analyzers + impacted slice | Whole-repository deterministic context, bounded model work, freshness and coverage receipts | More infrastructure and invalidation complexity | Selected |

### B. Analysis engine

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Model only | Flexible across languages | Non-deterministic, expensive, weak reachability/coverage | Rejected |
| Static analyzers only | Repeatable, scalable, strong known-pattern coverage | False positives, framework/business-logic gaps, no dynamic proof | Rejected |
| Parser graph only | Excellent navigation and impact | Not a vulnerability or correctness judge | Rejected |
| Hybrid analyzers + graph + bounded model synthesis + verification | Complementary evidence, explainable selection, dynamic escalation | More orchestration and provenance work | Selected |

### C. Assurance orchestration

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| One large reviewer | Simple | Single-context blind spots, poor refutation, unclear coverage | Rejected |
| Add many security-specific role kinds | Explicit names | Re-couples domain persona and execution posture; expands trust surface | Rejected |
| Durable campaign using generic roles plus persona/skills/tool policy | Reuses bounded roles, independent stages, resumable | Requires campaign engine and stage contracts | Selected |

### D. Browser compatibility

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Embedded browser only | One product surface, strong isolation | Some sites require existing profiles, extensions, or full-browser behavior | Insufficient alone |
| Copy external browser profiles/cookies | Familiar sessions | Credential risk, locking/corruption, unclear consent | Rejected |
| Embedded default + approved attach + human handoff | Clear boundaries and practical compatibility | More adapters and visible state | Selected |
| Stealth/fingerprint spoofing and challenge solving | May reduce some blocks temporarily | Brittle, unsafe, policy/identity concerns, cannot guarantee access | Rejected |

### E. Steering state

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Prompt-only steer | Minimal host logic | Plan/goal drift and no audit history | Rejected |
| Host infers edits from keywords | Fast | Brittle and language-dependent | Rejected |
| Model classifies at safe boundary; host validates and persists typed revision | Flexible semantics with deterministic invariants | One additional state transition | Selected |

### F. Human review

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Chat transcript as review | Already exists | Poor traceability and high comprehension cost | Rejected |
| Separate specialist dashboards | Tailored views | Fragmented lifecycle and duplicated state | Rejected |
| Shared Workbench projection with progressive disclosure | One evidence lineage across profiles and surfaces | Projection/query work | Selected |

## Consequences

### Positive

- PR review can reason about unchanged callers and configuration while keeping
  model context bounded.
- Deep security and authorized pentest workflows become genuine campaigns
  instead of alternate prompts over one diff.
- Atlas becomes useful to humans, agents, review, and impact analysis through one
  shared service.
- Findings have coverage, provenance, refutation, and lifecycle evidence.
- Steering becomes reviewable work history rather than invisible prompt drift.
- Browser actions become diagnosable and recoverable.
- Provider outages no longer collapse into an opaque dead end.
- Profile-specific planning and review share one harness without forcing every
  workspace through Engineering terminology.

### Negative

- Parser grammars, analyzer adapters, and index invalidation add maintenance and
  packaging complexity.
- Repository snapshots and analysis artifacts require retention, encryption, and
  quota policy.
- Deep assurance is materially more expensive than diff review.
- Attached-browser support adds a sensitive consent and ownership boundary.
- A Work Contract introduces migrations for existing plan/task records.
- Progressive review UX needs careful performance work for large graphs and
  finding sets.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| False “complete” coverage | Policy-specific floors, unsupported counters, partial status, no clean approval on partial runs |
| Stale index gives wrong impact | Commit/analyzer keys, preflight reconciliation, stale banners, direct file fallback |
| Analyzer prompt injection | Treat repository and tool output as untrusted evidence; structured parsers; no instruction authority |
| Repository secret leakage | Isolated checkout, secret redaction, no model access to credentials, bounded retention |
| Pentest escapes scope | Persisted authorization, origin allowlist, proxy-only network, read-only sandbox, no host fallback |
| Duplicate side effects after provider retry | Checkpoints, idempotency keys, action reconciliation, no blind replay |
| Runaway review costs | Dedupe/supersession, budgets, one bounded follow-up, no auto-fix loop |
| Too many global instructions | Profile/task skill activation and evaluated adapters; keep pointers thin |
| Browser account misuse | Explicit attach grant, visible lane, origin permissions, immediate human takeover |
| Graph support gaps | Per-language capability report and deterministic degraded mode |

## Security invariants

1. Repository contents, PR text, issue text, web pages, analyzer output, and
   extension observations are untrusted data, never authority.
2. A checkout token cannot be read by model tools or repository scripts.
3. Repository scripts and dependency installation do not run during review by
   default.
4. A review workflow is read-only. Fixing is a separate authorized workflow.
5. Dynamic testing requires a persisted authorization reference and target
   boundary.
6. Generic shell/network tools cannot bypass the pentest proxy perimeter.
7. A persona, capability, skill, orchestration plan, or model cannot widen the
   effective tool/access ceiling.
8. Provider fallback stays within organization/user policy and does not move
   data to an unapproved provider.
9. A partial or stale run cannot approve a repository as clean.
10. External-browser attachment is explicit, visible, revocable, and scoped.

## Non-goals

- Proving that a repository has no defects or vulnerabilities.
- Replacing CI, tests, language compilers, or human approval.
- Automatically exploiting third-party systems.
- Bypassing CAPTCHAs or impersonating a human/browser fingerprint.
- Adding a security workspace profile in the first rollout.
- Making every workspace load security, browser, or pentest tools.
- Replacing existing requirement, Track, memory, artifact, or review stores with
  one monolithic database record.
- Enabling automatic fixes from a read-only GitHub review.

## Rollout plan and taskboard

Each row is one PR or a small PR series with its own security review and rollback
boundary.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[U]` user decision.

| ID | Status | Deliverable | Depends on | Acceptance evidence |
|---|---|---|---|---|
| R0 | `[x]` | Accept, revise, or reject this ADR | — | Accepted on 2026-07-28 |
| R1 | `[x]` | Work Contract v1 schemas, stable task IDs, migration reader | R0 | Round-trip, migration, and invariant tests |
| R1a | `[~]` | Package contract-placement audit and responsibility splits, beginning with Work Contract types/validation/store | R1 | Inventory by contract/port/service/adapter owner; types and core builds; unchanged compatibility imports |
| R2 | `[ ]` | Typed Steer receipts and revision reconciliation in core | R1a | CLI/Desktop parity tests; goal-conflict tests |
| R3 | `[ ]` | Profile planning-schema catalog and activation policy | R1a | Six-profile resolver matrix |
| R4 | `[ ]` | Code Intelligence Index schema and parser spike for TypeScript/JavaScript | R0 | Symbol/reference/call golden corpus and performance budget |
| R5 | `[ ]` | Incremental index store, freshness reconciliation, Atlas adapter | R4 | Edit/delete/rename/stale/unsupported tests |
| R6 | `[ ]` | Shared graph query tools and Desktop/CLI/Atlas projections | R5 | Caller/callee/impact/route query fixtures |
| R7 | `[ ]` | Repository Assurance Run/job model and exact-SHA checkout sandbox | R0 | Credential isolation, supersession, idempotency tests |
| R8 | `[ ]` | Deterministic analyzer adapter contract and coverage receipt | R7 | Complete/partial/unavailable matrix |
| R9 | `[ ]` | PR code-review campaign using changed + affected context | R5, R7, R8 | Cross-file regression fixtures; GitHub annotation parity |
| R10 | `[ ]` | PR security-review campaign and security persona/capability/skills | R5, R7, R8 | Cross-file source/sink/auth/config fixtures; verifier dispositions |
| R11 | `[ ]` | Deep repository assessment mode | R9, R10 | Whole-repository campaign, budget, resume, partial coverage tests |
| R12 | `[ ]` | Linked repository + authorized target pentest campaign | R10, R11 | Authorization, sandbox, proxy, proof, cleanup tests |
| R13 | `[ ]` | Browser target receipts and observe/locate/act/verify/recover loop | R0 | Dynamic/stale/ambiguous target fixtures |
| R14 | `[ ]` | Attached-browser consent adapter and handoff lane | R13 | Revocation, ownership, profile-isolation tests |
| R15 | `[ ]` | Provider Recovery Receipt and resumable checkpoint UI/API | R1 | 502/429/offline/auth/context/side-effect scenarios |
| R16 | `[ ]` | Human Review Workbench core projection | R1, R5, R7 | Requirement-to-evidence lineage fixtures |
| R17 | `[ ]` | Desktop Workbench and catalog-backed setup controls | R3, R16 | Source-app browser QA and large-run performance |
| R18 | `[ ]` | CLI Workbench, catalog, Steer, assurance, and recovery parity | R2, R3, R15, R16 | PTY golden flows on macOS/Windows/Linux shells |
| R19 | `[ ]` | Consolidate canonical contributor instructions and templates | R2, R3 | Cross-model workflow evaluations; pointer-file checks |
| R20 | `[ ]` | Remove diff-only fallback as default after coverage telemetry proves readiness | R9, R10 | Adoption, latency, cost, failure, and unsupported-language thresholds |

### Rollout gates

1. R4 is a spike. Parser choice becomes accepted only after install size,
   language coverage, incremental latency, and cross-platform packaging meet a
   separately recorded threshold.
2. The existing diff reviewer remains available behind a degraded-mode flag
   until R9/R10 prove stable.
3. Deep review and pentest are manual/opt-in until quotas and authorization UX
   are proven.
4. Attached-browser control is off by default.
5. Contributor instruction changes ship last, after the runtime contracts they
   describe exist.

## Acceptance criteria

This ADR is implemented only when:

1. A PR changing a helper can show unchanged callers, relevant tests, and
   configuration in the review context.
2. A cross-file source-to-sink fixture is found by security review with an
   evidence path and exact locations.
3. Unsupported languages and failed analyzers produce partial coverage and
   prevent clean approval.
4. A repeated webhook does not duplicate a run, and a newer head supersedes the
   old run without publishing stale results.
5. Deep repository review is distinct from PR review and reports its full
   campaign scope and limitations.
6. Pentest cannot start without persisted authorization and cannot reach a
   target outside the scoped proxy policy.
7. Every blocking finding has a verifier disposition and stable lifecycle.
8. Atlas, CLI, Desktop, and review workflows query the same parser-backed index.
9. Incremental edits update affected symbols without rebuilding an unchanged
   repository, and stale results are labeled.
10. Engineering, Research, Data Science, Study, Writing, and Custom receive
    their selected planning schema and tool defaults.
11. Onboarding exposes catalog-backed checkboxes for capabilities, workflow
    skills, and tools with effective-authority explanations.
12. A material Steer creates a Work Contract/plan revision before related
    mutation; a clarification does not create noise.
13. Extension evidence cannot change a goal, plan authority, or permission.
14. Parent-to-child steering cannot widen the delegated packet.
15. A browser click is preceded by an observation/target receipt and followed by
    an expected-state verification.
16. Human navigation is not stolen by agent-created tabs or panel changes.
17. An incompatible site can be attached or handed off without copying cookies
    or claiming challenge bypass.
18. An exhausted `502 upstream_unavailable` displays retry/fallback history and
    a safe resume choice.
19. Retrying after a possibly completed side-effect reconciles the action rather
    than duplicating it.
20. The Workbench lets a reviewer travel from outcome → criterion → task →
    change → evidence → finding → decision.
21. Desktop and CLI show the same domain states and dispositions.
22. Automated review cannot enter an unbounded review→fix→push→review loop.
23. Global contributor instructions do not duplicate profile workflow skills or
    force redundant verification/delegation.
24. Every rollout item ships in a small PR with focused local verification and
    hosted CI as the broad integration gate.

## Accepted rollout defaults

1. The `security-auditor` persona ships with R10, when its capability, skills,
   assurance stages, and evidence contract exist.
2. Deep repository review is manual in the first release. Configurable scheduled
   runs follow only after cost, latency, supersession, and coverage telemetry are
   proven.
3. Python and Go follow TypeScript/JavaScript in the parser rollout.
4. Attached external-browser control remains in `0.4.17` scope, off by default
   behind explicit consent and policy.
5. GitHub code and security review are organization-selectable. Migration
   preserves each repository's current enabled lenses; new installations offer
   both without silently forcing either.
6. Exact checkouts are deleted when a run becomes terminal. Indexes use a
   configurable 30-day inactive default. Action receipts and assurance evidence
   use a configurable 90-day default; finding lifecycle records and their stable
   fingerprints remain durable while their large raw artifacts may expire.
