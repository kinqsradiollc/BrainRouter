import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '../config/config.js';
import { createRequirement, listRequirements } from '../requirement/requirementStore.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('automation config defaults every automatic phase to disabled', () => {
  const automation = resolveCliKnobs({ activeServer: '', servers: {} }).automation;

  assert.deepEqual(automation, {
    enabled: false,
    requirements: { enabled: false, autoCreateThreshold: 0.7, lowActThreshold: 0.4 },
    sync: { enabled: false },
    sprints: { enabled: false, minItems: 3, respectCapacity: true },
  });
});

test('requirement store persists the auto origin tag', () => {
  withTempWorkspace((workspace) => {
    const record = createRequirement(workspace, { title: 'Add rate limiting', origin: 'auto' });
    assert.equal(record.origin, 'auto');
  });
});

function response(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 8, completion_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function automationOverride(enabled: boolean) {
  return {
    nextActionPlanner: 'off' as const,
    automation: {
      enabled,
      requirements: { enabled, autoCreateThreshold: 0.7, lowActThreshold: 0.4 },
      sync: { enabled: false },
      sprints: { enabled: false, minItems: 3, respectCapacity: true },
    },
  };
}

test('pre-turn automation creates one provenance-linked auto requirement only when enabled', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    const mcp: any = {
      listTools: async () => ({ tools: [{ name: 'memory_capture_turn' }] }),
      callTool: async (name: string) => ({
        content: [{ text: JSON.stringify(name === 'memory_resolve_session' ? { sessionKey: 'session:auto' } : { recordId: 'mem_auto_requirement' }) }],
      }),
      close: async () => {},
    };
    try {
      globalThis.fetch = (async () => response('Done.')) as any;
      setCliKnobOverride(automationOverride(true));
      const agent = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, sessionKey: 'session:auto', silent: false,
      });
      await agent.runTurn('add a rate-limiter to the gateway', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const created = listRequirements(workspace);
      assert.equal(created.length, 1);
      assert.equal(created[0].origin, 'auto');
      assert.equal(created[0].sessionKey, 'session:auto');
      assert.deepEqual(created[0].acceptanceCriteria, ['Add a rate-limiter to the gateway.']);
      assert.equal(created[0].sourceEventId, 'mem_auto_requirement');
      assert.deepEqual(created[0].linkedMemoryIds, ['mem_auto_requirement']);

      await agent.runTurn('add a rate-limiter to the gateway', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(listRequirements(workspace).length, 1, 'an equivalent open requirement must not duplicate');

      _resetCliKnobsCache();
      setCliKnobOverride(automationOverride(false));
      const disabled = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, sessionKey: 'session:disabled', silent: false,
      });
      await disabled.runTurn('add request tracing to the gateway', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(listRequirements(workspace).length, 1, 'disabled automation must not create a second record');
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});
