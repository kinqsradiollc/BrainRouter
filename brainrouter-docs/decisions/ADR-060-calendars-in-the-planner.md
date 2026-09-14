# ADR-060 — Calendars in the planner

**Status:** Proposed (2026-09-14). Delivery board in §5.

**Depends on:** ADR-038 (a planner worth opening — one shared presentation, items + time
blocks), ADR-028 D7 (sources behind one interface; a stale source says so), the connector
runtime (`packages/core/src/connectors`, catalog + checkpoint runner + planner projection),
ADR-029 (one workspace, many surfaces).

---

## 1. Where we are

The planner knows about work that comes from *issue* sources — GitHub, GitLab, Jira, Linear —
through one path: a connector checkpoint writes `ConnectorDocument`s of kind `issue`, and
`connectorIssueAdapter` projects those into **mirrored** planner items with provenance, a stable
id, and a freshness label. Owned fields stay the person's; source fields are the source's, and
the surface says so when an edit would be undone by the next refresh.

It knows nothing about a person's **calendar**. The Calendar tab shows only the time blocks the
person made in the planner. The meeting at 10:00 that every other tool on the desk knows about
is invisible to the surface whose job is the day — so the day the planner shows is not the day
the person will have.

Two things people actually do with calendars, in the order they ask for them:

1. **Subscribe** — "show my Google / Apple / Outlook calendar here, and keep it current."
2. **Import** — "here is an `.ics` file; put these in."

Both exist for every calendar product because every calendar product speaks **iCalendar
(RFC 5545)**: Google offers a *secret address in iCal format* per calendar, iCloud a shared
calendar link (`webcal://`), Outlook and Fastmail a published `.ics` URL, and all of them
export `.ics` files. A subscription is a feed URL polled on a cadence; an import is the same
parse run once over a file.

Google additionally has a first-class API, and the product already holds a Google OAuth
identity for Drive and Gmail (`SERVER_OAUTH_SOURCES` on the desktop, `google-drive` / `gmail`
connectors on the server). Reading calendars through that identity needs only one more scope.

## 2. The idea

> **A calendar is a source. Its events are mirrored items with a scheduled time block each,
> projected by the same path issues take — so the Today list, the week strip and the Calendar
> tab show the person's real day without a second data model.**

Nothing in the planner's model changes to admit calendars. An event is an item whose day is
its start, whose block is its duration, whose provenance names the calendar it came from, and
whose title, time and location belong to the calendar (edits here would be undone by the next
refresh — the existing owned-vs-mirrored rule, with the existing tooltip). Completing it is the
person's ("I attended"), like completing a mirrored issue.

## 3. Decisions

### D1 · Two calendar sources, one document kind

- **`ics-calendar`** — *Calendar subscription (iCal)*. Config: `url` (`https://…ics` or
  `webcal://…`, normalised), `label`, `pollMinutes` (default 30), `windowDaysBack` (7),
  `windowDaysAhead` (60). Credential mode `none` (feed URLs carry their own secret). This one
  source covers Google (secret iCal address), Apple iCloud (shared link), Outlook/Exchange
  (published), Fastmail, Proton, Nextcloud, and any CalDAV server's export.
- **`google-calendar`** — *Google Calendar*. OAuth through the existing Google sign-in with
  the additional scope `https://www.googleapis.com/auth/calendar.readonly`. Config:
  `calendarIds` (default `primary`; the connector lists the account's calendars so the person
  picks by name, not id), the same window knobs. Reads
  `calendars/{id}/events?singleEvents=true&timeMin&timeMax&orderBy=startTime` — the API
  expands recurrences, so the client does not.
- Both emit **`ConnectorDocument` of a new kind `event`** with metadata
  `{ startAt, endAt, allDay, timeZone?, location?, organizer?, attendees?, status, calendarId,
  calendarLabel, uid, recurrenceId?, sequence? }`. `id` is `uid[/recurrenceId]` so a moved
  occurrence replaces itself; `url` is the event's link when the source has one.

### D2 · One RFC 5545 parser, in Core, pure and browser-safe

No calendar library is in the tree and none is added. `packages/core/src/calendar/ics.ts`
parses what the sources above actually emit: line unfolding, `VEVENT` with `DTSTART` /
`DTEND` / `DURATION` (DATE and DATE-TIME; `TZID=` and `Z`), `SUMMARY`, `DESCRIPTION`,
`LOCATION`, `UID`, `STATUS`, `RECURRENCE-ID`, `EXDATE`, and `RRULE` with `FREQ=`
DAILY/WEEKLY/MONTHLY/YEARLY, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` (weekly), `BYMONTHDAY`
(monthly) — expanded **inside the request window only**, so a "forever" rule is bounded.
Time zones resolve through `Intl.DateTimeFormat` (no tz database shipped); an unknown `TZID`
falls back to the feed's `X-WR-TIMEZONE`, then UTC, and the document records which. Anything
the parser does not understand is skipped and counted in the run's `failures`, never
guessed.

The same parser serves the subscription runner, the file import, and — because it is pure —
the tests, with a fixture set drawn from a real Google export, a real iCloud export and a
real Outlook export (identifying content replaced).

### D3 · Projection: an event is an item plus a block

`connectorEventAdapter.ts` sits beside `connectorIssueAdapter.ts` and is called by the same
`projectPlannerIssues` hook, renamed to `projectPlannerDocuments` (the old name stays as an
alias for one release). For each `event` document:

- an item with `id = stablePlannerId(connectorId, documentId)`, `origin: 'mirrored'`,
  `title = summary`, `dueDate = start date`, `notes = location + description (bounded)`,
  provenance `{ source: calendarLabel, kind: 'event', externalId: uid, url }`;
- a time block with `id = 'evt:' + item id`, `scheduledFor = startAt`, `estimateMinutes =
  duration` (all-day → the day's first hour, 60 minutes, marked `allDay` in metadata so the
  calendar draws it as a banner, not a block), source-owned like the item.

Cancelled events (`STATUS:CANCELLED`, or gone from the feed within the window) delete their
projection on the next run — the same "the source is the truth" rule as issues that close.
The person's completion and their own notes survive refreshes (`PLANNER_OWNED_FIELDS`).

### D4 · Import is a subscription that ran once

"Import an `.ics` file" creates an `ics-calendar` connector with `mode: 'file'`, stores the
file's contents once (desktop: the app data dir; dashboard: the server's connector store),
runs the checkpoint once, and never polls. It appears in Settings → Connectors like any other
source, so it can be removed — removing it removes its events, which is what "un-import"
means. A second import of the same file replaces, because ids are `uid`-stable.

The planner's Calendar tab gains one control: **Add calendar…** → *Subscribe to a feed URL* /
*Sign in with Google* / *Import an .ics file*. The control opens the connector flow; it does
not reimplement it.

### D5 · The surface shows where an event came from, and what it cannot edit

- Rows and calendar blocks from a calendar carry the calendar's chip (`Work · Google
  Calendar`, `iCal · Family`) in the existing provenance slot; the calendar block gets a
  hairline in the source's colour when the feed declares one (`X-APPLE-CALENDAR-COLOR`,
  Google's `backgroundColor`), else the default.
- Dragging a calendar event in the Calendar tab is refused with the existing "belongs to the
  source" tooltip. Completing it is allowed. Deleting it is not — remove the calendar instead.
- Freshness: a subscription that has not answered for longer than its cadence ×2 shows in
  `staleSources` exactly as GitHub does today ("Family calendar last refreshed 3 hours ago").

### D6 · Parity and boundaries

- Both hosts get it through the shared package and the connector catalog — the desktop's
  Connectors settings renders catalog entries generically, so the two sources appear there
  with no host code beyond the OAuth allowlist entry for `google-calendar`.
- The server gains the same two runners in `runCheckpoint.ts` and the calendar scope in its
  Google OAuth provider; the dashboard's planner reads the projected items through the API it
  already uses.
- Core never fetches: the runner receives an HTTP client the host provides, as every
  connector does. The parser has no I/O.

## 4. What this does not do

- No two-way sync. The planner does not create, move or delete events on Google or Apple.
  ("Block an hour" stays a planner block; publishing planner blocks to a calendar is a
  separate decision with a separate consent story.)
- No CalDAV client. Feeds and the Google API cover every product people named; CalDAV
  (authenticated iCloud, Nextcloud, Fastmail without a published link) is a follow-up source
  that would reuse D2 and D3 unchanged.
- No attendee management, invitations, free/busy, or reminders.
- No notification on upcoming events — that is ADR-027's territory.

## 5. Dependency-ordered delivery board

| # | Slice | Scope | Proves |
|---|---|---|---|
| C1 | iCalendar parser | `packages/core/src/calendar/ics.ts` + tests on real exports (Google, iCloud, Outlook), recurrence within a window, time zones via Intl | D2 |
| C2 | `ics-calendar` source | types (`event` kind, source), catalog entry, `runIcsCalendarConnectorCheckpoint`, runner switch, desktop + server HTTP client (webcal→https) | D1 |
| C3 | Event projection | `connectorEventAdapter.ts`, `projectPlannerDocuments`, block upsert for source-owned blocks, cancel/vanish removal, owned-field survival tests | D3 |
| C4 | Surface | provenance chip + colour hairline, all-day banner, drag refusal, `staleSources` wording, **Add calendar…** on the Calendar tab, file import flow on desktop (dialog) and dashboard (upload) | D4, D5 |
| C5 | `google-calendar` source | scope on the server's Google OAuth, calendar list for the picker, events runner, desktop OAuth allowlist | D1 |
| C6 | Docs + catalog | configuration.md, connectors guide, STATUS row | — |

C1–C3 are Core-only and ship first; C4 makes it visible; C5 is the OAuth path. Each slice is
its own PR into the release branch with the focused checks plus the planner visual gate where
the surface changes.

## 6. How this will be judged

> Subscribe to your real Google calendar's iCal address and your iCloud family calendar, import
> last term's timetable from an `.ics` file, and open Today on Monday morning.

- Today's meetings are in the Now group with their times, and the week strip counts them.
- A meeting moved on the phone is moved here within one poll, with no page reload.
- A cancelled meeting disappears; a meeting the person completed stays completed after a
  refresh.
- Nothing here can change the calendar on the phone — and the surface says so where the
  person would try.
- A feed that stops answering says so in the same words GitHub uses.
