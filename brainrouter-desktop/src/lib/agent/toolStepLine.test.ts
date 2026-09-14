import test from 'node:test';
import assert from 'node:assert/strict';
import { toolStartLine, toolEndLine } from './toolStepLine.js';

test('a tool call renders as one step line in the thinking stream: start, then its outcome', () => {
  const line = toolStartLine('read_file', { path: 'src/a.ts', startLine: 1, note: undefined }) + toolEndLine(true, '42 lines');
  assert.equal(line, '\n▸ read_file path="src/a.ts" startLine=1 → ✓ 42 lines\n');
  assert.equal(toolStartLine('list_dir', {}) + toolEndLine(false, 'Tool execution failed:  ENOENT\n  stat x'), '\n▸ list_dir → ✗ Tool execution failed: ENOENT stat x\n');
  assert.equal(toolStartLine('goal_complete', undefined), '\n▸ goal_complete');
});

test('long arguments and summaries are cut, never dumped', () => {
  const start = toolStartLine('write_file', { path: 'a.md', content: 'x'.repeat(500) });
  assert.ok(start.length < 140 && start.endsWith('…'));
  const end = toolEndLine(true, 'y'.repeat(500));
  assert.ok(end.length < 170 && end.endsWith('…\n'));
});
