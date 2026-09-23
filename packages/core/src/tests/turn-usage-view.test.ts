// ADR-041 A41-13 — buildTurnUsageView maps agent turn-loop state into a bounded,
// serializable snapshot a turn-end observer can read without agent internals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnUsageView, type TurnUsageReadPort } from '../util/tokens/turnUsageView.js';

function port(overrides: Partial<TurnUsageReadPort> = {}): TurnUsageReadPort {
  return {
    llmConfig: { model: 'gpt-test' },
    sessionUsage: { promptTokens: 100, completionTokens: 40, calls: 3, turns: 2, cachedTokens: 10, missedTokens: 90 },
    lastTurnUsage: { promptTokens: 50, completionTokens: 20, calls: 1, cachedTokens: 5, missedTokens: 45 },
    taskBudgetCaps: { maxPerTaskUSD: 1, maxPerTaskTokens: 1000 },
    usageBySkill: new Map([
      ['review', { promptTokens: 60, completionTokens: 20, turns: 1, calls: 2 }],
      ['chat', { promptTokens: 40, completionTokens: 20, turns: 1, calls: 1 }],
    ]),
    mcpServerCallCounts: new Map([['zen', 2], ['atlas', 1]]),
    ...overrides,
  };
}

test('A41-13 — maps model, session, lastTurn and caps', () => {
  const view = buildTurnUsageView(port());
  assert.equal(view.model, 'gpt-test');
  assert.equal(view.session.promptTokens, 100);
  assert.equal(view.lastTurn.completionTokens, 20);
  assert.deepEqual(view.taskBudgetCaps, { maxPerTaskUSD: 1, maxPerTaskTokens: 1000 });
});

test('A41-13 — bySkill and byMcpServer are sorted by name', () => {
  const view = buildTurnUsageView(port());
  assert.deepEqual(view.bySkill.map((s) => s.skill), ['chat', 'review']);
  assert.deepEqual(view.byMcpServer, [{ server: 'atlas', calls: 1 }, { server: 'zen', calls: 2 }]);
});

test('A41-13 — omits taskBudgetCaps when the run has none', () => {
  const view = buildTurnUsageView(port({ taskBudgetCaps: undefined }));
  assert.equal(view.taskBudgetCaps, undefined);
});

test('A41-13 — copies (not aliases) the session/lastTurn objects', () => {
  const p = port();
  const view = buildTurnUsageView(p);
  view.session.promptTokens = 999;
  assert.equal(p.sessionUsage.promptTokens, 100, 'view must not alias agent state');
});
