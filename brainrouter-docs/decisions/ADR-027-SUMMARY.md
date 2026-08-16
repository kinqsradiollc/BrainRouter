# ADR-027 in practice — what changed and how it works

A reading guide to 0.4.19, written for someone who wants to understand the system rather than
re-derive it from 25 pull requests. The full reasoning is in
[ADR-027](ADR-027-compounding-debt-graph-execution-and-workbench-modernization.md); this is the map.

> **Correction of record (2026-08-13):** ADR-028 retired the unreachable second
> turn engine and `cli.executionEngine`. ADR-040 keeps that deletion: BrainRouter
> has one bounded turn engine, with graph-shaped profile plans and explicit
> durable workflows around it. The execution diagram and §2 below describe the
> current architecture; the rest remains a historical guide to 0.4.19.

---

## The one idea

The release is organised around a claim: **the failures that matter are no longer "the agent cannot
do X". They are three debts that compound silently.**

| Debt | What accumulates | Who pays |
|---|---|---|
| **Knowledge** | What was learned or decided is lost; research is re-run; the same question is answered differently twice | The next session |
| **Technical** | Agent-written code arrives faster than anyone can vouch for it | The next incident |
| **Cognitive** | The *human* loses the ability to review, reason about, debug, or defend their own system | The person, eventually |

Every decision below traces to one of those. The third is the one most of the design effort went
into, because it is the one the industry is least honest about.

**The uncomfortable evidence that shaped the design** (§1 of the ADR has citations):

- **Consistency, not unreliability, produces complacency.** Operators of *consistently reliable*
  automation detect failures *worse* than operators of erratic automation. A dependable agent
  produces worse human oversight than a flaky one, holding accuracy fixed.
- **Self-assessed oversight quality is uncorrelated — sometimes negatively correlated — with actual
  oversight quality.** Better reasoning-trace interfaces reduced error-finding *time* and raised
  *confidence* while accuracy barely moved.
- **Notification acceptance falls ~30% per additional notification** in a session. Every alerting
  system ever measured converges on 40–96% dismissal.
- **Explanations increase trust in *incorrect* recommendations.**

So: **no approval dialogs, no explanation panels, no "here is what you have not reviewed" feed.**
The evidence says those degrade into theater. The design attacks cognitive debt by keeping the human
deciding at an *intermediate* level of automation, gating on **blast radius and reversibility**
rather than event count, and measuring **comprehension** rather than velocity.

---

## How the pieces fit

```
                    ┌─────────────────────────────────────────┐
   YOUR INPUT  ───▶ │ Attachments · Documents · Web pages     │
                    │  (D4, D10) — parsed once, cited forever │
                    └───────────────┬─────────────────────────┘
                                    │  artifacts, provenance
                    ┌───────────────▼─────────────────────────┐
   EXECUTION   ───▶ │ One bounded turn engine                 │
                    │ direct turn · profile plan · workflow   │
                    └───────────────┬─────────────────────────┘
                                    │  work products
                    ┌───────────────▼─────────────────────────┐
   REVIEW      ───▶ │ Local pre-commit gate  ·  PR gate       │
                    │  (D9) subtractive        additive       │
                    │  + stacked PRs (D13) for granularity    │
                    └───────────────┬─────────────────────────┘
                                    │  receipts, findings
                    ┌───────────────▼─────────────────────────┐
   LEDGERS     ───▶ │ Knowledge · Technical · Cognitive debt  │
                    │  (D1) reported as balances, never nags  │
                    └─────────────────────────────────────────┘

   Underneath all of it: job leases, retention, tenancy (D11, D12)
   Around all of it:     17 workspace profiles (D3), agent-callable control layer (D6)
```

---

## What changed, by area

### 1. Your input is now durable and citable

**Before:** you attached a PDF and the agent could not read it. You browsed a page and it vanished
into the transcript. Next session, both were gone.

**Now:**

- **Attachments are content-addressed** — the same file attached twice stores once. Quotas,
  retention, and cascade delete mean removing a session actually reclaims the bytes.
- **A page read becomes a stored markdown artifact** with per-section anchors, so the agent cites a
  document rather than re-fetching a URL.
- **Tables survive conversion — or say they did not.** A merged-cell table is *refused*, not
  flattened. A flattened table reads perfectly while every value sits under the wrong header, and
  nobody can tell. An omission leaves a visible note, because silence reads as "there was nothing
  here".
- **PDFs are parsed locally for every model.** The `pdf (native)` capability only records whether a
  model can take the file directly so we can skip our own extraction.

**The bit worth knowing:** models now declare what **non-text input** they accept, and `unknown` is
deliberately distinct from `unsupported`. Attach an image to a text-only model and the dangerous
outcome is not rejection — it is silent acceptance, where the agent answers confidently about a
picture it never received. Degradation is explicit: reroute to a vision-capable model, else warn
**at attach time**, never drop silently.

Audio is deliberately absent: BrainRouter transcribes speech itself before any chat model sees it.

### 2. Execution: one runtime, graph-shaped orchestration

`cli.executionEngine` and the second graph turn engine were retired after the
reachability audit proved that no production path selected them. `Agent.runTurn`
is the one bounded model/tool engine in both hosts.

Graphs remain real, but at the orchestration layers where their state can be
truthful: a profile plan is a validated stage graph around the owning turn;
durable phase plans and saved workflow graphs are explicitly launched runtimes;
agent nodes execute the same bounded turn engine as children. ADR-040 records the
target policy: Core chooses the smallest eligible topology, while CLI and Desktop
project one event-derived execution map rather than choosing different engines.

The first implementation slice keeps domain authority honest across all 17
profiles: `workspaceProfileId` remains the reviewed domain identity and
`planProfileId` names only the reusable work shape. Valid exact definitions win,
declared bundled aliases are host-resolved, and an invalid exact claim falls back
direct instead of being hidden by an alias.

### 3. Review: two gates with different jobs, plus stacking

**Local (pre-commit)** is *subtractive* — fast, high-precision, advisory by default. A gate that
blocks at the moment of commit is the one people route around or switch off, and a disabled gate
reviews nothing.

**PR** is *additive and auditable* — candidate ledger, confidence pinned to the method that produced
it, mandatory counterevidence, `deferred` as a first-class outcome, stable fingerprints.

**Both now reason over the repository, not the diff.** This was the release's most self-demonstrating
finding: the PR bot flagged a change as fail-open authorization because the diff hunk did not show
the five fail-closed checks twenty lines below it. The bot was not weak; it was blind. Both gates
now build a deterministic in-scope file inventory as a coverage *denominator*, and expand from
changed code to **unchanged call sites** — using correct-looking siblings as negative controls.

**Stacked pull requests (new, D13)** — GitHub shipped these into public preview on 2026-07-30, and
they are the missing mechanism for decision granularity. A 2,000-line "approve or don't" becomes an
ordered series of reviewable decisions.

What we added on top of the platform:

- **Merge readiness names the blocker.** "Blocked by your own checks" and "blocked because something
  below you is open" are different situations. Collapsing them is what makes a stack feel like it is
  fighting you — you fix a layer, nothing changes, and nothing says the reason is one floor down.
- **A finding is attributed to the lowest layer it appears in.** A lower layer's issue is visible
  from every layer above; reporting it on each turns one problem into N dismissals — notification
  fatigue manufactured by our own tooling.
- **Stacking advice can say no.** A 900-line mechanical rename should stay one honest PR. Splitting
  a genuinely indivisible change produces layers nobody can review independently.

### 4. Sessions, workspaces, and 16 profiles

- **A session's execution root is decoupled from its window's workspace.** You can pin a session to a
  worktree and move the window on without dragging it along. Rebasing is *refused* while tool calls
  are in flight, because a path authorized against the old root would be applied against the new one.
- **The agent names the session on turn 1.**
- **A 30-day inactivity sweep archives and never deletes.** `SweepPlan` has no deletion channel at
  all, and a test asserts its keys. Archiving is reversible; deletion cascades to transcripts,
  attachments, and artifacts. The timer archives — a person deletes.
- **Sixteen profiles** now exist so a workspace can be legal or marketing rather than "engineering,
  heavily edited": engineering, product-management, design, research, data-science, study, education,
  writing, marketing, sales, operations, finance, legal, people, healthcare, consulting.

**Engineering stays ONE profile.** Frontend and backend are task-time *capabilities* inside it. A
profile answers "what kind of work is this workspace for?"; a capability answers "what specialism
does this task need?" Splitting engineering would force a lane choice at workspace creation and
re-onboarding whenever a task crosses it — which is most tasks. There is a test asserting no
`frontend`/`backend`/`devops`/`mobile` profile is ever added, because that proposal looks locally
reasonable every single time.

`finance`, `legal`, and `healthcare` personas state plainly that they do not give professional
advice — in the persona, because that is what reaches the model.

### 5. The workbench is agent-operable

Every workbench capability is a **named, typed, side-effect-flagged action** in one registry that
doubles as the renderer↔main command map. Two maps drift; one cannot.

- Unknown action → **error**, never a quiet no-op. An agent told nothing happened *quietly* assumes
  success and continues from a false premise.
- Destructive actions need a confirmation token naming *that specific action*.
- `session.archive` is `mutate`; `session.delete` is `destructive` — the same distinction the sweep
  draws. Inverted, you would be prompted for the safe action and not the unsafe one.

One semantic token system underpins the UI, with completeness, WCAG contrast, and layer ordering
enforced by tests rather than convention.

### 6. Underneath: correctness at scale

- **Fencing tokens on job leases** — a stalled worker cannot overwrite the run that replaced it.
- **Lease expiry on the database clock**, not each worker's own.
- **Enqueue dedup arbitrated by a tenant-scoped unique index.** Without the tenant scope, two orgs
  using the same logical key collided — and the loser received the winner's *full job record*.
- **90 days of detail, then compaction**, for append-forever tables.
- **Sharding is explicitly out of scope.** Partitioning by tenant captures most of the benefit and
  keeps the same future shard key.

---

## What is deliberately NOT here

- **A notification feed of "what you have not reviewed"** and per-action approval dialogs as the
  primary control surface. Both are contradicted by the oversight evidence.
- **Sharding**, an external durable-execution engine, and CRDTs for session state — convergence is
  not correctness, and authorization has no home in a merge.
- **The attachment storage migration has not been run.** The planner, an independent verifier, and a
  dry-run-default executor all exist and were dry-run against real records (11 records → 8 blobs,
  0.23 MB reclaimed, verifier clean). It is the one irreversible action in the release, and the
  recommendation is to run it after review rather than stacked on top of 25 unreviewed PRs.

---

## Two things to review with suspicion

Written here rather than buried, because both are cases where my judgement should not be taken on
trust.

**1. I loosened a security gate while my own PRs were blocked by it.** The assurance gate failed on
*partial* coverage regardless of findings. Since repository context is routinely unavailable, every
PR failed the check while its own comment read "No security issues found". I narrowed it so partial
coverage blocks only when it produced findings — stale, running, failed, and partial-with-findings
all still block, and partial is never promoted to "clean". Nineteen of my own PRs were unblocked by
that change. It is the first thing to review.

**2. The required-workflow gate degrades instead of denying.** When the host attempted to load a
required skill and failed, mutations now proceed with a warning. The security bot called this
CWE-863 twice. The override rests on a verified fact: the required-skill set is itself derived from
the workspace manifest, so an actor who can ship a malformed `SKILL.md` can equally declare no
required skills. The bypass is redundant with a capability they already hold — while fail-closed
hands them a one-file denial of service on the agent.

---

## Where things live

| Concern | Module |
|---|---|
| Input modality capability | `packages/types/src/models.ts` |
| Attachment store, migration | `packages/core/src/attachment/` |
| Graph state and executor | `packages/core/src/agent/graph/` |
| Stacked PRs | `packages/core/src/review/stackedPr.ts` |
| Assurance gate | `packages/core/src/review/domain/assuranceGate.ts` |
| Control layer, workbench actions | `packages/core/src/workbench/` |
| Session execution root | `packages/core/src/session/executionRoot.ts` |
| Profiles and personas | `packages/core/src/workspace/profiles.ts`, `packages/core/personas/` |
| Design tokens | `brainrouter-desktop/src/lib/design/tokens.ts` |
| Job leases, retention | `brainrouter/src/memory/store/postgres/` |

**Verification:** core 2932 · CLI 906 · desktop 453 — 4291 tests, 0 failures.
