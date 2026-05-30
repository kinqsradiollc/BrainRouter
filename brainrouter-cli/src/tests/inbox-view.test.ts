import test from 'node:test';
import assert from 'node:assert/strict';
import { groupInboxByKind, formatInboxPane } from '../runtime/inboxView.js';

const msgs = [
  { id: 'a1', fromSessionKey: 'sess-aaaa', kind: 'text', payload: { text: 'hello there' }, createdAt: 't' },
  { id: 'b2', fromSessionKey: 'sess-bbbb', kind: 'goal-handoff', payload: { goal: 'finish the refactor' }, createdAt: 't' },
  { id: 'c3', fromSessionKey: 'sess-cccc', kind: 'text', payload: { text: 'second text' }, createdAt: 't' },
];

test('CLI-15 groupInboxByKind: groups + orders the most-actionable kind first', () => {
  const groups = groupInboxByKind(msgs);
  assert.deepEqual(groups.map((g) => g.kind), ['goal-handoff', 'text']); // handoff before text
  assert.equal(groups[0].count, 1);
  assert.equal(groups[1].count, 2);
});

test('CLI-15 formatInboxPane: summary line + grouped sections + previews', () => {
  const out = formatInboxPane(msgs).join('\n');
  assert.match(out, /3 messages — 1 goal-handoff · 2 text/);
  assert.match(out, /goal-handoff \(1\)/);
  assert.match(out, /finish the refactor/); // handoff goal preview
  assert.match(out, /text \(2\)/);
});

test('CLI-15 formatInboxPane: empty inbox', () => {
  assert.deepEqual(formatInboxPane([]), ['Inbox empty.']);
});
