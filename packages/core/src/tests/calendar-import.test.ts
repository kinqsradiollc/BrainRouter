/**
 * ADR-060 D4 — what may be imported, and where it goes.
 *
 * The rules live beside the runner rather than in whichever surface offers the
 * button, because the two ends have to agree: one writes the file, the other
 * reads it back by the same reference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calendarImportDir, importedCalendarRef, planCalendarImport, MAX_IMPORTED_CALENDAR_BYTES } from '../connectors/sources/calendarImport.js';
import { getStateDir } from '../storage/store.js';

const ICS = ['BEGIN:VCALENDAR', 'X-WR-CALNAME:Semester 2\\, 2026', 'BEGIN:VEVENT', 'UID:a', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test('a chosen calendar is stored under its connector, and takes its name from the calendar rather than the file', () => {
  const out = planCalendarImport({ fileName: '/Users/someone/Downloads/export (1).ics', contents: ICS });
  assert.ok(out.ok);
  assert.deepEqual(out.plan, { fileName: 'export (1).ics', label: 'Semester 2, 2026' });
  assert.equal(importedCalendarRef('conn_1a2b3c4d'), 'conn_1a2b3c4d.ics');
  // No X-WR-CALNAME: the file's own name, without the extension.
  const plain = planCalendarImport({ fileName: 'timetable.ics', contents: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' });
  assert.equal(plain.ok && plain.plan.label, 'timetable');
});

test('a file that is not a calendar is answered, not thrown at', () => {
  const csv = planCalendarImport({ fileName: 'timetable.csv', contents: 'Subject,Start\nMaths,9am' });
  assert.equal(csv.ok, false);
  assert.match(csv.ok === false ? csv.error : '', /timetable\.csv is not an iCalendar file/);

  const huge = planCalendarImport({ fileName: 'all.ics', contents: `BEGIN:VCALENDAR${'x'.repeat(MAX_IMPORTED_CALENDAR_BYTES)}` });
  assert.equal(huge.ok, false);
  assert.match(huge.ok === false ? huge.error : '', /the limit is 8 MB\. Export a narrower date range\./);

  assert.equal(planCalendarImport({ fileName: '   ', contents: ICS }).ok, false);
});

test('the reference can only ever be a plain file name, whatever the connector id claims to be', () => {
  for (const connectorId of ['../escape', 'a/b', '', '.hidden']) {
    assert.throws(() => importedCalendarRef(connectorId), /cannot be stored under connector id/, connectorId || '(empty)');
  }
});

test('an imported calendar lives beside the connector record that reads it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-calendar-import-'));
  try {
    const dir = calendarImportDir(root);
    // `connectors.json` is written into the state directory; the calendar the
    // connector reads sits one folder down from it, so removing the workspace's
    // state removes both together.
    assert.equal(path.basename(dir), 'calendars');
    assert.equal(path.dirname(dir), getStateDir(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
