import test from 'node:test';
import assert from 'node:assert/strict';
import { checkClass, summarizeChecks, ciStatusLabel, runClass, ciDuration } from './ciFormat.js';

test('checkClass maps gh buckets', () => {
  assert.equal(checkClass('pass'), 'ok');
  assert.equal(checkClass('fail'), 'fail');
  assert.equal(checkClass('pending'), 'pending');
  assert.equal(checkClass('cancel'), 'cancel');
  assert.equal(checkClass('skipping'), 'neutral');
  assert.equal(checkClass(undefined), 'neutral');
});

test('summarizeChecks rolls up to a conclusion (fail > pending > pass)', () => {
  assert.deepEqual(summarizeChecks([]), { total: 0, passing: 0, failing: 0, pending: 0, conclusion: 'none' });
  assert.equal(summarizeChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'pass' }]).conclusion, 'passing');
  assert.equal(summarizeChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'pending' }]).conclusion, 'pending');
  assert.equal(summarizeChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'fail' }, { name: 'c', bucket: 'pending' }]).conclusion, 'failing');
  const s = summarizeChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'fail' }, { name: 'c', bucket: 'cancel' }]);
  assert.deepEqual({ passing: s.passing, failing: s.failing }, { passing: 1, failing: 2 }, 'cancel counts as failing');
});

test('ciStatusLabel always reads as GitHub CI (never bare "successful")', () => {
  assert.equal(ciStatusLabel(summarizeChecks([])), 'No CI checks');
  assert.equal(ciStatusLabel(summarizeChecks([{ name: 'a', bucket: 'pass' }])), 'CI: 1 passing');
  assert.match(ciStatusLabel(summarizeChecks([{ name: 'a', bucket: 'fail' }, { name: 'b', bucket: 'pass' }])), /^CI: 1 failing, 1 passing$/);
  assert.match(ciStatusLabel(summarizeChecks([{ name: 'a', bucket: 'pending' }])), /^CI: 1 running$/);
});

test('runClass maps Actions status/conclusion', () => {
  assert.equal(runClass({ status: 'in_progress' }), 'pending');
  assert.equal(runClass({ status: 'queued' }), 'pending');
  assert.equal(runClass({ status: 'completed', conclusion: 'success' }), 'ok');
  assert.equal(runClass({ status: 'completed', conclusion: 'failure' }), 'fail');
  assert.equal(runClass({ status: 'completed', conclusion: 'cancelled' }), 'cancel');
  assert.equal(runClass({ status: 'completed', conclusion: 'skipped' }), 'neutral');
});

test('ciDuration formats a span and tolerates missing/invalid input', () => {
  const a = '2026-06-17T10:00:00Z', b = '2026-06-17T10:02:30Z';
  assert.equal(ciDuration(a, b), '2m 30s');
  assert.equal(ciDuration(a, undefined), '');
  assert.equal(ciDuration(undefined, b), '');
  assert.equal(ciDuration(b, a), '', 'negative span → empty');
});
