# ADR-028 — Stacked pull requests, done properly

**Status:** PROPOSED — planning only, awaiting owner approval. No implementation begins until this
ADR is approved. · **Target:** `release/0.4.20` ·
**Supersedes:** ADR-027 D13, which shipped a partial and in one respect *incorrect* implementation.

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

### D7 — The agent AUTO-PROPOSES a stack for its own large, separable changes *(owner-decided)*

This is the payoff and the part that connects to ADR-027 D1: a 2,000-line "approve or don't" becomes
an ordered series of decisions. The owner's call is that the agent raises this **unprompted** when
its own change qualifies, rather than waiting to be asked.

It never *silently splits* work. Auto-propose means: state that the change looks stackable, name the
proposed layers and why they are the seams, and wait. Cutting happens only on confirmation.

**The tension to respect, because ADR-027 §1 is explicit about it.** Notification acceptance falls
roughly 30% per additional notification in a session; a proposal that fires often becomes one that
is dismissed reflexively, and then it is worth nothing when the change genuinely needs splitting. So
auto-propose is gated hard:

- It fires only when `adviseStacking` returns `shouldStack: true` — over the ~200-line band **and**
  genuinely separable. A large indivisible change stays one honest pull request and produces no
  proposal at all.
- It fires **once per change**, not per turn. Declining is remembered for that change; the agent
  does not re-raise it after the next commit.
- The proposal is a single sentence plus the layer list, not a panel.

`adviseStacking` already refuses to split an indivisible change; that stands, and it is now the
gate rather than merely advice.

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

### D9 — Explicitly out of scope

- **Reimplementing restack in TypeScript.** GitHub maintains cascading rebase; we would maintain a
  worse copy.
- **Cross-fork stacks.** GitHub does not support them.
- **Auto-merging stacks without confirmation**, however green the checks.
- **A local stack database.** `gh stack` owns local tracking; a second source of truth would drift.

---

## 3. Phases

| ID | Deliverable | Depends on |
|---|---|---|
| S0-1 | Remove `stack.addlayer` — it reports success for work it does not do | — |
| S0-2 | Capability detection: gh version, git version, extension present; cached per workspace | — |
| S1-1 | Typed exit-code outcomes for every `gh stack` invocation | S0-2 |
| S1-2 | Hard stops on codes 3 / 7 / 10; feature-disabled (9) hides the actions | S1-1 |
| S2-1 | `gh stack` runner: init / add / push / submit / link | S1-1 |
| S2-2 | Rewrite the create path onto it; a layer is genuinely registered as a stack | S2-1 |
| S3-1 | Navigation: view / checkout / switch / up / down / top / bottom / trunk | S2-1 |
| S3-2 | `sync` / `rebase`, human-initiated only, with a preview of what moves | S2-1 |
| S4-1 | `stack.merge` — top layer plus everything beneath, destructive, lists every PR | S2-1 |
| S4-2 | Long timeout + pending-not-failed for 90s+ stack merges | S4-1 |
| S4-3 | Post-mid-stack-merge staleness detection and report | S4-1 |
| S5-1 | Agent authoring: propose a stack, confirm once, then create | S2-2, S4-1 |
| S6-1 | Desktop stack panel, read-only | S3-1 |
| S6-2 | Mutation controls for confirmed operations | S6-1, S4-1 |

---

## 4. Consequences

**We take a dependency on a preview feature and an optional CLI extension.** Capability detection
and the fail-hidden posture are what keep that from degrading the product for anyone who has neither.

**Removing `stack.addlayer` before replacing it is a visible regression.** It is the right one:
the action currently lies about what it did.

**Rebase stays manual, which some will find slow.** That is deliberate — the alternative is an agent
rewriting the history of branches that already carry review comments.

---

## 5. Owner decisions

All three resolved.

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

### Still open

Nothing blocking. Two things to decide during implementation rather than now:

- Whether the auto-propose gate should also require a minimum number of *files* rather than lines
  alone — a 400-line change in two files may not be worth a stack.
- Whether declining a proposal should suppress it for the session or only for that change.
