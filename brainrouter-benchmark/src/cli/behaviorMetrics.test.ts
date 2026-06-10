import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateBehavior,
  formatBehaviorReport,
  scoreSession,
  type BehaviorTranscriptEntry,
} from './behaviorMetrics.js';

const asst = (content: string): BehaviorTranscriptEntry => ({ role: 'assistant', content });
const call = (...names: string[]): BehaviorTranscriptEntry => ({
  role: 'assistant',
  content: '',
  tool_calls: names.map((name, i) => ({ id: `c${i}-${name}`, type: 'function', function: { name, arguments: '{}' } })),
});
const callWithArgs = (name: string, args: string): BehaviorTranscriptEntry => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: args } }],
});
const result = (name: string, isError = false): BehaviorTranscriptEntry => ({ role: 'tool', name, isError, content: isError ? 'ERR' : 'ok' });

test('scoreSession: batching counts ≥2-call messages; singles do not batch', () => {
  const s = scoreSession([
    call('read_file', 'grep_search', 'list_dir'),
    result('read_file'), result('grep_search'), result('list_dir'),
    call('read_file'),
    result('read_file'),
    asst('Done: the answer is 42.'),
  ]);
  assert.equal(s.toolMessages, 2);
  assert.equal(s.batchedToolMessages, 1);
  assert.equal(s.toolCalls, 4);
});

test('scoreSession: question/offer + promise endings detected; deliverable ending is clean', () => {
  const q = scoreSession([asst('Would you like me to continue?')]);
  assert.equal(q.endsOnQuestionOrOffer, true);
  const offer = scoreSession([asst('Here is a sketch. Let me know if you want the full version.')]);
  assert.equal(offer.endsOnQuestionOrOffer, true);
  const promise = scoreSession([asst("I'll now implement the parser and report back.")]);
  assert.equal(promise.endsOnPromise, true);
  const clean = scoreSession([asst('Fixed the bug in src/a.ts:12 and all 14 tests pass.')]);
  assert.equal(clean.endsOnQuestionOrOffer, false);
  assert.equal(clean.endsOnPromise, false);
});

test('scoreSession: verification-after-mutation requires verify AFTER the last mutation', () => {
  const verified = scoreSession([
    call('edit_file'), result('edit_file'),
    callWithArgs('run_command', '{"command":"npm test"}'), result('run_command'),
    asst('Edited and tests pass.'),
  ]);
  assert.equal(verified.hadMutation, true);
  assert.equal(verified.verifiedAfterMutation, true);

  const verifyThenEdit = scoreSession([
    callWithArgs('run_command', '{"command":"npm test"}'), result('run_command'),
    call('edit_file'), result('edit_file'),
    asst('Edited.'),
  ]);
  assert.equal(verifyThenEdit.verifiedAfterMutation, false);

  const readOnly = scoreSession([call('read_file'), result('read_file'), asst('It reads config.')]);
  assert.equal(readOnly.hadMutation, false);
});

test('scoreSession: verification run_command is not itself a mutation', () => {
  const s = scoreSession([
    callWithArgs('run_command', '{"command":"npm run build"}'), result('run_command'),
    asst('Build is green.'),
  ]);
  assert.equal(s.hadMutation, false);
});

test('scoreSession: edit errors attribute via tool_call_id and via name', () => {
  const viaId = scoreSession([
    { role: 'assistant', content: '', tool_calls: [{ id: 'e1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'e1', isError: true, content: 'no match' },
  ]);
  assert.equal(viaId.editCalls, 1);
  assert.equal(viaId.editErrors, 1);
  const viaName = scoreSession([call('apply_patch'), result('apply_patch', true)]);
  assert.equal(viaName.editErrors, 1);
});

test('aggregateBehavior: rates + null denominators', () => {
  const m = aggregateBehavior([
    scoreSession([
      call('read_file', 'grep_search'), result('read_file'), result('grep_search'),
      asst('Answer: yes.'),
    ]),
    scoreSession([
      call('edit_file'), result('edit_file'),
      callWithArgs('run_command', '{"command":"vitest run"}'), result('run_command'),
      asst('Done, suite green.'),
    ]),
  ]);
  assert.equal(m.sessions, 2);
  assert.equal(m.batchingRate, 1 / 3);
  assert.equal(m.prematureQuestionRate, 0);
  assert.equal(m.verificationRate, 1);
  assert.equal(m.editFailureRate, 0);

  const empty = aggregateBehavior([]);
  assert.equal(empty.batchingRate, null);
  assert.equal(empty.verificationRate, null);
  assert.equal(empty.prematureQuestionRate, null);
});

test('formatBehaviorReport: renders all metrics with — for null', () => {
  const md = formatBehaviorReport(aggregateBehavior([]), { title: 'Baseline' });
  assert.match(md, /# Baseline/);
  assert.match(md, /Batching rate \| — /);
  assert.match(md, /Verification-after-mutation/);
});
