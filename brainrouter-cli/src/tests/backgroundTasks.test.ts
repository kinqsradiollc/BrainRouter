import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBackgroundTasks, summarizeTasks, type BackgroundTask } from '../runtime/backgroundTasks.js';

const TASKS: BackgroundTask[] = [
  { kind: 'agent', id: 'agent-1', label: 'reviewer (agent-1)' },
  { kind: 'workflow', id: 'migrate', label: 'migrate' },
  { kind: 'worker', id: 'w7', label: 'w7 · builder' },
];

test('summarizeTasks: counts per kind, omits zero kinds, pluralizes', () => {
  assert.equal(summarizeTasks(TASKS), '1 workflow · 1 worker · 1 agent');
  assert.equal(summarizeTasks([{ kind: 'agent', id: 'a', label: 'a' }, { kind: 'agent', id: 'b', label: 'b' }]), '2 agents');
  assert.equal(summarizeTasks([]), '');
});

test('formatBackgroundTasks: empty → [] (panel hides)', () => {
  assert.deepEqual(formatBackgroundTasks([]), []);
});

test('formatBackgroundTasks: workflows first, then workers, then agents', () => {
  const lines = formatBackgroundTasks(TASKS);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /⟳ workflow migrate/);
  assert.match(lines[1], /◆ worker w7 · builder/);
  assert.match(lines[2], /◐ agent reviewer \(agent-1\)/);
});

test('formatBackgroundTasks: caps the list with an overflow summary', () => {
  const many: BackgroundTask[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'agent', id: `a${i}`, label: `a${i}` }));
  const lines = formatBackgroundTasks(many, { max: 3 });
  assert.equal(lines.length, 4); // 3 + overflow
  assert.match(lines[3], /…and 7 more/);
});
