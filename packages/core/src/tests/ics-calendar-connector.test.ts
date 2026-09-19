/**
 * ADR-060 D1 — the `ics-calendar` source through the connector contract: a fake
 * feed client, a real ConnectorRecord, event documents out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import { CONNECTOR_SOURCES, isConnectorSource } from '@kinqs/brainrouter-types';
import { CONNECTOR_CATALOG } from '../connectors/catalog.js';
import { icsFeedClient, runIcsCalendarConnectorCheckpoint } from '../connectors/sources/icsCalendarConnector.js';

const NOW = '2026-09-14T04:00:00.000Z';

function connector(config: Record<string, unknown> = {}): ConnectorRecord {
  return {
    id: 'cx_family',
    source: 'ics-calendar',
    name: 'Family',
    config: { url: 'webcal://p12-caldav.icloud.com/published/2/SECRET-TOKEN', ...config },
    credential: { mode: 'none' },
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as ConnectorRecord;
}

const FEED = [
  'BEGIN:VCALENDAR', 'X-WR-CALNAME:Family (feed)', 'X-APPLE-CALENDAR-COLOR:#FF2D55',
  'BEGIN:VEVENT', 'DTSTART:20260915T230000Z', 'DTEND:20260916T000000Z', 'UID:one', 'SUMMARY:Dentist', 'LOCATION:Level 2', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20260914T230000Z', 'DTEND:20260914T233000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'UID:daily', 'SUMMARY:Walk', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20200101T000000Z', 'DTEND:20200101T010000Z', 'UID:ancient', 'SUMMARY:Long ago', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function fake(body: string, status = 200, contentType = 'text/calendar'): { client: { fetchText: (url: string) => Promise<{ status: number; contentType: string; body: string }> }; urls: string[] } {
  const urls: string[] = [];
  return { urls, client: { fetchText: async (url: string) => { urls.push(url); return { status, contentType, body }; } } };
}

test('the source is declared, catalogued without a credential, and its feed is fetched over https even when given as webcal://', async () => {
  assert.ok(CONNECTOR_SOURCES.includes('ics-calendar'));
  assert.ok(isConnectorSource('ics-calendar'));
  const entry = CONNECTOR_CATALOG.find((e) => e.source === 'ics-calendar')!;
  assert.ok(entry, 'catalogued');
  assert.deepEqual(entry.credentialModes, ['none']);
  assert.deepEqual(entry.flows, ['checkpoint']);
  assert.ok(entry.configFields.some((f) => f.key === 'url' && f.required));
  const { client, urls } = fake(FEED);
  await runIcsCalendarConnectorCheckpoint(connector(), client, { now: NOW });
  assert.deepEqual(urls, ['https://p12-caldav.icloud.com/published/2/SECRET-TOKEN'], 'the client receives the normalised URL');
});

test('a run emits one event document per occurrence inside the window, with the planner-facing metadata, and records the window in the checkpoint', async () => {
  const out = await runIcsCalendarConnectorCheckpoint(connector({ label: 'Family' }), fake(FEED).client, { now: NOW });
  assert.deepEqual(out.failures, []);
  assert.deepEqual(out.documents.map((d) => d.id), ['daily/2026-09-14T23:00:00.000Z', 'daily/2026-09-15T23:00:00.000Z', 'one', 'daily/2026-09-16T23:00:00.000Z']);
  const dentist = out.documents.find((d) => d.id === 'one')!;
  assert.equal(dentist.kind, 'event');
  assert.equal(dentist.source, 'ics-calendar');
  assert.equal(dentist.connectorId, 'cx_family');
  assert.equal(dentist.title, 'Dentist');
  assert.equal(dentist.metadata.startAt, '2026-09-15T23:00:00.000Z');
  assert.equal(dentist.metadata.endAt, '2026-09-16T00:00:00.000Z');
  assert.equal(dentist.metadata.allDay, false);
  assert.equal(dentist.metadata.location, 'Level 2');
  assert.equal(dentist.metadata.calendarLabel, 'Family', 'the configured label wins over the feed name');
  assert.equal(dentist.metadata.calendarColor, '#FF2D55');
  assert.equal(dentist.metadata.status, 'CONFIRMED');
  assert.equal(typeof dentist.metadata.calendarId, 'string');
  assert.match(dentist.text, /Dentist\nWhere: Level 2/);
  assert.ok(!out.documents.some((d) => d.id === 'ancient'), 'events outside the window are not emitted');
  assert.equal(out.checkpoint.eventCount, 4);
  assert.equal(out.checkpoint.windowStart, '2026-09-07T04:00:00.000Z');
  assert.equal(out.checkpoint.windowEnd, '2026-11-13T04:00:00.000Z');
  assert.equal(out.checkpoint.calendarName, 'Family');
  assert.equal(out.checkpoint.color, '#FF2D55');
  const unlabelled = await runIcsCalendarConnectorCheckpoint(connector(), fake(FEED).client, { now: NOW });
  assert.equal(unlabelled.documents[0]!.metadata.calendarLabel, 'Family (feed)', 'without a label the feed names itself');
});

test('the window knobs are honoured and a cap on events is reported, never silent', async () => {
  const narrow = await runIcsCalendarConnectorCheckpoint(connector({ windowDaysBack: 1, windowDaysAhead: 1 }), fake(FEED).client, { now: NOW });
  assert.deepEqual(narrow.documents.map((d) => d.id), ['daily/2026-09-14T23:00:00.000Z']);
  const capped = await runIcsCalendarConnectorCheckpoint(connector(), fake(FEED).client, { now: NOW, maxEvents: 2 });
  assert.equal(capped.documents.length, 2);
  assert.ok(capped.failures.some((f) => /Stopped after 2 events/.test(f)));
});

test('a feed that is not a calendar, an HTTP failure, or a bad URL is a failure with the secret redacted — and never a throw', async () => {
  const html = await runIcsCalendarConnectorCheckpoint(connector(), fake('<!doctype html><html>calendar page</html>', 200, 'text/html').client, { now: NOW });
  assert.deepEqual(html.documents, []);
  assert.equal(html.failures.length, 1);
  assert.match(html.failures[0]!, /^https:\/\/p12-caldav\.icloud\.com\/…: not an iCalendar feed/);
  assert.ok(!html.failures[0]!.includes('SECRET-TOKEN'), 'the feed secret never appears in a failure');
  assert.equal(html.checkpoint.lastError, html.failures[0]!.split(': ').slice(1).join(': '));
  const down = await runIcsCalendarConnectorCheckpoint(connector(), fake('', 503).client, { now: NOW });
  assert.match(down.failures[0]!, /HTTP 503/);
  await assert.rejects(() => runIcsCalendarConnectorCheckpoint(connector({ url: 'ftp://x/y.ics' }), fake(FEED).client), /must be https/);
  await assert.rejects(() => runIcsCalendarConnectorCheckpoint({ ...connector(), source: 'github' } as ConnectorRecord, fake(FEED).client), /is not ics-calendar/);
  const google = await runIcsCalendarConnectorCheckpoint(connector({ url: 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics' }), fake('', 404).client, { now: NOW });
  assert.match(google.failures[0]!, /^https:\/\/calendar\.google\.com\/…: HTTP 404$/, 'a Google secret address is redacted to its host');
});

test('the runtime feed client sends a calendar Accept header and follows the normalised URL', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return new Response(FEED, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' } });
  }) as unknown as typeof fetch;
  const res = await icsFeedClient({ fetchImpl }).fetchText('webcal://example.com/cal.ics');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/calendar/);
  assert.equal(seen!.url, 'https://example.com/cal.ics');
  assert.match(String((seen!.init.headers as Record<string, string>).Accept), /text\/calendar/);
});

/* ------------------------------------- an import is a subscription that ran once */

test('an imported file is read from the host, parsed identically, and never touches the network', async () => {
  const reads: string[] = [];
  const imported = connector({ url: undefined, mode: 'file', file: 'cx_family.ics', fileName: 'timetable.ics' });
  const net = fake('SHOULD NOT BE FETCHED');
  const out = await runIcsCalendarConnectorCheckpoint(imported, {
    ...net.client,
    readImported: async (ref) => { reads.push(ref); return FEED; },
  }, { now: NOW });

  assert.deepEqual(net.urls, [], 'an imported calendar makes no request');
  assert.deepEqual(reads, ['cx_family.ics']);
  assert.deepEqual(out.failures, []);
  assert.equal(out.documents.length, 4, 'the same parse as the feed above');
  assert.equal(out.checkpoint.importedFile, 'timetable.ics', 'the checkpoint names the file the person chose');
});

test('an imported calendar a host cannot read says so, in the file\'s name and never a path', async () => {
  const imported = connector({ url: undefined, mode: 'file', file: 'cx_family.ics', fileName: 'timetable.ics' });
  const noReader = await runIcsCalendarConnectorCheckpoint(imported, fake('').client, { now: NOW });
  assert.equal(noReader.documents.length, 0);
  assert.match(noReader.failures[0]!, /^timetable\.ics: this host cannot read imported calendar files$/);
  assert.match(String(noReader.checkpoint.lastError), /cannot read imported/);

  const notCalendar = await runIcsCalendarConnectorCheckpoint(imported, {
    ...fake('').client,
    readImported: async () => 'Subject,Start\nMaths,9am',
  }, { now: NOW });
  assert.match(notCalendar.failures[0]!, /not an iCalendar file\. Export the calendar again as \.ics\./);
});

test('a stored reference is a plain file name — a path is refused rather than followed', async () => {
  for (const ref of ['../../../etc/passwd', '/etc/passwd', 'a/b.ics', '']) {
    await assert.rejects(
      () => runIcsCalendarConnectorCheckpoint(
        connector({ url: undefined, mode: 'file', file: ref }),
        { ...fake('').client, readImported: async () => FEED },
        { now: NOW },
      ),
      /plain file name|has no stored file/,
      `refused: ${ref || '(empty)'}`,
    );
  }
  // And the client refuses independently of the runner, for a host that calls it directly.
  await assert.rejects(() => icsFeedClient({ importedRoot: '/tmp' }).readImported!('../x'), /plain file name/);
});
