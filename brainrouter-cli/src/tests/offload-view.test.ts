import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOffloadList, formatOffloadGraph } from '../runtime/offloadView.js';

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

test('OFFLOAD-GRAPH formatOffloadGraph: empty → friendly message', () => {
  assert.match(formatOffloadGraph([]).join('\n'), /No offloads/);
});

test('OFFLOAD-GRAPH: groups by kind when no taskId, emits valid Mermaid', () => {
  const out = formatOffloadGraph([
    { nodeId: 'w1', title: 'log', kind: 'tool_output', tokenEstimate: 100 },
    { nodeId: 'w2', title: 'big file', kind: 'file', tokenEstimate: 5000, replaceable: true },
  ]).join('\n');
  assert.match(out, /^```mermaid/);
  assert.match(out, /graph TD/);
  assert.match(out, /session\(\[session working memory\]\)/);
  assert.match(out, /tool_output \(~100 tok\)/);
  assert.match(out, /file \(~5000 tok\)/);
  assert.match(out, /big file \(replaceable\) \(~5000 tok\)/);
  assert.match(out, /```$/);
});

test('OFFLOAD-GRAPH: groups by taskId + marks current task when present', () => {
  const out = formatOffloadGraph([
    { nodeId: 'w1', title: 'a', taskId: 'T1', tokenEstimate: 10, currentTask: true },
    { nodeId: 'w2', title: 'b', taskId: 'T2', tokenEstimate: 20 },
  ]).join('\n');
  assert.match(out, /T1 \*current \(~10 tok\)/);
  assert.match(out, /T2 \(~20 tok\)/);
});

test('OFFLOAD-GRAPH: sanitizes labels that would break Mermaid', () => {
  const out = formatOffloadGraph([
    { nodeId: 'w["x"]', title: 'has "quotes" [and] brackets', kind: 'k', tokenEstimate: 1 },
  ]).join('\n');
  assert.ok(!out.includes('"quotes"'), 'inner quotes stripped');
  assert.ok(!/\[and\]/.test(out.replace(/\["/g, '').replace(/"\]/g, '')), 'inner brackets stripped');
});
