import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJsonlEvent, JSONL_SCHEMA_VERSION, RUN_EVENT_TYPES, type RunEvent } from '../runtime/jsonlEvents.js';

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
    { type: 'child_complete', childId: 'c', role: 'r', status: 'completed' },
    { type: 'text', text: 'answer' },
    { type: 'turn_end', sessionKey: 's', durationMs: 10, usage: { promptTokens: 1, completionTokens: 2, calls: 1 } },
    { type: 'error', message: 'boom' },
  ];
  const seen = new Set<string>();
  for (const ev of samples) {
    const obj = JSON.parse(formatJsonlEvent(ev, 'ts'));
    assert.equal(obj.type, ev.type);
    seen.add(obj.type);
  }
  assert.deepEqual([...seen].sort(), [...RUN_EVENT_TYPES].sort(), 'samples cover exactly the declared event types');
});
