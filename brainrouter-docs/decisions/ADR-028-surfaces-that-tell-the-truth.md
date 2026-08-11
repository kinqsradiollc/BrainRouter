# ADR-028 — Surfaces that tell the truth about their own state

**Status:** ACCEPTED — approved by the owner 2026-08-04. · **Target:** `release/0.4.20`
**Implementation:** PARTIAL — audited against the code 2026-08-06; per-decision state in [§2.9](#29--audit--what-is-built-what-is-half-built-what-is-not).
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
invokes it. That is the root cause, and E1 addresses it as a class rather than five bugs.

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

> **Built in part.** The detector that actually runs is `packages/core/src/review/stackProbe.ts:26`,
> called from `packages/core/src/orchestration/workflow/buildLoop.ts:428` and
> `brainrouter-desktop/electron/host/github-track-services.ts:629`. It checks `gh` and the extension
> — **not git 2.20+** — and it caches nothing. The cached, git-aware detector
> (`packages/core/src/review/stackCapability.ts:65,130`) and the fail-hidden gate
> (`packages/core/src/review/stackRunner.ts:137`) have no caller outside their own tests.

#### A2 · Remove the create path before replacing it

`stack.addlayer` is rewritten onto `gh stack add` + `gh stack submit`, or `gh stack link` where the
branches and PRs already exist.

**Until that lands the action is removed.** A tool reporting success for work it did not do is worse
than a missing tool, because the human stops checking. There is no deprecation window for a wrong
answer.

> **The removal shipped; the replacement did not.** `stack.addlayer` is gone
> (`packages/core/src/workbench/workbenchActions.ts:123-132`, absence pinned by
> `packages/core/src/tests/workbench-actions.test.ts:142-145`). But `addStackLayer` and
> `linkExistingIntoStack` (`packages/core/src/review/stackAuthoring.ts:91,142`) have no caller
> outside their own test and are not exported from `packages/core/src/review/index.ts`. **There is
> no create path today.** A change routed to `stack` reaches GitHub as a single
> `gh stack submit --auto` over one pushed branch (`packages/core/src/forge/forge.ts:33`), which
> registers one pull request, not a chain of layers.

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

> **Not built as anything a person can run.** `syncStack` and the rewrite preview
> `describeSyncRewrite` (`packages/core/src/review/stackLifecycle.ts:55,33`) have no caller anywhere
> in the repo outside `packages/core/src/tests/stack-lifecycle.test.ts`. No control action, no host
> handler and no command runs a stack sync, so neither guard is reachable to be tested by use.

#### A5 · Merge is all-or-nothing, and names every PR that lands

`stack.merge` takes a top layer and merges it plus everything beneath, matching `gh stack merge`. It
is **destructive** in the control layer, requiring the action-specific confirmation token.

**The confirmation states every PR number that will land.** "Merge #12" that silently lands #9, #10
and #11 has not obtained consent for what happens.

**A 90-second merge is `pending`, never `failed`.** Stack merges take 90+ seconds through GitHub's
API; a short timeout produces a spurious failure on an action that is succeeding, and a retry against
a partially-applied merge is the worst possible response.

**Stale layers after a mid-stack merge are detected and reported**, not silently left.

> **Not built as anything a person can run.** `mergeStackThrough`, `planMergeCascade`,
> `describeMergeCascade` and `staleAfterMerge` (`packages/core/src/review/stackLifecycle.ts:296,192,259`)
> have no caller outside `packages/core/src/tests/stack-lifecycle.test.ts`, and no destructive
> `stack.merge` action exists — `packages/core/src/workbench/workbenchActions.ts:123-132` registers
> only the two read actions. The confirmation token this decision turns on has nothing to guard.

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

> **The mapping is built; the authoring is not.** `proposeStackFromPlan` is wired into the router
> (`packages/core/src/review/prRouter.ts:75-83`) and the router is reached from the build loop and
> the Track path, so a plan genuinely decides the route. What does not exist is *one layer per
> phase*: `packages/core/src/git/prEmit.ts:296-316` pushes one branch and hands one submit to the
> forge, so a five-phase plan still produces one pull request. The guards are unenforced too —
> `mayProposeStack` (`packages/core/src/review/planToStack.ts:197`) and `canAddLayer`
> (`packages/core/src/review/stackAuthoring.ts:190`) have no caller, so "once per change, suppressed
> after a decline" and the depth cap are decisions with no code path.

#### A8 · Desktop surface follows the model

Stack panel showing the chain, per-layer readiness, the named blocker, and the highest mergeable
layer. Read-only first; mutation controls only for operations already reachable with their
confirmations.

> **Not built end-to-end. The panel renders and nothing reaches it — this ADR's own defect, in the
> surface written to fix it.** `brainrouter-desktop/src/App/render/renderPanelBody.tsx:393-394` reads
> `stackLayers` and `stackAvailability`; the one call site,
> `brainrouter-desktop/src/App.tsx:667`, passes neither, so the chain is permanently empty and
> availability is permanently `{capable:false}`. `refreshPanelData`
> (`brainrouter-desktop/src/lib/panels/usePanels.ts:185-194`) has no `stack` branch, so opening the
> panel fetches nothing. Its View / Sync / Merge buttons dispatch `stack-read`, `stack-sync` and
> `stack-merge` (`renderPanelBody.tsx:395,405,408`); the host registers only `stack-describe` and
> `stack-advise` (`brainrouter-desktop/electron/host/queries.ts:653-654`). The two host actions that
> do exist are also unreachable from the agent — nothing constructs `workbenchRegistry`
> (`packages/core/src/workbench/workbenchActions.ts:150`).

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

> **Not built.** The full lifecycle exists in `packages/core/src/task/messageReceipts.ts` and its
> only importer in the repo is `packages/core/src/tests/message-receipts.test.ts`. The delivery path
> it was written for holds no receipt state (`packages/core/src/session/input/inputDelivery.ts:20,142`),
> nothing is re-exported from `packages/core/src/task/index.ts`, and no desktop or CLI surface
> renders queued / delivered / dropped. §1.2 describes today's behaviour exactly as it still is.

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

> **Requirements 1, 3 and 4 are built. Requirement 2 is not, and the consequence is that `graph`
> can never actually run.** `runTurn` reads the knob and names the running engine in the session
> (`packages/core/src/agent/runtime/runTurn.impl.ts:286-291`). The control is
> `brainrouter-desktop/src/settings/runtime/RuntimeSection.tsx:64`, mounted unconditionally from
> `brainrouter-desktop/src/settings.tsx:443-453` — under **Automation → Runtime**, rather than the
> "agent runtime" this decision names. Its nav keywords carried none of "engine", "loop" or "graph"
> at audit time, so settings search returned nothing for the control's own name; they now do
> (`brainrouter-desktop/src/settings/shared/types.ts:185`).
>
> Parity is absent and declared absent: `ENGINE_CAPABILITIES` gives graph no interrupts, no tool
> authorization, no receipts and no delegation
> (`packages/core/src/agent/runtime/engineSelection.ts:72-79`), so `selectEngine` always falls back
> to the loop with a notice, and the `allowIncomplete` escape is passed by nothing outside
> `packages/core/src/tests/engine-selection.test.ts:80`. `packages/core/src/graph/graphExecutor.ts`
> has exactly one importer in the repo: its own test. **There is no parity matrix** —
> `engine-selection.test.ts` exercises the selector, not the same scenarios through both engines.
>
> This is the honest version of the failure §1.4 describes, not a repeat of it: the knob is read and
> the fallback says why. But §5 anticipated exactly this, and its instruction now applies — say so,
> and reconsider whether the option should exist.

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

> **"Can operate it" is built; "is context-aware" is not.** Five `planner_*` tools are registered
> and advertised (`packages/core/src/extension/builtin/toolCatalog.ts:85-92`, handlers at
> `packages/core/src/extension/builtin/runtime.ts:250-298`). `buildPlannerContext` — the bounded,
> summarised injection with per-source freshness that this decision specifies — has no caller
> outside `packages/core/src/tests/planner-surface.test.ts`. Nothing puts today's committed items,
> the current block or the carried-over items in front of the model, so the planner is still the
> second place your intentions live unless the agent goes looking with a tool.

#### D7 · Sources are adapters behind one interface

List candidates, map to a planner item, report freshness. First set: Track, GitHub issues, GitHub
PRs, review findings, meeting actions, manual entry.

**A stale source says so.** If GitHub has been unreachable six hours, the view says the GitHub items
are six hours old rather than presenting them as current.

> **Built in part.** `connectorIssueAdapter.ts` is the first production adapter. A successful
> server connector checkpoint invokes it from `connectors/syncExecutor.ts` with the connector's
> explicit `(org_id, user_id)` and persists supported GitHub, GitLab, Jira and Linear issue records
> into the Planner backend. The projection carries a stable external id, actionable source URL,
> actual ingest freshness, explicit blocked facts and time estimates; it deliberately never infers
> Planner completion. Replaying the same ingest is idempotent and does not bump a Planner revision.
> Track, pull-request, review-finding and meeting-action adapters remain to be built.

#### D8 · Retention follows ADR-027 D11

Completed items keep detail 90 days, then compact. The planner is a working surface, not an archive.

> **Not built end-to-end.** The server now has `compactCompletedPlannerItems`, and its SQL rebuilds
> payloads from an explicit data-minimisation allowlist (id, origin, title, completion, estimate and
> estimate HLC) and advances the revision so device caches receive the minimised row. The
> real-Postgres harness verifies the exact retained shape. No maintenance job
> schedules the sweep yet, so retention is still not an operational guarantee.

---

#### D9 · The planner is user-scoped, and the backend holds the truth

The first implementation got this wrong and it is worth recording why, because the mistake is
attractive: the planner was written to a workspace-local JSON file, following the artifact and
requirement stores.

That is wrong twice over. A planner is **personal**, not per-repository — scoped to a workspace,
"today" changes depending on which repo you happen to have open, which is nonsense. And a
device-local file means two devices never see each other, so the entire D3/D4 conflict apparatus
can never fire. We built machinery for a problem the topology made impossible.

**Truth lives in Postgres, scoped `(org_id, user_id, id)`**, following the tenancy convention every
other table uses. Each device keeps a local cache plus its outbox — the cache is what makes the
surface instant and the outbox is what makes offline real rather than a banner.

**The planner works with no backend at all.** Solo local mode is not a degraded tier: the cache is
authoritative until a server is configured, at which point the outbox drains and the merge rules
decide. This is the same solo↔team↔org partitioning the rest of the product uses, and the local-first
design in D2 already assumes it.

#### D10 · The dashboard is a device, not a privileged writer

The gap D1–D8 did not cover, and it would have produced silent data loss.

The dashboard is online-only, so the obvious implementation writes straight to the server: no local
cache, no outbox, no HLC stamp. Then a desktop edit made offline arrives **stamped** and meets a
server value that is **unstamped**, and the merge is undefined. Whichever way it resolved would be
arbitrary — which is exactly the quiet loss D4 exists to refuse.

> **The dashboard carries its own `deviceId` and stamps through the same path as every other client.
> There is no writer that skips the merge rules.**

One merge path, exercised by every surface, so the rarely-taken branch is not the one that decides
your data. A privileged writer would also mean the conflict UI could never be reached from the
dashboard, which is where a multi-device user is most likely to encounter one.

#### D11 · Sync is pull-then-push, and never destructive on either side

- **Pull `changed-since`**, merge locally by HLC, then **push the outbox.** Pulling first means a push
  never overwrites something it has not seen.
- **The server merges too, with the same rules.** A client that is behind must not be able to win by
  pushing last; the server applies D4 against its own state rather than accepting a payload.
- **A rejected operation is returned, not dropped.** The client keeps it in the outbox and surfaces it
  after `ATTEMPTS_BEFORE_SURFACING` rather than retrying invisibly.
- **A first sync never deletes.** An empty local cache meeting a populated server is a new device, not
  a mass deletion — and the reverse, an empty server meeting a populated client, is a fresh account,
  not a signal to clear the device. Deletions travel only as tombstones with stamps.

**Three edge cases the tests must cover**, because each destroys data if it is wrong: same field
edited on two devices while both are offline; an item deleted on one device and edited on another;
and a device returning after longer than the outbox retention, which must refresh rather than replay.

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

> **Built, and it is still absorbing this ADR's own violations.** The sweep exists with all four
> parts — knob consumers, a named-orphan list, an orphan baseline of 32 and H4's reachability walk
> (`packages/core/src/tests/inert-value-sweep.test.ts:107,164,179-184,244-249,341`). But the
> "undocumented orphan" assertion only inspects modules under `planner/`
> (`inert-value-sweep.test.ts:190-200`), and `KNOWN_UNWIRED` names four planner modules that are no
> longer orphans while omitting the ones that are: `task/messageReceipts.ts` (B1),
> `review/stackLifecycle.ts` (A4/A5), `graph/graphExecutor.ts` (C1) and
> `workbench/workbenchActions.ts` (A8). They pass because the numeric baseline has room for them.
>
> That is the mistake recorded at the end of §2.9 — the baseline set after the orphans landed —
> happening a second time, to four different decisions. Closing it means widening the assertion
> beyond `planner/` and naming every orphan with a reason, which is deliberately not done here
> because a document reconciliation should not quietly change what a test enforces.
>
> The sweep is also structurally blind to Part F: `packages/core/src/comprehension/*` counts as
> reachable because `packages/core/package.json`'s `exports` map credits anything re-exported from
> the package, so six modules with no consumer anywhere read as wired.

---

---

## Part F — Comprehension *(BUILT IN PART — audited 2026-08-06, see §2.9)*

> **Status.** This header said "not implemented" while §2.9 listed every F
> decision as shipped. Both were wrong. What is true: the decision logic for
> F1–F6 exists in `packages/core/src/comprehension/` and **no file outside its
> own tests imports any of it**. F7's panel and its invoke path are real and
> reachable. Per-decision detail with file:line is in §2.9.

### The problem this part exists for

Every decision so far makes a surface stop lying about **state**. Part F is about a different
failure, which the rest of the ADR does not touch and which is arguably worse:

> **A surface can be entirely truthful and still leave you not understanding your own system.**

An agent that produces correct work faster than a person can absorb it produces a codebase its owner
did not write, cannot explain, and will eventually be unable to change. Nothing has lied. Every
receipt was accurate. And the person is still worse off than if they had written less, slower.

This is not hypothetical for this repository. This release alone added roughly seventy modules across
five workspaces, and the owner's most useful question about it was *"why don't I see anything for
calendar, todo"* — a gap that existed for hours because the summary said "complete" and the person
had no way to check that claim short of opening the app.

**Comprehension is not documentation.** Docs describe what exists. What is missing is the ability to
know, at the moment of accepting work, whether you actually understand what you just accepted.

### F1 · Comprehension is profile-shaped, not a single feature

Different work fails comprehension in different ways, so the same mechanism cannot serve all three.

| Profile | What they must not lose | What the agent owes them |
|---|---|---|
| **Engineer** | The ability to change this later without archaeology | Blast radius, what breaks if the assumption is wrong, which decision would be expensive to reverse |
| **Researcher** | Calibration — knowing how much to believe | Sources with what each actually supports, confidence, **and what would falsify the conclusion** |
| **Tutor / learner** | The skill itself | The reasoning, at the depth asked for, and the parts they should try before being told |

Profiles already exist (ADR-021 workspace manifests). This is a comprehension mode attached to one,
not a new axis.

### F2 · Explain-back, at a depth the human chooses

After substantial work, the agent can explain what it produced — but the **depth is chosen by the
person, not the agent**, because an agent that decides how much you need is guessing at the one thing
only you know.

Three depths, and the names matter more than the mechanism:

- **`what`** — what changed and where. What a good diff summary already gives.
- **`why`** — the decisions and what was rejected. *The diff cannot show the road not taken, and that
  is usually the part worth knowing.*
- **`teach`** — the reasoning from first principles, assuming you will maintain this alone.

**Never volunteered on a schedule.** Offered once when the work is genuinely large, and then only if
asked. An agent that explains itself after every turn is ADR-027 §1's notification failure again,
and it trains the reflex that makes the important explanation get skipped.

### F3 · The decision log is a by-product, not a chore

The agent already commits to a plan (A7), records phases, and produces reasoning it currently throws
away. What is missing is the **rejected** alternative — "we did X" is recoverable from the diff;
*"we considered Y and rejected it because Z"* is not, and it is what the next person needs when Z
stops being true.

> **One line per non-obvious decision, written when it is made, never reconstructed afterwards.**

Reconstruction is the failure mode: a decision log written at the end is a rationalisation of what
happened, not a record of what was decided.

### F4 · Verification hand-off — the agent says what it could NOT check

The most useful comprehension artifact is not a summary. It is the honest boundary of the agent's own
confidence:

- what was verified, and *how* (test, run, screenshot — with the evidence)
- what was **not** verified and why
- **the specific thing a human should look at**, chosen because the agent cannot check it

This is the direct extension of B1's principle to work product. B1 refuses to claim a message was
read; F4 refuses to claim work was validated when what happened was that it compiled.

### F5 · The tutor profile teaches instead of answering

For a learner, a correct answer delivered instantly is the *worst* outcome — it looks like help and
removes the thing they came for.

- Asks what the learner thinks first, on genuinely instructional questions.
- Gives the smallest hint that unblocks, not the solution.
- **Never for a blocked professional under time pressure.** Socratic method aimed at someone
  debugging production at 2am is obstruction wearing a teacher's costume. The profile is opt-in and
  the escape hatch — *"just tell me"* — is always one word away and never questioned.

### F6 · Research output carries its own falsifiability

For the researcher profile, a claim ships with what would overturn it. A conclusion nobody could
disprove is not a finding, it is a position — and the difference is invisible in prose written
confidently.

Sources are cited **for what they actually support**, not appended as a bibliography. A link that
supports one sentence of five, listed at the bottom, reads as though it supports all five.

### What Part F must NOT become

Every one of these has a plausible version that makes the product worse, so they are refused by name:

- **UNPROMPTED quizzing.** A pop quiz nobody asked for is patronising and makes the surface something
  to avoid. *(An invoked one is a different thing entirely — see F7, which reverses an earlier
  refusal here.)*
- **Gating anything on comprehension.** A merge blocked until you prove you understood is
  paternalistic, and the reliable response is to click through it.
- **Summaries that restate the diff in prose.** Longer, not clearer, and they crowd out the parts
  that could not be read off the diff.
- **Comprehension theatre** — a confident explanation of work the agent did not actually verify is a
  *worse* failure than no explanation, because it transfers unearned confidence. F4 exists precisely
  to prevent this, and if F2 ever conflicts with F4, F4 wins.

### F7 · Comprehension review — the agent asks, you answer, it validates

**This reverses a refusal.** An earlier draft of this Part listed "quizzing the person on their own
codebase" as something F must never become. That was wrong, and the owner's framing is what makes it
wrong: *"same with how we review code."*

A code review is **invoked, structured, and produces findings.** Nobody calls a code review
patronising, because you asked for it and it tells you something. The thing I was refusing — a pop
quiz sprung on you mid-task — is a different artifact that happens to share a shape. **The
difference is entirely in who starts it.**

> **A comprehension review is a code review pointed at your understanding instead of the code.**

#### How it works

The agent generates a set of questions about work it just produced, you answer, and it validates
each answer with an explanation. Same lifecycle as a code review: requested → produced → answered →
findings.

Question forms, because one is not enough:

- **Multiple choice** — fast, and good for "what happens if" where the wrong answers are the
  plausible mistakes rather than filler.
- **Free text** — for "why was it done this way", where recognising the right answer is much easier
  than producing it, and only producing it demonstrates understanding.
- **Predict-the-failure** — "this breaks when ___". The single most useful form, because it is the
  question you will actually face at 3am.

#### What a question must be about

**Consequences and decisions, never trivia.** "Which file is `mergeOwnedItem` in" tests nothing —
you can grep. The questions that matter are the ones whose answers you would need before changing
this code:

- what breaks if this assumption is wrong
- why the rejected alternative was rejected
- which part would be expensive to reverse
- what this does NOT handle

A question whose answer is in the diff is a bad question. The value is in what the diff cannot show.

#### The rule that makes it honest

> **A wrong answer is not always the human's.**

If you answer confidently and the agent marks it wrong, one of two things is true: you
misunderstood, or **the agent did**. The second is not rare — the agent wrote the code from its own
model of what you wanted, and that model can be wrong in ways the tests do not catch.

So a disagreement produces a **finding**, not a mark. The agent states its reasoning, you state
yours, and if yours holds the output is a defect report about the code rather than a score about
you. A comprehension review that can only ever find the human wanting is a grading tool, and grading
tools get closed.

#### What it must not be

- **Never unprompted.** Invoked by `/understand`, a panel button, or an explicit ask. The moment it
  fires on its own it becomes the pop quiz this Part originally refused.
- **Never a gate.** Nothing is blocked on answering. A merge held until you pass is paternalism, and
  the reliable response is to click through it.
- **No score, no streak, no history of your mistakes.** The output is *which parts of this change you
  do not yet have a model of* — actionable — rather than *how you did* — a judgement nobody asked
  for. A stored record of wrong answers turns one honest tool into a performance file.
- **Skippable per question,** with no penalty and no follow-up. "I don't know" is a legitimate answer
  and is more useful than a guess, because it identifies the gap precisely.

#### Where it lives

Its own **Comprehension** panel in the Understand group (G4), not in chat. You want it when deciding
whether to accept work, which is minutes to days after the message that produced it — a panel
persists, a message is gone by the next turn.

### What Part F actually is, as of 2026-08-06

| # | State | Evidence |
|---|---|---|
| F1 | **Not built** | `packages/core/src/comprehension/profileComprehension.ts:28,50` — only importer is its own test |
| F2 | **Not built** | `packages/core/src/comprehension/workRecord.ts:25,46` — only importer is its own test |
| F3 | **Not built** | `packages/core/src/comprehension/workRecord.ts:81,96` — nothing records a decision anywhere |
| F4 | **Not built** | `packages/core/src/comprehension/workRecord.ts:117` `VerificationHandoff` — no consumer, no panel |
| F5 | **Not built** | `packages/core/src/comprehension/profileComprehension.ts:82,100,110` — no caller |
| F6 | **Not built** | `packages/core/src/comprehension/profileComprehension.ts:121-158` — no caller |
| F7 | **Built in part** | see below |

Not one file outside `packages/core/src/comprehension/` and its own tests imports any of it. The
sweep does not catch this because the package `exports` map credits the whole directory as reachable
(see E1's note above), which is the second time a reachability check has certified this ADR's own
inert code.

**What F7 does have.** The panel is real and a person can reach it:
`brainrouter-desktop/src/panels/memory/ComprehensionPanel.tsx` with its container at
`ComprehensionContainer.tsx:40`, wired at
`brainrouter-desktop/src/App/render/renderPanelBody.tsx:381` to `reviewMyUnderstanding`
(`brainrouter-desktop/src/App/hooks/useAppHandlers.ts:235-245`), which submits a turn carrying the
question rules and the "a wrong answer is not always yours" instruction. That is the honest design:
only the model that did the work can write the questions, and the handler says so rather than
faking them (`brainrouter-desktop/electron/host/queries.ts:2079-2099`).

**What F7 does not have.** The judging logic in
`packages/core/src/comprehension/comprehensionReview.ts:125-261` — `validateQuestion`,
`validateReview`, `judgeAnswer`, `buildJudgePrompt`, `toFinding`, `summarizeReview` — has no
caller, so nothing validates that a question is about consequences rather than trivia, and a
disagreement produces no finding: `'comprehension-dispute'`
(`brainrouter-desktop/electron/host/queries.ts:2107`) returns `{noted:true}` and records nothing.
The `/understand` invocation this decision names does not exist as a command.

### Open questions for review

1. **Does F5's tutor profile belong in this product at all**, or is it a different product wearing
   the same shell?
2. **Is F3's decision log worth the friction** if nobody reads it? It costs the agent little and the
   human nothing — but an artifact nobody opens is its own kind of lie.
3. **Should F4 be mandatory rather than offered?** It is the one here with no plausible downside, and
   the argument for making it a default is strong.

---

## Part G — The side panel *(BUILT except G4 — audited 2026-08-06, see §2.9)*

Part F needs somewhere to live, and the honest answer is that **there is no room**. The panel has
twenty-six registered ids and a tab strip that already overflows. Adding comprehension surfaces to it
would make the crowding worse and bury the thing they exist to make visible.

So G comes first, and it also fixes two behaviours that are wrong today independent of F.

### G1 · The agent may make a panel AVAILABLE; only the human makes one ACTIVE

**The bug:** `ensurePanel` does three things at once — adds the tab, makes it the active tab, and
opens the panel (`usePanels.ts:167`). Twenty-one call sites use it, and many fire from agent
activity: `diff` ×6, `tasks` ×3, `review` ×3, `browser` ×3. So the agent editing a file yanks you off
whatever you were reading.

This is the same category as everything else in this ADR. The panel is claiming *"this is what you
want to look at now"* — a claim about your attention that nothing established.

> **Split the verb.** `revealPanel` (human intent: add, activate, open) versus `offerPanel` (agent
> intent: ensure the tab exists, mark it with an unread dot, change nothing about focus).

Every agent-triggered call becomes `offerPanel`. The dot is how you learn a diff is waiting without
being moved to it. **The one exception is an interaction request** — a permission prompt is not the
agent deciding what interests you, it is the agent blocked until you answer.

### G2 · Closed at launch, and closed means closed

**The bug:** `sidePanelOpen` and `sideTabs` both restore from `localStorage`
(`usePanels.ts:66–86`), so a session that ended with six tabs open starts with six tabs open. That is
defensible as a general principle and wrong here, because panel state accumulates across a long
session and nobody ever prunes it.

> **The app starts with the panel closed and no tabs open.** Every launch begins from the same clean
> state.

Panel state is *session* state, not preference state — it reflects what you were doing an hour ago,
not how you want to work. The width, the pinned flag and the dock height are genuine preferences and
are still persisted; the open/closed state and the tab list are not.

A **"reopen last session's panels"** affordance is available for the case where the restore was
actually wanted, so this removes an assumption rather than a capability. It sits at the top of the
views chooser — the list you are looking at the moment you open the panel and find it empty — and
appears only when there is something to bring back.

### G3 · Group the panels, because twenty-six is not a tab strip

Twenty-six flat ids is a list you scan, not a strip you navigate. Grouped by what you are doing:

| Group | Panels |
|---|---|
| **Code** | Files, Editor, Diff, Search, Terminal |
| **Work** | Plan, Tasks, **Pull request** (see G5), Worktrees |
| **Knowledge** | Memory, Knowledge, Artifacts, Annotations, Requirements |
| **Understand** *(new — Part F)* | Explain, Decisions, Verification |
| **Environment** | Tools, Servers, Browser, Context |

Only the active group's tabs are in the strip. The grouping is not new information — it is the
structure the panel list already has implicitly, made visible.

### G4 · Comprehension lives in "Understand", never inline

Part F's surfaces go in their own group, for a reason that is not just space:

- **Explain** (F2) — the explain-back, at the depth you picked.
- **Decisions** (F3) — the decision log, newest first.
- **Verification** (F4) — what was checked, what was not, and the specific thing to look at.

Putting these inline in chat would make them scroll away, which is the opposite of what they are for:
you want them when you are *deciding whether to accept work*, which is minutes-to-days after the
message that produced them. A panel persists; a message is gone by the next turn.

**The Verification panel is the one that should carry an unread dot** by default, because F4 is the
mechanism that stops "it compiled" being reported as "it works".

> **Built in part — the group exists with one panel in it, not three.**
> `brainrouter-desktop/src/panels/panelCatalog.ts:28` registers `comprehension` (title "Understand")
> and `:80` puts it in the group. Explain, Decisions and Verification are not panel ids, so the
> unread-dot rule above has nothing to attach to and F2/F3/F4 have nowhere to appear even if their
> core logic were wired.

### G5 · Stack, checks and review are ONE panel, because they answer one question

A8 specified a stack panel and I built one. That was wrong, and the evidence was already on screen:

| Panel | Title | Answers |
|---|---|---|
| `diff` | Changes | What is in this change |
| `stack` | Stack | Which layers, and what blocks them |
| `review` | Review | What the reviewer found |
| `ci` | **PR / Checks** | Whether the checks passed |

Four panels — one of them *already named "PR"* — for facets of a single question:

> **Can this land, and if not, what is stopping it?**

Nobody asks "what is my stack doing" in isolation from "did checks pass". A stack layer is blocked by
a failing check or a requested change at least as often as by its position, and today those live in
different tabs, so answering the actual question means assembling it yourself from three places.

This is worse than crowding — it is the same fragmentation `layerStatus` was written to remove. That
function reports *"the blocker you can act on first"*, and it currently cannot see review findings or
CI results at all, so it reports a confident partial answer. **The consolidation is what makes it
truthful**, not merely tidier.

> **One `pull-request` panel: the stack chain, each layer's checks and review state inline, and the
> changes.** `stack`, `review` and `ci` are retired as separate ids; `diff` stays, because reading a
> diff is a different activity from deciding whether to land it.

**`layerStatus` gains the review and CI inputs it should have had**, so its blocker ordering covers
every real cause rather than the subset one panel happened to know about.

I am recording this as my error rather than as a discovered improvement. A8 said "stack panel", I
built a stack panel, and neither the ADR nor I asked whether a repository that already had a panel
called "PR / Checks" needed a second one next to it.

### G6 · The planner is a MODE, not a panel — Calendar, Today and Notes

Part D specifies the planner's clocks, merge rules, outbox, retention and agent contract in detail,
and **never says what surface it is**. That omission is why it shipped as six libraries: there was no
place for it to appear, so it did not appear.

The right panel is the wrong home, and D9 already implies why. Panels are bound to the **current
workspace and session** — that is what makes them useful for Files, Diff and Stack. The planner is
**user-scoped and spans every project you have**. Putting a cross-workspace surface inside a
workspace-scoped container is the same category error as scoping the store per repository, one layer
up.

> **A fifth workspace mode, beside Chat · Code · Track · Meetings.** Modes are the app-level surface;
> that is exactly what a personal planner is.

Three views inside it:

| View | What it answers |
|---|---|
| **Today** | What am I doing now — the committed list, the current block, what carried over |
| **Calendar** | What does the week look like — scheduled blocks against actual time (D5) |
| **Notes** | The things that are not tasks — captured fast, findable later |

All three read the same user-scoped store, so an item scheduled in Calendar is the same record Today
shows and the agent sees, rather than three stores that drift.

**Why this is not Track.** Track is project management: work items, sprints, boards, owned by a
project and shared with a team. The planner is *personal* and *cross-project* — your day, assembled
from every source including Track. A Track item appears in the planner as a **mirrored** item (D1),
which is precisely the distinction D1 exists to draw. They are not the same product and neither
replaces the other; building the planner inside Track would make your day belong to a project.

**Notes belong here rather than in Knowledge** for the same reason: Knowledge is workspace-scoped
reference material, notes are personal and cross-workspace. The test is whether the thing follows you
between projects — if it does, it is planner; if it belongs to the repo, it is not.

### Open questions for review

1. **Does G2's clean start need the "reopen last session" affordance at all**, or is it a feature
   nobody uses that exists to soften a decision that is simply correct?
2. **Is G3's grouping worth the navigation cost** — one more click to reach a panel — against the
   scanning cost it removes?
3. **Should `offerPanel`'s unread dot decay?** A dot that has been there for two days is furniture.
4. **Should Notes be a planner view at all**, or does personal note-taking deserve its own mode?
   The cross-workspace test says planner; the amount of surface it needs says otherwise.
5. **Does G5's consolidation go far enough?** `diff` is kept separate on the argument that reading a
   change and deciding to land it are different activities — but that argument would also have
   justified keeping `stack` separate, so it deserves a second look.

---

## Part H — Stacks are not reaching the products *(H1–H4 BUILT — audited 2026-08-06, H2 closed 2026-08-07)*

Reported by the owner: the desktop app and the CLI agent still open ordinary
pull requests. Verified — and it is the ADR's own pattern again, at the largest
scale yet.

Part A built capability detection, an exit-code contract, a latching runner, a
create path, sync, merge and a plan→stack mapping. **Nothing routes through
any of it.** There are four independent `gh pr create` call sites, and not one
knows the stack machinery exists:

| Call site | What opens the PR |
|---|---|
| `brainrouter-desktop/electron/host/github-track-services.ts:610` | Track item → draft PR |
| `packages/core/src/forge/forge.ts:24` | the forge adapter's `createChangeRequest` |
| `packages/core/src/git/prEmit.ts` | the build-loop PR emit |
| `packages/core/src/plugin/publish.ts:154` | plugin registry publish |

> **This is the sixth instance of "declared but never wired", and the biggest.**
> Five modules and eleven decisions of stack support, reachable by nothing a
> user can do.

E1's sweep did not catch it, and the reason matters: those modules **do** have
importers — each other. `stackAuthoring` imports `stackRunner`, which imports
`stackCapability`. A cluster that only calls itself passes an
importer-existence check while being exactly as inert as a lone orphan.

### H1 · One create path, and it decides

Every PR creation goes through a single function that asks whether this change
should be a stack — `adviseStacking` for unplanned work, `proposeStackFromPlan`
when a plan exists (A7) — and then routes to `gh stack add`/`submit` or to a
plain `gh pr create`.

**Plain PRs remain correct and common.** A one-file fix is not a stack, and a
router that stacks everything is worse than one that stacks nothing. The point
is that the DECISION happens once, in a place that has both options, rather
than four places that have only one.

### H2 · The four call sites converge

`forge.createChangeRequest` becomes the chokepoint the others call, rather than
one of four peers. The Track path, the build-loop emit and the agent all reach
GitHub through it. Plugin publish is the exception and stays direct — it opens
a PR against a *different* repository, where a local stack has no meaning.

> **Audited 2026-08-06 — this is stated more strongly than it is built.** What
> converged is the ROUTE (H1): `routePullRequest` decides stack-vs-plain in one
> place and both the build-loop emit and the Track path consult it.
> `createChangeRequest` did not converge — `git/prEmit.ts:310` is its only
> non-test caller, and the Track path at
> `brainrouter-desktop/electron/host/github-track-services.ts:635-636` still
> invokes `gh stack submit` / `gh pr create` itself. The duplication H2 exists to
> remove is still there, one layer down from where the decision claims it was
> removed. Tracked in "Built in part".

### H3 · The agent is told, not left to infer

`cli.buildLoopEmitPr` and the desktop PR actions get an explicit stacking mode:
`auto` (advise), `always`, `never`. Default `auto`, because a person who has
never used stacks should not have their first PR silently become one.

### H4 · E1 gains a reachability check, not just an importer check

The sweep asks whether a module has an importer. That is too weak: a cluster
importing only itself passes. The stronger question is whether a module is
reachable from an **entry point** — a registered tool, a route, a command, a
panel, a host handler.

> **A module is not done until something a USER can reach calls it.**

Reachability is a graph walk from the entry points rather than a lookup, so it
is more work — but it is the check that would have caught Part A the day it
landed, instead of the owner catching it in the product weeks later.

---

## 2.9 · Audit — what is built, what is half-built, what is not

**Audited against the code on 2026-08-06.** What stood here before was three
tables of "shipped" and the sentence *"Every decision in this ADR is
implemented."* **Twelve of those decisions are not built at all and nine more
are built in part** — and the error was in this ADR's own defect class: a
surface claiming a state it had not established. The document was the last place
the pattern was still running.

The three tiers below use one definition, taken from E1 and H4 rather than
invented here:

- **Built** — implemented, and something a person can reach calls it.
- **Built in part** — the named half is reachable; the rest is written down here
  with what is missing.
- **Not built** — the module exists and compiles and passes its own tests, and
  **nothing outside those tests imports it**. This is not a softer word for
  shipped. It is the §1.6 failure, and naming it is the only thing that makes
  the count go down.

### Built

| # | Decision | Reached from |
|---|---|---|
| A3 | Exit-code contract | `packages/core/src/review/stackRunner.ts:21,118` — every `gh stack` call classifies its exit |
| B2 | Artifacts panel re-fetch + scoping | `brainrouter-desktop/src/App.tsx:350-354`, `src/panels/memory/ArtifactsPanel.tsx:32,55` |
| D1 | Mirrored vs owned | `packages/core/src/planner/itemMerge.ts`, `plannerStore.ts`, and the production `connectorIssueAdapter.ts` projection |
| D2 | Outbox, local-first | `packages/core/src/sync/outbox.ts`, scoped Core stores and Dashboard's per-operation durable browser queue |
| D3 | Hybrid logical clocks | `packages/core/src/sync/stamped.ts`; both pull paths absorb every remote item/block/conflict stamp before a local tick |
| D4 | Field merge + retained conflicts | `itemMerge.ts`, `recordSync.ts` and server `memory/planner/backend.ts`; text and delete-versus-edit choices are durable operations with causal watermarks |
| D5 | Timetable and drift ratio | `packages/core/src/planner/timetable.ts`; shared `packages/ui/src/planner/PlannerCalendar.tsx` records planned and actual time in both hosts |
| D9 | User-scoped, backend truth | migrations `051`, `058`, `059`, `061`; API routes bind authenticated org/user and Desktop files bind the same scope |
| D10 | Dashboard is a device | `brainrouter-dashboard/app/planner/useDashboardPlanner.ts` gates on active organisation, pages snapshots and replays durable pending work |
| D11 | Pull → merge → push | Core `sync/recordSync.ts` and Dashboard's single-flight pull/push/pull loop validate an exact outcome partition |
| G1 | `offerPanel` vs `revealPanel` | `brainrouter-desktop/src/lib/panels/usePanels.ts:62,231`; callers at `App.tsx:341`, `useAppHandlers.ts:326` |
| G2 | Closed at launch, restore offered | `usePanels.ts:106-108`; the restore is pressable in the views chooser (`ViewsRail.tsx:209-217`), threaded through `MainContent.tsx` and `App.tsx:731` |
| G3 | Panel grouping | `brainrouter-desktop/src/panels/panelCatalog.ts:66-103` |
| G5 | One Pull request panel | `panelCatalog.ts:21-25` — `review` and `ci` gone from `PANEL_DEFS`; checks and findings inline at `renderPanelBody.tsx:411-419` |
| G6 | Planner is a mode | `brainrouter-desktop/src/components/layout/ActivityBar.tsx:15,24`; `App/layout/MainContent.tsx:212-216` |
| H1 | One PR create path | `packages/core/src/review/prRouter.ts:59`, called from `git/prEmit.ts:302-308` and `github-track-services.ts:630-633` |
| H3 | `cli.stackingMode` | `packages/core/src/config/config.ts:714`, read at `buildLoop.ts:426` and `github-track-services.ts:631` — **config file only, no settings UI** |
| H4 | Reachability walk | `packages/core/src/tests/inert-value-sweep.test.ts:244-249,281,341` |
| I1 | Startup detection, blast-radius install, and the report | `packages/core/src/tooling/provisioning.ts:52,128`; host `queries.ts:2021-2058`; UI `ToolingNotice.tsx` mounted at `App.tsx:724`, `auto_install` arm at `:47-75` |
| I2 | Bundling rejected | a decision not to build; nothing to verify |
| I4 | Reads never prompt | `github-track-services.ts:616` is the only identity call site, and it passes `create_pr` |

Surfaces genuinely reachable: Desktop Planner and Notes modes, Dashboard
`/planner` and `/notes`, CLI `/planner`, five `planner_*` tools, migrations
051/058/059/061 and `/api/planner`. `/plan` remains the durable agent-workflow
command and no longer shadows Planner.

### Built in part

| # | What works | What does not |
|---|---|---|
| A1 | `stackProbe.ts:26` probes `gh` + extension, reached from the build loop and Track | no git-2.20 check, no cache — `stackCapability.ts:65,130` and `stackRunner.ts:137` have no caller |
| A2 | the lying action is gone (`workbenchActions.ts:123-132`) | no replacement create path — `stackAuthoring.ts:91,142` has no caller |
| A7 | plan → route (`prRouter.ts:75-83`) | no layer-per-phase authoring; `mayProposeStack`/`canAddLayer` unconsulted |
| C1 | knob read and engine named (`runTurn.impl.ts:286-291`); control at `RuntimeSection.tsx:64` | no parity, so `graph` always falls back (`engineSelection.ts:72-79`); no parity matrix |
| D6 | five `planner_*` tools registered | `buildPlannerContext` has no caller — no planner context reaches the model |
| D7 | connector issue adapter is invoked after successful scoped ingestion and writes durable mirrored Planner rows | Track, PR, review-finding and meeting-action adapters remain |
| E1 | the sweep exists with all four parts | its orphan assertion inspects only `planner/`, so four of this ADR's own orphans pass |
| F7 | panel, invoke path and honest host stubs | `comprehensionReview.ts:125-261` unused; dispute records nothing; no `/understand` command |
| G4 | the Understand group exists | one panel in it, not Explain + Decisions + Verification |
| H2 | the ROUTE is decided once (`prRouter.routePullRequest`) AND the ARGV is built once (`prRouter.changeRequestArgv`) | closed. The audit was right that a shared decision was not enough: each site still assembled its own command, and the argv is what drifts — `gh stack link` shipped and survived a ten-code exit contract because an unknown subcommand exits 1 exactly like a real failure. Track now builds its command from core (`github-track-services.ts:637-641`). The argv builder returns argv rather than spawning, because the surfaces genuinely differ in how they run commands and forcing one runner would be a worse coupling than the duplication it removes |
| I3 | identity checked on the Track create-PR path | not on the build-loop push; the "question, both one click" UI has no renderer caller |

### Not built

| # | Decision | Where the code sits, uncalled |
|---|---|---|
| A4 | Sync with a rewrite preview | `packages/core/src/review/stackLifecycle.ts:33,55` |
| A5 | Merge cascade with confirmation | `packages/core/src/review/stackLifecycle.ts:192,259,296` |
| A8 | Stack/PR panel | renders, receives no props, and its three buttons dispatch queries with no host handler |
| B1 | Message receipts | `packages/core/src/task/messageReceipts.ts` — sole importer is its own test |
| D8 | Retention | compaction query and exact PostgreSQL harness exist, but no maintenance job invokes the sweep |
| F1 | Profile-shaped comprehension | `packages/core/src/comprehension/profileComprehension.ts:28,50` |
| F2 | Explain-back | `packages/core/src/comprehension/workRecord.ts:25,46` |
| F3 | Decision log | `packages/core/src/comprehension/workRecord.ts:81,96` |
| F4 | Verification hand-off | `packages/core/src/comprehension/workRecord.ts:117,135` |
| F5 | Tutor profile | `packages/core/src/comprehension/profileComprehension.ts:82,100,110` |
| F6 | Research falsifiability | `packages/core/src/comprehension/profileComprehension.ts:121-158` |

A6 is a decision *not* to build, and no merge-queue integration exists, which is
consistent with it. Plugin publish still calling `gh pr create` directly
(`packages/core/src/plugin/publish.ts`) remains the deliberate exception H2
names: it opens a pull request against a *different* repository, where a local
stack has no meaning.

**F5's open question is therefore still open.** The previous version of this
section answered it by citing `detectUrgency`'s guards — but `detectUrgency` has
no caller, so the guards that were supposed to settle the argument have never
run. An open question cannot be closed by code nothing executes.

### The five things worth arguing with

1. **Complete wins ties (D4).** Un-completing something you finished is worse
   than re-completing something that bounced back. That asymmetry is a taste
   judgement, not a derivation.
2. **`planner.complete` is never inferred (D6).** Costs a real convenience —
   the agent watching a PR merge and ticking the box — on the argument that the
   todo was usually broader than the PR.
3. **Overdue has no badge (D5).** Deliberately less legible than a red count,
   on the argument that a red count is why planners get abandoned.
4. **Closed at launch (G2).** Removes a restore some people will miss. The
   "reopen last session" affordance may be a fig leaf over a decision that
   should stand on its own.
5. **Stacking defaults to `auto`, not `always` (H3).** The cautious choice, and
   it means the feature stays invisible to anyone who does not go looking.

### What I got wrong, on the record

- Built the planner as six libraries with no caller — the exact pattern E1
  exists to catch.
- Set E1's baseline *after* those orphans landed, so the sweep certified two of
  its own author's violations as the floor.
- Scoped the planner store per workspace, making the multi-device conflict
  machinery unreachable.
- Added a Stack panel beside one already titled "PR / Checks".
- Refused mid-stack merges in the first pass of A5, forbidding the operation
  the feature exists for.

Added by the 2026-08-06 audit, because the list was itself out of date:

- **Wrote "Every decision in this ADR is implemented" while twelve were not
  built at all.**
  The document became the last surface running this ADR's defect, and it is the
  one that had least excuse: the code at least declared its own gaps in
  `engineSelection.ts` and in the comprehension host stubs.
- **Left three Part headers reading "PROPOSED — not implemented" underneath a
  summary calling the same decisions shipped.** Both statements were wrong, and
  a document that contradicts itself is read as neither.
- **Rebuilt the Stack panel after G5 without connecting it.** A8 was recorded as
  an error and then re-made: the consolidated Pull request panel renders, and
  `App.tsx` passes it no data while its buttons call three host queries that do
  not exist. This is the fourth surface in this release to be reachable and
  inert.
- **Repeated the E1 baseline mistake with four new orphans.** The KNOWN_UNWIRED
  list names four planner modules that are no longer orphans and omits
  `task/messageReceipts.ts`, `review/stackLifecycle.ts`, `graph/graphExecutor.ts`
  and `workbench/workbenchActions.ts`, which are.
- **Answered F5's open question by citing a guard with no caller.**

---

## Part I — Tooling and identity *(I1/I2/I4 BUILT, I3 built in part — audited 2026-08-06)*

Part I carried no status marker at all and appeared in no summary table, so
§2.9's "every decision is implemented" never covered it either way. It does now.

The stack feature shipped, and then sat unused because `gh-stack` was not installed. A1 was
correctly reporting it unavailable the whole time. **A capability check that is right and silent is
still a feature nobody gets**, and that is a different failure from the ones this ADR has been
fixing: not a false claim, but a true one nobody acted on.

### I1 · Detect at startup; install by blast radius, never silently *(owner-decided)*

The first draft of this refused to install anything without a click. The owner asked twice for
check-and-install, which is their decision to make; what survives from the objection is the part
that was actually right — **silent is wrong, not automatic.**

The line is drawn on **blast radius**, not on trust:

| | Installs on startup | Why |
|---|---|---|
| `gh extension install github/gh-stack` | **yes** | touches only gh's own extension directory; no sudo, no system change; undone by deleting a folder |
| `brew install gh` | no | a package manager, with a system-wide install root |
| `xcode-select --install` | no | a multi-gigabyte toolchain and a system dialog |

`planProvisioning` never places a system package in `install`, so the host cannot invoke a package
manager however the setting is configured. `cli.autoInstallTools` defaults to `safe`; setting it to
`off` returns to detect-and-offer for everything.

**The residual risk is real and worth naming**: `gh extension install` fetches and can run code from
the extension's repository. It is pinned to `github/gh-stack` — a GitHub-published extension, not an
arbitrary one — but a compromise of that repository would reach machines that never clicked
anything. That is the trade being made, deliberately, against a feature that shipped and sat unused
because the extension was missing.

The install command is still shown in full, and a declined tool is never installed.

- **Checked once per launch**, cached per workspace. Probing three binaries on every turn taxes every
  session for an answer that changes when someone installs software.
- **Never blocking.** A missing tool disables one feature; it does not gate the app.
- **Declined is remembered.** Asking again next launch is how a prompt becomes noise, and then the
  one that matters is dismissed reflexively (ADR-027 §1).

### I2 · Bundling is rejected, and it is not close

Shipping `gh` inside the app would remove the install step. It would also mean shipping a binary we
do not maintain, on three platforms, that talks to GitHub with the user's credentials — and owning
its CVEs on our release cadence rather than its own.

**A tool that authenticates to a forge should be updated by whoever writes it.** The install step is
the smaller cost.

### I3 · Git identity is per workspace, because the wrong account is a real harm

`gh` holds one active account. A person with a work account and a personal one has an active account
that is right for whichever repository they last thought about.

The failure is not cosmetic: **pushing a work branch from a personal account, or company code to a
personal fork, is a disclosure**. It is silent, it is attributed to the person, and it is discovered
by someone else.

> **Each workspace records the account it expects. Before any push, create, or merge, the active
> account is compared against it — and a mismatch stops the operation and names both accounts.**

- **Bound on first push**, not by a settings page nobody visits. The first time a workspace pushes,
  the account in use is what it expects from then on.
- **A mismatch is a question, not an error**: *"This workspace has pushed as `work-acct`; you are
  signed in as `personal`. Switch, or update what this workspace expects?"* Both are one click,
  because both are legitimate — people do change which account owns a project.
- **Switching is `gh auth switch`**, not a second credential store. A second store would drift from
  the one `git` and `gh` actually use, and the drift would show up as a push that used an account the
  UI said was inactive.

> **Built in part.** `checkIdentity` and `bindWorkspace` exist
> (`packages/core/src/tooling/gitIdentity.ts:75,127`) and are enforced on exactly **one** write
> path, the Track create-PR button
> (`brainrouter-desktop/electron/host/github-track-services.ts:616-622` via
> `brainrouter-desktop/electron/host/workspaceIdentity.ts:33-47`). This decision says *any* push,
> create or merge; the build-loop push runs `git push` with no check
> (`packages/core/src/git/prEmit.ts:296`). The "mismatch is a question, both one click" affordance
> does not exist either: the `'git-identity-check'` handler
> (`brainrouter-desktop/electron/host/queries.ts:2062`) has no caller in the renderer, so a mismatch
> reaches the person as a refusal with an error string — which is the shape this decision names as
> wrong, because an error is not a choice between two legitimate answers.

### I4 · Read-only operations never prompt

Fetching a stack's state, reading checks, listing PRs — none of these can disclose anything, so none
of them ask. Only operations that **write to the forge** consult the binding.

An identity check on every read would make the guard something people learn to click through, which
is exactly how it would fail on the push that mattered.

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

> **It did, and this is the saying-so.** Graph lacks interrupts, tool
> authorization, receipts and delegation
> (`packages/core/src/agent/runtime/engineSelection.ts:72-79`), so selecting it
> runs the loop and explains why. The knob is now honest rather than inert,
> which is better — but the decision this paragraph reserved is live: either the
> parity work is scheduled, or C1's rejected alternative (delete the knob, ship
> only the loop) becomes the right answer after all.

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
