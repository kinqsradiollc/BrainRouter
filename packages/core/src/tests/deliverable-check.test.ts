import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { classifyDeferral, buildDeliverableCorrection } from '../agent/deliverableCheck.js';
import { withTempWorkspaceAsync } from './_helpers.js';

// --- CC-P6.2 pure heuristics --------------------------------------------------

test('classifyDeferral: trailing question → question', () => {
  assert.equal(classifyDeferral('I scanned the repo. Should I also check the tests?'), 'question');
  assert.equal(classifyDeferral('Done. Want me to continue?'), 'question');
});

test('classifyDeferral: offer endings → offer', () => {
  assert.equal(classifyDeferral('Here is a partial sketch. Let me know if you want the full implementation.'), 'offer');
  assert.equal(classifyDeferral('The fix is small. Happy to implement it.'), 'offer');
});

test('classifyDeferral: promise endings → promise', () => {
  assert.equal(classifyDeferral("I found the root cause in router.ts. I'll now implement the fix."), 'promise');
  assert.equal(classifyDeferral('The plan is solid. Next, I will write the migration.'), 'promise');
});

test('classifyDeferral: substantive endings pass clean', () => {
  assert.equal(classifyDeferral('Fixed the bug in src/router.ts:42 — all 1295 tests pass.'), null);
  assert.equal(classifyDeferral('The recall pipeline has four stages: retrieval, rerank, judge, expansion.'), null);
  // A question asked AND answered mid-message must not trip the ending check.
  assert.equal(classifyDeferral('Why does it fail? Because the cache key drifts. Fixed by pinning the key.'), null);
  // Early promise followed by the actual result is fine.
  assert.equal(classifyDeferral("I'll check the config first. Checked: the value is 42, which confirms the bug. Patched and verified."), null);
  assert.equal(classifyDeferral(''), null);
});

test('classifyDeferral: a report ending on a Markdown table row is a deliverable, not a question', () => {
  // The investigation-report false positive: the message ends with a table
  // whose last cell happens to contain a '?'. That's the deliverable, not the
  // model deferring — it must NOT be classified as a trailing question.
  const report = [
    '## Root causes',
    '',
    '| Bug | File | Fix |',
    '|-----|------|-----|',
    '| Banner stuck | useAgentEvents.ts:1124 | refresh goalState |',
    '| Which first? | — | your call? |',
  ].join('\n');
  assert.equal(classifyDeferral(report), null);
  // A plain trailing question still trips it.
  assert.equal(classifyDeferral('Here is the summary. Which bug should I fix first?'), 'question');
});

test('buildDeliverableCorrection: names the deferral kind and demands the result', () => {
  const c = buildDeliverableCorrection('offer', 'let me know if…');
  assert.match(c, /deliverable guardrail/i);
  assert.match(c, /OFFER/);
  assert.match(c, /IN THIS MESSAGE/);
});

// --- CC-P6.2 runTurn guard ------------------------------------------------------

test('runTurn: deliverable guard nudges a worked-then-deferred turn into delivering', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let sawGuardMessage = false;
    try {
      globalThis.fetch = (async (_url: any, opts: any) => {
        const body = JSON.parse(opts.body);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        calls++;
        if (calls === 1) {
          // Do real work: one read tool call.
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (calls === 2) {
          // End on an offer instead of the deliverable → guard must fire.
          return new Response(JSON.stringify({
            choices: [{ message: { content: 'I inspected the workspace. Let me know if you want a summary.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        sawGuardMessage = messages.some((m: any) =>
          m.role === 'user' && typeof m.content === 'string' && m.content.includes('deliverable guardrail'));
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'The workspace contains 3 files; the entry point is index.ts.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;

      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('what is in this workspace?', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      } as any);

      assert.equal(sawGuardMessage, true, 'guard correction must be injected before the final call');
      assert.match(answer, /entry point is index\.ts/);
      assert.equal(calls, 3, 'exactly one nudge: work → deferral → delivered');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn: deliverable guard stays quiet when the turn ends on substance', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'The workspace has 3 files. Entry point: index.ts.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;

      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('what is here?', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      } as any);
      assert.match(answer, /Entry point: index\.ts/);
      assert.equal(calls, 2, 'no extra LLM round-trip when the ending is substantive');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
