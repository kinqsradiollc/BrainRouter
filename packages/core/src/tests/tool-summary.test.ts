import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolSummary } from '../agent/agent.js';

// run_command summaries surface the COMMAND (the scannable part), not just the
// exit status — the UI shows ✓/✕ + output preview for the outcome.
test('getToolSummary: run_command shows the command on success', () => {
  assert.equal(getToolSummary('run_command', { command: 'npm test' }, 'Exit Code: 0\nok'), 'npm test');
});

test('getToolSummary: run_command appends exit code on failure', () => {
  assert.equal(getToolSummary('run_command', { command: 'npm run build' }, 'Exit Code: 2\nerror'), 'npm run build — exit 2');
});

test('getToolSummary: run_command first line only, trimmed/clamped', () => {
  const long = 'echo ' + 'x'.repeat(400);
  const out = getToolSummary('run_command', { command: `  ${long}\nsecond line` }, 'Exit Code: 0');
  assert.ok(!out.includes('\n'), 'single line');
  assert.ok(out.length <= 160, `clamped to 160 (was ${out.length})`);
  assert.ok(out.startsWith('echo x'), 'keeps the command head');
});

test('getToolSummary: run_command rejection keeps the command', () => {
  assert.equal(getToolSummary('run_command', { command: 'rm -rf build' }, 'rejected by user'), 'rejected: rm -rf build');
});

test('getToolSummary: run_command falls back to exit code when no command arg', () => {
  assert.equal(getToolSummary('run_command', {}, 'Exit Code: 0'), 'exited with code 0');
});
