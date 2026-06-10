import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('requestInterrupt: a multi-tool turn stops at the boundary with a clean answer', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    try {
      globalThis.fetch = (async () => {
        llmCalls++;
        // One batch of two reads; the agent gets interrupted during tool 1.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } },
                { id: 'c2', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } },
              ],
            },
          }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;

      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });

      const skipped: string[] = [];
      const answer = await agent.runTurn('look around', {
        onStatusUpdate: () => {},
        onToolStart: () => { agent.requestInterrupt(); }, // user hits Stop mid-batch
        onToolEnd: (tool: string, r: { success: boolean; summary: string }) => {
          if (!r.success && r.summary.includes('interrupted')) skipped.push(tool);
        },
      } as any);

      assert.match(answer, /interrupted/i);
      assert.equal(llmCalls, 1, 'no further LLM calls after the stop');
      assert.ok(skipped.length >= 1, 'queued tools were skipped, not executed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('requestInterrupt before any turn is a no-op for the next turn (flag resets)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'All done: 42.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      agent.requestInterrupt(); // stale flag from "before" the turn
      const answer = await agent.runTurn('hi', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      assert.match(answer, /All done: 42/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
