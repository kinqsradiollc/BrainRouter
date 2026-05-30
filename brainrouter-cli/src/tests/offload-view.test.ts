import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOffloadList } from '../runtime/offloadView.js';

test('CLI-14 formatOffloadList: empty → friendly message', () => {
  assert.match(formatOffloadList([]).join('\n'), /No offloads/);
});

test('CLI-14 formatOffloadList: biggest savings first, with totals + expand hint', () => {
  const out = formatOffloadList([
    { nodeId: 'w1', title: 'small', kind: 'tool_output', tokenEstimate: 100, createdAt: '2026-05-30T01:02:03Z', summary: 'a small thing' },
    { nodeId: 'w2', title: 'big', kind: 'file', tokenEstimate: 5000, createdAt: '2026-05-30T02:00:00Z', summary: 'a big file' },
  ]).join('\n');
  assert.match(out, /2 offloads · ~5,100 tokens kept out of context/);
  // big (5000 tok) listed before small (100 tok)
  const idxBig = out.indexOf('ref w2');
  const idxSmall = out.indexOf('ref w1');
  assert.ok(idxBig !== -1 && idxBig < idxSmall, 'higher-savings offload first');
  assert.match(out, /\[file\] big — ~5,000 tok · ref w2 · 2026-05-30 02:00:00/);
  assert.match(out, /memory_working_context \(nodeId: <ref>\)/);
});
