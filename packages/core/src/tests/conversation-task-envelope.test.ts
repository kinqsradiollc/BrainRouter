/**
 * ADR-040 A40-2 — the bounded conversation task envelope.
 *
 * The property that matters is §8.2 step 3: an elliptical follow-up must inherit
 * the shape of the task it refers to, not lose it and drop to direct. And its
 * counterweight, step 4: a contextless acknowledgement with nothing to inherit
 * DOES take direct. Each of these fails silently in the worst way — a turn that
 * quietly plans as the wrong shape, or no shape at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationTaskEnvelope,
  buildTurnTaskEnvelope,
  isEllipticalFollowUp,
} from '../workspace/conversationTaskEnvelope.js';
import { detectOrchestrationTaskSignals } from '../orchestration/profiles/taskSignals.js';

const TASK = 'please implement the new billing service';

test('a message with its own task shape carries nothing — the signal text is just the message', () => {
  const env = buildTurnTaskEnvelope({ currentMessage: TASK, priorUserMessages: [] });
  assert.equal(env.carriedTask, undefined);
  assert.equal(env.signalText, TASK);
});

test('§8.2 step 3 — an elliptical follow-up inherits the last unresolved task, and its signals', () => {
  const env = buildTurnTaskEnvelope({ currentMessage: 'now go ahead and do it', priorUserMessages: [TASK] });
  assert.equal(env.carriedTask, TASK, 'the established task is carried');
  // Mutation-proof: the follow-up now matches the SAME signals as the original
  // task. Drop the carry-forward and env.signalText is just "now go ahead" — no
  // signals — and this fails.
  const taskSignals = detectOrchestrationTaskSignals(TASK);
  const followSignals = detectOrchestrationTaskSignals(env.signalText);
  assert.ok(taskSignals.size > 0, 'the original task has signals');
  for (const sig of taskSignals) assert.ok(followSignals.has(sig), `the follow-up inherits ${sig}`);
});

test('§8.2 step 4 — a contextless acknowledgement with no unresolved task takes direct', () => {
  const env = buildTurnTaskEnvelope({ currentMessage: 'ok thanks', priorUserMessages: ['what is the capital of France'] });
  assert.equal(env.carriedTask, undefined);
  assert.equal(detectOrchestrationTaskSignals(env.signalText).size, 0, 'no signals → the direct fallback');
});

test('a fresh task after an old one is its OWN task — the old one is not carried', () => {
  // A new task with its own signals is a topic change, so nothing is carried.
  const env = buildTurnTaskEnvelope({ currentMessage: 'now write an academic paper on caching', priorUserMessages: [TASK] });
  assert.equal(env.carriedTask, undefined, 'a message with its own signals does not inherit');
  assert.match([...detectOrchestrationTaskSignals(env.signalText)].join(','), /academic-paper/);
});

test('a goal objective fills the inherited slot when history has no unresolved task', () => {
  const env = buildTurnTaskEnvelope({ currentMessage: 'go ahead', priorUserMessages: [], goalObjective: TASK });
  assert.equal(env.carriedTask, TASK);
});

test('goal/no-goal parity — a goal objective is treated identically to a prior user task', () => {
  const viaGoal = buildTurnTaskEnvelope({ currentMessage: 'continue', priorUserMessages: [], goalObjective: TASK });
  const viaHistory = buildTurnTaskEnvelope({ currentMessage: 'continue', priorUserMessages: [TASK] });
  assert.equal(viaGoal.signalText, viaHistory.signalText, 'same text, same selection input — parity');
});

test('the carried task is size-bounded, never a transcript', () => {
  const huge = 'implement ' + 'x'.repeat(20_000);
  const env = buildConversationTaskEnvelope({ currentMessage: 'go ahead', currentHasOwnSignals: false, lastUnresolvedTask: huge });
  assert.ok((env.carriedTask ?? '').length <= 4_000, 'the carry is bounded');
});

test('a long message that merely opens with a cue is its own task, not an elliptical follow-up', () => {
  assert.equal(isEllipticalFollowUp('now implement that'), true);
  assert.equal(isEllipticalFollowUp('now ' + 'x'.repeat(300)), false);
  assert.equal(isEllipticalFollowUp(''), false);
});
