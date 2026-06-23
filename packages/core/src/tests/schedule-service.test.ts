import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScheduleService, ScheduleService } from '../schedule/service.js';
import { loadSchedules } from '../schedule/scheduleStore.js';
import { parseCron, nextCronFire } from '../schedule/cronParser.js';

test('ScheduleService is a per-workspace facade — delegates to store + cron parser', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-svc-'));
  try {
    const svc = createScheduleService(ws);
    assert.ok(svc instanceof ScheduleService);

    // cron helpers (pure delegation)
    assert.deepEqual(svc.parseCron('0 9 * * *'), parseCron('0 9 * * *'));
    const cron = parseCron('0 9 * * *');
    if (cron) {
      const after = new Date('2026-01-01T00:00:00.000Z');
      assert.deepEqual(svc.nextFire(cron, after), nextCronFire(cron, after));
    }

    // store ops — fresh workspace starts empty, then round-trips through the store
    assert.deepEqual(svc.list(), loadSchedules(ws));
    assert.equal(svc.list().length, 0);

    const rec = svc.add({ kind: 'cron', expr: '0 9 * * *', command: '/recap', owner: 'tester', nextRun: '2026-01-02T09:00:00.000Z' });
    assert.ok(rec.id.startsWith('sch_'));
    assert.deepEqual(svc.list(), loadSchedules(ws)); // service view == raw store
    assert.ok(svc.list().some((s) => s.id === rec.id));

    assert.equal(svc.setEnabled(rec.id, false), true);
    assert.equal(svc.list().find((s) => s.id === rec.id)?.enabled, false);
    assert.equal(svc.remove(rec.id), true);
    assert.equal(svc.list().length, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
