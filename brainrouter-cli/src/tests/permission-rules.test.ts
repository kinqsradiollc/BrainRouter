import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRuleEdit, normalizeRuleSet } from '../config/permissionRules.js';

test('add appends to the right list, dedup + trim', () => {
  const r1 = applyRuleEdit({ allow: [], deny: [] }, 'add', 'deny', '  rm -rf *  ');
  assert.deepEqual(r1, { allow: [], deny: ['rm -rf *'] });
  const r2 = applyRuleEdit(r1, 'add', 'deny', 'rm -rf *');
  assert.deepEqual(r2.deny, ['rm -rf *'], 'idempotent add (no duplicate)');
  const r3 = applyRuleEdit(r2, 'add', 'allow', 'git *');
  assert.deepEqual(r3, { allow: ['git *'], deny: ['rm -rf *'] });
});

test('remove deletes from the right list, no-op when absent', () => {
  const start = { allow: ['git *', 'npm *'], deny: ['curl *'] };
  assert.deepEqual(applyRuleEdit(start, 'remove', 'allow', 'git *').allow, ['npm *']);
  assert.deepEqual(applyRuleEdit(start, 'remove', 'deny', 'nope').deny, ['curl *'], 'absent remove is a no-op');
});

test('empty rule is rejected on add', () => {
  assert.deepEqual(applyRuleEdit({ allow: [], deny: [] }, 'add', 'allow', '   '), { allow: [], deny: [] });
});

test('does not mutate the input set', () => {
  const start = { allow: ['a'], deny: [] };
  applyRuleEdit(start, 'add', 'allow', 'b');
  assert.deepEqual(start.allow, ['a'], 'input untouched (returns a new set)');
});

test('normalizeRuleSet fills missing lists', () => {
  assert.deepEqual(normalizeRuleSet(undefined), { allow: [], deny: [] });
  assert.deepEqual(normalizeRuleSet({ allow: ['x'] }), { allow: ['x'], deny: [] });
});
