import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPendingChildStatusHint } from '../runtime/childResume.js';

test('MAR-4 buildPendingChildStatusHint: names exact ids + steers to wait_agents, not list_agents', () => {
  const hint = buildPendingChildStatusHint(['agent-1', 'agent-2']);
  assert.ok(hint, 'should return a hint');
  assert.match(hint!, /agent-1, agent-2/);
  assert.match(hint!, /\["agent-1","agent-2"\]/); // exact ids as a JSON array for wait_agents
  assert.match(hint!, /wait_agents/);
  assert.match(hint!, /do NOT call `list_agents`/i);
});

test('MAR-4 buildPendingChildStatusHint: null when nothing pending / only junk ids', () => {
  assert.equal(buildPendingChildStatusHint([]), null);
  assert.equal(buildPendingChildStatusHint(['', '(unknown)']), null);
});

test('MAR-4 buildPendingChildStatusHint: filters junk but keeps real ids', () => {
  const hint = buildPendingChildStatusHint(['(unknown)', 'agent-9', '']);
  assert.ok(hint);
  assert.match(hint!, /agent-9/);
  assert.doesNotMatch(hint!, /unknown/);
});
