# ADR-049 — Memory for the human

**Status:** Proposed — drafted at the owner's request (2026-08-25). Planning only; no slice is
scheduled until this ADR is accepted. Desktop-only surface.

**Depends on:** the workspace-mode system (`brainrouter-desktop/src/lib/workspace/modes.ts` —
`WORKSPACE_MODE_IDS` / `WORKSPACE_MODE_DEFINITIONS`, rendered by `ActivityBar` and routed by
`MainContent`), ADR-021 (typed workspace profiles — `WORKSPACE_PROFILES`), ADR-030 (documents the
agent can read), ADR-018/035 (meetings), ADR-048 (the Atlas map + provenance discipline), ADR-032
(the review-gate posture for anything a model writes into durable state), and the Track precedent
(a mode = a core store, `packages/core/src/track/`, plus a desktop view, `src/track/TrackView`).

---

## 1. Where we are

The product remembers relentlessly — for the **agent**. The memory engine captures every turn,
recall briefs each prompt, learned skills survive sessions (ADR-032), the Atlas map now orients
every session (ADR-048). And it organizes for the **team**: Track holds the work, Meetings holds
the decisions, Notes and Planner hold the person's writing and plans.

Nobody holds the person's **retention**. A user reads an ADR, sits through a meeting, studies a
paper, learns a subsystem — and a week later it is gone, because reading is not remembering.
Spaced-repetition study is the one technique with decades of evidence behind it, and today that
means exporting your life into a separate flashcard app that knows nothing about your workspace.
Meanwhile this product is uniquely positioned to do it better: the material worth studying —
meetings, documents, memory records, the codebase map, track items, the decision log — is already
here, structured, with provenance.

The gap is visible in the profile presets themselves: `WORKSPACE_PROFILES` ships a **`study`**
profile ("Learning a subject — tutoring, practice, and progress over time", persona `tutor`,
skills pack `study`, memory tag `study`) and an **`education`** profile ("Teaching others —
curriculum, explanation, and assessment design"). Both promise a learning loop; neither has a
surface where practice and progress actually live. Chat with a tutor persona is a conversation —
it does not schedule what you are about to forget.

## 2. What this is

**Study**: a seventh workspace mode alongside Chat, Code, Track, Meetings, Planner, and Notes —
a full study system in the Quizlet family, but workspace-native:

- **Decks and cards.** A deck holds cards; a card is a prompt/answer pair with optional cloze
  form, tags, and — when generated — a provenance link to its source. Authored by hand in a
  keyboard-first editor, imported from tabular text, or **proposed by the agent** from what the
  workspace already knows.
- **A real spaced-repetition scheduler.** Review sessions surface exactly the cards that are due;
  the person grades each recall (again / hard / good / easy); a deterministic SM-2-family
  scheduler moves the interval and ease. Streaks, per-deck retention, and due counts tell the
  truth about progress.
- **Practice formats.** Flip-and-grade is the floor; multiple choice (distractors sampled
  deterministically from sibling cards, no model needed), typed-answer with diff highlighting,
  and cloze fill-in build on the same queue.
- **Generation with receipts.** "Make cards from this meeting / this document / this ADR / this
  subsystem" runs an agent turn that returns **card proposals** — never committed cards. The
  person accepts, edits, or rejects each one; every accepted card keeps a link to the exact
  source (meeting id, document, memory record, Atlas node → file). What gets offered to generate
  from is **profile-aware** (§D2).

Desktop-only as a surface, **workspace-scoped as data**: a deck belongs to the workspace it was
made in, and everything lives inside that workspace's root folder (`.brainrouter/study/` — the
same root-folder convention as ADR-047's `.brainrouter/playbooks/`). That makes a deck a project
artifact: commit it, and every teammate who clones the repo gets the deck — a codebase-onboarding
deck generated from the Atlas map travels with the codebase it teaches. The store *code* lives in
core (the Track pattern) so the data model is shared and testable, but no CLI or dashboard
surface is part of this decision.

## 3. Decisions

### D1 · Study is a mode scoped to the current workspace

It joins `WORKSPACE_MODE_IDS` as a first-class mode with the **"This workspace"** scope Code and
Track established — the decks you see, review, and generate are the *current workspace's* decks,
and switching workspaces switches decks. The owner's call, and the right one for what this is:
the study material IS the project's knowledge (its decisions, meetings, documents, map), the
workspace already carries the profile that shapes generation (D2), and a deck stored in the repo
is instantly a *team* artifact — sharing is `git commit`, not an export ritual. (The alternative
— a personal across-projects store like Notes/Planner — was considered and rejected: it detaches
decks from the project knowledge they teach and from the teammates who need them.)

### D2 · Available in every profile; shaped by each profile

This is the integration question, answered: **the mode is not gated to any profile** — modes are
not profile-gated today and studying is universal. What the profile drives is the **generation
surface** — which sources the "Generate cards" flow offers first, per the active workspace's
profile:

| Profile family | Default generation sources |
|---|---|
| `study` (flagship) | documents/readings (ADR-030), tutor-chat highlights, research notes |
| `education` | the same, plus *assessment authoring*: build decks intended for someone else |
| `engineering` / `data-science` | the decision log (`brainrouter-docs/decisions`), `brainrouter-rules/`, the Atlas map's layers and summaries (ADR-048), meeting decisions |
| `research` / `writing` | documents, the research-notes ledger, captured sources |
| `product-management` / `operations` / `sales` / … | meetings (ADR-018/035), track items, documents |

The `study` profile is the flagship home (its `tutor` persona and `study` skills pack point
straight at this mode), and `profileRecommendations` may surface the mode there — but an engineer
studying their own system's failure modes is exactly as legitimate a user. One mode, seventeen
profiles, profile-mapped defaults; every source remains reachable from every profile.

### D3 · The scheduler is engineering; the model never grades or schedules

The ADR-033 line, applied to studying: *deterministic engineering owns everything that must not
go wrong; the model owns judgement.* Intervals, ease factors, lapses, due queues, streaks, and
multiple-choice distractor sampling are pure, tested code — the same grades always produce the
same schedule, offline, forever. The model's only role is **writing card content** (D4) and,
optionally, judging a typed answer's semantic closeness as a *hint* the person can override —
never as the recorded grade.

### D4 · Generated cards are proposals behind a human gate, and every card carries its source

A flashcard is the person's memory. Nothing a model writes lands in a deck without explicit
acceptance — the ADR-032 gate posture, applied to human knowledge. Generation returns structured
proposals (parsed through the `extractJsonValue` chokepoint like every LLM-JSON boundary), each
carrying provenance (`meeting:<id>`, `doc:<path>`, `memory:<id>`, `atlas:<nodeId>`, `adr:<n>`);
the review tray shows source-beside-card; accepted cards keep the link so a stale card can be
traced and refreshed. Source text is untrusted data end-to-end — a document cannot inject a card
that carries instructions anywhere authority lives, because a human reads every card before it
exists.

### D5 · Plain files in the workspace root; decks commit, progress stays personal

Authoring, review, scheduling, and stats require no model and no network — a person can complete
a session with everything unplugged. Everything lives under `<workspaceRoot>/.brainrouter/study/`:

- **Deck files** (`decks/*.json` — content, tags, provenance) are designed to commit cleanly:
  stable ids, sorted keys, no timestamps that churn. Committing a deck is how a team shares it —
  and how an `education`-profile author distributes an assessment.
- **Review state** (ease, intervals, streaks) is *personal*, so it is keyed per user
  (`progress/<user>.json`) and recommended for `.gitignore` — your retention is yours, and two
  teammates reviewing the same committed deck never conflict.

No brain-side sync in this decision (a later ADR may add `atlas_put`-style sync). Export
(Markdown table / CSV) and import remain first-class from the first slice that has cards, so
decks are portable in both directions — including from the incumbent apps.

### D6 · Nudges ride existing rails

Due cards for the **active workspace's** decks surface as a badge on the mode's ActivityBar
entry, and an optional once-daily reminder
through the **existing** schedule store (`schedules.json` + the schedule ticker) — no new
scheduler, no notification system, no engagement mechanics. The number is honest (truly-due
count) or absent.

### D7 · The renderer boundary follows the house split

Pure logic (types, the SRS scheduler, distractor sampling, import/export codecs) is browser-safe
core the renderer deep-imports; the store (node fs over `<workspaceRoot>/.brainrouter/study/`)
lives main-process-side behind host queries — the same recipe as Track and the request-trace
panel. No new IPC surface beyond the established
host-query pattern.

## 4. What this does not do

- **No CLI/TUI or dashboard surface, no mobile, no web** — desktop mode only.
- **No deck marketplace or hosted sharing** — a deck is shared the way the repo is shared:
  commit it. (The `education` profile authors decks *for* others; git and export are the
  hand-offs — no service, no accounts.)
- **No gamification economy** — streaks and retention stats are measurements, not points, and no
  mechanic ever changes the schedule.
- **No auto-committed cards, ever** — including "just this once" bulk-accept-without-review.
- **No general LMS ambitions** — no courses, cohorts, assignments, or grading of other people.
- **No brain-side sync in this decision** — the store is local; sync is a future ADR if wanted.

## 5. Delivery board

- [ ] **S1 — The study core.** `packages/core/src/study/`: types (deck, card, review record,
  provenance ref), the pure SM-2-family scheduler (`srs.ts` — interval/ease/lapse transitions,
  due-queue selection, deterministic and property-tested), deterministic MC distractor sampling,
  Markdown/CSV import-export codecs, and the workspace-root store (`studyStore.ts` over
  `.brainrouter/study/` — commit-clean deck files, per-user progress files, D5). Browser-safe
  purity split per D7. *(M)*
- [ ] **S2 — The mode shell.** `study` joins `WORKSPACE_MODE_IDS` + `WORKSPACE_MODE_DEFINITIONS`
  ("This workspace" scope); ActivityBar picks it up; `MainContent` routes a lazy `StudyView`;
  host queries for store reads/writes; empty state that teaches the mode in one screen. *(S)*
- [ ] **S3 — Decks and authoring.** Deck CRUD, the keyboard-first card editor (prompt/answer/
  cloze/tags), import/export wired to the S1 codecs, deck list with due counts. *(M)*
- [ ] **S4 — The review engine.** The due-queue session UI: flip-and-grade (again/hard/good/easy,
  keyboard 1–4), session summary, per-deck stats (retention, streak, due forecast). Multiple
  choice and typed-answer (diff highlight) and cloze ride the same queue. *(M)*
- [ ] **S5 — Generation with receipts.** The profile-aware source picker (D2 table), the agent
  turn returning proposals via `extractJsonValue`, the accept/edit/reject review tray with
  source-beside-card, provenance stored on accepted cards. *(M)*
- [ ] **S6 — Nudges + polish.** ActivityBar due badge; optional daily reminder via the existing
  schedule store; theme + keyboard polish; `profileRecommendations` surfaces the mode for the
  `study` profile. *(S)*

## 6. How this will be judged

- **Unplugged test.** Create a deck, author ten cards, and complete a review session with no
  model configured and no network — everything works, and the next session's due queue reflects
  the grades.
- **Determinism test.** A property test replays grade sequences: identical grades from identical
  state always produce identical intervals — the scheduler never surprises.
- **Receipts test.** Every generated card in every deck can answer "where did you come from" with
  one click to a real source; no card exists that a human did not accept.
- **Profile test.** All seventeen profiles show the mode; the `study` profile's generation picker
  leads with readings/tutoring, the `engineering` profile's with decisions/rules/map — the D2
  table, observable.
- **Clone test.** Commit a deck, clone the repo on another machine: the deck is there with
  full provenance, due counts start fresh for the new person, and nothing of the original
  author's personal progress came along.
- **Portability test.** Export a deck, delete it, re-import: cards, tags, and provenance
  round-trip; scheduling state resets honestly (and says so) rather than pretending.
- Not judged by: cards created, minutes-in-app, or any engagement number. A study system is
  judged by whether the person still knows the thing — retention on review, over weeks.
