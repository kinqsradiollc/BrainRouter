import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { runShell } from '../runtime/exec/sandbox.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('DESK-6 runShell SIGKILLs a long command the instant the signal aborts', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 150);
  const t0 = Date.now();
  const r = await runShell('sleep 10', { enabled: false, workspaceRoot: process.cwd() } as any, 120_000, ctrl.signal);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2_000, `killed promptly (${elapsed}ms), not after the 10s sleep or 120s timeout`);
  assert.equal(r.interrupted, true, 'returns a clean interrupted envelope');
  assert.equal(r.exitCode, 130);
});

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

test('DESK-6 requestInterrupt mid-LLM-call aborts the in-flight request and does NOT retry', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let agentRef: any;
    try {
      // A fetch that NEVER resolves on its own — it only settles when the
      // request's AbortSignal fires (i.e. when the user presses Stop). This is
      // the "model is generating for a long time" case.
      globalThis.fetch = ((_url: any, opts: any) => {
        llmCalls++;
        // Fire Stop the instant the (first) request is in flight.
        queueMicrotask(() => agentRef?.requestInterrupt());
        return new Promise((_resolve, reject) => {
          const sig: AbortSignal | undefined = opts?.signal;
          const onAbort = () => { const e: any = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e); };
          if (sig?.aborted) onAbort();
          else sig?.addEventListener('abort', onAbort, { once: true });
        });
      }) as any;

      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      agentRef = agent;

      const t0 = Date.now();
      const answer = await agent.runTurn('do a long thing', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      const elapsed = Date.now() - t0;

      assert.match(answer, /interrupted/i);
      assert.equal(llmCalls, 1, 'the aborted request is NOT retried/reconnected (interrupt is not a transient failure)');
      assert.ok(elapsed < 5_000, `unwinds promptly (took ${elapsed}ms), not after the LLM timeout`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
