/**
 * ADR-061 D3.4 — scoring the window instead of asking the model that is in it.
 *
 * Built on the real shape of #1724: the same file read over and over, the same
 * bytes back each time, while a denial the runtime had already recorded went
 * unmentioned in three consecutive checkpoints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNoProgressCheckpoint,
  decideTurnProgress,
  progressDecisionState,
  PROGRESS_LEVELS,
  type ProgressToolCall,
} from '../agent/guards/progressDecision.js';
import { buildBudgetCheckpoint } from '../agent/guards/turnBudget.js';
import { createDecisionPort, type DecisionProvider } from '../decision/port.js';

const scoring = (level: string): DecisionProvider => ({
  name: 'stub',
  async answer(_state, questions) {
    return Object.fromEntries(Object.keys(questions).map((id) => [id, { kind: 'score' as const, value: level }]));
  },
});

const loopWindow: ProgressToolCall[] = Array.from({ length: 6 }, () => ({
  name: 'read_file',
  result: '# AGENT.md\nthe same 400 characters, again',
}));

test('the default rules provider scores `some`, which is the existing prompt unchanged', async () => {
  const { level, answer } = await decideTurnProgress(createDecisionPort(), loopWindow);
  assert.equal(level, 'some');
  assert.equal(answer.provider, 'rules');
  assert.equal(answer.kind, 'score');
});

test('a `none` score is the only one that changes the checkpoint', async () => {
  for (const level of PROGRESS_LEVELS) {
    const { level: scored } = await decideTurnProgress(createDecisionPort({ provider: scoring(level) }), loopWindow);
    assert.equal(scored, level);
  }
  // A provider that answers with a level that does not exist cannot invent one:
  // the port rejects it and the floor — `some` — stands.
  const { level, answer } = await decideTurnProgress(
    createDecisionPort({ provider: scoring('excellent') }),
    loopWindow,
  );
  assert.equal(level, 'some');
  assert.match(answer.fellBack ?? '', /not one of: none, some, substantial/);
});

test('the no-progress checkpoint hands over the denials instead of asking the model to introspect', () => {
  const message = buildNoProgressCheckpoint(22, 30, [
    'extract_result: Tool "extract_result" denied by the active workspace tool-profile policy.',
  ]);
  assert.match(message, /made NO progress/);
  assert.match(message, /extract_result.*denied by the active workspace tool-profile policy/);
  assert.match(message, /STOP retrying it/);
  assert.match(message, /goal_blocked/);
  // The old checkpoint ASKS; this one tells, because the asking already failed.
  assert.ok(!/decide FOR YOURSELF/.test(message));
  assert.match(buildBudgetCheckpoint(22, 30), /decide FOR YOURSELF/, 'the other path is untouched');
});

test('with nothing recorded it still says what to do, without an empty evidence block', () => {
  const message = buildNoProgressCheckpoint(22, 30, []);
  assert.match(message, /made NO progress/);
  assert.ok(!/what the runtime refused/.test(message), 'no header over an empty list');
  assert.match(message, /three options/);
});

test('a provider failure leaves the checkpoint exactly as it was', async () => {
  const port = createDecisionPort({ provider: { name: 'boom', async answer() { throw new Error('offline'); } } });
  const { level, answer } = await decideTurnProgress(port, loopWindow);
  assert.equal(level, 'some', 'a scorer that is down must not start declaring turns stuck');
  assert.match(answer.fellBack ?? '', /boom failed: offline/);
});

test('the state carries names, failures and a bounded head of each result', () => {
  const state = progressDecisionState([
    { name: 'read_file', result: 'x'.repeat(5_000) },
    { name: 'run_command', result: 'boom', isError: true },
  ], 600) as { calls: Array<Record<string, unknown>> };
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0]!.tool, 'read_file');
  assert.ok(String(state.calls[0]!.result).length <= 261, 'each result is bounded by its share');
  assert.equal(state.calls[1]!.failed, true, 'a failure is the strongest signal of a stuck window');
  assert.ok(!('failed' in state.calls[0]!), 'and is omitted when there was none');
  assert.ok(JSON.stringify(state).length < 800, 'the window fits the bound');
});
