import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';
import { createRequirement, getRequirement } from '../requirement/requirementStore.js';
import {
  createWorkItem,
  findWorkItemsByCodeLink,
  getWorkItem,
  linkWorkItem,
} from '../track/trackStore.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('Track store: findWorkItemsByCodeLink matches exact kind and reference', () => {
  withTempWorkspace((workspace) => {
    const branch = createWorkItem(workspace, { title: 'Branch evidence' });
    const commit = createWorkItem(workspace, { title: 'Commit evidence' });
    linkWorkItem(workspace, branch.id, { codeLinks: [{ kind: 'branch', ref: 'feat/tracing' }] });
    linkWorkItem(workspace, commit.id, { codeLinks: [{ kind: 'commit', ref: 'feat/tracing' }] });

    assert.deepEqual(
      findWorkItemsByCodeLink(workspace, { kind: 'branch', ref: 'feat/tracing' }).map((item) => item.id),
      [branch.id],
    );
    assert.deepEqual(findWorkItemsByCodeLink(workspace, { kind: 'branch', ref: 'missing' }), []);
  });
});

function response(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ message }],
    usage: { prompt_tokens: 8, completion_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function automationOverride(enabled: boolean) {
  return {
    nextActionPlanner: 'off' as const,
    automation: {
      enabled,
      requirements: { enabled: false, autoCreateThreshold: 0.7, lowActThreshold: 0.4 },
      sync: { enabled },
      sprints: { enabled: false, minItems: 3, respectCapacity: true },
    },
  };
}

test('code-link automation: branch then PR advance an item and done back-links its requirement', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'session:code-link';
    const requirement = createRequirement(workspace, { title: 'Trace requests', sessionKey });
    const workItem = createWorkItem(workspace, { title: 'Trace requests', requirementId: requirement.id, sessionKey });
    const originalFetch = globalThis.fetch;
    const captured: Array<Record<string, unknown>> = [];
    let llmCalls = 0;
    setCliKnobOverride(automationOverride(true));
    globalThis.fetch = (async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return response({
          content: '',
          tool_calls: [{
            id: 'link_branch', type: 'function',
            function: { name: 'track_update', arguments: JSON.stringify({ action: 'link', key: workItem.key, codeLinks: [{ kind: 'branch', ref: 'feat/request-tracing' }] }) },
          }],
        });
      }
      if (llmCalls === 2) {
        return response({
          content: '',
          tool_calls: [{
            id: 'link_pr', type: 'function',
            function: { name: 'track_update', arguments: JSON.stringify({ action: 'link', key: workItem.key, codeLinks: [{ kind: 'pull-request', ref: 'https://example.test/pull/42' }] }) },
          }],
        });
      }
      if (llmCalls === 3) {
        return response({
          content: '',
          tool_calls: [{
            id: 'complete', type: 'function',
            function: { name: 'track_update', arguments: JSON.stringify({ action: 'transition', key: workItem.key, toStatus: 'done' }) },
          }],
        });
      }
      return response({ content: 'Tracing work is complete.' });
    }) as any;
    const mcp: any = {
      listTools: async () => ({ tools: [{ name: 'memory_capture_turn' }] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'memory_capture_turn') captured.push(args);
        return { content: [{ text: JSON.stringify({ recordId: `mem_code_${captured.length}` }) }] };
      },
      close: async () => {},
    };
    try {
      const agent = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, sessionKey, silent: false,
      });
      await agent.runTurn('link the implementation evidence', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const completed = getWorkItem(workspace, workItem.id)!;
      assert.equal(llmCalls, 4);
      assert.equal(completed.statusCategory, 'done');
      assert.equal(completed.codeLinks.length, 2);
      assert.ok(getRequirement(workspace, requirement.id)?.taskIds.includes(workItem.id));
      const eventActions = captured
        .map((call) => (call.messages as Array<{ content: string }> | undefined)?.[1]?.content)
        .flatMap((content) => {
          try { return [JSON.parse(content ?? '')]; } catch { return []; }
        })
        .map((event) => event?.action)
        .filter(Boolean);
      assert.deepEqual(eventActions, ['code-link-progress', 'code-link-progress', 'requirement-fulfilled']);
      assert.equal(completed.linkedMemoryIds.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});

test('code-link automation: disabled configuration leaves a linked todo item unchanged', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const workItem = createWorkItem(workspace, { title: 'No automatic transition' });
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    setCliKnobOverride(automationOverride(false));
    globalThis.fetch = (async () => {
      llmCalls += 1;
      return llmCalls === 1
        ? response({
          content: '',
          tool_calls: [{
            id: 'link_disabled', type: 'function',
            function: { name: 'track_update', arguments: JSON.stringify({ action: 'link', key: workItem.key, codeLinks: [{ kind: 'branch', ref: 'feat/no-auto' }] }) },
          }],
        })
        : response({ content: 'Evidence linked.' });
    }) as any;
    try {
      const mcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, sessionKey: 'session:disabled', silent: false,
      });
      await agent.runTurn('link evidence only', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(getWorkItem(workspace, workItem.id)?.statusCategory, 'todo');
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});
