import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCron, nextCronFire } from '../runtime/cronParser.js';
import { startScheduleTicker } from '../runtime/scheduleTicker.js';
import {
  addSchedule,
  loadSchedules,
  removeSchedule,
  setScheduleEnabled,
} from '../state/scheduleStore.js';
import { withTempWorkspace } from './_helpers.js';

// --- Parser --------------------------------------------------------------

test('parseCron accepts the basic shapes', () => {
  assert.ok(parseCron('* * * * *'));
  assert.ok(parseCron('0 9 * * 1-5'));
  assert.ok(parseCron('*/15 * * * *'));
  assert.ok(parseCron('1,15,30 * * * *'));
  assert.ok(parseCron('0-30/10 * * * *'));
  assert.ok(parseCron('  0   12   1   *   *  '));
});

test('parseCron rejects malformed input', () => {
  assert.equal(parseCron(''), undefined);
  assert.equal(parseCron('* * * *'), undefined, 'too few fields');
  assert.equal(parseCron('* * * * * *'), undefined, 'too many fields');
  assert.equal(parseCron('60 * * * *'), undefined, 'minute out of range');
  assert.equal(parseCron('* 24 * * *'), undefined, 'hour out of range');
  assert.equal(parseCron('* * 0 * *'), undefined, 'dom < 1');
  assert.equal(parseCron('* * * 13 *'), undefined, 'month > 12');
  assert.equal(parseCron('* * * * 8'), undefined, 'dow > 7');
  assert.equal(parseCron('abc * * * *'), undefined);
  assert.equal(parseCron('*/0 * * * *'), undefined, 'step must be >= 1');
  assert.equal(parseCron('5-3 * * * *'), undefined, 'inverted range');
});

test('parseCron expands fields correctly', () => {
  const c = parseCron('*/15 * * * *');
  assert.deepEqual([...c!.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  const list = parseCron('1,15,30 * * * *');
  assert.deepEqual([...list!.minute].sort((a, b) => a - b), [1, 15, 30]);
  const range = parseCron('0 9 * * 1-5');
  assert.deepEqual([...range!.dow].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  const sunday = parseCron('0 9 * * 0,7');
  assert.deepEqual([...sunday!.dow], [0], '7 should normalize to 0');
});

// --- Next-fire -----------------------------------------------------------

test('nextCronFire for */2 hits 2,4,6 minutes', () => {
  const cron = parseCron('*/2 * * * *')!;
  // Start at 2026-01-01T00:00:00 (a Thursday — irrelevant for */2)
  const start = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const a = nextCronFire(cron, start);
  const b = nextCronFire(cron, a);
  const c = nextCronFire(cron, b);
  assert.equal(a.getUTCMinutes() % 2, 0);
  assert.equal(b.getTime() - a.getTime(), 2 * 60 * 1000);
  assert.equal(c.getTime() - b.getTime(), 2 * 60 * 1000);
});

test('nextCronFire produces strictly future times', () => {
  const cron = parseCron('30 14 * * *')!;
  const at = new Date(2026, 4, 1, 14, 30, 0, 0);
  const next = nextCronFire(cron, at);
  assert.ok(next.getTime() > at.getTime(), 'must skip the boundary minute');
});

test('nextCronFire for weekday 9am skips weekends', () => {
  const cron = parseCron('0 9 * * 1-5')!;
  // Saturday 2026-05-30
  const sat = new Date(2026, 4, 30, 0, 0, 0, 0);
  const next = nextCronFire(cron, sat);
  // Monday 2026-06-01 at 9am local
  assert.equal(next.getDay(), 1, 'should land on Monday');
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

// --- Store ---------------------------------------------------------------

test('scheduleStore round-trip: add / list / disable / remove', () => {
  withTempWorkspace((ws) => {
    const rec = addSchedule(ws, {
      kind: 'cron',
      expr: '*/2 * * * *',
      command: '/agents',
      owner: 'session-A',
      nextRun: new Date(Date.now() + 60_000).toISOString(),
    });
    let list = loadSchedules(ws);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, rec.id);
    assert.equal(list[0].enabled, true);

    assert.equal(setScheduleEnabled(ws, rec.id, false), true);
    list = loadSchedules(ws);
    assert.equal(list[0].enabled, false);

    assert.equal(removeSchedule(ws, rec.id), true);
    assert.equal(loadSchedules(ws).length, 0);
    assert.equal(removeSchedule(ws, 'nope'), false);
  });
});

// --- Ticker --------------------------------------------------------------

test('ticker fires */2 cron exactly at minutes 2, 4, 6 — no doubles, no misses', () => {
  withTempWorkspace((ws) => {
    const sessionKey = 'session-T';
    let nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const cron = parseCron('*/2 * * * *')!;
    const firstFire = nextCronFire(cron, new Date(nowMs));
    addSchedule(ws, {
      kind: 'cron',
      expr: '*/2 * * * *',
      command: '/agents',
      owner: sessionKey,
      nextRun: firstFire.toISOString(),
    });

    const fires: number[] = [];
    const ticker = startScheduleTicker({
      workspaceRoot: ws,
      sessionKey,
      fire: () => { fires.push(nowMs); },
      intervalMs: 1_000_000, // disable the internal setTimeout; we drive scans manually
      now: () => nowMs,
    });

    // Step the simulated clock minute-by-minute for 5 minutes from 12:00.
    // Cron rule: next-fire is strictly future, so 12:00 itself never matches
    // when we start AT 12:00. Expect fires at 12:02, 12:04, 12:06.
    for (let i = 0; i <= 6; i++) {
      nowMs = Date.UTC(2026, 0, 1, 12, i, 30);
      ticker.tickNow();
    }
    ticker.stop();

    const minutes = fires.map((ms) => new Date(ms).getUTCMinutes()).sort((a, b) => a - b);
    assert.deepEqual(minutes, [2, 4, 6], `fires at minutes ${minutes.join(',')}`);
  });
});

test('ticker only fires schedules owned by this sessionKey', () => {
  withTempWorkspace((ws) => {
    addSchedule(ws, {
      kind: 'once',
      expr: new Date(Date.now() - 1000).toISOString(),
      command: '/agents',
      owner: 'other-session',
      nextRun: new Date(Date.now() - 1000).toISOString(),
    });
    const fires: string[] = [];
    const ticker = startScheduleTicker({
      workspaceRoot: ws,
      sessionKey: 'my-session',
      fire: (cmd) => fires.push(cmd),
      intervalMs: 1_000_000,
    });
    ticker.tickNow();
    ticker.stop();
    assert.deepEqual(fires, []);
  });
});

test('ticker removes one-shot after firing', () => {
  withTempWorkspace((ws) => {
    const rec = addSchedule(ws, {
      kind: 'once',
      expr: new Date(Date.now() - 1000).toISOString(),
      command: '/agents',
      owner: 'me',
      nextRun: new Date(Date.now() - 1000).toISOString(),
    });
    const fires: string[] = [];
    const ticker = startScheduleTicker({
      workspaceRoot: ws,
      sessionKey: 'me',
      fire: (cmd) => fires.push(cmd),
      intervalMs: 1_000_000,
    });
    ticker.tickNow();
    ticker.stop();
    assert.deepEqual(fires, ['/agents']);
    assert.equal(loadSchedules(ws).find((s) => s.id === rec.id), undefined);
  });
});
