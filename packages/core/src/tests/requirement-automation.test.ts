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
    requirements: { enabled: false, autoCreateThreshold: 0.7, lowActThreshold: 0.4, autopilot: false },
    sync: { enabled: false },
    sprints: { enabled: false, minItems: 3, respectCapacity: true, autopilot: false },
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

function automationOverride(enabled: boolean, autopilot = false) {
  return {
    nextActionPlanner: 'off' as const,
    providerRequestFormat: {},
    automation: {
      enabled,
      requirements: { enabled, autoCreateThreshold: 0.7, lowActThreshold: 0.4, autopilot },
      sync: { enabled: false },
      sprints: { enabled: false, minItems: 3, respectCapacity: true, autopilot: false },
    },
  };
}

const NOOP = { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} };
function autoMcp(): any {
  return {
    listTools: async () => ({ tools: [{ name: 'memory_capture_turn' }] }),
    callTool: async () => ({ content: [{ text: JSON.stringify({ recordId: 'mem_x' }) }] }),
    close: async () => {},
  };
}

test('tiered autonomy: default captures a DRAFT, autopilot captures READY', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => response('Done.')) as any;
    try {
      // default (autopilot off) → draft, gated until a human promotes.
      setCliKnobOverride(automationOverride(true, false));
      const a = new Agent(autoMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, { workspaceRoot: workspace, launchCwd: workspace, sessionKey: 'session:draft', silent: false });
      await a.runTurn('add a rate-limiter to the gateway', NOOP);
      assert.equal(listRequirements(workspace)[0].status, 'draft', 'default keeps the human gate');

      // autopilot on → ready, so the cascade can run unattended.
      _resetCliKnobsCache();
      setCliKnobOverride(automationOverride(true, true));
      const b = new Agent(autoMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, { workspaceRoot: workspace, launchCwd: workspace, sessionKey: 'session:autopilot', silent: false });
      await b.runTurn('add request tracing to the gateway', NOOP);
      const ready = listRequirements(workspace).find((r) => r.sessionKey === 'session:autopilot')!;
      assert.equal(ready.status, 'ready', 'autopilot promotes straight to ready');
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});

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
