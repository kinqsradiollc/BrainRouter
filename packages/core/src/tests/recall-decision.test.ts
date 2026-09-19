/**
 * ADR-061 D3.2 — the question the entity-token count is a proxy for.
 *
 * The gate fires a briefing when two "entity-shaped" tokens appear, which it
 * finds partly by counting mid-sentence capitalised words. *"tell me about the
 * current state of Orbyn"* has one, so a question about a repository skipped
 * the memory about that repository. That is the case these tests are built on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { countEntityTokens, decideMemoryBriefing } from '../memory/briefingTriggers.js';
import {
  decideRecallWithPort,
  recallDecisionState,
  RECALL_DEFAULT_THRESHOLD,
} from '../memory/recallDecision.js';
import { createDecisionPort, type DecisionProvider } from '../decision/port.js';
import type { BriefingDecision } from '../memory/briefingTriggers.js';

const at = (probability: number): DecisionProvider => ({
  name: 'stub',
  async answer(_state, questions) {
    return Object.fromEntries(Object.keys(questions).map((id) => [id, { kind: 'noul' as const, value: probability }]));
  },
});

const hintOnly = (query: string): BriefingDecision => ({
  action: 'hint-only',
  reasons: ['gated mode: no memory trigger'],
  query,
  budget: { maxCharsPerSource: 2_000, maxSources: 5 },
});

test('the case that motivated this: a question about a repo scores one entity and no cue fires', () => {
  const prompt = 'tell me about the current state of Orbyn';
  assert.equal(countEntityTokens(prompt), 1, 'one proper noun, and the threshold is two');
  const decision = decideMemoryBriefing({
    prompt,
    recallMode: 'gated',
    // Not the first turn, no compaction, no goal — the plain case.
    recallHasFiredThisSession: true,
    postCompaction: false,
    hasActiveGoal: false,
    turnsSinceLastFullBriefing: 0,
  });
  assert.equal(decision.action, 'hint-only', 'the rules leave it undecided — that is the band');
});

test('on the default rules provider the decision is returned unchanged', async () => {
  const port = createDecisionPort();
  const input = hintOnly('tell me about the current state of Orbyn');
  const { decision, answer } = await decideRecallWithPort(port, input);
  assert.equal(decision.action, 'hint-only');
  assert.deepEqual(decision.reasons, input.reasons, 'not even the reasons move');
  assert.equal(answer!.value, 0);
  assert.equal(answer!.provider, 'rules');
});

test('a confident answer upgrades the turn to a briefing, and says why', async () => {
  const { decision, threshold } = await decideRecallWithPort(
    createDecisionPort({ provider: at(0.91) }),
    hintOnly('tell me about the current state of Orbyn'),
  );
  assert.equal(decision.action, 'fire');
  assert.match(decision.reasons[0]!, /memory looks relevant here \(0\.91\)/);
  assert.match(decision.reasons[0]!, /though no cue matched/);
  assert.equal(threshold, `>= ${RECALL_DEFAULT_THRESHOLD}`);
});

test('below the threshold nothing changes', async () => {
  const { decision } = await decideRecallWithPort(
    createDecisionPort({ provider: at(RECALL_DEFAULT_THRESHOLD - 0.01) }),
    hintOnly('thanks!'),
  );
  assert.equal(decision.action, 'hint-only');
});

test('the tier can ADD a briefing but never remove one the rules asked for', async () => {
  for (const action of ['fire', 'skip'] as const) {
    const input: BriefingDecision = { ...hintOnly('x'), action, reasons: ['a rule said so'] };
    // A provider screaming "irrelevant" must not override a rule that fired.
    const { decision, answer } = await decideRecallWithPort(createDecisionPort({ provider: at(0) }), input);
    assert.equal(decision.action, action, `${action} is the rules' to make`);
    assert.deepEqual(decision.reasons, ['a rule said so']);
    assert.equal(answer, undefined, 'the tier is not even consulted');
  }
});

test('a provider failure leaves the turn exactly as the rules left it', async () => {
  const port = createDecisionPort({ provider: { name: 'boom', async answer() { throw new Error('offline'); } } });
  const { decision, answer } = await decideRecallWithPort(port, hintOnly('tell me about Orbyn'));
  assert.equal(decision.action, 'hint-only');
  assert.match(answer!.fellBack ?? '', /boom failed: offline/);
});

test('the state is the message, bounded', () => {
  const state = recallDecisionState('y'.repeat(5_000), 1_000) as Record<string, string>;
  assert.ok(state.message.length <= 901, `bounded, got ${state.message.length}`);
  assert.ok(state.message.endsWith('…'));
  assert.equal((recallDecisionState('short', 1_000) as Record<string, string>).message, 'short');
});
