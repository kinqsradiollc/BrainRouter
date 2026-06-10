import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrace, summarizeTrace, diffTraces, type TraceStep } from './decisionTrace.js';
import type { BehaviorTranscriptEntry } from './behaviorMetrics.js';

const call = (...names: string[]): BehaviorTranscriptEntry => ({
  role: 'assistant', content: '',
  tool_calls: names.map((n, i) => ({ id: `c${i}`, type: 'function', function: { name: n, arguments: '{}' } })),
});

const ENTRIES: BehaviorTranscriptEntry[] = [
  { role: 'user', content: 'find the bug' },
  call('read_file', 'grep_search'),
  { role: 'tool', name: 'read_file', content: 'x' },
  { role: 'user', content: 'Runtime deliverable guardrail tripped. ...' }, // injected — must be filtered
  call('edit_file'),
  { role: 'assistant', content: 'Fixed in router.ts:42.' },
];

test('normalizeTrace: prompts (guards filtered), sorted batch shapes, answers', () => {
  const t = normalizeTrace(ENTRIES);
  assert.deepEqual(t, [
    { kind: 'prompt', text: 'find the bug' },
    { kind: 'batch', tools: ['grep_search', 'read_file'] },
    { kind: 'batch', tools: ['edit_file'] },
    { kind: 'answer', endsOnQuestion: false, chars: 22 },
  ]);
});

test('summarizeTrace: counts + parallel batches + tool mix', () => {
  const s = summarizeTrace(normalizeTrace(ENTRIES));
  assert.equal(s.prompts, 1);
  assert.equal(s.batches, 2);
  assert.equal(s.parallelBatches, 1);
  assert.equal(s.toolCalls, 3);
  assert.deepEqual(s.toolMix, { read_file: 1, grep_search: 1, edit_file: 1 });
  assert.equal(s.questionEndings, 0);
});

test('diffTraces: reports batching/step/deferral/tool-mix gaps', () => {
  const reference: TraceStep[] = [
    { kind: 'prompt', text: 'task' },
    { kind: 'batch', tools: ['glob_files', 'grep_search', 'read_file'] },
    { kind: 'answer', endsOnQuestion: false, chars: 100 },
  ];
  const ours: TraceStep[] = [
    { kind: 'prompt', text: 'task' },
    { kind: 'batch', tools: ['read_file'] },
    { kind: 'batch', tools: ['grep_search'] },
    { kind: 'batch', tools: ['list_dir'] },
    { kind: 'answer', endsOnQuestion: true, chars: 60 },
  ];
  const md = diffTraces(reference, ours);
  assert.match(md, /\| parallel batches \| 1 \(100%\) \| 0 \(0%\) \|/);
  assert.match(md, /2 more tool round-trips/);
  assert.match(md, /ended on a question 1× vs 0×/);
  assert.match(md, /only brainrouter used list_dir/);
});

test('diffTraces: identical traces → no gaps', () => {
  const t = normalizeTrace(ENTRIES);
  assert.match(diffTraces(t, t), /No structural gaps detected/);
});
