/**
 * ADR-061 D3.1 — the band the lexical rules cannot reach.
 *
 * `shellClassifier.ts` allows anything nobody wrote down. The first test here
 * pins WHICH commands those actually are — because the ADR's own example list
 * was wrong, and a premise this slice rests on has to be asserted, not assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyShellCommand } from '../exec/policy/shellClassifier.js';
import {
  decideShellRisk,
  shellDecisionState,
  SHELL_RISK_DEFAULT_THRESHOLDS,
} from '../exec/policy/shellDecision.js';
import { createDecisionPort, type DecisionProvider } from '../decision/port.js';

const at = (probability: number): DecisionProvider => ({
  name: 'stub',
  async answer(_state, questions) {
    return Object.fromEntries(Object.keys(questions).map((id) => [id, { kind: 'noul' as const, value: probability }]));
  },
});

test('the lexical rules are good at DESTRUCTION and blind to PUBLICATION — the actual gap', () => {
  // Not a straw man, and not the list this slice was first written against:
  // `find . -delete` and `aws s3 rm --recursive` ARE caught, by the dangerous
  // heuristic. What the wordlist has no entry for is the other kind of
  // irreversible — shipping something. That is the band this tier covers.
  for (const command of ['find . -delete', 'aws s3 rm s3://bucket --recursive']) {
    assert.equal(classifyShellCommand(command, { mode: 'on', silent: false }).decision, 'deny',
      `the rules already catch destruction: ${command}`);
  }
  for (const command of [
    'npm publish',
    'terraform apply -auto-approve',
    'gh release create v9.9.9 --generate-notes',
  ]) {
    assert.equal(classifyShellCommand(command, { mode: 'on', silent: false }).decision, 'allow',
      `the rules have nothing to say about: ${command}`);
  }
});

test('with the default rules provider the outcome is allow — byte-for-byte what the gate did before', async () => {
  const port = createDecisionPort();
  for (const command of ['git status', 'npm publish', 'terraform apply -auto-approve']) {
    const risk = await decideShellRisk(port, { command });
    assert.equal(risk.decision, 'allow', command);
    assert.equal(risk.answer.provider, 'rules');
    assert.equal(risk.answer.value, 0, 'the floor already allowed; that IS its answer');
  }
});

test('a probability routes to the band it falls in', async () => {
  const { low, high } = SHELL_RISK_DEFAULT_THRESHOLDS;
  const cases: Array<[number, 'allow' | 'ask' | 'deny']> = [
    [0, 'allow'],
    [low - 0.01, 'allow'],
    [low, 'ask'],
    [(low + high) / 2, 'ask'],
    [high - 0.01, 'ask'],
    [high, 'deny'],
    [1, 'deny'],
  ];
  for (const [probability, expected] of cases) {
    const risk = await decideShellRisk(createDecisionPort({ provider: at(probability) }), { command: 'npm publish' });
    assert.equal(risk.decision, expected, `p=${probability}`);
    assert.ok(risk.reason.length > 0, 'every band explains itself');
    assert.ok(risk.threshold.length > 0, 'the band is recorded beside the decision');
  }
});

test('an unsure answer says it is unsure, and a refusal says what it refused', async () => {
  const asked = await decideShellRisk(createDecisionPort({ provider: at(0.5) }), { command: 'npm publish' });
  assert.match(asked.reason, /unsure/);
  assert.match(asked.reason, /no rule matched it, so it is your call/);

  const denied = await decideShellRisk(createDecisionPort({ provider: at(0.95) }), { command: 'npm publish' });
  assert.match(denied.reason, /0\.95 risk/);
  assert.match(denied.reason, /destroys, deploys, spends, or reaches outside the workspace/);
});

test('a provider failure lands on allow — the outcome the caller already had', async () => {
  const port = createDecisionPort({
    provider: { name: 'boom', async answer() { throw new Error('offline'); } },
  });
  const risk = await decideShellRisk(port, { command: 'terraform apply -auto-approve' });
  assert.equal(risk.decision, 'allow', 'a decision tier that is down must not start blocking work');
  assert.match(risk.answer.fellBack ?? '', /boom failed: offline/);
});

test('an inverted or out-of-range band cannot turn every command into a refusal', async () => {
  const port = createDecisionPort({ provider: at(0.5) });
  const inverted = await decideShellRisk(port, { command: 'ls' }, { thresholds: { low: 0.9, high: 0.2 } });
  assert.equal(inverted.decision, 'ask', 'an inverted band falls back to the documented defaults');
  const garbage = await decideShellRisk(port, { command: 'ls' }, { thresholds: { low: -5, high: 12 } });
  assert.equal(garbage.decision, 'ask', 'out-of-range falls back to the documented defaults');
});

test('the state a provider would see is bounded and carries the authorization context', () => {
  const state = shellDecisionState(
    { command: 'x'.repeat(5_000), userIntent: 'y'.repeat(5_000), cwd: '/tmp/repo' },
    1_000,
  ) as Record<string, string>;
  assert.ok(state.command.length <= 501, `command bounded, got ${state.command.length}`);
  assert.ok(state.userAsked.length <= 351, `intent bounded, got ${state.userAsked.length}`);
  assert.equal(state.cwd, '/tmp/repo');
  assert.ok(JSON.stringify(state).length < 1_200, 'the whole payload respects the bound');
  // What the user asked for IS the authorization context — a deploy during
  // "ship the release" is not the same call as a deploy during "fix this typo".
  assert.ok('userAsked' in state);
  assert.ok(!('userIntent' in state), 'named for the provider, not for us');
});
