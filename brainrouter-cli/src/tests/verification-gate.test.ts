import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import {
  classifyForVerification,
  shouldNudgeVerification,
  buildVerificationNudge,
} from '../agent/verificationGate.js';
import { withTempWorkspaceAsync } from './_helpers.js';

// --- pure classifiers -------------------------------------------------------

test('classifyForVerification: edits mutate; build/test commands verify', () => {
  assert.equal(classifyForVerification('edit_file'), 'mutated');
  assert.equal(classifyForVerification('write_file'), 'mutated');
  assert.equal(classifyForVerification('apply_patch'), 'mutated');
  assert.equal(classifyForVerification('run_command', 'npm test'), 'verified');
  assert.equal(classifyForVerification('run_command', 'npm run build'), 'verified');
  assert.equal(classifyForVerification('run_command', 'vitest run src/'), 'verified');
  assert.equal(classifyForVerification('run_command', 'cargo check'), 'verified');
  assert.equal(classifyForVerification('run_command', 'tsc --noEmit'), 'verified');
});

test('classifyForVerification: non-verify shell mutates; reads are neutral', () => {
  assert.equal(classifyForVerification('run_command', 'git add -A'), 'mutated');
  assert.equal(classifyForVerification('run_command', 'echo hi'), 'mutated');
  assert.equal(classifyForVerification('read_file'), 'none');
  assert.equal(classifyForVerification('grep_search'), 'none');
});

test('shouldNudgeVerification: only when mutated && not verified && not nudged', () => {
  assert.equal(shouldNudgeVerification({ mutated: true, verified: false, alreadyNudged: false }), true);
  assert.equal(shouldNudgeVerification({ mutated: true, verified: true, alreadyNudged: false }), false);
  assert.equal(shouldNudgeVerification({ mutated: false, verified: false, alreadyNudged: false }), false);
  assert.equal(shouldNudgeVerification({ mutated: true, verified: false, alreadyNudged: true }), false);
});

test('buildVerificationNudge: demands a check and allows a justified skip', () => {
  const m = buildVerificationNudge();
  assert.match(m, /verification guardrail/i);
  assert.match(m, /build, test, typecheck/);
  assert.match(m, /docs-only/);
});

// --- runTurn integration ----------------------------------------------------

test('runTurn: verification gate nudges an edit-then-done turn into verifying', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let sawNudge = false;
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello\n');
      globalThis.fetch = (async (_url: any, opts: any) => {
        const body = JSON.parse(opts.body);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        calls++;
        if (calls === 1) {
          // read then edit, in one assistant message
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [
                  { id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } },
                  { id: 'e1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a.txt', targetContent: 'hello', replacementContent: 'hi' }) } },
                ],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (calls === 2) {
          // Declare done with NO verification → gate must fire.
          return new Response(JSON.stringify({
            choices: [{ message: { content: 'Done — edited a.txt.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        sawNudge = messages.some((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('verification guardrail'));
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Verified — the change is correct (no test suite in this workspace).' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;

      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, accessMode: 'shell',
      });
      const answer = await agent.runTurn('change hello to hi in a.txt', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      } as any);
      assert.equal(sawNudge, true, 'verification nudge injected before the final reply');
      assert.match(answer, /Verified/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
