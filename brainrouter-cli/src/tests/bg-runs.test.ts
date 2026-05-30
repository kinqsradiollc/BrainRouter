import test from 'node:test';
import assert from 'node:assert/strict';
import { BgRunRegistry, formatBgRuns } from '../runtime/bgRuns.js';

test('CLI-4 BgRunRegistry: lifecycle running → done/failed/stopped', () => {
  const reg = new BgRunRegistry();
  reg.start('r1', 'refactor', 1000);
  reg.start('r2', 'tests', 1000);
  reg.start('r3', 'build', 1000);
  assert.equal(reg.running().length, 3);

  assert.equal(reg.markDone('r1', 5000), true);
  assert.equal(reg.markFailed('r2', 6000, 'boom'), true);
  assert.equal(reg.markStopped('r3', 7000), true);
  assert.equal(reg.running().length, 0);
  assert.equal(reg.get('r1')!.status, 'done');
  assert.equal(reg.get('r2')!.error, 'boom');
});

test('CLI-4 BgRunRegistry: terminal/unknown transitions are no-ops', () => {
  const reg = new BgRunRegistry();
  reg.start('r1', 'x', 1000);
  reg.markDone('r1', 2000);
  assert.equal(reg.markFailed('r1', 3000, 'late'), false, 'already terminal');
  assert.equal(reg.markDone('ghost', 3000), false, 'unknown id');
  assert.equal(reg.get('r1')!.status, 'done');
});

test('CLI-4 formatBgRuns: glyphs + durations (injected now) + empty', () => {
  assert.deepEqual(formatBgRuns([], 0), ['No background runs.']);
  const reg = new BgRunRegistry();
  reg.start('r1', 'refactor', 1000);
  reg.markFailed('r1', 4000, 'oops');
  reg.start('r2', 'tests', 2000); // still running
  const out = formatBgRuns(reg.list(), 9000).join('\n');
  assert.match(out, /✗ r1 {2}failed · 3s · refactor — oops/);
  assert.match(out, /▶ r2 {2}running · 7s · tests/); // 9000-2000 = 7s
});
