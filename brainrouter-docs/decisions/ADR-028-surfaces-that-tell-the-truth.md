# ADR-028 — Surfaces that tell the truth about their own state

**Status:** PROPOSED — planning only. No implementation until approved. · **Target:** `release/0.4.20`
**Supersedes:** ADR-027 D13 (stacked PRs), which shipped partial and in one respect incorrect.
**Builds on:** ADR-027 D1 (debt ledgers, oversight evidence), D2 (execution engines), D6 (control
layer), D11 (retention), D12 (idempotency, fencing, database clock).

**Date:** 2026-08-04

---

## 0. The one idea

Four subsystems sit in this release. They are one ADR because they are **one defect class**.

> **Every part of this release is a surface claiming a state it has not established.**

| Surface | What it claims | What is true |
|---|---|---|
| `stack.addlayer` | "I created a stack layer" | It created an ordinary pull request |
| A sent steer | "Delivered" | Nothing knows whether the model received it |
| Artifacts panel | "These are this session's artifacts" | They are the previous session's |
| `cli.executionEngine` | "Selects loop or graph" | Nothing reads it; the loop always runs |
| A planner (proposed) | "Here is your day" | Three sources would be hours stale, unmarked |

The fix in each case has the same shape, and it is not *be more careful*:

> **Report what is known. Name what is not. Never let a comfortable default stand in for a fact.**

That is ADR-027 D4.1's `unknown` ≠ `unsupported`, generalised into a design rule.

---

## 1. What is broken today

### 1.1 Stacked PRs — shipped on a guess

ADR-027 D13 was written the day GitHub's public preview was announced, researched from a changelog
and an overview page, and implemented **before the CLI reference was read**. The model, the tests,
and the review-comment integration are sound and reusable. The part that touches GitHub is not.

**`stack.addlayer` does not create a stack.** It calls `gh api repos/{repo}/pulls` with `base` set to
the branch below. That opens a pull request which *targets* the right branch and is **not registered
as a stack** — no stack object, no bottom-up merge, no auto-retarget. It returns `created: true` and
a URL, so you believe you have a stack you do not have.

That is exactly what the function's own comment warns against:

> *"`gh` would happily open an ordinary pull request, which is NOT what was asked for, and silently
> doing something adjacent to the request is how an agent action becomes untrustworthy."*

**Ten semantic exit codes collapse into one string.** `gh stack` distinguishes *not in a stack* (2),
*rebase conflict* (3), *API failure* (4), *disambiguation required* (6), *rebase in progress* (7),
*stack locked* (8), *feature disabled* (9), and *recovery needed* (10). We report all of them as
"no stack, here is a message". Code 10 is one where continuing can destroy work.

**The whole local half is unreachable.** `init / add / modify / unstack / view / checkout / switch /
up / down / top / bottom / trunk / sync / rebase / push / submit` — none of it. We can read a stack
somebody else made. We cannot create, navigate, restack or sync one.

**Merging is impossible.** The docs are explicit: merging a stacked PR requires the Stacks API; the
legacy merge endpoints cannot do it. Our model computes exactly what should merge and nothing can
act on it.

### 1.2 Message receipts — no way to know a steer landed

`InputQueue` and `publishExternalSteering` deliver in `queue` and `steer` modes. Nothing reports what
happened. Send a correction mid-turn and three outcomes are indistinguishable: it landed and changed
course, it landed and was ignored, or it never arrived. Assume it landed → you continue from a false
premise. Assume it did not → you repeat yourself, which can double-apply an instruction that did.

### 1.3 Artifacts panel — shows another session's work

Switching sessions leaves the panel showing the previous session's artifacts until it is closed and
reopened. A missing re-fetch on session change.

It matters more than ordinary staleness because artifacts are **session-scoped by design**
(`recall.applyFilters` drops rows whose `session_key` does not match). The panel is not showing an
out-of-date list — it is showing *another session's* work while claiming to show yours.

### 1.4 Execution engine — a setting that does nothing

`cli.executionEngine` appears in exactly two places: the type declaration and the resolver.
**`runTurn` never reads it.** The graph executor, its typed state, checkpoints and compensation
ordering all exist and are tested, and nothing routes a turn into them. Setting `"graph"` changes
nothing.

ADR-027 D2 claimed "both engines ship and a setting selects". It shipped both engines, a setting,
and no wire between them.

### 1.5 No planner — work has no single home

Work arrives from Track, GitHub issues and PRs, review findings, meeting actions, connectors, and
your own head. There is no place that answers *"what am I doing today?"*, so the answer is assembled
each morning — which is knowledge debt by definition. Nothing exists: no offline queue, no logical
clock, no sync primitive anywhere in the codebase.

### 1.6 The systemic finding

Five of the above are **the same failure**: something declared, tested, and never invoked.

| # | Thing | Failure |
|---|---|---|
| 1 | Stack model | Never exported — unreachable |
| 2 | `stack.*` actions | Declarations with no host |
| 3 | `stack.addlayer` | Calls an endpoint that does not do what its name says |
| 4 | `cli.executionEngine` | Resolves a value nobody reads |
| 5 | `cli.buildLoopEmitPr` | Same |

**Every one passed its tests.** Tests prove a unit behaves; they say nothing about whether anything
invokes it. That is the root cause, and D21 addresses it as a class rather than five bugs.

---

## 2. Decisions

### Part A — Stacked pull requests

#### A1 · `gh stack` is the execution surface; REST is read-only

All mutation goes through the `gh stack` extension. We do not reimplement cascading rebase, restack
ordering or stack-aware merge — GitHub maintains those and ours would be a worse copy.

REST (`GET /repos/{owner}/{repo}/stacks`) stays for **reading** in the brain, which runs server-side
where a `gh` extension may not exist. The brain never mutates a stack.

**Capability is detected, not assumed.** `gh stack` needs `gh` 2.90+, git 2.20+, and an explicit
`gh extension install github/gh-stack`. Detection is cached per workspace, and where the extension is
absent stack actions are **hidden rather than offered-and-failing** — an action that always errors is
worse than one not offered, because the agent retries it.

#### A2 · Remove the create path before replacing it

`stack.addlayer` is rewritten onto `gh stack add` + `gh stack submit`, or `gh stack link` where the
branches and PRs already exist.

**Until that lands the action is removed.** A tool reporting success for work it did not do is worse
than a missing tool, because the human stops checking. There is no deprecation window for a wrong
answer.

#### A3 · Exit codes are the contract

Every invocation maps its exit code to a typed outcome naming what to do next. Three must never be
collapsed:

- **9 feature disabled** — stop offering stack actions here and say why. Retrying looks like our bug.
- **3 / 7 conflict or rebase in progress** — the working tree holds a half-finished operation. Do
  not start a second stack command on top; surface and stop.
- **10 recovery needed** — refuse all further mutation, require explicit human action. This is where
  guessing destroys work.

#### A4 · Sync and rebase run on instruction, never on inference *(owner-decided)*

`sync` and `rebase` cascade across every layer, and resolving a conflict rewrites branches that
already carry review comments. The agent may run them **when told to**; it may never decide a stack
looks stale and fix it.

Because it is allowed at all, two guards:

- **Every run previews the layers whose history will be rewritten** — the actual list, not a dialog
  to click past. Consent to "sync the stack" is not consent to rewrite six branches you forgot were
  in it.
- **A conflict stops everything.** Codes 3 and 7 halt further stack operations.

`--committer-date-is-author-date` keeps review timestamps meaningful.

#### A5 · Merge is all-or-nothing, and names every PR that lands

`stack.merge` takes a top layer and merges it plus everything beneath, matching `gh stack merge`. It
is **destructive** in the control layer, requiring the action-specific confirmation token.

**The confirmation states every PR number that will land.** "Merge #12" that silently lands #9, #10
and #11 has not obtained consent for what happens.

**A 90-second merge is `pending`, never `failed`.** Stack merges take 90+ seconds through GitHub's
API; a short timeout produces a spurious failure on an action that is succeeding, and a retry against
a partially-applied merge is the worst possible response.

**Stale layers after a mid-stack merge are detected and reported**, not silently left.

#### A6 · Wait for GitHub's native merge queue *(owner-decided)*

No third-party queue integration. The timeout and staleness work above ships regardless, because both
are properties of the stack merge itself rather than of any queue in front of it.

#### A7 · Stacks are the native output shape of agent work

GitHub's framing, and the most important decision here:

> *"An agent completes one task, then starts the next task that builds on it. That sequence maps
> directly onto a stack: one pull request per task, each based on the one below."*

**We already have this structure.** `planPhases.ts` produces ordered phases with ids, declared order
and a `current` pointer, and the agent commits to that plan before writing code. A plan of five
executable phases *is* a five-layer stack. The dependency information a stack needs is information
the agent already produces and currently throws away.

> **One plan phase → one layer → one pull request, authored as the work happens.**

Post-hoc splitting remains the fallback for unplanned work, and is strictly worse: seams must be
*inferred* from a finished diff rather than *recorded* as it is written, and inferred seams are
guesses about intent.

**Five guards, because this fails badly without them:**

1. **Depth capped (~5).** A fifteen-layer stack is *less* reviewable than one large PR, with fifteen
   CI runs attached. Past the cap the agent asks whether the rest belongs in a follow-on stack.
2. **Never stack on a broken base.** If layer *N* fails its checks, *N+1* is not created — enforced
   at authoring time, not discovered at merge time.
3. **Every layer stands alone.** Independently reviewable and revertible. Phases that only make sense
   together are folded (`gh stack modify`) *before* the human sees them.
4. **Rebase cost grows with depth** — a second, independent reason for the cap.
5. **Each layer's body states its dependency in prose.** "Layer 3 of 5" is navigation; *"this needs
   the schema from #41 before the API can read it"* is what makes it reviewable alone.

**Auto-propose** *(owner-decided)* covers unplanned work: fires only when `adviseStacking` returns
`shouldStack: true` (over the band **and** separable), **once per change**, suppressed after a
decline, never for an indivisible change. Per ADR-027 §1, notification acceptance falls ~30% per
notification — a proposal that fires often is dismissed reflexively and worth nothing when it matters.

**`cli.buildLoopEmitPr`, when wired, emits into the current stack**, not a competing branch.

#### A8 · Desktop surface follows the model

Stack panel showing the chain, per-layer readiness, the named blocker, and the highest mergeable
layer. Read-only first; mutation controls only for operations already reachable with their
confirmations.

---

### Part B — Truthful surfaces

#### B1 · Message receipts, without claiming what we cannot prove

**The constraint that shapes everything: "read" is not observable for a model.** We can prove a
message entered the turn's context. We cannot prove the model attended to it — attention is not
instrumentable from outside, and a token in a prompt is not evidence it influenced output.

A `✓✓ Read` badge would be a claim we cannot substantiate, and a false receipt is worse than none
because it is precisely what stops you repeating yourself.

| State | Meaning | How we know |
|---|---|---|
| `queued` | Accepted, not yet in a turn | Ours — the queue holds it |
| `delivered` | Entered a model's context | Ours — we built that context |
| `acknowledged` | Demonstrably consumed | **Evidence required** |
| `dropped` | Never reached a model, never will | Ours — turn ended, error, closed |

`acknowledged` is set on evidence — an explicit ack, a plan revision citing it, or a
`reconcile_steer` call carrying its id — **never on mere presence in the window**. Absent evidence
the UI says *delivered*.

**`dropped` is loud.** A steer arriving after the turn ends is the most harmful case, precisely
because you have every reason to believe it landed. It surfaces with a resend, never silently
discarded.

#### B2 · Artifacts panel: current session, and optionally more

**Fix:** re-fetch on session change. No close-and-reopen.

**Improve:** the session filter becomes **multi-select, defaulting to the current session**. Opening
to everything you have ever produced is a search problem you did not ask for — start scoped, widen
deliberately.

**With more than one session selected, each artifact shows which session produced it.** An
aggregated list without provenance reintroduces the same misattribution the bug causes today, only
on purpose.

---

### Part C — Execution engine

#### C1 · Wire the setting, or delete it

Four requirements:

1. **Wire it.** `runTurn` dispatches on the resolved knob.
2. **Parity.** The graph path needs the same interrupts, tool authorization and receipts the loop
   has, or "selectable" means "selectable if you do not mind losing features".
3. **Surface it** in desktop settings under agent runtime, per workspace, described by *what each
   engine is good at* — the bare words *loop* and *graph* mean nothing to anyone who has not read
   ADR-027 D2.
4. **Show which is running**, in the session, where work happens. A setting whose effect is invisible
   is one nobody trusts they changed.

**Parity is asserted by a test matrix**, not assumed — the same scenarios through both engines,
failing when one supports something the other does not. Without it, "both ship" decays into "one
ships and one exists".

**The rejected alternative:** delete the knob and ship only the loop. Honest and cheaper. Rejected
because the graph's value for interrupted, resumable work is real — but it is currently zero and
would stay zero.

---

### Part D — Unified planner

#### D1 · Mirrored items versus owned items — the split everything rests on

**Mirrored items** project something whose truth lives elsewhere: a GitHub issue, a Track item, a
review finding. **We never merge these; we re-read them.** If an issue changed while you were
offline there is no conflict — the issue is what GitHub says it is. Local state is a cache with a
fetch time.

**Owned items** are created in the planner: a todo, a time block, a note. These are the only things
that can genuinely conflict.

A planner aggregating ten sources therefore has a conflict surface of **one**. Most of the apparent
difficulty of "sync everything across devices" dissolves once mirrored data stops pretending to be
editable local state.

Local edits to a mirrored item are limited to *planner metadata* — schedule it, block it, order it,
snooze it. Changing an issue's title is an action against GitHub, queued as an outbound operation,
failing visibly.

#### D2 · Local-first with an outbox; the network is never on the critical path

Every mutation writes locally and returns immediately, and appends to a durable **outbox**.

- **Idempotency keys** (ADR-027 D12) so a redelivery does not double-apply.
- **Ordered per item** — reordering two edits to one todo produces a state neither device had.
- **Bounded with age-based shedding.** A device offline three months refreshes from the server
  instead of replaying a thousand stale operations, and is *told* that happened.

Offline is not a degraded mode with a banner. It is the normal mode that happens to be syncing.

#### D3 · Hybrid logical clocks, because device wall clocks lie

Ordering by `Date.now()` is the mistake this exists to prevent: a device five minutes fast wins every
conflict it participates in, silently and permanently.

Every mutation carries `(physical, logical, deviceId)`, advancing monotonically, absorbing the
highest clock seen from any peer, tie-broken on device. ADR-027 D12 moved lease expiry to the
database clock for the same reason; this extends it to where that clock is unreachable.

#### D4 · Field-level last-writer-wins, except where it loses work

Each field resolves independently by HLC — two devices setting `dueDate` and `priority` both win.

**Where LWW is wrong we do not use it:**

- **Concurrent free-text edits** — marked *conflicted*, both kept, human picks. A planner is not
  important enough to lose a paragraph over, and exactly important enough that quietly losing one
  destroys trust in all of it.
- **Delete versus edit** — deletion is a tombstone with its own stamp; a later edit **resurrects as
  conflicted** rather than losing the edit or silently undeleting.
- **Completion** — complete wins at equal clocks. Un-completing something you finished is more
  annoying than the reverse; the asymmetry is deliberate.

**Not CRDTs**, consistent with ADR-027. Narrower reason: CRDT text merge produces a document neither
person wrote, which is worse than a conflict marker because it looks like agreement.

#### D5 · The timetable is honest about estimates

Planned blocks against **actual** time, because the gap is the useful information.

- Blocks may be **unscheduled** (a today list) or **scheduled**. Forcing everything onto a clock is
  how planners get abandoned.
- **Carry-over is normal, not failure** — recorded, not scolded.
- **Drift as a ratio, not a scoreboard.** "Tasks here take 1.8× their estimate" teaches; a red
  overdue count is ADR-027 §1's notification failure in planner form.

#### D6 · The agent is context-aware, and can operate it

A planner the agent cannot see is a second place your intentions live.

**Context is bounded and summarised, never the whole list** — injecting everything spends context
belonging to the actual task, and per §1's attention evidence, fifty low-signal lines make the model
worse at the five that matter. What goes in: today's committed items (rest as a count), current or
next block, anything carried over more than twice, and **per-source freshness**.

| Action | Effect |
|---|---|
| `planner.today` · `planner.timetable` · `planner.find` | `read` |
| `planner.add` · `schedule` · `complete` · `reschedule` | `mutate` |
| `planner.delete` | `destructive` |

**`planner.complete` is never inferred.** Marking a todo done because its linked PR merged is
sometimes right and often wrong — the todo was usually broader. Guessing converts the planner from a
record of what you decided into a record of what the tooling assumed, the same substitution B1
refuses for receipts.

**Completed items and drift feed ADR-027 D1's ledgers** — consistent overruns are technical-debt
evidence, repeated carry-over is usually something nobody knows how to start.

**Knowing you are behind does not license mentioning it.** Raised when relevant, otherwise quiet. An
agent opening each turn with your overdue count is notification fatigue in a planner costume.

#### D7 · Sources are adapters behind one interface

List candidates, map to a planner item, report freshness. First set: Track, GitHub issues, GitHub
PRs, review findings, meeting actions, manual entry.

**A stale source says so.** If GitHub has been unreachable six hours, the view says the GitHub items
are six hours old rather than presenting them as current.

#### D8 · Retention follows ADR-027 D11

Completed items keep detail 90 days, then compact. The planner is a working surface, not an archive.

---

### Part E — The systemic fix

#### E1 · Sweep for values nobody reads

Five instances of one shape in one release (§1.6). Fixing them as they surface is how the sixth
ships. So:

- **Enumerate every `cli.*` knob and assert a consumer exists.** Mechanical enough to be a test
  rather than a review habit.
- **Same for exported `packages/core` modules with no importer outside their own tests.** Some are
  legitimately public SDK API, so the output is a reviewed list, not an automatic failure.
- **Record the count** as a baseline; a rise is a signal.

> **A module or setting is not done until something calls it, and the test proving the caller exists
> is a different test from the one proving the unit works.**

---

## 3. Out of scope

- Reimplementing cascading rebase — GitHub maintains it.
- Cross-fork stacks — unsupported by the platform.
- Auto-merging a stack without confirmation, however green.
- A local stack database — `gh stack` owns local tracking; a second store drifts.
- A "read" receipt based on context inclusion.
- Calendar read/write, shared planners, CRDTs, real-time collaborative editing, natural-language
  recurrence.

---

## 4. Phases and timetable

The full phase list and the twelve-week timetable live in
[`brainrouter-roadmap/0.4.20.md`](../../brainrouter-roadmap/0.4.20.md) — one copy, because two
diverge and then nobody knows which is current.

| Weeks | Focus |
|---|---|
| 1–3 | **Repairs** — remove the lying action, exit codes, create path, navigation, merge, receipts, artifacts panel |
| 4 | **Execution engine** — wire, parity matrix, settings surface |
| 5–6 | HLC, schema, local store, outbox |
| **7–8** | **Sync and the conflicts that must not auto-merge** ← highest risk |
| 9–11 | Adapters, planner, timetable, agent wiring, surfaces |
| 12 | **Multi-device soak** |

---

## 5. Consequences

**Removing `stack.addlayer` before replacing it is a visible regression.** The right one — it
currently lies about what it did.

**We depend on a preview feature and an optional CLI extension.** Capability detection and the
fail-hidden posture keep that from degrading the product for anyone without them.

**Rebase stays manual, which some will find slow.** Deliberate: the alternative is an agent rewriting
history of branches under review.

**Wiring the engine may expose that the graph path is not at parity.** If that is more than a week,
the honest response is to say so and reconsider whether the knob should exist — not to ship a
`graph` option that silently loses features.

**The planner adds persistence and sync we have never had.** Sync bugs are found by use, not unit
tests, and found late they cost someone's data. Hence weeks 7–8 and the week-12 soak.

**Twelve single-track weeks** beats running repairs and greenfield in parallel and getting two
half-verified subsystems. The repairs correct behaviour that currently lies to the user; they should
not share attention.

**This ADR is large.** Twenty-one decisions across four subsystems, justified by §0 — one defect
class, not four features. If that framing stops holding during implementation, splitting is the right
response rather than defending the structure.

---

## 6. Owner decisions

**Resolved:**

| Question | Answer |
|---|---|
| Agent may run `gh stack sync`? | **Yes, on explicit instruction** — never on inference (A4) |
| Auto-propose stacks? | **Yes**, gated to `shouldStack:true`, once per change (A7) |
| Merge queue? | **Wait for GitHub's native queue** (A6) |

**Open — planner.** None blocks starting; all affect week 5 onward.

1. **Which sources matter most?** The order assumes Track → GitHub issues → GitHub PRs. If meeting
   actions or review findings matter more to your day, the order changes.
2. **May the agent propose a day plan unprompted?** D6 says it may propose; whether *unprompted* is
   the open part. Same tension as A7.
3. **How long may an offline device diverge** before its outbox is shed? Proposal is D8's 90 days;
   30 would bound conflict complexity at the cost of a rarely-used device losing offline edits.

**Deferred to implementation:** whether auto-propose should also require a minimum file count; whether
declining suppresses for the session or the change; the exact depth cap (~5 proposed — the right
number is where a reviewer stops holding the chain in their head, worth measuring).
