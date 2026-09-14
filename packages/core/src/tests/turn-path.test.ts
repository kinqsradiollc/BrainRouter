import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emitTurnStep,
  guardStepFromStatus,
  modelStepDetail,
  renderTurnPath,
  turnEndLabel,
  type TurnStep,
} from '../agent/runtime/turnPath.js';

// ADR-059 — the turn path is the runtime's own account of a turn: what it did or
// observed, in order, in words a person can read. Nothing here infers what the
// model "thought"; every step comes from something the runtime actually did.

test('emitTurnStep records on the agent AND forwards to the host, stamping the time once', () => {
  const agent = { turnPathSteps: [] as TurnStep[] };
  const seen: TurnStep[] = [];
  const step = emitTurnStep(agent, { onTurnStep: (s) => seen.push(s) }, { type: 'model', label: 'openai/gpt-5', detail: 'finish: stop · 12 tokens out · 0.4 s', ok: true });
  assert.equal(agent.turnPathSteps.length, 1);
  assert.equal(seen[0], step);
  assert.ok(typeof step.at === 'number' && step.at > 0);
  // A host with no handler is fine.
  emitTurnStep(agent, {}, { type: 'end', label: 'answered' });
  assert.equal(agent.turnPathSteps.length, 2);
});

test('guardStepFromStatus turns the guard status line into a step without inventing anything', () => {
  const s = guardStepFromStatus('Recovery: promised-tools-then-asked (1/2) — steering to discovery');
  assert.equal(s.type, 'guard');
  assert.equal(s.label, 'guard: promised tools then asked');
  assert.deepEqual(s.attempt, { n: 1, max: 2 });
  assert.equal(s.detail, 'steering to discovery');
  assert.equal(s.ok, false);
  const p = guardStepFromStatus('Recovery: required profile stage research/research-question-skill (1/3)');
  assert.equal(p.label, 'guard: required profile stage research/research question skill');
  assert.deepEqual(p.attempt, { n: 1, max: 3 });
  assert.equal(p.detail, undefined);
  // An unknown shape still becomes a readable step.
  assert.equal(guardStepFromStatus('something else happened').label, 'guard: something else happened');
});

test('modelStepDetail + turnEndLabel say what happened in the runtime\'s words', () => {
  assert.equal(modelStepDetail({ finishReason: 'stop', usage: { completion_tokens: 42 } }, 1234), 'finish: stop · 42 tokens out · 1.2 s');
  assert.equal(modelStepDetail({ toolCalls: [{}, {}] }, 500), '2 tool calls · 0.5 s');
  assert.equal(turnEndLabel({ exitedCleanly: true, answered: true, loopCount: 3, maxLoops: 40 }), 'answered');
  assert.equal(turnEndLabel({ exitedCleanly: true, answered: false, loopCount: 3, maxLoops: 40 }), 'ended without an answer');
  assert.equal(turnEndLabel({ exitedCleanly: false, answered: false, loopCount: 40, maxLoops: 40 }), 'stopped at the tool-loop limit (40/40)');
});

test('renderTurnPath is one readable line per step with relative time, attempt and outcome', () => {
  const t0 = 1_700_000_000_000;
  const text = renderTurnPath([
    { at: t0, type: 'model', label: 'matilda/matilda', detail: 'finish: stop · 47 tokens out · 3.1 s', ok: true },
    { at: t0 + 3200, type: 'guard', label: 'guard: promised tools then asked', detail: 'steering to discovery', attempt: { n: 1, max: 2 }, ok: false },
    { at: t0 + 3300, type: 'provider', label: 'Matilda web search', detail: "on BrainRouter's own message to it" },
    { at: t0 + 9000, type: 'end', label: 'answered', ok: true },
  ]);
  assert.equal(text, [
    '+0.0s model: matilda/matilda — finish: stop · 47 tokens out · 3.1 s ✓',
    '+3.2s guard: guard: promised tools then asked (1/2) — steering to discovery ✗',
    "+3.3s provider: Matilda web search — on BrainRouter's own message to it",
    '+9.0s end: answered ✓',
  ].join('\n'));
  assert.equal(renderTurnPath([]), '');
});
