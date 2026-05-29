import test from 'node:test';
import assert from 'node:assert/strict';
import { newlyTerminal, formatCompletionNotice, type CompletionItem } from '../runtime/completionNotices.js';

const item = (id: string, ok = true): CompletionItem => ({ id, label: `${id} ${ok ? 'completed' : 'failed'}`, ok });

test('PARITY-W3 newlyTerminal: only items not already seen', () => {
  const seen = new Set(['wkr:a', 'agent:1']);
  const fresh = newlyTerminal(seen, [item('wkr:a'), item('wkr:b'), item('agent:1'), item('run:s')]);
  assert.deepEqual(fresh.map((f) => f.id), ['wkr:b', 'run:s']);
});

test('PARITY-W3 newlyTerminal: empty seen returns all; nothing new returns none', () => {
  const all = [item('wkr:a'), item('wkr:b')];
  assert.equal(newlyTerminal(new Set(), all).length, 2);
  assert.equal(newlyTerminal(new Set(['wkr:a', 'wkr:b']), all).length, 0);
});

test('PARITY-W3 formatCompletionNotice: ✓ for ok, ✗ for failure', () => {
  assert.equal(formatCompletionNotice({ id: 'wkr:x', label: 'worker wkr_x done', ok: true }), '✓ worker wkr_x done');
  assert.equal(formatCompletionNotice({ id: 'wkr:y', label: 'worker wkr_y failed', ok: false }), '✗ worker wkr_y failed');
});
