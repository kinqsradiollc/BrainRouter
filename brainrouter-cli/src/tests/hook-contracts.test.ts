import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { parseHookDecision, addHook } from '../state/hooksStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

// --- pure decision parsing ---------------------------------------------------

test('parseHookDecision: deny/allow/updatedInput; non-JSON → null', () => {
  assert.deepEqual(parseHookDecision('{"decision":"deny","reason":"prod is frozen"}'),
    { decision: 'deny', reason: 'prod is frozen' });
  assert.deepEqual(parseHookDecision('  {"decision":"allow"} '), { decision: 'allow' });
  assert.deepEqual(parseHookDecision('{"updatedInput":{"command":"git status"}}'),
    { updatedInput: { command: 'git status' } });
  assert.equal(parseHookDecision('all good'), null);
  assert.equal(parseHookDecision(''), null);
  assert.equal(parseHookDecision('{"unrelated":true}'), null);
});

// --- pre-tool decision: deny on exit 0 ----------------------------------------

test('pre-tool hook JSON deny blocks the call even with exit code 0', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    addHook(workspace, {
      event: 'pre-tool',
      match: 'list_dir',
      command: `echo '{"decision":"deny","reason":"listing is forbidden by policy-bot"}'`,
    });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    // NOT silent — hooks only fire for the user-facing agent.
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    // Drive one tool through the dispatch path that applies hooks.
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({
            choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] } }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Understood — listing is blocked by policy.' } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;
      const answer = await agent.runTurn('list the workspace', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      } as any);
      assert.match(answer, /blocked by policy/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// --- user-prompt-submit gate ---------------------------------------------------

test('user-prompt-submit deny blocks the turn before any LLM call', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    addHook(workspace, {
      event: 'user-prompt-submit',
      command: `echo '{"decision":"deny","reason":"prompts are frozen during the demo"}'`,
    });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const originalFetch = globalThis.fetch;
    let llmCalled = false;
    try {
      globalThis.fetch = (async () => { llmCalled = true; throw new Error('should not be called'); }) as any;
      const answer = await agent.runTurn('do something', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      } as any);
      assert.match(answer, /Prompt blocked by user-prompt-submit hook: prompts are frozen/);
      assert.equal(llmCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
