import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackgroundTarget, describeStopOutcome } from '../runtime/background/bgDetach.js';

const workers = [
  { id: 'wkr_abc', status: 'running', role: 'worker' },
  { id: 'wkr_done', status: 'completed', role: 'worker' },
];
const agents = [
  { id: 'agent-1', status: 'running', role: 'explorer' },
  { id: 'agent-2', status: 'completed', role: 'reviewer' },
  { id: 'agent-3', status: 'pending', role: 'worker' },
];

test('CLI-BG-DETACH resolveBackgroundTarget: matches a running worker', () => {
  const t = resolveBackgroundTarget('wkr_abc', workers, agents);
  assert.equal(t.kind, 'worker');
  assert.equal(t.active, true);
  assert.equal(t.role, 'worker');
});

test('CLI-BG-DETACH resolveBackgroundTarget: a completed worker is resolved but inactive', () => {
  const t = resolveBackgroundTarget('wkr_done', workers, agents);
  assert.equal(t.kind, 'worker');
  assert.equal(t.active, false);
});

test('CLI-BG-DETACH resolveBackgroundTarget: pending + running agents are active, completed is not', () => {
  assert.equal(resolveBackgroundTarget('agent-1', workers, agents).active, true);
  assert.equal(resolveBackgroundTarget('agent-3', workers, agents).active, true);
  const done = resolveBackgroundTarget('agent-2', workers, agents);
  assert.equal(done.kind, 'agent');
  assert.equal(done.active, false);
});

test('CLI-BG-DETACH resolveBackgroundTarget: unknown / empty id', () => {
  assert.equal(resolveBackgroundTarget('nope', workers, agents).kind, 'unknown');
  assert.equal(resolveBackgroundTarget('', workers, agents).kind, 'unknown');
  assert.equal(resolveBackgroundTarget('  ', workers, agents).kind, 'unknown');
});

test('CLI-BG-DETACH resolveBackgroundTarget: trims whitespace before matching', () => {
  assert.equal(resolveBackgroundTarget('  wkr_abc  ', workers, agents).kind, 'worker');
});

test('CLI-BG-DETACH describeStopOutcome: wording per kind/active', () => {
  assert.match(describeStopOutcome(resolveBackgroundTarget('wkr_abc', workers, agents)).message, /closed/);
  assert.equal(describeStopOutcome(resolveBackgroundTarget('wkr_abc', workers, agents)).ok, true);

  // Already-completed agent → nothing to stop.
  const doneAgent = describeStopOutcome(resolveBackgroundTarget('agent-2', workers, agents));
  assert.equal(doneAgent.ok, false);
  assert.match(doneAgent.message, /already completed/);

  // Unknown id → not ok, points at /ps.
  const unknown = describeStopOutcome(resolveBackgroundTarget('nope', workers, agents));
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /\/ps/);
});
