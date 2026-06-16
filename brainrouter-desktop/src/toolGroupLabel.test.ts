import test from 'node:test';
import assert from 'node:assert/strict';
import { toolGroupLabel } from './toolGroupLabel.js';

test('live step shows the current tool with a marker', () => {
  assert.equal(toolGroupLabel([{ tool: 'read_file' }], true), 'Using read_file ✶');
  assert.equal(toolGroupLabel([{ tool: 'grep', child: 'worker·a1' }], true), 'Using [worker·a1] grep ✶');
});

test('single finished tool reads "tool — summary"', () => {
  assert.equal(toolGroupLabel([{ tool: 'read_file', summary: 'src/x.ts (12 lines)' }], false), 'read_file — src/x.ts (12 lines)');
});

test('multi-tool step lists distinct names', () => {
  assert.equal(
    toolGroupLabel([{ tool: 'read_file' }, { tool: 'edit_file' }, { tool: 'read_file' }], false),
    '3 tools · read_file · edit_file',
  );
});

test('multi-tool step caps names with a +N overflow', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => ({ tool: t }));
  assert.equal(toolGroupLabel(items, false), '6 tools · a · b · c · d +2');
});

test('empty group is handled', () => {
  assert.equal(toolGroupLabel([], true), 'Working ✶');
  assert.equal(toolGroupLabel([], false), 'No tools');
});
