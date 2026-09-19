# Calendars in the planner

The planner's job is the day. A day with a 10:00 meeting in it that the planner
cannot see is not the day you are going to have, so the planner reads your
calendars — Google, Apple iCloud, Outlook, Fastmail, Proton, Nextcloud, a
university timetable someone emailed you as a file.

There is no separate calendar app to configure. **A calendar is a source**, like
a GitHub repository is a source: its events become planner items on their own
day, each with a time block at its own time, and they refresh on a cadence.

---

## The short version

Open the planner's **Calendar** tab and use **Add calendar…**:

| You have | Choose | What happens |
|---|---|---|
| A calendar that lives in Google / iCloud / Outlook | **Subscribe to a feed…** | Polled every 30 minutes; moves and cancellations follow |
| A one-off export someone sent you, or a term timetable | **Import an .ics file…** | Read once, never polled |

Both create a connector you can see and remove in **Settings → Data
connectors**. Removing it removes its events — that is what "un-subscribe" and
"un-import" mean here.

---

## Subscribing to a feed

Every calendar product publishes iCalendar, so one source covers all of them.
What you need is the feed's address, which is **not** the address of the
calendar's web page.

### Google Calendar

1. Open Google Calendar on the web.
2. Hover the calendar in the left list → **⋮** → **Settings and sharing**.
3. Scroll to **Integrate calendar**.
4. Copy **Secret address in iCal format**.

That address is a password in URL form — anyone holding it can read that
calendar. BrainRouter never logs it: a failure says `https://calendar.google.com/…`
and stops there. If you paste it somewhere you should not have, use **Reset**
on that same settings page.

### Apple iCloud

1. Open Calendar on a Mac (or iCloud.com).
2. Right-click the calendar → **Share Calendar…**
3. Turn on **Public Calendar** and copy the link.

It begins `webcal://`. Paste it as it is — BrainRouter normalises it to
`https://`.

### Outlook / Microsoft 365

1. **Settings → Calendar → Shared calendars**.
2. Under **Publish a calendar**, pick the calendar and **Can view all details**.
3. **Publish**, then copy the **ICS** link (not the HTML one).

### Anything else

Fastmail, Proton, Nextcloud and any CalDAV server offer a published `.ics`
address in their sharing settings. If the link ends in `.ics` or starts with
`webcal://`, it will work.

### Settings worth knowing

| Field | Default | What it does |
|---|---|---|
| **Feed URL** | — | The `.ics` or `webcal://` address |
| **Calendar name** | the name inside the feed | What appears on each event |
| **Auto run minutes** | 30 | How often to re-read. Leave it blank for the default; set `0` for "only when I ask" |
| **Days back** | 7 | How far into the past to keep events |
| **Days ahead** | 60 | How far ahead to read |

A feed you have set to `0` never refreshes itself, and the planner will not call
it stale — it is exactly as current as the last time you ran it. A feed that
*does* refresh itself and stops answering says so, after twice its cadence:
*"Family · iCloud is 3 hours old."*

---

## Importing a file

**Add calendar… → Import an .ics file…** reads the file once and keeps a copy
beside the connector, so the events survive restarts and moving the original.
Nothing polls it.

Importing the same file again creates a **second** calendar, and you will see
every event twice. To refresh an import, remove the old one in Settings → Data
connectors first — removing it removes its events.

If the file is not a calendar, you are told so rather than given an empty
calendar: *"timetable.csv is not an iCalendar file. Export the calendar again as
.ics."*

---

## What the planner does with an event

- **A timed meeting** becomes an item on its own day, plus a time block at its
  own time and duration. It counts toward the day's committed minutes, because
  it is time you genuinely do not have.
- **An all-day event** — a public holiday, a birthday, a conference day — has a
  day and no hour. It appears in the day's *All day* lane and takes no hours
  away from the day, because it does not take hours away from your day.
- **A cancelled meeting** disappears on the next refresh, and takes its block
  with it.
- **Times are the calendar's.** An event's zone is respected: a 23:00 UTC
  meeting is a 9am meeting if that is what it is where you are.

## What is yours and what is the calendar's

| | Whose |
|---|---|
| Title, time, duration, location | the calendar's |
| Whether you attended it | **yours** |
| Time you actually spent on it | **yours** |
| Notes you add | **yours** |

So a meeting can be ticked — the control says **"Mark Standup as attended"**,
not "Complete Standup", because that is what the tick records — and it stays
ticked through every later refresh.

Dragging a meeting to another hour is refused, with the reason: *"This time
comes from Work · Google. Move the meeting there — moving it here would be
undone by the next refresh."* That is not a limitation the planner is being coy
about; it is the truth about where the event lives.

## What this does not do

- **Nothing here writes to your calendar.** Blocking an hour in the planner
  makes a planner block, not a calendar event. Publishing planner blocks to a
  calendar is a separate decision with its own consent story.
- **No invitations, attendees, free/busy or reminders.**
- **No authenticated CalDAV** yet. Published feeds and file imports cover every
  product named above.

---

Design and rationale: [ADR-060 — Calendars in the planner](../decisions/ADR-060-calendars-in-the-planner.md).
