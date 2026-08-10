# ADR-038 — A planner worth opening

**Status:** PROPOSED — for owner review.
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

### D6 · One design brief, applied — not three interpretations

ADR-031 vendored a design skill and attached it to the `frontend` capability. This is the work it
exists for: a single brief for planner and notes, applied to shared components, reviewed once on
both hosts.

---

## 4. What this does not do

- **It does not redesign the whole product.** Chat, review, meetings and settings keep their current
  look; the tokens they eventually adopt come from this work, but their migration is separate.
- **It does not change storage or sync semantics.** ADR-029's block model, hybrid clocks, outbox and
  lease-with-fencing stay exactly as they are. This is presentation and composition.
- **It does not add planner features.** No dependencies, no gantt, no assignments. The complaint is
  that what exists is unusable, and adding to an unusable surface makes it worse.

---

## 5. Open questions

1. **Where do shared components live?** `packages/core` is browser-safe in parts but is not a UI
   package, and the renderer already has deep-import constraints. A dedicated UI package is the
   obvious answer and the one with the most build-system cost — worth deciding before code moves.
2. **How much can actually be shared?** Desktop has native menus, drag targets and window chrome the
   dashboard does not. The honest split is probably shared logic and presentational components with
   host-specific shells; the boundary needs to be drawn deliberately rather than discovered.
3. **Does the desktop notes implementation move, or does the dashboard's?** The dashboard's is
   larger; the desktop's is closer to the block model. Neither being obviously the survivor is
   exactly why this keeps not happening.
4. **What is the density target?** A planner for ten items and one for a hundred are different
   designs. This should be answered from real usage, not taste.
5. **Does this need its own visual review gate?** ADR-026 asked for live macOS and Windows review of
   the desktop visual system. The same question applies here, on two hosts.

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
