import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTurnPathStep, completeToolStep, summarizeTurnPath, toolStartStep } from './turnPathRows.js';
import type { ChatRow } from '../../types.js';

let n = 0;
const id = () => ++n;

test('a turn\'s path is one row that grows in order: model → tool (pending → done) → guard → end', () => {
  let rows: ChatRow[] = [{ id: 'u', kind: 'user', text: 'what is brainrouter?', ts: 1 }];
  rows = appendTurnPathStep(rows, { at: 10, type: 'model', label: 'matilda/matilda', detail: '1 tool call · 2.1 s', ok: true }, id);
  rows = appendTurnPathStep(rows, toolStartStep('list_dir', { path: '.' }, 'c1', 11), id);
  assert.equal(rows.length, 2);
  const row = rows[1] as Extract<ChatRow, { kind: 'turn-path' }>;
  assert.equal(row.kind, 'turn-path');
  assert.equal(row.steps.length, 2);
  assert.equal(row.steps[1].type, 'tool');
  assert.equal((row.steps[1] as { pending?: boolean }).pending, true);
  rows = completeToolStep(rows, { tool: 'list_dir', callId: 'c1', ok: true, summary: '61 entries' }, id);
  const done = (rows[1] as Extract<ChatRow, { kind: 'turn-path' }>).steps[1] as { ok?: boolean; pending?: boolean; detail?: string };
  assert.equal(done.pending, false);
  assert.equal(done.ok, true);
  assert.equal(done.detail, 'path="." → 61 entries');
  rows = appendTurnPathStep(rows, { at: 20, type: 'guard', label: 'guard: promised tools then asked', attempt: { n: 1, max: 2 }, ok: false }, id);
  rows = appendTurnPathStep(rows, { at: 30, type: 'end', label: 'answered', ok: true }, id);
  assert.equal(rows.length, 2, 'still one path row for the turn');
  assert.equal(summarizeTurnPath((rows[1] as Extract<ChatRow, { kind: 'turn-path' }>).steps), '4 steps · 1 tool call · 1 guardrail · answered');
});

test('an assistant message between steps starts a NEW path row (the next turn), and a tool-end with no start is recorded alone', () => {
  let rows: ChatRow[] = [];
  rows = appendTurnPathStep(rows, { at: 1, type: 'end', label: 'answered', ok: true }, id);
  rows = [...rows, { id: 'a', kind: 'assistant', text: 'done', ts: 2 }];
  rows = completeToolStep(rows, { tool: 'read_file', ok: false, summary: 'Tool execution failed: ENOENT' }, id);
  assert.equal(rows.length, 3);
  const row = rows[2] as Extract<ChatRow, { kind: 'turn-path' }>;
  assert.equal(row.kind, 'turn-path');
  assert.deepEqual(row.steps.map((s) => [s.type, s.ok]), [['tool', false]]);
  assert.equal(summarizeTurnPath(row.steps), '1 step · 1 tool call · running…');
});
