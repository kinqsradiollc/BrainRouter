import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { setSessionMode } from '../session/state/sessionModeStore.js';
import { readPlanHistory } from '../task/planHistoryStore.js';
import { setCliKnobOverride } from '../config/config.js';
import { withTempWorkspaceAsync } from './_helpers.js';

// The next-action planner would consume the first stubbed LLM call; turn it off
// so call #1 is the main loop's first tool turn. (Reset by withTempWorkspaceAsync.)
const noPlanner = (): void => setCliKnobOverride({ nextActionPlanner: 'off' });

const stubMcp = (): any => ({
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [{ text: '{}' }] }),
  close: async () => {},
});

const updatePlanCall = (id: string, plan: Array<{ step: string; status: string }>): unknown => ({
  id, type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ plan, explanation: 'v' }) },
});

const reply = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const usage = { prompt_tokens: 10, completion_tokens: 2 };

test('auto mode: update_plan records an auto-approval into the plan history', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) return reply({ choices: [{ message: { content: '', tool_calls: [updatePlanCall('p1', [{ step: 'design', status: 'in_progress' }, { step: 'build', status: 'pending' }])] } }], usage });
        return reply({ choices: [{ message: { content: 'Done.' } }], usage });
      }) as any;

      const agent = new Agent(stubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: ws, launchCwd: ws, sessionKey: 'sess:auto', silent: false, accessMode: 'shell',
      });
      setSessionMode(ws, 'sess:auto', { executionMode: 'fast', reviewPolicy: 'proceed' }); // auto mode
      noPlanner();

      await agent.runTurn('do the thing', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as never);

      const hist = readPlanHistory(ws, 'sess:auto');
      assert.equal(hist.length, 1, 'one auto-approval recorded');
      assert.equal(hist[0].verdict, 'approved');
      assert.equal(hist[0].actor, 'auto');
      assert.equal(hist[0].planSnapshot.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('non-auto mode (plan/request): update_plan records NO approval', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) return reply({ choices: [{ message: { content: '', tool_calls: [updatePlanCall('p1', [{ step: 'design', status: 'in_progress' }])] } }], usage });
        return reply({ choices: [{ message: { content: 'Done.' } }], usage });
      }) as any;

      const agent = new Agent(stubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: ws, launchCwd: ws, sessionKey: 'sess:plan', silent: false, accessMode: 'shell',
      });
      setSessionMode(ws, 'sess:plan', { executionMode: 'planning', reviewPolicy: 'request' }); // NOT auto
      noPlanner();

      await agent.runTurn('do it', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as never);

      assert.equal(readPlanHistory(ws, 'sess:plan').length, 0, 'no decision recorded outside auto mode');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('auto mode dedup: re-updating the SAME plan version (status change) records once', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) return reply({ choices: [{ message: { content: '', tool_calls: [updatePlanCall('p1', [{ step: 'design', status: 'in_progress' }, { step: 'build', status: 'pending' }])] } }], usage });
        // same step set, design now completed → SAME plan version (no new approval)
        if (calls === 2) return reply({ choices: [{ message: { content: '', tool_calls: [updatePlanCall('p2', [{ step: 'design', status: 'completed' }, { step: 'build', status: 'completed' }])] } }], usage });
        return reply({ choices: [{ message: { content: 'Done.' } }], usage });
      }) as any;

      const agent = new Agent(stubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: ws, launchCwd: ws, sessionKey: 'sess:dedup', silent: false, accessMode: 'shell',
      });
      setSessionMode(ws, 'sess:dedup', { executionMode: 'fast', reviewPolicy: 'proceed' });
      noPlanner();

      await agent.runTurn('do it', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as never);

      const hist = readPlanHistory(ws, 'sess:dedup');
      assert.equal(hist.length, 1, 'same plan version → a single auto-approval, not one per status tick');
      assert.equal(hist[0].actor, 'auto');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
