// ADR-041 A41-16 (W4) — session-native reminders: the catch-up policy, the store,
// and the turn-boundary delivery tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadReminders,
  addReminder,
  removeReminder,
  setReminderEnabled,
  advanceReminder,
  collectDueReminders,
  renderReminderSystemMessage,
  type ReminderRecord,
  type ReminderTrigger,
} from '../session/reminders/reminderStore.js';
import { reminderHandlers } from '../extension/builtin/handlers/reminder.js';

const HOUR = 3_600_000;
const MIN = 60_000;

function rec(over: Partial<ReminderRecord> & { trigger: ReminderTrigger; nextFireAt: string }): ReminderRecord {
  return {
    id: 'rem_test' as ReminderRecord['id'],
    message: 'do the thing',
    createdAt: new Date(0).toISOString(),
    enabled: true,
    ...over,
  };
}

/* ------------------------------------------------- catch-up projection */

test('A41-16 — a once reminder in the past fires exactly once; a future one does not', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const past = collectDueReminders([rec({ trigger: { kind: 'once', fireAt: new Date(now - MIN).toISOString() }, nextFireAt: new Date(now - MIN).toISOString() })], now);
  assert.equal(past.length, 1);
  assert.equal(past[0]!.kind, 'fire-once');
  const future = collectDueReminders([rec({ trigger: { kind: 'once', fireAt: new Date(now + MIN).toISOString() }, nextFireAt: new Date(now + MIN).toISOString() })], now);
  assert.deepEqual(future, []);
});

test('A41-16 — a recurring rule N windows behind coalesces to ONE fire at the LATEST due edge', () => {
  const now = Date.parse('2026-08-20T12:00:30.000Z'); // 30s past the 12:00 edge
  // nextFireAt is 3 minutes behind: 11:57. A per-minute rule missed 11:57/58/59/12:00.
  const r = rec({ trigger: { kind: 'recurring', cron: '* * * * *' }, nextFireAt: '2026-08-20T11:57:00.000Z' });
  const out = collectDueReminders([r], now);
  assert.equal(out.length, 1);
  const o = out[0]!;
  assert.equal(o.kind, 'fire-recurring');
  if (o.kind !== 'fire-recurring') return;
  assert.equal(o.occurrence, '2026-08-20T12:00:00.000Z', 'latest edge <= now, not the earliest missed one');
  assert.equal(o.nextFireAt, '2026-08-20T12:01:00.000Z', 'next edge strictly after now');
});

test('A41-16 — a disabled record is never projected, whatever its nextFireAt', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const r = rec({ enabled: false, trigger: { kind: 'once', fireAt: new Date(now - HOUR).toISOString() }, nextFireAt: new Date(now - HOUR).toISOString() });
  assert.deepEqual(collectDueReminders([r], now), []);
});

test('A41-16 — an unparseable recurring rule yields disable, never a fire and never a throw', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const r = rec({ trigger: { kind: 'recurring', cron: 'not a cron' }, nextFireAt: new Date(now - MIN).toISOString() });
  const out = collectDueReminders([r], now);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'disable');
});

test('A41-16 — a rule exactly at the walk cap (1440 windows) keeps its true edge, not now', () => {
  // Regression for the overflow-snap boundary: at exactly MAX_CATCHUP_STEPS the walk
  // finishes NATURALLY (probe > now), so the occurrence must stay the greatest edge
  // <= now, never be clobbered with `now`.
  const now = Date.parse('2026-08-20T12:00:30.000Z'); // 30s past the 12:00 edge
  const r = rec({ trigger: { kind: 'recurring', cron: '* * * * *' }, nextFireAt: '2026-08-19T12:00:00.000Z' }); // exactly 1440 min back
  const out = collectDueReminders([r], now);
  assert.equal(out.length, 1);
  const o = out[0]!;
  assert.equal(o.kind, 'fire-recurring');
  if (o.kind !== 'fire-recurring') return;
  assert.equal(o.occurrence, '2026-08-20T12:00:00.000Z', 'greatest edge <= now, NOT snapped to now');
  assert.equal(o.nextFireAt, '2026-08-20T12:01:00.000Z');
});

test('A41-16 — a rule dormant far beyond the cap snaps to now with a bounded walk (no spin)', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  // per-minute rule whose nextFireAt is a year behind → millions of windows.
  const r = rec({ trigger: { kind: 'recurring', cron: '* * * * *' }, nextFireAt: '2025-08-20T12:00:00.000Z' });
  const start = Date.now();
  const out = collectDueReminders([r], now);
  assert.ok(Date.now() - start < 1000, 'the walk is bounded, not a year of minute-steps');
  assert.equal(out.length, 1);
  const o = out[0]!;
  assert.equal(o.kind, 'fire-recurring');
  if (o.kind !== 'fire-recurring') return;
  assert.equal(o.occurrence, new Date(now).toISOString(), 'snaps to now');
  assert.ok(Date.parse(o.nextFireAt) > now, 'next strictly after now');
});

test('A41-16 — collectDueReminders is pure: identical outcomes across repeated calls', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const records = [rec({ trigger: { kind: 'recurring', cron: '0 * * * *' }, nextFireAt: '2026-08-20T11:00:00.000Z' })];
  const a = collectDueReminders(records, now);
  const b = collectDueReminders(records, now);
  assert.deepEqual(a, b);
});

/* ------------------------------------------------- renderer */

test('A41-16 — N due reminders render into ONE <system-reminder id="reminders"> block', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const out = collectDueReminders([
    rec({ id: 'rem_a' as ReminderRecord['id'], message: 'alpha', trigger: { kind: 'once', fireAt: new Date(now - MIN).toISOString() }, nextFireAt: new Date(now - MIN).toISOString() }),
    rec({ id: 'rem_b' as ReminderRecord['id'], message: 'beta', trigger: { kind: 'once', fireAt: new Date(now - MIN).toISOString() }, nextFireAt: new Date(now - MIN).toISOString() }),
  ], now);
  const body = renderReminderSystemMessage(out)!;
  assert.equal((body.match(/<system-reminder id="reminders">/g) ?? []).length, 1);
  assert.equal((body.match(/<\/system-reminder>/g) ?? []).length, 1);
  assert.ok(body.includes('alpha') && body.includes('beta'));
});

test('A41-16 — a render with only disable outcomes is undefined (nothing deliverable)', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const out = collectDueReminders([rec({ trigger: { kind: 'recurring', cron: 'bad' }, nextFireAt: new Date(now - MIN).toISOString() })], now);
  assert.equal(renderReminderSystemMessage(out), undefined);
});

/* ------------------------------------------------- store round-trip + fail-loud */

test('A41-16 — store round-trip: add persists, remove/enable/advance mutate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const sk = 'sess-1';
  const r = addReminder(dir, sk, { trigger: { kind: 'once', fireAt: '2026-08-20T12:00:00.000Z' }, message: 'x', nextFireAt: '2026-08-20T12:00:00.000Z' });
  assert.deepEqual(loadReminders(dir, sk).map((x) => x.id), [r.id]);
  assert.equal(setReminderEnabled(dir, sk, r.id, false), true);
  assert.equal(loadReminders(dir, sk)[0]!.enabled, false);
  assert.equal(advanceReminder(dir, sk, r.id, '2026-08-20T13:00:00.000Z', '2026-08-20T12:00:00.000Z'), true);
  assert.equal(loadReminders(dir, sk)[0]!.nextFireAt, '2026-08-20T13:00:00.000Z');
  assert.equal(removeReminder(dir, sk, r.id), true);
  assert.equal(removeReminder(dir, sk, r.id), false);
  assert.deepEqual(loadReminders(dir, sk), []);
});

test('A41-16 — loadReminders fails loud and inert on a corrupt persisted record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const sk = 'sess-2';
  addReminder(dir, sk, { trigger: { kind: 'recurring', cron: '* * * * *' }, message: 'ok', nextFireAt: '2026-08-20T12:00:00.000Z' });
  // A record whose cron and nextFireAt are both unusable — persisted verbatim by
  // addReminder (which does not validate), then caught at load.
  const bad = addReminder(dir, sk, { trigger: { kind: 'recurring', cron: 'nonsense' }, message: 'bad', nextFireAt: 'not-a-date' });
  const reloaded = loadReminders(dir, sk);
  const badReloaded = reloaded.find((r) => r.id === bad.id)!;
  assert.equal(badReloaded.enabled, false, 'corrupt record forced inert');
  assert.deepEqual(
    collectDueReminders(reloaded, Date.parse('2026-08-20T13:00:00.000Z')).filter((o) => o.record.id === bad.id),
    [],
    'excluded from the due projection',
  );
});

/* ------------------------------------------------- handler (resolve → spec, errors-as-fields) */

async function callRemind(args: Record<string, unknown>, dir: string, sk: string): Promise<any> {
  const out = await reminderHandlers.remind!({ args, host: { workspaceRoot: dir, sessionKey: sk } as any } as any);
  return JSON.parse(out);
}

test('A41-16 — remind:set validates via errors-as-fields, never throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const sk = 'sess-h';
  assert.equal((await callRemind({ action: 'set' }, dir, sk)).error, 'missing-message');
  assert.equal((await callRemind({ action: 'set', message: 'x' }, dir, sk)).error, 'missing-schedule');
  assert.equal((await callRemind({ action: 'set', message: 'x', at: '2027-01-01T00:00:00Z', in: '5m' }, dir, sk)).error, 'ambiguous-schedule');
  assert.equal((await callRemind({ action: 'set', message: 'x', every: 'nope' }, dir, sk)).error, 'invalid-cron');
  assert.equal((await callRemind({ action: 'set', message: 'x', at: 'not-a-time' }, dir, sk)).error, 'invalid-time');
  assert.equal((await callRemind({ action: 'set', message: 'x', at: '2000-01-01T00:00:00Z' }, dir, sk)).error, 'time-in-past');
  assert.equal((await callRemind({ action: 'set', message: 'x', in: 'abc' }, dir, sk)).error, 'invalid-duration');
  // An out-of-range duration must be an error field, never an uncaught RangeError.
  assert.equal((await callRemind({ action: 'set', message: 'x', in: '99999999999999d' }, dir, sk)).error, 'invalid-duration');
  assert.equal((await callRemind({ action: 'whoops' }, dir, sk)).error, 'unknown-action');
});

test('A41-16 — a session is capped at 100 reminders (error field, not a throw)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const sk = 'sess-cap';
  for (let i = 0; i < 100; i++) {
    const r = await callRemind({ action: 'set', message: `r${i}`, in: '1h' }, dir, sk);
    assert.equal(r.ok, true);
  }
  const over = await callRemind({ action: 'set', message: 'one too many', in: '1h' }, dir, sk);
  assert.equal(over.ok, false);
  assert.equal(over.error, 'too-many-reminders');
  assert.equal((await callRemind({ action: 'list' }, dir, sk)).reminders.length, 100);
});

test('A41-16 — remind:set then list then cancel round-trips through the session store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
  const sk = 'sess-h2';
  const set = await callRemind({ action: 'set', message: 'check build', in: '30m' }, dir, sk);
  assert.equal(set.ok, true);
  assert.equal(set.recurs, false);
  assert.ok(typeof set.id === 'string');
  const every = await callRemind({ action: 'set', message: 'hourly', every: '0 * * * *' }, dir, sk);
  assert.equal(every.recurs, true);
  const list = await callRemind({ action: 'list' }, dir, sk);
  assert.equal(list.reminders.length, 2);
  const cancel = await callRemind({ action: 'cancel', id: set.id }, dir, sk);
  assert.equal(cancel.ok, true);
  assert.equal((await callRemind({ action: 'cancel', id: set.id }, dir, sk)).error, 'not-found');
  assert.equal((await callRemind({ action: 'list' }, dir, sk)).reminders.length, 1);
});
