# ADR-028 — Surfaces that tell the truth about their own state

**Status:** PROPOSED — planning only, awaiting owner approval. No implementation begins until this
ADR is approved. · **Target:** `release/0.4.20` ·
**Supersedes:** ADR-027 D13, which shipped a partial and in one respect *incorrect* implementation.
**Builds on:** ADR-027 D1 (debt ledgers, notification evidence), D11 (retention), D12 (idempotency,
fencing, database clock).

## 0. The single idea

Four apparently unrelated pieces of work sit in this ADR: stacked pull requests, message receipts,
the artifacts panel, and a unified planner. They are one ADR because they are one defect class.

**Every part of this release is about a surface claiming a state it has not established.**

- `stack.addlayer` reports it created a stack layer. It created an ordinary pull request.
- A steer shows as sent. Nothing knows whether the model received it.
- The artifacts panel shows the previous session's work while claiming to show yours.
- A planner would show ten sources as one list, with no indication that three of them are hours
  stale and one failed to load.

The fix in each case is the same shape, and it is not "be more careful". It is: **report what is
known, name what is not, and refuse to let a comfortable default stand in for a fact.** That is
ADR-027 D4.1's `unknown` ≠ `unsupported` generalised into a design rule.

## Date

2026-08-04

---

## 1. Context — what 0.4.19 shipped, and what is wrong with it

ADR-027 D13 added stacked-PR support in a single sitting on the day GitHub's public preview was
announced. It shipped three things: a stack model with merge-order reasoning, a brain-side adapter
that renders stack context onto review comments, and three agent-callable control actions.

Reading the full `gh stack` reference afterwards showed the work was built on a guess about the
shape of the feature rather than on its actual surface. The defects below are not polish items.

### 1.1 `stack.addlayer` does not create a stack

The shipped implementation calls `gh api repos/{repo}/pulls` with `base` set to the branch of the
layer below. That opens a pull request which *targets* the right branch — and is **not registered as
a stack on GitHub**. No stack object, no stack UI, no bottom-up merge, no auto-retarget.

The action reports `created: true` and returns a URL. The user believes they have a stack. They have
an ordinary pull request with an unusual base.

This is precisely the failure mode that function's own comment warns about:

> *"`gh` would happily open an ordinary pull request, which is NOT what was asked for, and silently
> doing something adjacent to the request is how an agent action becomes untrustworthy."*

The correct surface is `gh stack link` (register existing PRs into a stack) or `gh stack submit`
(push branches and create the PRs already linked).

### 1.2 We ignore ten semantic exit codes

`gh stack` returns a distinct exit code per failure class:

| Code | Meaning | What we currently do |
|---|---|---|
| 2 | Not in a stack | indistinguishable |
| 3 | Rebase conflict | indistinguishable |
| 4 | API failure | indistinguishable |
| 6 | Disambiguation required | indistinguishable |
| 7 | Rebase in progress | indistinguishable |
| 8 | Stack locked | indistinguishable |
| 9 | Feature disabled for this repo | indistinguishable |
| 10 | Recovery needed | indistinguishable |

Every one currently collapses into "no stack, here is a string". "This repository has stacks turned
off" and "a rebase is half-finished and needs your attention" are different situations demanding
different responses, and code 10 — *recovery needed* — is one where continuing could lose work.

### 1.3 The whole local half is missing

`gh stack init / add / modify / unstack / view / checkout / switch / up / down / top / bottom /
trunk / sync / rebase / push / submit` — none of it is reachable. We can *read* a stack somebody
else made and *describe* it. We cannot create, navigate, restack, or sync one.

### 1.4 Merging is unreachable, and the legacy path cannot do it

The docs are explicit: **merging a stacked pull request requires the Stacks API; the legacy pull
request merge endpoints cannot merge a stack.** `gh stack merge` is all-or-nothing across the
selected layers, with `--merge-method`.

Our model computes exactly what should merge (`evaluateStackMerge`, `highestMergeableLayer`) and
then nothing can act on it. The most useful thing the model knows is unreachable.

### 1.5 Honest note on how this happened

The 0.4.19 work was researched from a changelog and an overview page, and the implementation was
written before the CLI reference and quickstart were read. Everything built on top — the model, the
tests, the review integration — is sound and reusable. The part that touched GitHub was guessed.

The lesson worth encoding: for a platform feature in preview, read the *command reference* before
writing the adapter, not after.

---

## 2. Decisions

### D1 — `gh stack` is the execution surface; REST is read-only fallback

All stack *mutation* goes through the `gh stack` extension. We do not reimplement stack semantics
over REST: cascading rebase, restack ordering, and stack-aware merge are non-trivial and GitHub
maintains them.

REST (`GET /repos/{owner}/{repo}/stacks`) stays for **reading** in the brain, which runs server-side
where a `gh` extension may not be installed. The brain never mutates a stack.

**The extension is not guaranteed present.** `gh stack` requires `gh` 2.90.0+, git 2.20+, and an
explicit `gh extension install github/gh-stack`. Capability is therefore **detected once per
workspace and cached**, and every stack-mutating action is *hidden* rather than failing when the
extension is absent — an action that always errors is worse than one that is not offered, because
the agent will retry it.

### D2 — Fix the create path, and treat the shipped behaviour as a defect

`stack.addlayer` is rewritten onto `gh stack add` + `gh stack submit`, or `gh stack link` when the
branches and PRs already exist.

Until that lands, **the action is removed rather than left in place**. A tool that reports success
for something it did not do is worse than a missing tool: the human stops checking. There is no
deprecation window for a wrong answer.

### D3 — Exit codes are the contract

Every `gh stack` invocation maps its exit code to a typed outcome, and each outcome names what the
human or agent should do next. The three that must never be collapsed:

- **9 — feature disabled.** Stop offering stack actions for this repository and say why. Retrying is
  pointless and looks like a bug in us.
- **7 / 3 — rebase in progress / conflict.** There is an interrupted operation in the working tree.
  The agent must NOT start another stack operation on top; it surfaces the state and stops.
- **10 — recovery needed.** Refuse all further stack mutation and require explicit human action.
  This is the one where guessing can destroy work.

### D4 — Sync and rebase are the hard part; the agent may run them ON INSTRUCTION *(owner-decided)*

`gh stack sync` and `gh stack rebase` perform *cascading rebases across every layer*. A conflict can
surface in any layer, and resolving it rewrites branches that already have review comments attached.

Rebase is therefore **never automatic, but the agent may run it when told to** — the owner's call.
The distinction that makes this safe is *instruction*, not *inference*: the agent may propose a
restack and show which layers would move, and it executes only when the human says so. It may never
decide on its own that a stack looks stale and fix it.

Two consequences that follow from allowing it at all:

- **A preview of what moves is shown before execution, every time.** Not a confirmation dialog to
  click past — the actual list of layers whose history will be rewritten. Consent to "sync the
  stack" is not consent to rewrite six branches the human has forgotten are in it.
- **A conflict mid-restack stops everything.** Exit codes 3 and 7 mean the working tree holds a
  half-finished operation; the agent surfaces it and does not attempt a second stack command on top.

`--committer-date-is-author-date` is used on our restacks so review timestamps stay meaningful.

### D5 — Merge is all-or-nothing, through the Stacks API, with an explicit ceiling

`stack.merge` accepts a *top layer* and merges it plus everything beneath, matching `gh stack merge`.
It is **destructive** in the control layer's classification, requiring the action-specific
confirmation token, because it merges pull requests the caller may not have individually named.

The confirmation message must state **every PR number that will land**, not just the one requested.
"Merge #12" that silently lands #9, #10 and #11 is a confirmation dialog that has not obtained
consent for what actually happens.

### D6 — Wait for GitHub's native merge queue; no third-party integration *(owner-decided)*

**We do not build a Trunk-specific integration.** GitHub's own merge-queue support for stacks was
still rolling out at preview; we wait for it rather than taking a dependency on another vendor's
queue semantics for a feature that will get first-party support.

The behavioural facts below were learned from studying a third-party queue but describe the
*underlying GitHub API*, so they apply regardless of which queue eventually sits in front:

- A stack may be enqueued **from any point**, and several segments may be enqueued at once.
- A queue tests the stack **as a unit**, which is the real CI saving.
- **Stack merges can take 90+ seconds** through GitHub's API. Our timeouts assume seconds; a 10s
  timeout on a 90s operation produces a spurious failure on an action that is actually succeeding —
  and a retry against a partially-applied merge is exactly the wrong response. Stack merge gets its
  own long timeout and is *pending*, never *failed*, when it exceeds it.
- After a mid-stack merge, remaining layers may need a manual rebase. We detect and report that
  rather than silently leaving a stale stack.

That last pair is worth building **now** even without a queue, because both are properties of the
merge itself.

### D7 — Stacks are the NATIVE OUTPUT SHAPE of agent work, not a post-hoc split

*(Refined after the owner surfaced GitHub's "fit for high-volume development" framing. The earlier
version of this decision was about splitting a large change after the fact. That is the weaker
reading and it is now the fallback, not the design.)*

GitHub's framing:

> *"An agent completes one task, then starts the next task that builds on it. That sequence maps
> directly onto a stack: one pull request per task, each based on the one below. Stacks let you
> record those dependencies explicitly instead of combining unrelated changes into a single branch."*

**We already have the structure this describes.** `planPhases.ts` produces ordered phases with ids,
declared order, and a `current` pointer. The agent commits to that plan before it writes code. A
plan of five executable phases *is* a five-layer stack — the dependency information a stack needs is
information the agent has already produced and currently throws away by collapsing everything onto
one branch.

So the design is not "notice the diff got big, then cut it up". It is:

**One plan phase → one layer → one pull request, authored as the work happens.**

Splitting a monolith afterwards stays as the fallback for work that was not planned in phases. It is
strictly worse: the seams have to be *inferred* from a finished diff rather than *recorded* as the
work is done, and inferred seams are guesses about intent.

#### Why this matters more than it looks

The dependency is recorded rather than reconstructed. Reviewing layer 3 you can see that it builds on
2 and 1 — because that is how it was written. Today that ordering exists only in the agent's plan and
is lost the moment the branch is pushed.

It also fixes an asymmetry: the agent already works in ordered, dependent steps. The pull request is
the only place that structure gets flattened.

#### The guards, because this can fail badly

An agent emitting a layer per task will produce deep stacks unless constrained, and a fifteen-layer
stack is not more reviewable than one large pull request — it is *less*, with fifteen CI runs
attached. The failure mode is real and this decision must not create it.

- **Depth is capped, and the cap is low.** Beyond roughly five layers a stack stops being an ordered
  series of decisions and becomes a queue. Past the cap the agent stops and asks whether the
  remaining phases belong in a second stack after this one lands. The cap is a default, not a law,
  but exceeding it is a deliberate choice rather than a drift.
- **Never stack on a broken base.** If layer *N* fails its checks, layer *N+1* is not created. This
  follows from D5's merge ordering — anything above a blocked layer cannot land anyway — but it must
  be enforced at *authoring* time, not discovered at merge time, or the agent cheerfully builds four
  layers on a foundation that will never merge.
- **Every layer stands alone.** A layer must be independently reviewable and independently
  revertible. A plan phase that produces "half a refactor" is not a layer; phases that only make
  sense together get folded into one before submitting. `gh stack modify` exists for exactly this
  and the fold happens *before* the human sees it.
- **Rebase cost grows with depth.** A conflict in layer 2 of a six-layer stack cascades through four
  restacks. That is a second reason for the cap, independent of reviewability.
- **Each layer's PR body states what it depends on and why**, in prose. "Layer 3 of 5" is
  navigation; "this needs the schema from #41 before the API can read it" is the dependency, and
  that sentence is what makes the layer reviewable on its own.

#### Auto-propose still applies, and is still gated

For unplanned work the agent raises stacking unprompted when `adviseStacking` returns
`shouldStack: true` — over the reviewable band *and* genuinely separable. It fires **once per
change**, is suppressed after a decline, and never fires for an indivisible change.

The ADR-027 §1 reasoning is unchanged: notification acceptance falls roughly 30% per additional
notification, so a proposal that fires often is one that gets dismissed reflexively and is then
worth nothing when the change genuinely needs splitting.

#### Connection to the build loop

`cli.buildLoopEmitPr` already exists as a knob for delivering a passing build as a draft pull
request — and, checked while writing this, it is **another config-only value with no consumer**, the
fifth instance of that shape. When it is wired it emits a *layer* into the current stack rather than
an isolated pull request, or the two features produce competing branches for the same work.


### D8 — Desktop surface follows the model, not the other way round

A stack panel showing the layer chain, each layer's readiness, the named blocker, and the highest
mergeable layer. Read-only first; mutation buttons only for operations already reachable through
D2/D5 with their confirmations.

### D10 — Message receipts: did the agent actually get what I sent?

*(Raised by the owner as important. Not a stacked-PR concern, but it belongs in the same release
because it is the same class of problem: an interface reporting a state it has not established.)*

**The gap.** `InputQueue` and `publishExternalSteering` already deliver messages in `queue` and
`steer` modes. Nothing reports what happened to one. You type a correction mid-turn and then face
three indistinguishable outcomes:

1. It reached the model and changed course.
2. It reached the model and was ignored.
3. It never reached the model at all — the turn ended first, or the steer was dropped.

Not being able to tell these apart is expensive in both directions. Assume it landed and you carry
on from a false premise. Assume it did not and you repeat yourself, which wastes a turn and — worse
— can double-apply an instruction that *did* land.

**The honest constraint, which shapes the whole design: "read" is not observable for a model.**

We can prove a message entered the turn's context. We cannot prove the model attended to it.
Attention is not instrumentable from outside, and a token appearing in a prompt is not evidence it
influenced the output. So a "✓✓ Read" receipt on a chat message to an agent would be a claim we
cannot substantiate — and a false receipt is worse than none, because it is precisely what stops the
human from repeating themselves.

This is the same distinction as D4.1's `unknown` ≠ `unsupported`: report what is known, and do not
let a comfortable-looking default stand in for a fact.

**So the receipt has four states, three of them observable and one inferred:**

| State | Meaning | How we know |
|---|---|---|
| `queued` | Accepted, not yet handed to a turn | Ours — the queue holds it |
| `delivered` | Entered the model's context for a specific turn | Ours — we constructed that context |
| `acknowledged` | The agent demonstrably consumed it | **Evidence required** (below) |
| `dropped` | Never reached a model, and never will | Ours — turn ended, session closed, error |

**`acknowledged` requires evidence, not assumption.** It is set when the agent references the
message (an explicit ack, a plan revision citing it, or a `reconcile_steer` call carrying its id) —
never merely because the message was in the window. Where there is no such evidence the receipt
stays at `delivered`, and the UI says *delivered*, not *read*.

**`dropped` must be loud.** A steer that arrives after the turn ends is the case most likely to
cause real harm, because the human has every reason to believe it landed. It surfaces immediately
with the option to resend, and it is never silently discarded.

**Where this shows up:**

- Per-message state in the composer/transcript — `queued` → `delivered` → `acknowledged`, and
  `dropped` in an unmissable form.
- A count of pending steers, so "I sent three corrections" is checkable rather than remembered.
- The agent-facing side: a steer carries an id, and `reconcile_steer` reports which ids it
  reconciled. That is what makes `acknowledged` a fact rather than a guess.

**Deliberately not built:** a read-receipt that turns green on context inclusion. It is the obvious
implementation, it would look right in a demo, and it would be a lie in exactly the situation where
the human most needs the truth.

### D11 — The artifacts panel shows the session you are in, and can show more than one

*(Owner-reported. Grouped with D10 for the same reason: a surface displaying a state that is no
longer true.)*

**The defect.** Switching sessions leaves the artifacts panel showing the previous session's
artifacts. Closing and reopening the panel fixes it. That is a missing re-fetch on session change —
the panel loads on mount and nothing re-runs it when the active session changes underneath.

It matters more than a stale list usually would, because artifacts are *session-scoped by design*
(`recall.applyFilters` drops rows whose `session_key` does not match). So the panel is not showing a
slightly-out-of-date list; it is showing **another session's** work while claiming to show yours.
Acting on it means acting on the wrong session's outputs.

The fix is the re-fetch. The lesson is the same one D10 encodes: a surface must not present data
whose scope has changed out from under it.

**The improvement.** Session filtering is currently all-or-nothing: this session only. Real use
crosses sessions — you split work across three sessions this morning and want the artifacts from
all of them.

So the filter becomes **multi-select over sessions, defaulting to the current one**. The default
matters: opening the panel and seeing every artifact you have ever produced is not a feature, it is
a search problem you did not ask for. Start scoped, let the human widen deliberately.

When more than one session is selected, **each artifact shows which session produced it.** An
aggregated list without provenance is how you attribute one session's output to another — the same
failure the panel currently has by accident, reintroduced on purpose.

### D12 — Planner: the central split: MIRRORED items versus OWNED items

This is the decision everything else depends on, and it is what makes the hard problem small.

**Mirrored items** are projections of something whose truth lives elsewhere: a GitHub issue, a Track
item, a review finding, a meeting action. **We never merge these.** We re-read them. If a GitHub
issue changes while you were offline, there is no conflict to resolve — the issue is what GitHub
says it is. Local state for a mirrored item is a *cache with a fetch time*, nothing more.

**Owned items** are created in the planner and exist nowhere else: a personal todo, a time block, a
note against the day. These are the only things we own, and therefore the only things that can
genuinely conflict.

The consequence: a planner aggregating ten sources has a conflict surface of *one* — its own items.
Most of the apparent difficulty of "sync everything" dissolves once mirrored data stops pretending
to be editable local state.

**What you may do to a mirrored item locally** is limited to planner metadata: schedule it into
today, put it in a time block, order it, snooze it. Those are *ours*. Changing an issue's title is
not — that is an action against GitHub, queued as an outbound operation, and it fails visibly if it
fails.

### D13 — Planner: local-first with an outbox; the network is never on the critical path

Every mutation writes to the local store first and returns immediately. It also appends an entry to
an **outbox**: an ordered, durable log of operations to send.

This is the ADR-027 D12 pattern applied to a new surface, and the same rules hold:

- Each outbox entry carries an **idempotency key**, so a redelivery after a flaky reconnect does not
  double-apply.
- The outbox drains **in order per item** — reordering two edits to the same todo would produce a
  state neither device ever had.
- **Bounded with age-based shedding.** A device offline for three months should not replay a
  thousand stale operations on reconnect; past the retention horizon the local state is refreshed
  from the server instead, and the user is told that happened rather than left to notice.

The UI never spins on the network. Offline is not a degraded mode with a banner; it is the normal
mode that happens to be syncing.

### D14 — Planner: hybrid logical clocks, because device wall clocks lie

Ordering edits by `Date.now()` on the device is the mistake this decision exists to prevent. Laptop
clocks drift, phones cross timezones, and a device with a clock five minutes fast wins every
conflict it participates in — silently, and forever, until someone notices their phone always beats
their laptop.

Every mutation carries a **hybrid logical clock** stamp: `(physical, logical, deviceId)`. It
advances monotonically per device, absorbs the highest clock seen from any peer, and breaks ties on
`deviceId`. This gives a total order that no clock skew can invert.

ADR-027 D12 moved lease expiry onto the *database* clock for the same reason. This is that decision
extended to a case where the device is genuinely offline and the database clock is unavailable.

### D15 — Planner: field-level last-writer-wins, EXCEPT where that would lose work

For owned items, each field resolves independently by HLC. Two devices setting `dueDate` and
`priority` on the same todo both win — there is no reason for one to clobber the other.

**Where last-writer-wins is wrong, we do not use it.** Specifically:

- **Free text edited on both devices.** LWW here silently discards someone's writing. The item is
  marked *conflicted*, both versions are kept, and the human picks. A planner is not important
  enough to lose a paragraph over, and it is exactly important enough that quietly losing one
  destroys trust in the whole thing.
- **Deletion versus edit.** Deletion is a tombstone with its own HLC stamp. An edit that post-dates
  the tombstone **resurrects the item as conflicted** rather than either losing the edit or silently
  undeleting. Both silent outcomes are worse than asking.
- **Completion.** Complete wins over incomplete at equal clocks. Un-completing something you already
  finished is more annoying than the reverse, and the asymmetry is deliberate rather than emergent.

**We are not adopting CRDTs**, consistent with ADR-027, which ruled them out for plan and task state
on the grounds that convergence is not correctness. The narrower reason here: CRDT text merge
produces a document neither person wrote. For a shared todo that is worse than a conflict marker,
because it looks like agreement.

### D16 — Planner: the timetable is honest about estimates

The timetable shows **planned** blocks against **actual** time, because the gap is the useful
information. A planner that only shows intent teaches nothing; one that shows a two-hour task
routinely taking five is how you learn to plan.

- Blocks may be **unscheduled** (a today list) or **scheduled** (a time). Both are first-class;
  forcing every todo onto a clock is how planners get abandoned.
- **Carry-over is normal, not failure.** An item rolling to tomorrow is recorded, not scolded.
- **Drift is reported as a ratio, not a scoreboard.** "Tasks here typically take 1.8× their estimate"
  is useful; a red overdue count is the notification-fatigue failure from ADR-027 §1 in planner form.

### D17 — Planner: the agent is context-aware of it, and can operate it

*(Owner: the planner and timetable must be wired to the agent, not merely visible to a human.)*

A planner the agent cannot see is a second place your intentions live, and the agent works against
the version in its head. Knowing what you committed to today, what is scheduled in the next hour,
and what has been carried over three times makes it materially better at everything else it does —
it stops proposing a two-hour refactor twenty minutes before a meeting, and it stops suggesting work
you already decided against this morning.

**Context injection is BOUNDED and SUMMARISED, never the whole list.**

Injecting every open item into every turn is the obvious implementation and the wrong one. It burns
context that belongs to the actual task, and — per the ADR-027 §1 attention evidence — diluting a
prompt with fifty low-signal lines makes the model worse at the five that matter. What goes in is a
compact block:

- today's committed items (bounded; the rest are a count, not a list),
- the current or next time block,
- anything carried over more than twice, because that is a signal rather than noise,
- **per-source freshness**, so the agent knows the GitHub half is six hours old.

That last point is D18's rule applied to the agent rather than the human. Context that hides its own
staleness produces confident answers about work that has already changed.

**The agent reads freely and mutates only on confirmation.** Reading is `read`-classified in the D6
control layer. Every mutation — create, complete, reschedule, delete — is proposed and confirmed,
and agent-originated items are visibly marked as such.

The failure this prevents is specific: an agent that quietly reorganises your day produces a plan
you do not recognise, and then the planner stops being a record of your own intent. Once that trust
goes, the thing is worse than useless, because you now have two plans and believe in neither.

**Agent-callable actions** (D6 control layer, ADR-027):

| Action | Effect | Notes |
|---|---|---|
| `planner.today` | `read` | Today's items with per-source freshness |
| `planner.timetable` | `read` | Scheduled blocks, planned vs actual |
| `planner.find` | `read` | Search across sources |
| `planner.add` | `mutate` | Marked agent-originated |
| `planner.schedule` | `mutate` | Into a time block |
| `planner.complete` | `mutate` | Never inferred from a commit or a merged PR |
| `planner.reschedule` | `mutate` | Carry-over is recorded, not hidden |
| `planner.delete` | `destructive` | Confirmation token; a tombstone, recoverable |

**`planner.complete` is never inferred.** It would be easy to mark a todo done because its linked
pull request merged. Sometimes that is right; often the todo was broader than the PR. Guessing
converts the planner from a record of what you decided into a record of what the tooling assumed,
which is the same substitution D10 refuses for message receipts.

**Memory and the debt ledgers.** Completed items and their planned-versus-actual drift feed
ADR-027 D1's ledgers: what took longer than expected is technical-debt evidence, and what was
carried over repeatedly is a knowledge-debt signal — usually something nobody knows how to start.
The planner becomes an input to the debt program rather than a parallel system beside it.

**Knowing you are behind does not license mentioning it.** The agent has this context on every turn;
it raises it when relevant to what you asked, and otherwise stays quiet. An agent that opens each
turn with your overdue count is the notification-fatigue failure wearing a planner costume.

### D18 — Planner: sources are adapters behind one interface

Each source implements the same small contract: list candidate items, map to a planner item, report
its own freshness. Adding a source is writing an adapter, not touching the planner.

First set: Track, GitHub issues, GitHub pull requests (review-requested and authored), review
findings, meeting actions, and manual entry. Calendar is deliberately deferred — see §5.

**A stale source says so.** If GitHub has not been reachable for six hours, the view says the GitHub
items are six hours old rather than presenting them as current. An aggregated view whose freshness
is invisible is one that quietly lies about what is outstanding.

### D19 — Planner: retention follows ADR-027 D11

Completed items keep full detail for 90 days, then compact to a summary row. The planner is a
working surface, not an archive, and unbounded growth of a per-user table across every device is the
D11 problem in a new place.

### D20 — The execution engine is a setting that currently does nothing

*(Owner-reported: "I don't see where we utilise loop engineering or graph engineering in settings".)*

Correct, and the answer is worse than "there is no UI for it".

**`cli.executionEngine` is inert.** It appears in exactly two places: the type declaration in
`configTypes.ts` and the resolver in `config.ts`. `runTurn` never reads it. The graph executor,
its typed state, its checkpoints and its compensation ordering all exist and are tested — and
nothing routes a turn into them. Setting `executionEngine: "graph"` today changes nothing at all;
the loop runs regardless.

So ADR-027 D2 claimed "both engines ship and a setting selects" and shipped: both engines, a setting,
and no wire between them. This is the same defect class as everything else in this ADR — and it is
the fourth instance of one specific shape in a single release: **a module with no caller.** The
stack model was unreachable until it was exported. The `stack.*` actions were declarations with no
host. `stack.addlayer` called an endpoint that does not do what its name says. Now a setting
resolves a value nobody reads.

Every one of those passed its tests. Tests prove a unit behaves; they say nothing about whether
anything invokes it. That gap is worth naming as a standing check rather than a one-off fix: **a new
module or setting is not done until something calls it, and the test that proves the caller exists
is a different test from the one that proves the unit works.**

**What this decision requires:**

1. **Wire it.** `runTurn` dispatches on the resolved knob. This is the actual work — the branch is
   small, but the graph path needs the same interrupt, tool-authorization and receipt behaviour the
   loop has, or "selectable" means "selectable if you do not mind losing features".
2. **Surface it** in desktop settings under agent runtime, per workspace, with plain descriptions
   of what each engine is good at rather than the words *loop* and *graph* alone. The choice is
   meaningless to anyone who has not read D2.
3. **Show which engine is running**, in the session, at the point work happens. A setting whose
   effect is invisible is one nobody trusts they changed — and this is the ADR's whole theme: a
   surface that does not report its own state.
4. **Parity is asserted, not assumed.** A test matrix runs the same scenarios through both engines
   and fails when one supports something the other does not. Without that, "both ship" decays into
   "one ships and one exists".

**The honest option that is NOT chosen.** Deleting the knob and shipping only the loop would also
resolve the contradiction, and is less work. It is rejected because the graph executor's value is
real for interrupted, resumable work — but that value is currently zero, and would stay zero
indefinitely if this were left as it is. A capability nobody can reach is not a capability.

### D21 — Sweep for values nobody reads

D20 found `cli.executionEngine` resolving into nothing. Writing D7 found
`cli.buildLoopEmitPr` doing the same. Counting the stack model, the `stack.*` actions and
`stack.addlayer`, that is **five instances of one shape in a single release**: something declared,
tested, and never invoked.

Fixing them one at a time as they surface is how the sixth gets shipped. So this release includes a
deliberate sweep:

- **Enumerate every `cli.*` knob and assert a consumer exists.** A knob resolved by `config.ts` and
  read by nothing is a defect, and the assertion is mechanical enough to be a test rather than a
  review habit.
- **Same for exported modules in `packages/core` with no importer outside their own tests.** Not all
  are defects — some are genuinely public API for the SDK — so the output is a reviewed list, not an
  automatic failure.
- **Record the count.** If it is five today, the number after the sweep is the baseline, and a rise
  is a signal.

The general lesson is already in D20 and is worth repeating here because it is the reason all five
survived review: **tests prove a unit behaves; they say nothing about whether anything invokes it.**
Every one of these had passing tests.

---

## 3. Explicitly out of scope

- **Reimplementing restack in TypeScript.** GitHub maintains cascading rebase; we would maintain a
  worse copy.
- **Cross-fork stacks.** GitHub does not support them.
- **Auto-merging stacks without confirmation**, however green the checks.
- **A local stack database.** `gh stack` owns local tracking; a second source of truth would drift.

---

---

## 4. Phases

The full phase list — S rows (stacked PRs, receipts, artifacts), E rows (execution engine), and
P rows (planner) — lives in
[`brainrouter-roadmap/0.4.20.md`](../../brainrouter-roadmap/0.4.20.md) together with the twelve-week
delivery timetable. It is kept in one place rather than duplicated here, because two copies of a
phase list diverge and then nobody knows which is current.

Shape of it: **weeks 1–3 repairs** (the action that reports success for work it did not do, exit
codes, merge, receipts, artifacts panel), **week 4 the execution engine**, **weeks 5–11 the planner**
(clock and schema, local-first store, sync, conflicts, adapters, timetable, agent wiring), **week 12
multi-device soak**.

---

## 5. Consequences

**We take a dependency on a preview feature and an optional CLI extension.** Capability detection
and the fail-hidden posture are what keep that from degrading the product for anyone who has neither.

**Removing `stack.addlayer` before replacing it is a visible regression.** It is the right one:
the action currently lies about what it did.

**Rebase stays manual, which some will find slow.** That is deliberate — the alternative is an agent
rewriting the history of branches that already carry review comments.

**Wiring the execution engine may expose that the graph path is not at parity.** D20 requires the
same interrupts, tool authorization and receipts the loop has. If that turns out to be more than a
week's work, the honest response is to say so and reconsider whether the knob should exist at all —
not to ship a `graph` option that silently loses features.

**The planner adds a persistence and sync layer we have never had.** No offline queue, no logical
clock, no conflict resolution exists anywhere in the codebase today. That is why weeks 7–8 carry the
risk and week 12 is a soak: sync bugs are found by use, not by unit tests, and the cost of finding
them late is measured in someone's lost data rather than in rework.

**Twelve weeks is a long single-track release.** The alternative — running repairs and the planner in
parallel — would finish sooner on paper and produce two half-verified subsystems. The repairs are
correcting behaviour that currently lies to the user; they should not share attention with greenfield
work.

**This ADR is large.** Twenty-one decisions across four subsystems is more than one ADR usually
carries, and the justification is §0: they are one defect class, not four features. If that framing
stops holding as implementation proceeds, splitting it is the right response rather than defending
the structure.

---

## 6. Owner decisions

Three resolved on the stacked-PR half.

**Q1 — may the agent run `gh stack sync`? → YES, ON EXPLICIT INSTRUCTION.** Never on its own
inference that a stack looks stale. Every run shows the list of layers whose history will be
rewritten before it executes, and a conflict mid-restack stops all further stack operations. (D4)

**Q2 — auto-propose stacks, or only on request? → AUTO-PROPOSE.** The agent raises it unprompted
when its own change is over the reviewable band *and* genuinely separable. Gated to once per change
and suppressed entirely for indivisible changes, because a proposal that fires often is one that
gets dismissed reflexively — and then it is worth nothing when it matters. (D7)

**Q3 — third-party merge queue, or wait? → WAIT FOR GITHUB'S NATIVE QUEUE.** No Trunk-specific
integration. The timeout and staleness work (S4-2, S4-3) is built now regardless, because both are
properties of the stack merge itself rather than of any queue. (D6)

### Still open — planner

Carried over when the planner was folded into this ADR. None blocks starting, because all three
affect weeks 5 onward and the answers can land before then.

1. **Which sources matter most?** The phase list assumes Track, GitHub issues, then GitHub pull
   requests. If meeting actions or review findings matter more to your actual day, the order changes
   and the adapter week shortens.
2. **May the agent propose a day plan unprompted?** Same tension as D7's auto-propose: genuinely
   useful, and one more thing that speaks without being asked. D17 currently says it may propose;
   whether it may do so *unprompted* is the open part.
3. **How long may an offline device diverge before its outbox is shed and it refreshes from the
   server?** The proposal is D19's 90-day horizon. A shorter one — 30 days — bounds conflict
   complexity at the cost of a rarely-used device losing offline edits.

### Deferred to implementation

- Whether the auto-propose gate should also require a minimum number of *files* rather than lines
  alone — a 400-line change in two files may not be worth a stack.
- Whether declining a proposal suppresses it for the session or only for that change.
- The exact stack depth cap. D7 proposes about five; the right number is the one where a reviewer
  stops holding the chain in their head, and that is worth measuring rather than asserting.
