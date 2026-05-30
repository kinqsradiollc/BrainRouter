import test from 'node:test';
import assert from 'node:assert/strict';
import {
  entryKind, entryPreview, filterTranscriptEntries, formatAgentTranscript, formatAgentReplay,
  type TranscriptEntryLike,
} from '../orchestration/agentTranscriptView.js';

const E: TranscriptEntryLike[] = [
  { role: 'user', content: 'do X', timestamp: '2026-01-01T00:00:00Z' },
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }], timestamp: '2026-01-01T00:00:01Z' },
  { role: 'tool', name: 'read_file', content: 'file contents here', timestamp: '2026-01-01T00:00:02Z' },
  { role: 'tool', name: 'run_command', content: 'boom', isError: true, timestamp: '2026-01-01T00:00:03Z' },
  { role: 'assistant', content: 'done', timestamp: '2026-01-01T00:00:04Z' },
];

test('MAS-P5-T7 entryKind: classifies tool-call / tool-result / error / prose', () => {
  assert.deepEqual(E.map(entryKind), ['user', 'tool-call', 'tool-result', 'error', 'assistant']);
});

test('MAS-P5-T7 filterTranscriptEntries: no flags = all; tools/errors = union', () => {
  assert.equal(filterTranscriptEntries(E, {}).length, 5);
  // tools = tool calls + tool results (E1, E2, E3-by-role)
  assert.deepEqual(filterTranscriptEntries(E, { tools: true }).map((e) => e.name ?? e.role), ['assistant', 'read_file', 'run_command']);
  assert.deepEqual(filterTranscriptEntries(E, { errors: true }).map((e) => e.name), ['run_command']);
  // union: both flags → tool calls/results + errors (E3 matches both, not duplicated)
  assert.equal(filterTranscriptEntries(E, { tools: true, errors: true }).length, 3);
});

test('MAS-P5-T7 entryPreview: tool calls, tool result w/ name, prose, clip', () => {
  assert.equal(entryPreview(E[1]), 'calls read_file');
  assert.equal(entryPreview(E[2]), 'read_file: file contents here');
  assert.equal(entryPreview(E[0]), 'do X');
  assert.equal(entryPreview({ role: 'assistant', content: 'x'.repeat(50) }, 10), 'xxxxxxxxx…');
  assert.equal(entryPreview({ role: 'tool', content: '' }), '(empty)');
});

test('MAS-P5-T7 formatAgentTranscript: glyphs + filter + empty note', () => {
  const all = formatAgentTranscript(E).join('\n');
  assert.match(all, /❯ 00:00:00  user         do X/);
  assert.match(all, /→ 00:00:01  tool-call    calls read_file/);
  assert.match(all, /✗ 00:00:03  error        run_command: boom/);
  // filtered to errors only
  const errs = formatAgentTranscript(E, { errors: true });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /run_command: boom/);
  assert.deepEqual(formatAgentTranscript([{ role: 'user', content: 'x' }], { errors: true }), ['(no matching entries)']);
});

test('MAS-P5-T8 formatAgentReplay: numbered ordered steps; empty', () => {
  const lines = formatAgentReplay(E);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^\[1\/5\] ❯ user /);
  assert.match(lines[4], /^\[5\/5\] ⏺ assistant /);
  assert.deepEqual(formatAgentReplay([]), ['(empty transcript)']);
});
