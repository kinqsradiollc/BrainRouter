import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJsonlEvent, memoryRunEvent, isOffloadTool, JSONL_SCHEMA_VERSION, RUN_EVENT_TYPES, type RunEvent } from '../runtime/reporting/jsonlEvents.js';

test('CLI-7 formatJsonlEvent: single line, parseable, carries v + ts + type', () => {
  const line = formatJsonlEvent({ type: 'tool_end', name: 'read_file', ok: true, summary: 'ok' }, '2026-05-30T00:00:00Z');
  assert.ok(!line.includes('\n'), 'one line, no embedded newline');
  const obj = JSON.parse(line);
  assert.equal(obj.v, JSONL_SCHEMA_VERSION);
  assert.equal(obj.ts, '2026-05-30T00:00:00Z');
  assert.equal(obj.type, 'tool_end');
  assert.equal(obj.name, 'read_file');
  assert.equal(obj.ok, true);
});

test('CLI-7 every declared event type renders to valid JSON (stable schema)', () => {
  const samples: RunEvent[] = [
    { type: 'turn_start', sessionKey: 's', prompt: 'hi' },
    { type: 'status', message: 'loading' },
    { type: 'tool_start', name: 't' },
    { type: 'tool_end', name: 't', ok: false, summary: 'x' },
    { type: 'child_tool', childId: 'c', role: 'r', tool: 't' },
    {
      type: 'child_complete',
      childId: 'c',
      role: 'r',
      status: 'interrupted',
      receipt: {
        childId: 'c',
        role: 'r',
        status: 'interrupted',
        completedAt: '2026-07-30T00:00:00.000Z',
        summary: 'Child execution interrupted by the parent request.',
      },
    },
    { type: 'text', text: 'answer' },
    { type: 'turn_end', sessionKey: 's', durationMs: 10, usage: { promptTokens: 1, completionTokens: 2, calls: 1 } },
    { type: 'error', message: 'boom' },
    // HEADLESS-EVENTS (0.4.5)
    { type: 'memory', op: 'briefing', records: 3, sources: ['recall'] },
    { type: 'offload', tool: 'memory_working_offload', ok: true, summary: 'stored' },
    { type: 'cost_update', promptTokens: 100, completionTokens: 20, calls: 2, costUsd: 0.001 },
    { type: 'approval', tool: 'write_file', action: 'file_edit', decision: 'allow' },
    { type: 'code_index', file: 'src/x.ts', status: 'reindexed', chunks: 4 },
  ];
  const seen = new Set<string>();
  for (const ev of samples) {
    const obj = JSON.parse(formatJsonlEvent(ev, 'ts'));
    assert.equal(obj.type, ev.type);
    if (ev.type === 'child_complete') {
      assert.deepEqual(obj.receipt, ev.receipt);
    }
    seen.add(obj.type);
  }
  assert.deepEqual([...seen].sort(), [...RUN_EVENT_TYPES].sort(), 'samples cover exactly the declared event types');
});

test('HEADLESS-EVENTS schema version 3 carries shared child receipts', () => {
  assert.equal(JSONL_SCHEMA_VERSION, 3);
});

test('memoryRunEvent maps the surfaced kinds and ignores the rest', () => {
  assert.deepEqual(
    memoryRunEvent({ kind: 'briefing', recordCount: 5, sources: ['recall', 'tree'] }),
    { type: 'memory', op: 'briefing', records: 5, sources: ['recall', 'tree'] },
  );
  assert.deepEqual(
    memoryRunEvent({ kind: 'capture', extractedCount: 2 }),
    { type: 'memory', op: 'capture', extracted: 2 },
  );
  assert.deepEqual(
    memoryRunEvent({ kind: 'citation', recordIds: ['a', 'b'] }),
    { type: 'memory', op: 'citation', records: 2 },
  );
  assert.equal(memoryRunEvent({ kind: 'skipped' }), null);
  assert.equal(memoryRunEvent({ kind: 'contradiction' }), null);
});

test('isOffloadTool matches only the offload tool', () => {
  assert.equal(isOffloadTool('memory_working_offload'), true);
  assert.equal(isOffloadTool('memory_working_context'), false);
  assert.equal(isOffloadTool('write_file'), false);
});
