# ADR-027 — Compounding Debt, Graph Execution, and Workbench Modernization

**Status:** PROPOSED — awaiting owner approval. No implementation may begin until this ADR is
approved. · **Target:** `release/0.4.19` ·
**Builds on:** ADR-020 (memory self-improvement), ADR-021 (typed workspace profiles),
ADR-022/023 (persona, orchestration, context contracts), ADR-024/025 (work contracts,
repository assurance, runtime boundaries), ADR-026 (desktop visual system) ·
**Supersedes nothing.** It refines the review, orchestration, and onboarding decisions those
ADRs accepted.

## Date

2026-08-01

---

## 1. Context — the real problem is compounding debt, not missing features

BrainRouter can already plan, execute, review, remember, and ship. The failures that now matter
are not "the agent cannot do X". They are **three debts that compound silently**, and a set of
concrete defects that each turn out to be an instance of one of them.

- **Knowledge debt** — what was learned or decided is lost. Context is rebuilt from scratch,
  research is re-run, and the same question is answered differently twice.
- **Technical debt** — agent-written code accumulates faster than anyone can vouch for it.
- **Cognitive debt** — the *human* loses understanding of their own system. They can no longer
  review, reason about, debug, or defend it. This is the one the owner cares most about, and it
  is the one the industry is least honest about.

The evidence on the third is uncomfortable and we should design against it rather than around it:

- **Consistency, not unreliability, produces complacency.** In the canonical multi-task study,
  operators of *consistently reliable* automation detected failures far worse than operators of
  variable-reliability automation. A highly consistent agent produces *worse* human oversight than
  an erratic one, holding accuracy fixed. Reliability is not a safety property of the
  human+machine system.
- **Full automation destroys situation awareness; intermediate levels preserve it.** The
  out-of-the-loop decrement is significantly greater under full automation. The mechanism is the
  shift from *active* to *passive* processing — the human still sees the diff, but loses the model
  of why it is what it is.
- **Self-assessed oversight quality is uncorrelated with, or negatively correlated with, actual
  oversight quality.** In a large incentivized study, participants' confidence was *negatively*
  associated with performance, and their judgments of the algorithm's accuracy had no association
  with its real accuracy. A controlled study of agent reasoning-trace interfaces reproduced this:
  a better trace view reduced error-finding *time* and raised *confidence* while accuracy gains
  were minimal.
- **Acceptance of a notification falls monotonically with notification count** — roughly a 30%
  drop in acceptance per additional reminder in the same session. Every notification system ever
  measured (clinical alerts, security operations, static analysis, dependency bots, browser
  warnings) converges on 40–96% dismissal.
- **Explanations and transparency can make oversight worse.** Explanations increase trust in
  *incorrect* recommendations, and work even when they have no basis in the model's actual
  behavior.
- **Review of agent-authored code is changing in character.** Across large 2026 datasets:
  PRs merged with no review are up sharply, time-in-review is up several-fold, PR size and files
  per PR are up, and human comments on agent-authored PRs are markedly less substantive than on
  human-authored ones (a quarter are mere agent-steering commands). Reviewers also express *more
  neutral-to-positive* sentiment toward agent contributions than human ones despite those
  contributions carrying measurably more redundancy — vigilance is lowest exactly where scrutiny
  is most warranted.

Two honesty notes we will not paper over. First, most of the mechanistic evidence comes from
aviation, medicine, and driving, not software; the transfer argument is strong but it is an
argument, not a measurement — and it should be discounted somewhat because a developer reviewing
a diff usually has unlimited time and a revert, unlike a pilot. Second, the failure mode is
**bimodal**: people over-trust until a visible failure, then abandon the tool entirely even when
it still outperforms them. Any claim that "the user will calibrate over time" is unsupported.

**The design consequence that follows, and that governs this entire ADR:** we will *not* attack
cognitive debt by adding approval dialogs, explanation panels, or "here is what you have not
reviewed" notification lists. The evidence says those degrade into theater. We will attack it by
**keeping the human in active decision-making at an intermediate level of automation**, by
**varying presentation to resist habituation**, by **calibrating gates to blast radius and
reversibility** rather than to event count, and by **measuring comprehension rather than
velocity**.

### 1.1 The concrete defects, and which debt each one is

| Reported symptom | Root cause (verified) | Debt |
|---|---|---|
| `delegate_explorer paused until required workflow skill(s) are loaded: adr-skill` | The stage/preflight resolver reads workspace-managed skills, then the brain over MCP — the **bundled on-disk skills are invisible to it**. A packaged desktop build ships no skills at all. | Knowledge |
| Agent cannot read uploaded PDFs/images | A complete attachment subsystem exists (detection, PDF extraction, ingest, store) and is consumed by the desktop host, CLI and brain — but **there is no agent tool**. | Knowledge |
| Worktrees open a new window and become projects | Agent *execution root* and window *workspace* are the same concept; opening a worktree swaps the window and adds a recent. | Cognitive |
| Parallel agent candidates do not work | Candidate UI exists; production path unverified. | Technical |
| Sessions are unnamed; nothing is ever cleaned up | No auto-titling (only a hook output); no inactivity sweep; deleting a session or workspace reclaims nothing. | Knowledge |
| Research means re-fetching the same pages | Browser reads are transient; nothing durable and citable is produced. | Knowledge |
| Database growth and performance degradation | Append-forever tables with no partitioning and incomplete retention. | Technical |

---

## 2. Decisions

### D1 — A debt program with named, measurable mechanisms (the centerpiece)

We adopt **three debt ledgers** as first-class product concepts, each with mechanisms that follow
the evidence above rather than contradicting it.

**Knowledge debt.** Every durable output of agent work becomes a **referenced artifact** rather
than transient chat: research produces a cited document, a decision produces a record, a web read
produces a stored page. Recall is preferred over re-derivation, and the agent must cite what it
used. This extends the ADR-020 self-improvement loop rather than replacing it.

**Technical debt.** Every change carries a **verification receipt** — what was run, what passed,
what was not covered. Unverified surface is tracked as a debt balance rather than surfaced as an
alert list (per the notification evidence). The two review gates in D9 are the enforcement points.

**Cognitive debt.** This is the novel work:
- **Intermediate automation by default.** For consequential work the agent proposes and the human
  decides at a *decision* granularity — not an action granularity. Batch into coherent units of
  work; target roughly ten decisions per session, not a hundred.
- **Blast-radius-and-reversibility gating.** Gate on *irreversibility*, not on event type. A
  reversible edit needs no prompt; an irreversible or outward-facing action always does. This
  directly addresses the finding that a permission model gated on shell commands does not see
  equivalent state changes made through the editor.
- **Polymorphic high-stakes prompts.** Confirmation surfaces for irreversible actions must vary in
  presentation. Identical dialogs are optimized for habituation; varied ones measurably resist it.
- **Comprehension over velocity.** We measure whether the human can still explain their system —
  e.g. proportion of merged change the human has actually read, recency of last human-authored
  change in a subsystem, and answer-without-lookup checks — and we report these as a *balance*,
  never as a nag.
- **Teaching mode.** An explicit mode where the agent explains and the human implements, for
  subsystems the human owns but has stopped touching.

We explicitly reject: a "what you have not reviewed" notification feed; per-action approval
dialogs as the primary control surface; and explanation panels presented as an oversight
guarantee. Each is contradicted by the evidence in §1.

### D2 — Replace the turn loop with a graph execution engine

Today a turn is a loop with bolted-on phases. We move to an explicit **directed graph with typed
state**: nodes are units of work, edges carry conditional routing, and state is a typed value
threaded through. This gives durable resume, human-in-the-loop interrupts at real boundaries,
parallel fan-out/fan-in, and per-node retry.

Constraints learned from the field, which we adopt as rules: **checkpoint boundaries must be tool
boundaries** — never mid-stream, and never after dispatching a side-effecting call but before
recording its result; on resume, later nodes may re-execute, so every side-effecting node must
carry an idempotency key; and **not everything is compensable**, so the graph must order
non-compensable steps as late as possible and require confirmation before crossing that pivot.

We do **not** adopt an external durable-execution engine yet. By the standard crossover criteria
(cross-service compensation, execution-history queries at scale, worker concurrency in the
hundreds) we are below the line. A checkpointed graph over our existing queue gets most of the
value.

### D3 — Skills: fix resolution, then bundle a curated library

**The fix (blocking everything else).** The stage/preflight resolver gains the **bundled on-disk
catalog as a first-choice source**, so built-in workflows resolve offline; the desktop build ships
`skills/`; and an unresolvable required skill degrades to a **warning, not a denial** — a missing
workflow must never be able to deadlock the agent.

**Loader gaps to close first**, all small and all verified: `## Workflow` has no preamble fallback
(unlike `## Overview`), so a prose-first skill serves nothing — most candidate skills are
prose-first; the phase regex only matches H3, while good skills write phases at H2;
`disable-model-invocation` is silently dropped by both parsers, which would flip deliberately
human-only skills into model-invocable and push their descriptions into every turn's catalog.

**The library.** We adopt a small curated set — bug diagnosis (with its hard gate: no theory
before a reproducing command exists), test discipline, clarification, merge-conflict resolution,
interface design, primary-source research, and skill authoring — re-authored as our own, each
stamped as human-authored. Collisions with what we already ship are resolved by **merging into the
incumbent**, never by adding a shadowing twin.

### D4 — Attachments and profile-aware document understanding

**Storage and control.** Content-addressed blobs with **hashing for dedup** (the same file
attached twice stores once), an explicit record schema, **cached extraction** (extract once, reuse
forever), per-workspace **quotas and retention**, and **cascade delete** so removing a session or
workspace reclaims its bytes.

**Agent access.** A first-class builtin extension exposing list/read/search over session and
workspace attachments, with images passed as proper multimodal content parts rather than
stringified text.

**One shared substrate, many profile derivations.** A document is parsed, structured, and indexed
**once**; each profile derives its own view on top. Research derives claims with evidence and a
citation graph; study derives a concept map, progressive explanations, and practice questions;
engineering derives specs and API contracts; data-science derives tables as structured data;
writing derives quotable passages with provenance. We do not re-extract per profile.

Design choices taken from studying mature systems: **classify each page** and route text pages
through layout-aware extraction while sending scanned pages to vision — do not force one path;
keep **structure-aware chunking** with a breadcrumb context header stored *outside* the chunk text
so offsets stay exact; use **hybrid retrieval fused by reciprocal rank**, not a weighted sum; and
make provenance first-class — every retrieved span resolves to a document, a location, and a
verifiable source. Where those systems only record character offsets, we will record **page and
region** for PDFs, because a citation the human cannot visually verify does not discharge
cognitive debt.

### D5 — Desktop: one visual system, and performance by structure

We adopt a single semantic token system (surface/border/text/accent scales with a global radius
scale), a **floating-panel shell** on a distinct app background with platform-conditional
translucency, and a **dense type scale** (13px body). Platform variants drive titlebar drag
regions and vibrancy.

**We must pick one design language.** The reference we studied carries two overlapping systems
simultaneously; copying that would import the inconsistency. **This is an open question for the
owner (§5).**

Performance is structural, not incidental: **fold completed turns** rather than virtualizing the
transcript; opt specific hot components into the compiler rather than memoizing globally;
lazy-load only genuinely heavy editors; keep motion libraries behind a lazy boundary; and prefetch
inventory that would otherwise make a panel mount cold.

### D6 — An agent-callable control layer

Every UI capability is registered as a **named, typed, introspectable action** carrying a
description, argument schema, and an explicit side-effect flag, exposed through one registry the
agent can enumerate and invoke. This is how new workbench features become agent-interactable *by
construction* instead of by bespoke IPC per feature, and it is the mechanism by which the feature
parity in this release becomes usable by the agent rather than only by the mouse.

We additionally adopt a **single typed command map** as the one source of truth for the
renderer↔main boundary, enforced by a typecheck against the handler registry.

### D7 — Decouple execution root from window workspace

A session gains an **execution root** distinct from the window's workspace. The agent can work in
a worktree while the session, chat, and project list stay put — no new window, no new project
entry. Worktrees become a *property of the session*, not a new workspace.

### D8 — Session identity and lifecycle

Sessions are **named by the agent on the first turn** — short, specific, human-meaningful. A
**30-day inactivity sweep** archives dormant sessions, and deleting a session or workspace
**cascades** to transcripts, attachments, artifacts, and browser partitions.

### D9 — Two review gates, with different jobs

**Backend (pull request) — already correct, do not churn.** Security review fires automatically on
PR events; code review is **manual by default** and opt-in per repository. Both lenses exist and
comment triggers work. This ADR changes nothing about that trigger policy.

**Desktop (local, pre-commit) — the new gate.** The human runs it, or asks the agent to, against
**uncommitted changes** before anything is committed. It is the fast, private gate; the PR gate is
the durable, auditable one.

The two gates get **deliberately different engines**, because the two published philosophies are
complementary rather than competing:

- The **local gate is subtractive** — optimized for precision and speed. A high confidence bar,
  deterministic exclusions that are *language-conditional* (memory-safety findings are nonsense in
  a garbage-collected language; path traversal is nonsense in front-end code), and a codified
  precedent list. Findings that fail the bar are dropped.
- The **PR gate is additive and auditable** — optimized for coverage and durability. Evidence is
  required rather than noise being subtracted: a candidate ledger, confidence pinned to the
  *method* that produced it, a mandatory counterevidence pass, suppressions that must close the
  specific row they suppress, **`deferred` as a first-class outcome** for uncertain findings, and
  a stable fingerprint so identity survives across runs. Coverage is reported explicitly — an
  auditor must be able to see *why* something did not become a finding.

The isolation posture for anything that executes untrusted code follows the same layering:
least-privilege permission profile, then container, then syscall filtering.

### D10 — Browser reads become durable, citable artifacts

Instead of scraping pages into the transcript, a page read produces a **stored markdown artifact
with provenance** — title, source URL, and per-section anchors — that the agent references rather
than re-fetching. The agent manages tab lifecycle explicitly (open, read, close) rather than
leaking tabs.

Gaps we must close that the reference implementation has: **tables must survive** the markdown
conversion (the most common defect), relative URLs must be **absolutized** against the page, code
must be fenced, and because our reads are programmatic rather than user-triggered we need an
explicit **readiness wait**. Every research claim must carry a reference — this is the mechanism
that makes that enforceable rather than aspirational.

### D11 — Database growth: a threshold ladder, not sharding

**Sharding is not justified today** and adopting it now would be the expensive mistake. The ladder,
in order, each rung with a trigger:

1. **Retention and compaction first.** Most growth is append-forever data nobody reads after a
   week. Summarize old detail into compact records and drop the raw rows.
2. **Index and query hygiene.** Partial and covering indexes on hot paths; autovacuum tuning.
   Growth rarely degrades you — unindexed sorts and bloat do.
3. **Vector-specific work.** Index type and parameters are the real pressure point; quantization
   materially cuts storage. Our embedding dimension is already DB-driven, so this is reachable
   without a destructive migration.
4. **Declarative partitioning**, by time for event-shaped tables and by tenant for scoped ones.
   Dropping a partition beats deleting millions of rows.
5. **Only then sharding** — and per-tenant databases before a distributed extension.

The load-bearing insight: because every query is already tenant-scoped, **partitioning by tenant
captures most of sharding's benefit at a fraction of the cost** and leaves the door open, since the
shard key would be the same.

One non-obvious hazard to design against: a job queue in the same database as analytics is
degraded not by write volume but by **long-running analytics transactions pinning the cleanup
horizon**, so dead rows accumulate faster than they can be reclaimed.

### D12 — Distributed-systems correctness

A review of our queues, locks, leases, and event delivery found genuine defects. The pattern is
that **our fleet queue and review-projection layer are built to a high standard and the job queue
underneath them is not** — the same product at two levels of rigor. This ADR adopts bringing the
second up to the first.

Accepted as correct and explicitly **not to be churned**: the claim-time serialization on the job
queue; the review projection layer's advisory lock, idempotent ledger, and monotonic
newer-projection guard; the fleet queue's attempt-accounting and reconcile-path backoff; the
schema-migration lock; the feed lease that uses a database-enforced invariant and the database
clock; marker-based idempotent PR postbacks.

To fix, in priority order:

1. **Fence the job lease.** There is no fencing token anywhere in the system. Mutual exclusion is
   established at claim time and never re-verified across the minutes of model work that follow.
   A monotonic token stamped at claim and checked on every write-back turns "I think I still own
   this" into a database-enforced fact. **For a desktop app this is not theoretical — laptop sleep
   is the everyday version of a process pause, and it lasts hours.**
2. **Move time comparisons to the database clock.** Lease expiry, eligibility, projection
   ordering, and presence sweeps currently compare *two different processes' wall clocks*.
3. **Idempotency keys on enqueue**, so a redelivered webhook cannot buy a second full model review.
4. **Retry only idempotent operations.** A timeout classification defect currently causes memory
   writes to be retried; the payloads are byte-identical, so a content hash is the cheapest fix.
5. **Bound the wait queues and shed by age**, since an unbounded queue plus no-timeout patience
   means nothing ever drains.
6. **Do not retry our own rate-limit rejection** — retrying our own admission control amplifies
   load exactly when shedding was the point.
7. **Reachability probe, not a circuit breaker,** for the remote brain: an aggregate-threshold
   breaker converts a partial outage into a total one.
8. **Make the event sequence real or delete it.** It is currently emitted by two counters plus two
   magic values, resets on restart, and no consumer reads it — it advertises a guarantee the
   system does not have.
9. **Optimistic concurrency where two clients can write the same record**, returning a conflict
   with an explicit rebase path rather than silent last-write-wins. We deliberately do **not**
   adopt CRDTs here: convergence is not correctness, and authorization has no home in a merge.

---

## 3. Phases

Ordered so that blockers land first and each phase is independently shippable.

- **P0 — Unblock.** Skill resolution + loader gaps (D3 fix). Restores the agent's ability to work
  at all when the brain is unreachable.
- **P1 — Correctness.** The distributed-systems defects (D12 items 1–4) and the retention half of
  D11. These are bugs, not features.
- **P2 — Attachments.** Storage, dedup, retention, cascade delete, agent tools (D4 first half).
- **P3 — Graph execution.** The engine, checkpointing, interrupts (D2).
- **P4 — Workbench.** Visual system, performance, control layer, feature parity (D5, D6).
- **P5 — Session model.** Execution root, naming, sweep (D7, D8).
- **P6 — Review gates.** Local pre-commit engine; PR gate ledger/fingerprint/coverage (D9).
- **P7 — Research artifacts.** Page→artifact with references, tab lifecycle (D10).
- **P8 — Document understanding.** Profile derivations on the shared substrate (D4 second half).
- **P9 — Debt ledgers.** Measurement and surfaces (D1), last because it depends on the artifacts
  and receipts the earlier phases produce.

---

## 4. Consequences

- The agent stops being able to deadlock itself on a missing workflow, and works offline.
- Attachments stop being invisible to the agent, and stop growing without bound.
- Research becomes durable and citable instead of re-fetched.
- Two review gates with different jobs, neither pretending to be the other.
- A database growth story with explicit thresholds instead of a rewrite.
- Several genuine correctness bugs are closed; several already-correct designs are explicitly
  protected from churn.
- **The cost:** this is a large release touching every surface. The graph engine (D2) and the
  visual system (D5) are the two highest-risk items, and either could be deferred without
  invalidating the rest.
- **The honest risk on the centerpiece:** debt mechanisms can themselves become theater. If the
  comprehension measures turn into a nag, or the gates turn into reflexive clicking, we will have
  added friction and bought nothing. The mitigation is that every mechanism in D1 is designed
  against a specific documented failure mode, and we should be willing to delete any that does not
  demonstrably change behavior.

---

## 5. Open questions for the owner

1. **Which design language?** The reference carries two simultaneously. We must pick one for the
   whole app. (D5)
2. **How aggressive should the local gate be** — advisory only, or able to block a commit?
3. **Is the graph engine (D2) in scope for 0.4.19**, or does it want its own release? It is the
   largest single item here.
4. **Retention defaults** — 30 days for session inactivity is stated; what are the defaults for
   attachments and raw memory rows before compaction?
5. **Does the frontend-builder persona stay inside engineering** (as decided in ADR-021), or does
   the document-understanding work argue for more profiles?
6. **Comprehension measurement is the most speculative part of D1.** Is measuring it worth the
   risk of it feeling like surveillance of the user's own attention?
