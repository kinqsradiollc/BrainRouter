/**
 * ADR-060 D3 — calendar events projected into planner items and time blocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorDocumentRecord } from '@kinqs/brainrouter-types';
import {
  connectorEventToProjection,
  projectConnectorEvents,
  type ConnectorEventProjectionInput,
} from '../planner/connectorEventAdapter.js';

const SEEN = '2026-09-14T04:00:00.000Z';

function input(over: Partial<ConnectorEventProjectionInput> = {}): ConnectorEventProjectionInput {
  return { connectorId: 'cx_work', source: 'ics-calendar', sourceLabel: 'Work', documents: [], ...over };
}

function doc(over: Partial<ConnectorDocumentRecord> = {}, metadata: Record<string, unknown> = {}): ConnectorDocumentRecord {
  return {
    id: 'standup@google.com/2026-09-15T23:00:00.000Z',
    connectorId: 'cx_work',
    source: 'ics-calendar',
    kind: 'event',
    title: 'Standup',
    updatedAt: '2026-09-13T06:00:00.000Z',
    text: 'Standup',
    firstSeenAt: SEEN,
    lastSeenAt: SEEN,
    ...over,
    metadata: {
      startAt: '2026-09-15T23:00:00.000Z',
      endAt: '2026-09-15T23:30:00.000Z',
      allDay: false,
      timeZone: 'Australia/Melbourne',
      status: 'CONFIRMED',
      calendarId: 'abc',
      calendarLabel: 'Work · Google',
      uid: 'standup@google.com',
      ...metadata,
    },
  } as ConnectorDocumentRecord;
}

test('a timed event becomes a mirrored item on its OWN day plus a source-owned block at its start', () => {
  const projected = connectorEventToProjection(input(), doc())!;
  assert.ok(projected, 'projected');
  const { item, block } = projected;
  assert.equal(item.origin, 'mirrored');
  assert.equal(item.source, 'connector:cx_work');
  assert.equal(item.title.value, 'Standup');
  // 23:00Z is 9am the NEXT day in Melbourne — the day the person will have it.
  assert.equal(item.dueDate?.value, '2026-09-16');
  assert.equal(item.fetchedAt, SEEN);
  assert.equal(item.provenance?.sourceLabel, 'Work · Google', 'the calendar names itself on every event');
  assert.equal(item.provenance?.externalId, 'standup@google.com/2026-09-15T23:00:00.000Z');
  assert.equal(item.completed, undefined, 'attending is the person\'s act, never the calendar\'s');
  assert.equal(item.estimateMinutes, undefined, 'the block carries the duration');
  assert.equal(item.deletedAt, undefined);
  assert.ok(block, 'a timed event is blocked out');
  assert.equal(block!.itemId, item.id);
  assert.equal(block!.scheduledFor, '2026-09-15T23:00:00.000Z');
  assert.equal(block!.estimateMinutes, 30);
  assert.equal(block!.carriedOver, 0);
  // The stamp comes from the SOURCE's own revision, not from our clock.
  assert.equal(item.title.at.physical, Date.parse('2026-09-13T06:00:00.000Z'));
  assert.equal(item.title.at.deviceId, 'source:cx_work');
});

test('an all-day event has a day and no block — no invented hour on the calendar, no made-up minutes against the day', () => {
  const holiday = doc({ id: 'bday', title: "Mum's birthday" }, { startAt: '2026-09-19T00:00:00.000Z', endAt: '2026-09-20T00:00:00.000Z', allDay: true, timeZone: undefined });
  const { item, block } = connectorEventToProjection(input(), holiday)!;
  assert.equal(item.dueDate?.value, '2026-09-19');
  assert.equal(block, undefined);
});

test('a cancelled event is a tombstone, not a silent skip, and carries no block', () => {
  const { item, block } = connectorEventToProjection(input(), doc({ id: 'off' }, { status: 'CANCELLED' }))!;
  assert.ok(item.deletedAt, 'the feed says the meeting is off, so the planner records that');
  assert.equal(item.deletedAt!.deviceId, 'source:cx_work');
  assert.equal(block, undefined);
});

test('an event with no positive span is an item without a block', () => {
  assert.equal(connectorEventToProjection(input(), doc({ id: 'z' }, { endAt: '2026-09-15T23:00:00.000Z' }))!.block, undefined);
  assert.equal(connectorEventToProjection(input(), doc({ id: 'y' }, { endAt: undefined }))!.block, undefined);
  assert.equal(connectorEventToProjection(input(), doc({ id: 'x' }, { endAt: '2026-09-16T00:30:00.000Z' }))!.block!.estimateMinutes, 90);
  assert.equal(connectorEventToProjection(input(), doc({ id: 'w' }, { endAt: 'nonsense' }))!.block, undefined);
});

test('notes carry where and what, never a description that only repeats the title, and never an unbounded agenda', () => {
  const withBoth = connectorEventToProjection(input(), doc({ id: 'a' }, { location: 'Level 3, Room B', description: 'Bring the numbers.' }))!;
  assert.equal(withBoth.item.notes?.value, 'Where: Level 3, Room B\n\nBring the numbers.');
  const echo = connectorEventToProjection(input(), doc({ id: 'b', text: 'Standup' }, { location: undefined }))!;
  assert.equal(echo.item.notes, undefined, 'a description identical to the title adds nothing');
  const huge = connectorEventToProjection(input(), doc({ id: 'c' }, { description: 'x'.repeat(5_000) }))!;
  assert.equal(huge.item.notes!.value.length, 2_000);
});

test('ids are stable across runs, distinct per connector and per occurrence, and the block hangs off its item', () => {
  const first = connectorEventToProjection(input(), doc())!;
  const again = connectorEventToProjection(input(), doc({ lastSeenAt: '2026-09-20T00:00:00.000Z' }))!;
  assert.equal(first.item.id, again.item.id, 'a re-read updates the same item');
  assert.equal(first.block!.id, again.block!.id);
  const other = connectorEventToProjection(input({ connectorId: 'cx_family' }), doc({ connectorId: 'cx_family' }))!;
  assert.notEqual(other.item.id, first.item.id, 'two calendars carrying the same UID are two items');
  const nextOccurrence = connectorEventToProjection(input(), doc({ id: 'standup@google.com/2026-09-16T23:00:00.000Z' }))!;
  assert.notEqual(nextOccurrence.item.id, first.item.id, 'each occurrence is its own item');
  assert.equal(first.block!.itemId, first.item.id);
});

test('anything that is not a usable event from this source is refused', () => {
  assert.equal(connectorEventToProjection(input(), doc({ kind: 'issue' })), null);
  assert.equal(connectorEventToProjection(input(), doc({ source: 'github' })), null);
  assert.equal(connectorEventToProjection(input({ source: 'github' }), doc({ source: 'github' })), null);
  assert.equal(connectorEventToProjection(input(), doc({ title: '   ' })), null);
  assert.equal(connectorEventToProjection(input(), doc({}, { startAt: undefined })), null);
  assert.equal(connectorEventToProjection(input(), doc({}, { startAt: 'not a date' })), null);
});

test('the day is read in the event\'s own zone, and falls back rather than throwing', () => {
  const dayOf = (metadata: Record<string, unknown>) =>
    connectorEventToProjection(input(), doc({ id: `d-${JSON.stringify(metadata)}` }, metadata))?.item.dueDate?.value;
  assert.equal(dayOf({}), '2026-09-16', '9am Melbourne is the next day from 23:00Z');
  assert.equal(dayOf({ timeZone: 'America/Los_Angeles' }), '2026-09-15');
  assert.equal(dayOf({ timeZone: undefined }), '2026-09-15', 'no zone: the instant\'s own date');
  assert.equal(dayOf({ timeZone: 'Nowhere/Land' }), '2026-09-15', 'an unknown zone falls back rather than throwing');
  assert.equal(dayOf({ allDay: true, startAt: '2026-09-19T00:00:00.000Z', timeZone: undefined }), '2026-09-19');
});

test('the run projects every usable document and carries each one\'s freshness', () => {
  const documents = [
    doc({ id: '1' }),
    doc({ id: '2', kind: 'issue' }),
    doc({ id: '3', lastSeenAt: '2026-09-14T05:00:00.000Z' }, { allDay: true, startAt: '2026-09-20T00:00:00.000Z' }),
  ];
  const projected = projectConnectorEvents(input({ documents }));
  assert.deepEqual(projected.map((p) => p.item.title.value), ['Standup', 'Standup']);
  assert.deepEqual(projected.map((p) => Boolean(p.block)), [true, false]);
  assert.deepEqual(projected.map((p) => p.item.fetchedAt), [SEEN, '2026-09-14T05:00:00.000Z'],
    'each item carries when its own document was last seen — the freshness both surfaces read');
});
