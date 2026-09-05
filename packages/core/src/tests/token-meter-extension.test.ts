// ADR-041 A41-13 — the token-meter extension is the first consumer of the D4b
// turn-end phase-hook seam: it reads the usage view and injects a soft budget
// advisory into the next turn when session spend crosses a cap threshold.
//
// Plain ESM under extensions/token-meter/index.js, loaded via a non-literal dynamic
// import (tsc treats it as `any`). It deep-imports the built budget helpers, so the
// core package must be built (dist/) for this test to resolve them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionHost } from '../extension/host.js';
import type { PhaseHookHandler, AgentPhaseName } from '../extension/registry.js';
import type { TurnUsageView } from '../util/tokens/turnUsageView.js';

interface Ext {
  activate: (host: ExtensionHost) => Promise<void>;
  budgetAdvisoryFor: (usage: TurnUsageView, opts?: { threshold?: number }) => string | undefined;
}

async function loadExtension(): Promise<Ext> {
  const url = new URL('../../extensions/token-meter/index.js', import.meta.url).href;
  return import(/* @vite-ignore */ url as string) as Promise<Ext>;
}

function view(over: Partial<TurnUsageView> = {}): TurnUsageView {
  return {
    model: 'gpt-test',
    session: { promptTokens: 0, completionTokens: 0, calls: 0, turns: 0, cachedTokens: 0, missedTokens: 0 },
    lastTurn: { promptTokens: 0, completionTokens: 0, calls: 0, cachedTokens: 0, missedTokens: 0 },
    bySkill: [],
    byMcpServer: [],
    ...over,
  };
}

test('A41-13 — no advisory when the run has no task budget caps', async () => {
  const { budgetAdvisoryFor } = await loadExtension();
  assert.equal(budgetAdvisoryFor(view()), undefined);
});

test('A41-13 — advises once session tokens cross the threshold of the token cap', async () => {
  const { budgetAdvisoryFor } = await loadExtension();
  const usage = view({
    session: { promptTokens: 850, completionTokens: 0, calls: 1, turns: 1, cachedTokens: 0, missedTokens: 850 },
    taskBudgetCaps: { maxPerTaskUSD: 0, maxPerTaskTokens: 1000 },
  });
  const line = budgetAdvisoryFor(usage, { threshold: 0.8 });
  assert.ok(line, 'expected an advisory at 85% of the token cap');
  assert.match(line!, /85%/);
  assert.match(line!, /task budget/);
});

test('A41-13 — stays quiet below the threshold and at/over the hard cap', async () => {
  const { budgetAdvisoryFor } = await loadExtension();
  const caps = { maxPerTaskUSD: 0, maxPerTaskTokens: 1000 };
  const below = view({ session: { promptTokens: 500, completionTokens: 0, calls: 1, turns: 1, cachedTokens: 0, missedTokens: 500 }, taskBudgetCaps: caps });
  const over = view({ session: { promptTokens: 1200, completionTokens: 0, calls: 1, turns: 1, cachedTokens: 0, missedTokens: 1200 }, taskBudgetCaps: caps });
  assert.equal(budgetAdvisoryFor(below, { threshold: 0.8 }), undefined, 'below threshold: quiet');
  assert.equal(budgetAdvisoryFor(over, { threshold: 0.8 }), undefined, 'past the hard cap the enforcer handles it');
});

test('A41-13 — activate registers a turn-end hook that injects only past threshold', async () => {
  const ext = await loadExtension();
  const captured: Array<{ phase: AgentPhaseName; handler: PhaseHookHandler }> = [];
  const host = {
    workspaceRoot: '/tmp', version: 'test', log: () => {},
    registerTool: () => ({ dispose() {} }),
    registerProvider: () => ({ dispose() {} }),
    registerHook: () => ({ dispose() {} }),
    registerPhaseHook: (phase: AgentPhaseName, handler: PhaseHookHandler) => { captured.push({ phase, handler }); return { dispose() {} }; },
    registerPanel: () => ({ dispose() {} }),
  } as unknown as ExtensionHost;

  await ext.activate(host);
  assert.equal(captured.length, 1, 'activate should register one phase hook');
  const registered = captured[0]!;
  assert.equal(registered.phase, 'turn-end');

  const injected: string[] = [];
  const ctx = {
    phase: 'turn-end' as const, workspaceRoot: '/tmp', sessionKey: 's1',
    usage: view({
      session: { promptTokens: 900, completionTokens: 0, calls: 1, turns: 1, cachedTokens: 0, missedTokens: 900 },
      taskBudgetCaps: { maxPerTaskUSD: 0, maxPerTaskTokens: 1000 },
    }),
    injectNextTurnContext: (t: string) => { injected.push(t); },
  };
  await registered.handler.after?.(ctx, () => {});
  assert.equal(injected.length, 1, 'a crossing session injects one advisory');
  assert.match(injected[0]!, /Budget notice/);

  // A ctx with no usage / no channel must be a safe no-op (never throws).
  await registered.handler.after?.({ phase: 'turn-end', workspaceRoot: '/tmp', sessionKey: 's1' }, () => {});
});
