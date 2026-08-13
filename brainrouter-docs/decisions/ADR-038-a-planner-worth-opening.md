# ADR-038 — A planner worth opening

**Status:** ACCEPTED — 2026-08-11.

**Implementation status (2026-08-12): COMPLETE, after a repair round that mattered more than the
build.**

D1's acid test passes: a new block type or an in-block keyboard shortcut is added ONCE and appears
on both hosts. `packages/ui` exists — the dedicated package this ADR's open question 1 called "the
obvious answer and the one with the most build-system cost" — the dashboard's notes page went from
1,788 lines to 64, and `planner.module.css` from 67 to 10. Both hosts render the same surface.

**But the first pass shared the RENDERING and not the PROJECTION, and it had already drifted.** A
verification found, by running both hosts' logic over identical state:

- the dashboard could not say sync was FAILING — it said "4 changes waiting to sync" no matter how
  many operations were wedged, which is §6's own criterion failing on one host, with the only other
  signal being a dot that is `aria-hidden`;
- "Now · scheduled" contained zero items actually scheduled now, and the same surface filed those
  items under "No time" on the Calendar tab;
- "Last synced" printed a fresh timestamp after a cycle in which every write was rejected.

All three are fixed, and the root cause with them: the boundary script let `packages/ui` reach Core
only through the notes seam, so the planner's projection had **no legal shared home** and each host
wrote its own. Core now exposes `planner/presentation`, and the merge rule that decides what
survives a refresh — `PLANNER_OWNED_FIELDS`, which existed twice, five identical entries apart —
is read from Core rather than copied.

**D3 gained the control the day was missing.** `setDueDate` was declared on the shared contract,
implemented by the desktop, and called by NO component, while `/planner due` worked from the
terminal — so the CLI could move work the GUI could not, which is D5 inverted. `dueDate` drives
`groupFor` and therefore orders the entire Today view. Both hosts now supply it; it is owned-only,
and a mirrored issue says why rather than offering an edit the next refresh would undo.

**Depends on:** ADR-029 (one workspace, many surfaces), ADR-026 (desktop native visual system),
ADR-031 (the design skill and the capability it belongs to), ADR-028 (surfaces that tell the truth).

---

## 1. Where we are

The planner is not badly designed. It is **barely designed**, and the numbers say so plainly:

| surface | component | stylesheet |
|---|---|---|
| dashboard **notes** | `app/notes/page.tsx` — 1,788 lines | `notes.module.css` — 246 lines |
| dashboard **planner** | `app/planner/page.tsx` — 378 lines | `planner.module.css` — **67 lines** |

Sixty-seven lines of CSS is not a visual system. It is enough to stop elements overlapping.

What that produces, on the Today view: three tabs, a full-width text input, a button, and two lines
of grey prose on an empty field. No hierarchy, no density, no grouping, nothing that distinguishes
the primary action from the placeholder text, and nothing that makes the page feel like the thing it
is meant to be — the surface you open first each day.

And in the corner, **"4 changes waiting to sync."** — plain text. Not a control. You cannot click
it, cannot see which four, cannot retry, cannot tell whether it is progressing or wedged. It is a
status the product knows and the person cannot act on, which is the ADR-028 failure in miniature:
the surface reports a state without making it inspectable.

### 1.1 The second problem is worse, because it compounds

**Notes is implemented twice.** `brainrouter-dashboard/app/notes/` (1,788 lines) and
`brainrouter-desktop/src/notes/` (`NotesSidebar`, `DatabaseBlock`, `QuickFind`, ~950 lines) are two
independent implementations of one concept.

ADR-029's whole claim is *one workspace, many surfaces*. Two codebases for one feature is how that
claim stops being true: a fix lands in one, the other drifts, and every future block type, keyboard
shortcut and empty state has to be built and debugged twice — or, more realistically, once, leaving
the other host visibly behind.

The planner has the same shape waiting for it: `plannerView.ts` on the desktop,
`app/planner/page.tsx` on the dashboard.

> **We are not one design short. We are one design and one implementation short, and the second is
> what makes the first keep happening.**

---

## 2. The idea

Two commitments, and the second is what makes the first survive contact with the next feature.

> **One planner, one notes, rendered by shared components — and a real visual system underneath them
> rather than per-surface CSS grown by accretion.**

---

## 3. Decisions

### D1 · Planner and notes are shared components, not per-host pages

The interactive surface — day list, item row, block editor, database views, quick find, empty
states — moves into components both hosts render. The hosts keep only what is genuinely theirs:
routing, chrome, window controls, and the transport that reaches storage.

This is the ADR-029 rule applied to the two surfaces that most obviously broke it. A block type or
keyboard shortcut is then built once, and neither host can silently fall behind.

### D2 · The design is a system, not a stylesheet per page

Shared tokens — spacing scale, type ramp, surface elevations, state colours, focus rings, density —
consumed by both hosts and by every planner/notes component. `planner.module.css` at 67 lines exists
because there was nothing to reach for; the fix is to have something to reach for, not to write
another 200 lines in one page.

Desktop already has `theme.css` and the dashboard has `globals.css`. They should express the same
system rather than two dialects of it, and the components should use semantic roles
(`--surface-raised`, `--text-muted`) rather than literal colours, so appearance can change once.

### D3 · The planner's job is the day, and the design must say so

Today is not a text field with a list under it. It is a working surface, and the design owes it:

- **an evident primary action** — capture is the thing people do most, and it should read that way;
- **hierarchy between now, next and later** — a flat list is a list of equals, which a day never is;
- **density that fits a real day** — twenty items, not two, without becoming a wall;
- **items that carry their state** — source, estimate, blocked-ness, and where an item came from when
  it was pulled from a connected issue;
- **empty states that are a starting point, not an apology.** "Nothing planned for today" plus a
  sentence of prose is the least useful moment in the product; it is the moment the person has the
  most attention and the least to look at.

### D4 · Sync is a control, not a caption

**"4 changes waiting to sync."** becomes something a person can open: which changes, how old, what
is blocking, retry now. When sync fails it says so where the person is looking, not only in a
receipt. When it is working, the affordance is quiet.

This is the same rule the review work landed on: a degraded state that nobody can inspect is
indistinguishable from a working one.

### D5 · CLI gets the parts a terminal can honour, and no imitation of the rest

`/planner` should be genuinely good at capture, listing and completing — the operations a terminal
is *better* at than a mouse. It should not attempt the block editor or the database views. A CLI
that pretends to be a GUI is worse at both.

The shared layer for the CLI is the DATA and the operations, not the rendering.

### D6 · One BrainRouter design brief, applied — not three interpretations

This ADR and the repository's visual rules are the single brief for BrainRouter's own planner and
notes surfaces. ADR-031's vendored workspace-design skill remains available to the `frontend`
capability for work BrainRouter generates in a user's workspace; it does not govern BrainRouter's
product UI. Shared components are reviewed once against this ADR and exercised in both hosts.

---

## 4. What this does not do

- **It does not redesign the whole product.** Chat, review, meetings and settings keep their current
  look; the tokens they eventually adopt come from this work, but their migration is separate.
- **It does not replace the storage or sync model.** ADR-029's block model, hybrid clocks, durable
  outbox and lease-with-fencing remain the authority. Delivery does harden their browser wire
  contracts, block persistence, scoped source projection and targeted retry because a polished
  surface over writes that do not round-trip would still fail this ADR.
- **It does not expand the planner into project management.** No task dependencies, gantt or
  assignments are introduced. The added provenance, scheduling and sync controls make the existing
  day-planning promise usable and truthful rather than widening its product scope.

> **This section was RELAXED by the change that implemented it, and that is recorded here rather
> than left in the diff.** As written and approved, the second bullet read: *"It does not change
> storage or sync semantics. ADR-029's block model, hybrid clocks, outbox and lease-with-fencing
> stay exactly as they are. This is presentation and composition."* Commit `1d7264756` rewrote it to
> the wording above in the same change that shipped the feature.
>
> Sync semantics did change. `stamped.ts` gained a causal branch and planner writes now carry
> `seen`, so two offline edits to one title return a conflict record where they previously merged
> silently to the later stamp. `syncRecords` calls `hlcReceive` on every pulled record. The outbox
> reorders retry-requested records to the front, gained a `resolve_conflict` kind, and moved from
> deterministic idempotency keys to `randomUUID()` — a fix, since the old key omitted `deviceId`,
> but a wire change. A block operation's identity changed from `{itemId, kind:'update'}` to
> `{itemId: blockId, entity:'block', kind:'create'}`, and a persisted pre-upgrade desktop outbox
> has no migration for that.
>
> None of this is asserted to be wrong. Lease-with-fencing is genuinely untouched, and hardening a
> wire contract under a surface that depends on it is a defensible call. What is not defensible is
> a constraint quietly becoming its own exception: an ADR that moves to fit its implementation
> stops being a decision and becomes a description. Whether the expansion is accepted is the
> owner's; whether it is VISIBLE is not.

---

## 5. Resolved questions

### Q1 · The shared components live in a dedicated UI package

Create the private workspace package `@kinqs/brainrouter-ui` under `packages/ui`, with curated
`./planner`, `./notes`, `./planner.css` and `./notes.css` exports. Core continues to own domain
policy and storage, while Brand continues to own source tokens and assets. Neither becomes a React
package, and neither application may become a dependency of the other.

React and ReactDOM are peer dependencies (`^18.3.1 || ^19.0.0`) because Desktop and Dashboard do
not currently run the same major. UI may import Core only through an exact browser-safe allowlist;
the Notes editor uses `@kinqs/brainrouter-core/notes/editing`. The package-boundary check and the
Dashboard Cloudflare build enforce that a Node-only Core path cannot enter either browser bundle.

### Q2 · Share the browser interaction layer; adapt host effects

The shared package owns Planner day/week/calendar presentation, Notes pages/blocks/databases,
empty/loading/error/conflict states, feature view models, keyboard and focus behaviour, page/block/
calendar drag targets, accessibility semantics, and feature CSS. It receives plain view data and
typed `PlannerOps` or `NotesOps` capabilities.

Desktop keeps Electron bridge queries, the local-first cache, native downloads and external-open,
window drag regions, menus and mode switching. Dashboard keeps Next routing, authentication and
active-organisation resolution, authenticated HTTP, server polling/invalidation and browser
downloads. Leases, durable sync, clocks, persistence and transport remain Core/host concerns. A
shared component never branches on a host name; a genuine difference is a typed capability.

The CLI shares Core data and operations only. It never depends on React or the UI package.

### Q3 · Desktop is the presentation seed; neither host container moves

Desktop's Planner and Notes renderers are the survivor because they already separate presentation
from `PlannerModeContainer` and `NotesModeContainer`, and Notes contains the complete block editor.
Their host containers stay in Desktop. Dashboard auth, organisation, API, server-resolution and
download behaviour stays in a Dashboard adapter. Once parity is proven, Dashboard's duplicated
planner rows, Notes renderers, table codec and feature CSS are retired.

This does not bless every Desktop choice: extraction is a migration through shared contracts and
tests. It establishes one implementation as the editing source rather than preserving two and
calling them shared.

### Q4 · Twenty items is the canonical real day

The acceptance fixture contains 20 items: 16 active and four complete, mixing local capture,
connected issues, estimates, a blocked item, moved/scheduled work, and four pending sync operations.
Rows target 36px compact density with controls at least 24px. At least 12 actionable rows are visible
at Dashboard 1440×900 and Desktop 1280×840 at 100%; all 20 are reachable in one surface scroll.

There is no horizontal overflow at Dashboard widths 768 and 390×844, or Desktop 900×600 and 200%
zoom. One hundred items is a stress/performance case, not the everyday design target; virtualisation
is added only when measurement shows it is needed.

### Q5 · The cross-host visual/usability gate is blocking

ADR-038 owns a dedicated gate rather than borrowing an embedded-browser smoke test. Both hosts
render the same deterministic fixture and exercise capture, complete, schedule/move, source-open,
sync inspection and retry. The gate checks keyboard reachability, focus visibility, accessible
names/states, contrast, row density, overlap and overflow, plus unexplained console/network errors.

Dashboard is checked in Chromium at 1440, 768 and 390 widths. Electron is checked at 1280×840 and
its 900×600 minimum at 100% and 200% zoom, with light/dark plus high-contrast, forced-colours and
reduced-motion coverage where supported. Hosted macOS and Windows runs are release-blocking, with
screenshots retained as CI artifacts and a human release checkpoint for unexplained visual drift.

---

## 6. How this will be judged

**By use, not by screenshot.**

> Plan a real day in it — ten to twenty items, some pulled from connected issues, some typed, some
> completed, some moved — on the dashboard AND on the desktop.

It must be faster than the current surface, must look like one product on both, and must not require
a full-page reload to feel current.

Three supporting criteria, because "looks better" is not checkable:

- **One implementation.** A new block type or keyboard shortcut is added once and appears on both
  hosts. If it has to be written twice, D1 did not land.
- **Sync is actionable.** With four changes pending, a person can see which four and retry them
  without leaving the page. With sync failing, the page says so.
- **The empty state is a starting point.** A new user opening Today has something to do that is not
  reading grey prose.

Not judged by: matching any particular reference product. The target is a surface worth opening every
morning — which is a claim about the second week of use, not the first screenshot.

### 6.1 Currentness and failure semantics

While either surface is active, a local or remote change must become visible within five seconds or
through explicit event invalidation; a full-page reload is never part of the workflow. Pending sync
shows the exact operation, age, attempts and last failure. Retry targets failed operations without
discarding good pending work. A rejected or fenced write remains inspectable until the person has
resolved or dismissed it.

### 6.2 Delivery evidence

Acceptance requires the focused UI/Core/Desktop/Dashboard/CLI checks, the PostgreSQL two-device
scenario, the Dashboard Cloudflare build, root verification, the cross-host visual/usability gate,
and the full hosted CI suite. The delivery pull request records the exact commands and retained
artifacts; this section must not claim a gate passed before that evidence exists.
