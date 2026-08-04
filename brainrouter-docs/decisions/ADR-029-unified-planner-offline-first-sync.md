# ADR-029 — Unified daily planner, offline-first, multi-device

**Status:** PROPOSED — planning only, awaiting owner approval. No implementation begins until this
ADR is approved. · **Target:** `release/0.4.21` (see §6 for why it is not 0.4.20) ·
**Builds on:** ADR-027 D1 (debt ledgers, notification evidence), D11 (retention), D12 (idempotency,
fencing, database clock).

## Date

2026-08-04

---

## 1. Context

Work arrives from everywhere: Track items, GitHub issues and pull requests, review findings, meeting
actions, connector sources, and the things you simply decide to do. There is no single place that
answers *"what am I doing today?"* — so the answer is assembled in your head each morning, which is
the definition of knowledge debt.

The requirement is a daily planner and todo list that:

1. **Aggregates every source** into one view.
2. **Syncs through the backend** so it is the same on every device.
3. **Works offline** — fully usable with no network.
4. **Survives concurrent edits on multiple devices**, which is the genuinely hard part.
5. Includes a **timetable**: what is happening when, not just what is outstanding.

Nothing here exists today. There is no offline queue, no logical clock, no sync primitive anywhere
in the codebase. This is greenfield, and the multi-device requirement is where such systems usually
go wrong.

---

## 2. Decisions

### D1 — The central split: MIRRORED items versus OWNED items

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

### D2 — Local-first with an outbox; the network is never on the critical path

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

### D3 — Hybrid logical clocks, because device wall clocks lie

Ordering edits by `Date.now()` on the device is the mistake this decision exists to prevent. Laptop
clocks drift, phones cross timezones, and a device with a clock five minutes fast wins every
conflict it participates in — silently, and forever, until someone notices their phone always beats
their laptop.

Every mutation carries a **hybrid logical clock** stamp: `(physical, logical, deviceId)`. It
advances monotonically per device, absorbs the highest clock seen from any peer, and breaks ties on
`deviceId`. This gives a total order that no clock skew can invert.

ADR-027 D12 moved lease expiry onto the *database* clock for the same reason. This is that decision
extended to a case where the device is genuinely offline and the database clock is unavailable.

### D4 — Field-level last-writer-wins, EXCEPT where that would lose work

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

### D5 — The timetable is honest about estimates

The timetable shows **planned** blocks against **actual** time, because the gap is the useful
information. A planner that only shows intent teaches nothing; one that shows a two-hour task
routinely taking five is how you learn to plan.

- Blocks may be **unscheduled** (a today list) or **scheduled** (a time). Both are first-class;
  forcing every todo onto a clock is how planners get abandoned.
- **Carry-over is normal, not failure.** An item rolling to tomorrow is recorded, not scolded.
- **Drift is reported as a ratio, not a scoreboard.** "Tasks here typically take 1.8× their estimate"
  is useful; a red overdue count is the notification-fatigue failure from ADR-027 §1 in planner form.

### D6 — The agent reads the planner; it schedules only on instruction

The agent may read the planner for context — knowing what you are working on today makes it
materially better at everything else. It may **propose** a plan for the day.

It does not silently create, complete, reschedule, or delete items. The failure mode is specific and
bad: an agent that quietly reorganises your day produces a plan you do not recognise, and you stop
trusting the planner as a record of your own intent. Every mutation is proposed and confirmed, and
agent-originated items are visibly marked as such.

### D7 — Sources are adapters behind one interface

Each source implements the same small contract: list candidate items, map to a planner item, report
its own freshness. Adding a source is writing an adapter, not touching the planner.

First set: Track, GitHub issues, GitHub pull requests (review-requested and authored), review
findings, meeting actions, and manual entry. Calendar is deliberately deferred — see §5.

**A stale source says so.** If GitHub has not been reachable for six hours, the view says the GitHub
items are six hours old rather than presenting them as current. An aggregated view whose freshness
is invisible is one that quietly lies about what is outstanding.

### D8 — Retention follows ADR-027 D11

Completed items keep full detail for 90 days, then compact to a summary row. The planner is a
working surface, not an archive, and unbounded growth of a per-user table across every device is the
D11 problem in a new place.

---

## 3. Phases

| ID | Deliverable | Depends on |
|---|---|---|
| **P0 — foundations** | | |
| P0-1 | HLC primitive: stamp, compare, merge; property tests against clock skew | — |
| P0-2 | Planner item schema: mirrored vs owned, tombstones, per-field stamps | — |
| P0-3 | Migration: `planner_items`, `planner_outbox`, `planner_blocks` | P0-2 |
| **P1 — local-first core** | | |
| P1-1 | Local store with immediate reads/writes, no network on the path | P0-2 |
| P1-2 | Outbox: ordered per item, idempotency keys, durable across restart | P1-1 |
| P1-3 | Bounded outbox with age-based shedding + visible refresh-from-server | P1-2 |
| **P2 — sync** | | |
| P2-1 | Backend sync endpoints: push operations, pull since cursor | P0-3 |
| P2-2 | Field-level LWW merge on HLC | P0-1, P2-1 |
| P2-3 | Conflict cases that are NOT auto-merged: text, delete-vs-edit | P2-2 |
| P2-4 | Conflict UI: both versions, human picks, nothing lost | P2-3 |
| **P3 — sources** | | |
| P3-1 | Source adapter interface + freshness reporting | P0-2 |
| P3-2 | Adapters: Track, GitHub issues, GitHub PRs | P3-1 |
| P3-3 | Adapters: review findings, meeting actions | P3-1 |
| P3-4 | Staleness surfaced per source in the view | P3-1 |
| **P4 — planner + timetable** | | |
| P4-1 | Today view: aggregated, orderable, schedulable | P1-1, P3-2 |
| P4-2 | Timetable: scheduled and unscheduled blocks | P4-1 |
| P4-3 | Planned vs actual, drift as a ratio | P4-2 |
| P4-4 | Carry-over recorded, never scolded | P4-1 |
| **P5 — agent + surfaces** | | |
| P5-1 | Agent reads the planner for context | P4-1 |
| P5-2 | Agent proposes a day plan; every mutation confirmed and marked | P5-1 |
| P5-3 | Desktop planner surface | P4-2 |
| P5-4 | Dashboard planner surface (same endpoints) | P2-1, P4-2 |
| P5-5 | Retention + compaction at 90 days | P0-3 |

---

## 4. Delivery timetable

Sequential, single-track, assuming the work is done the way this session has been — small PRs with
tests, full suites before merge.

| Week | Focus | Exit condition |
|---|---|---|
| **1** | P0 — HLC, schema, migration | HLC survives adversarial clock-skew property tests |
| **2** | P1 — local store + outbox | Fully usable with the network switched off; outbox survives restart |
| **3** | P2-1, P2-2 — sync endpoints + LWW merge | Two devices converge on non-conflicting edits |
| **4** | P2-3, P2-4 — conflicts that must not auto-merge | Concurrent text edits lose nothing; delete-vs-edit asks |
| **5** | P3 — source adapters + freshness | Six sources in one view, each showing its own age |
| **6** | P4 — planner and timetable | Today view and timetable usable end to end |
| **7** | P5 — agent, desktop, dashboard, retention | Same planner on two surfaces; agent proposes, never imposes |
| **8** | Hardening | Multi-device soak: offline edits on three devices reconciling |

**Week 8 is not padding.** Sync bugs surface under conditions unit tests do not reproduce — two
devices offline simultaneously, an edit during a partial drain, a tombstone racing an edit. A week
of deliberate soak is cheaper than the same bugs found by losing your data.

**Weeks 3–4 carry the real risk.** If merge semantics prove wrong there, everything after moves.
Weeks 1–2 are well-understood work; weeks 5–7 are adapters and UI over a settled core.

---

## 5. Explicitly out of scope

- **Calendar read/write (Google, Outlook).** A large OAuth and recurrence surface. The timetable
  works standalone first; calendar is its own ADR once the core is proven.
- **Shared or team planners.** Single-user only. Sharing reintroduces exactly the authorization
  question ADR-027 said has no home in a merge.
- **CRDTs.** See D4.
- **Real-time collaborative editing.** Sync converges in seconds, not keystrokes.
- **Natural-language scheduling ("every second Tuesday").** Recurrence is deferred with calendar.

---

## 6. Why 0.4.21 and not 0.4.20

0.4.20 is ADR-028: fixing stacked PRs, including removing an action that currently reports success
for work it did not do. That is a correction of shipped behaviour and should not queue behind an
eight-week greenfield subsystem.

They are also different kinds of work — one is a focused repair, the other a new persistence and
sync layer — and interleaving them would make both slower and the release notes incoherent.

---

## 7. Open questions for the owner

1. **Which sources matter most?** P3-2 assumes Track, GitHub issues, GitHub PRs. If meeting actions
   or review findings matter more, the order changes and week 5 shortens.
2. **Should the agent be allowed to propose a day plan unprompted**, as with ADR-028's stacked-PR
   auto-propose? Same tension: useful, and one more thing that speaks without being asked.
3. **How long should an offline device be allowed to diverge** before its outbox is shed and it
   refreshes from the server? The proposal is the D11 90-day horizon; a shorter one (say 30 days)
   would bound conflict complexity at the cost of a rarely-used device losing offline edits.
