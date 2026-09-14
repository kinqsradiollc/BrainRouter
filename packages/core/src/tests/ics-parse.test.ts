/**
 * ADR-060 D2 — the iCalendar parser, exercised on the shapes real feeds emit:
 * a Google secret-address feed (VTIMEZONE + TZID, RRULE with EXDATE and an
 * overridden occurrence), an iCloud export (X-WR-CALNAME, all-day, colour),
 * an Outlook publish (Windows zone name, DURATION), plus the folding, escaping
 * and window rules every feed depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCalendarFeedUrl, parseIcs } from '../calendar/ics.js';

const WINDOW = { windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-10-31T00:00:00.000Z' };

const GOOGLE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'X-WR-CALNAME:Work',
  'X-WR-TIMEZONE:Australia/Melbourne',
  'BEGIN:VTIMEZONE',
  'TZID:Australia/Melbourne',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Australia/Melbourne:20260914T090000',
  'DTEND;TZID=Australia/Melbourne:20260914T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261003T000000Z',
  'EXDATE;TZID=Australia/Melbourne:20260918T090000',
  'UID:standup@google.com',
  'SUMMARY:Standup',
  'DESCRIPTION:Daily sync\\, keep it short.\\nAgenda in the doc.',
  'LOCATION:Level 3\\, Room B',
  'STATUS:CONFIRMED',
  'SEQUENCE:2',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Australia/Melbourne:20260916T100000',
  'DTEND;TZID=Australia/Melbourne:20260916T103000',
  'RECURRENCE-ID;TZID=Australia/Melbourne:20260916T090000',
  'UID:standup@google.com',
  'SUMMARY:Standup (moved)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20260920T230000Z',
  'DTEND:20260921T000000Z',
  'UID:late@google.com',
  'SUMMARY:Late call with a very long summary that the feed folds across',
  '  two physical lines because it is over seventy-five octets',
  'URL:https://meet.google.com/abc-defg-hij',
  'ORGANIZER;CN=Sam Lee:mailto:sam@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('a Google feed: TZID wall-clock times become UTC instants; a weekly rule expands inside the window with EXDATE honoured and an override replacing its occurrence', () => {
  const out = parseIcs(GOOGLE, WINDOW);
  assert.equal(out.calendarName, 'Work');
  assert.equal(out.calendarTimeZone, 'Australia/Melbourne');
  assert.deepEqual(out.failures, []);
  const standups = out.events.filter((e) => e.uid === 'standup@google.com');
  // Melbourne days: Mon 14, Wed 16 (overridden to 10:00), Fri 18 (excluded), Mon 21, Wed 23, Fri 25, Mon 28, Wed 30, Fri 2 Oct;
  // UNTIL 3 Oct 00:00Z excludes nothing more. Starts are UTC instants, so a 09:00 AEST start reads as 23:00Z the day before.
  assert.deepEqual(standups.map((e) => e.start), [
    '2026-09-13T23:00:00.000Z', '2026-09-16T00:00:00.000Z', '2026-09-20T23:00:00.000Z', '2026-09-22T23:00:00.000Z',
    '2026-09-24T23:00:00.000Z', '2026-09-27T23:00:00.000Z', '2026-09-29T23:00:00.000Z', '2026-10-01T23:00:00.000Z',
  ]);
  // 09:00 Melbourne (AEST, UTC+10) is 23:00Z the day before.
  assert.equal(standups[0]!.start, '2026-09-13T23:00:00.000Z');
  assert.equal(standups[0]!.end, '2026-09-13T23:30:00.000Z');
  assert.equal(standups[0]!.timeZone, 'Australia/Melbourne');
  assert.equal(standups[0]!.recurrenceId, '2026-09-13T23:00:00.000Z', 'occurrences carry their original start as the instance id');
  // DST starts in Melbourne on 4 Oct 2026, so 2 Oct is still +10; the wall clock stays 09:00.
  const moved = standups.find((e) => e.summary === 'Standup (moved)');
  assert.ok(moved, 'the RECURRENCE-ID override replaced the Wednesday occurrence');
  assert.equal(moved!.start, '2026-09-16T00:00:00.000Z', '10:00 Melbourne');
  assert.equal(moved!.recurrenceId, '2026-09-15T23:00:00.000Z');
  assert.equal(standups[0]!.description, 'Daily sync, keep it short.\nAgenda in the doc.');
  assert.equal(standups[0]!.location, 'Level 3, Room B');
  assert.equal(standups[0]!.status, 'CONFIRMED');
  assert.equal(standups[0]!.sequence, 2);
  const late = out.events.find((e) => e.uid === 'late@google.com')!;
  assert.equal(late.summary, 'Late call with a very long summary that the feed folds across two physical lines because it is over seventy-five octets');
  assert.equal(late.url, 'https://meet.google.com/abc-defg-hij');
  assert.equal(late.organizer, 'Sam Lee');
  assert.equal(late.allDay, false);
});

const ICLOUD = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//macOS 15.0//EN',
  'X-WR-CALNAME:Family',
  'X-APPLE-CALENDAR-COLOR:#FF2D55',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260919',
  'DTEND;VALUE=DATE:20260920',
  'UID:bday@icloud.com',
  'SUMMARY:Mum\'s birthday',
  'RRULE:FREQ=YEARLY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260925',
  'UID:noend@icloud.com',
  'SUMMARY:School holidays start',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20260910T080000Z',
  'DTEND:20260910T090000Z',
  'UID:cancelled@icloud.com',
  'SUMMARY:Dentist',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n');

test('an iCloud export: all-day events are days not instants, a DTSTART-only all-day lasts one day, yearly rules land once in the window, colour and status come through', () => {
  const out = parseIcs(ICLOUD, WINDOW);
  assert.equal(out.calendarName, 'Family');
  assert.equal(out.color, '#FF2D55');
  const bday = out.events.filter((e) => e.uid === 'bday@icloud.com');
  assert.equal(bday.length, 1, 'a yearly rule yields one occurrence in a two-month window');
  assert.equal(bday[0]!.allDay, true);
  assert.equal(bday[0]!.start, '2026-09-19T00:00:00.000Z');
  assert.equal(bday[0]!.end, '2026-09-20T00:00:00.000Z');
  const noend = out.events.find((e) => e.uid === 'noend@icloud.com')!;
  assert.equal(noend.end, '2026-09-26T00:00:00.000Z', 'an all-day event with no DTEND lasts the day');
  const dentist = out.events.find((e) => e.uid === 'cancelled@icloud.com')!;
  assert.equal(dentist.status, 'CANCELLED', 'cancelled events are reported, not dropped — the projection decides');
});

const OUTLOOK = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:AUS Eastern Standard Time',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID="AUS Eastern Standard Time":20261006T140000',
  'DURATION:PT1H30M',
  'UID:040000008200E00074C5B7101A82E00800000000@outlook.com',
  'SUMMARY:Quarterly review',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID="Mars/Olympus Mons":20260915T090000',
  'DTEND;TZID="Mars/Olympus Mons":20260915T100000',
  'UID:unknownzone@outlook.com',
  'SUMMARY:Unknown zone',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20260915T090000',
  'RRULE:FREQ=SECONDLY;INTERVAL=5',
  'UID:weird@outlook.com',
  'SUMMARY:Unsupported rule',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('an Outlook publish: a Windows zone name resolves, DURATION sets the end, an unknown zone falls back with a note, an unsupported rule keeps its first occurrence with a note', () => {
  const out = parseIcs(OUTLOOK, { windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-12-31T00:00:00.000Z' });
  const review = out.events.find((e) => e.uid.endsWith('@outlook.com') && e.summary === 'Quarterly review')!;
  // 6 Oct 2026 is after Sydney's DST start (4 Oct): 14:00 AEDT = 03:00Z.
  assert.equal(review.start, '2026-10-06T03:00:00.000Z');
  assert.equal(review.end, '2026-10-06T04:30:00.000Z');
  assert.equal(review.timeZone, 'Australia/Sydney');
  const unknown = out.events.find((e) => e.uid === 'unknownzone@outlook.com')!;
  assert.equal(unknown.start, '2026-09-15T09:00:00.000Z', 'no calendar zone declared: read as UTC');
  assert.ok(out.failures.some((f) => /unknown zone "Mars\/Olympus Mons"/.test(f)), out.failures.join(' | '));
  const weird = out.events.filter((e) => e.uid === 'weird@outlook.com');
  assert.equal(weird.length, 1);
  assert.ok(out.failures.some((f) => /recurrence "SECONDLY" is not supported/.test(f)));
});

test('the window bounds expansion: a daily forever rule stops at the window end and a COUNT stops earlier; events wholly outside the window are not produced', () => {
  const daily = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20260901T120000Z', 'DTEND:20260901T123000Z', 'RRULE:FREQ=DAILY', 'UID:d', 'SUMMARY:Daily', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20260901T120000Z', 'DTEND:20260901T123000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'UID:c', 'SUMMARY:Three', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261201T120000Z', 'DTEND:20261201T123000Z', 'UID:far', 'SUMMARY:December', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20260801T120000Z', 'DTEND:20260801T123000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15', 'UID:m', 'SUMMARY:Mid-month', 'END:VEVENT',
    'END:VCALENDAR'].join('\n');
  const out = parseIcs(daily, { windowStart: '2026-09-10T00:00:00.000Z', windowEnd: '2026-09-20T00:00:00.000Z' });
  const d = out.events.filter((e) => e.uid === 'd');
  assert.equal(d.length, 10, 'only the ten days inside the window, from a rule that never ends');
  assert.equal(d[0]!.start, '2026-09-10T12:00:00.000Z');
  assert.equal(out.events.filter((e) => e.uid === 'c').length, 0, 'COUNT=3 ended on 3 Sep, before the window');
  assert.equal(out.events.filter((e) => e.uid === 'far').length, 0);
  const m = out.events.filter((e) => e.uid === 'm');
  assert.deepEqual(m.map((e) => e.start.slice(0, 10)), ['2026-09-15'], 'monthly BYMONTHDAY inside the window only');
});

test('monthly BYDAY with an ordinal ("second Tuesday") and negative ordinal ("last Friday")', () => {
  const ics = ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'DTSTART:20260908T010000Z', 'DTEND:20260908T020000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU', 'UID:2tu', 'SUMMARY:Board', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20260925T010000Z', 'DTEND:20260925T020000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'UID:lastfri', 'SUMMARY:Retro', 'END:VEVENT',
    'END:VCALENDAR'].join('\n');
  const out = parseIcs(ics, { windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-11-30T00:00:00.000Z' });
  assert.deepEqual(out.events.filter((e) => e.uid === '2tu').map((e) => e.start.slice(0, 10)), ['2026-09-08', '2026-10-13', '2026-11-10']);
  assert.deepEqual(out.events.filter((e) => e.uid === 'lastfri').map((e) => e.start.slice(0, 10)), ['2026-09-25', '2026-10-30', '2026-11-27']);
});

test('building blocks, seen through the parser: quoted parameters with colons, tab folding, an Evolution-prefixed TZID, DST on both sides, durations, and the webcal scheme', () => {
  const ics = ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'DTSTART;TZID="Europe/Paris";VALUE=DATE-TIME:20260915T100000', 'DTEND;TZID="Europe/Paris":20260915T110000', 'UID:paris', 'SUMMARY:Quoted', 'URL:https://example.com/a:b', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=/freeassociation.sourceforge.net/Europe/London:20260915T100000', 'DURATION:P1DT1H30M', 'UID:evo', 'SUMMARY:Tab', '\tfolded', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=Australia/Melbourne:20260115T090000', 'DURATION:P2W', 'UID:summer', 'SUMMARY:AEDT', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=Australia/Melbourne:20260715T090000', 'DURATION:-PT15M', 'UID:winter', 'SUMMARY:AEST', 'END:VEVENT',
    'END:VCALENDAR'].join('\n');
  const out = parseIcs(ics, { windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-12-31T00:00:00.000Z' });
  const by = (uid: string) => out.events.find((e) => e.uid === uid)!;
  assert.equal(by('paris').start, '2026-09-15T08:00:00.000Z', 'a quoted TZID parses; CEST is +2');
  assert.equal(by('paris').url, 'https://example.com/a:b', 'the first unquoted colon ends the name, later ones are value');
  assert.equal(by('evo').timeZone, 'Europe/London', 'an Evolution-style prefixed TZID strips to the IANA name');
  assert.equal(by('evo').start, '2026-09-15T09:00:00.000Z', 'BST is +1');
  assert.equal(by('evo').summary, 'Tabfolded', 'a tab-folded line continues the previous one');
  assert.equal(Date.parse(by('evo').end) - Date.parse(by('evo').start), 25.5 * 3_600_000, 'P1DT1H30M');
  assert.equal(by('summer').start, '2026-01-14T22:00:00.000Z', 'AEDT is +11');
  assert.equal(Date.parse(by('summer').end) - Date.parse(by('summer').start), 14 * 86_400_000, 'P2W');
  assert.equal(by('winter').start, '2026-07-14T23:00:00.000Z', 'AEST is +10');
  assert.equal(by('winter').end, by('winter').start, 'a negative duration clamps to zero, never before the start');
  assert.equal(normalizeCalendarFeedUrl('webcal://p12-caldav.icloud.com/published/2/abc'), 'https://p12-caldav.icloud.com/published/2/abc');
  assert.equal(normalizeCalendarFeedUrl(' https://calendar.google.com/calendar/ical/x/private-abc/basic.ics '), 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics');
});

test('a feed with no events, an event with no DTSTART, and unbalanced components are reported, never thrown', () => {
  const out = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:No start\nEND:VEVENT\nBEGIN:VEVENT\nUID:y\n', WINDOW);
  assert.deepEqual(out.events, []);
  assert.ok(out.failures.some((f) => /event x: no DTSTART/.test(f)));
  assert.ok(out.failures.some((f) => /unbalanced/.test(f)));
  assert.deepEqual(parseIcs('', WINDOW), { events: [], failures: [] });
});
