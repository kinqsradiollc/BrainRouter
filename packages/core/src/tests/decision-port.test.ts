/**
 * ADR-061 S1 — the port, and the floor that makes it landable.
 *
 * The tier's whole safety argument is two properties: a provider cannot return
 * a value the question never admitted, and the rule the caller already computed
 * always stands in when anything goes wrong. Both are asserted here against a
 * provider that misbehaves in every way a real one can.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecisionPort,
  rulesProvider,
  type DecisionProvider,
} from '../decision/port.js';
import {
  validateAnswer,
  validateQuestion,
  MAX_CHOICE_OPTIONS,
  type ChoiceQuestion,
  type DecisionQuestion,
  type NoulQuestion,
  type ScoreQuestion,
} from '../decision/types.js';

const noul = (rulesAnswer = 0): NoulQuestion => ({ kind: 'noul', instructions: 'Is this risky?', rulesAnswer });
const choice = (rulesAnswer = 'fast'): ChoiceQuestion => ({
  kind: 'choice',
  instructions: 'Which route?',
  options: { fast: 'lookups', powerful: 'architecture' },
  rulesAnswer,
});
const score = (rulesAnswer = 'none'): ScoreQuestion => ({
  kind: 'score',
  instructions: 'How much progress?',
  levels: ['none', 'some', 'substantial'],
  rulesAnswer,
});

function provider(name: string, answer: DecisionProvider['answer']): DecisionProvider {
  return { name, answer };
}

test('the default port answers with the rule the caller already computed — the equivalence S1 rests on', async () => {
  const port = createDecisionPort();
  const answers = await port.ask('anything', { risky: noul(0), route: choice('powerful'), progress: score('some') });
  assert.equal(answers.risky!.value, 0);
  assert.equal(answers.route!.value, 'powerful');
  assert.equal(answers.progress!.value, 'some');
  for (const a of Object.values(answers)) {
    assert.equal(a.provider, 'rules');
    assert.equal(a.confidence, 1, 'a rule weighed nothing, so it is certain by construction');
    assert.equal(a.fellBack, undefined, 'the floor is not a fallback when it IS the provider');
  }
});

test('an answer the question never admitted is a fallback, not an outcome', async () => {
  const cases: Array<[string, DecisionQuestion, unknown, RegExp]> = [
    ['a choice key that was never offered', choice(), 'cheapest', /not one of: fast, powerful/],
    ['a score level that was never offered', score(), 'enormous', /not one of: none, some, substantial/],
    ['a probability above 1', noul(), 4.2, /outside \[0,1\]/],
    ['a string where a probability belongs', noul(), 'very', /noul needs a number/],
  ];
  for (const [label, question, value, reason] of cases) {
    const port = createDecisionPort({
      provider: provider('liar', async () => ({ q: { kind: question.kind, value: value as never } })),
    });
    const { q } = await port.ask('s', { q: question });
    assert.equal(q!.value, question.rulesAnswer, `${label}: the floor stands`);
    assert.equal(q!.provider, 'rules');
    assert.match(q!.fellBack ?? '', reason, label);
    assert.match(q!.fellBack ?? '', /^liar answered invalidly/, label);
  }
});

test('a provider that throws, times out, or skips a question never breaks the gate', async () => {
  const thrown = createDecisionPort({
    provider: provider('boom', async () => { throw new Error('connection reset'); }),
  });
  const a = await thrown.ask('s', { q: noul(0) });
  assert.equal(a.q!.value, 0);
  assert.match(a.q!.fellBack ?? '', /boom failed: connection reset/);

  const hung = createDecisionPort({
    timeoutMs: 10,
    provider: provider('slow', (_s, _q, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    })),
  });
  const b = await hung.ask('s', { q: noul(0) });
  assert.equal(b.q!.value, 0);
  assert.match(b.q!.fellBack ?? '', /slow timed out after 10ms/);

  const partial = createDecisionPort({
    provider: provider('half', async () => ({ first: { kind: 'noul' as const, value: 0.9 } })),
  });
  const c = await partial.ask('s', { first: noul(0), second: noul(0) });
  assert.equal(c.first!.value, 0.9, 'the question it answered stands');
  assert.equal(c.first!.provider, 'half');
  assert.equal(c.second!.value, 0, 'the one it skipped falls to the floor');
  assert.match(c.second!.fellBack ?? '', /did not answer "second"/);
});

test('a good answer is carried through, with its confidence clamped and its provider named', async () => {
  const port = createDecisionPort({
    provider: provider('jev', async () => ({
      q: { kind: 'choice' as const, value: 'powerful', probabilities: { fast: 0.1, powerful: 0.9 }, confidence: 1.4 },
    })),
  });
  const { q } = await port.ask('s', { q: choice('fast') });
  assert.equal(q!.value, 'powerful', 'the provider overrode the rule, which is the point');
  assert.equal(q!.provider, 'jev');
  assert.equal(q!.confidence, 1, 'a confidence outside [0,1] is clamped, not trusted');
  assert.deepEqual(q!.probabilities, { fast: 0.1, powerful: 0.9 });
  assert.equal(q!.fellBack, undefined);
});

test('a malformed question is the CALLER\'s bug and throws at the call site', async () => {
  const port = createDecisionPort();
  await assert.rejects(
    () => port.ask('s', { q: { kind: 'choice', instructions: 'pick', options: {}, rulesAnswer: 'x' } }),
    /needs at least one option/,
  );
  await assert.rejects(
    () => port.ask('s', { q: { ...choice(), rulesAnswer: 'nonexistent' } }),
    /rulesAnswer invalid/,
    'a floor that is not a legal answer leaves nothing to fall back to',
  );
  await assert.rejects(
    () => port.ask('s', { q: { ...noul(), instructions: '  ' } }),
    /needs instructions/,
  );
});

test('the question and answer validators are the contract, standalone', () => {
  assert.equal(validateQuestion(choice()), null);
  assert.equal(validateAnswer(noul(), { kind: 'noul', value: 0.5 }), null);
  assert.match(validateAnswer(noul(), { kind: 'choice', value: 'fast' }) ?? '', /answered as choice, asked as noul/);
  const tooMany: ChoiceQuestion = {
    kind: 'choice',
    instructions: 'pick',
    options: Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`o${i}`, 'x'])),
    rulesAnswer: 'o0',
  };
  assert.match(validateQuestion(tooMany) ?? '', /at most 255 options/);
  assert.equal(rulesProvider.name, 'rules');
});
