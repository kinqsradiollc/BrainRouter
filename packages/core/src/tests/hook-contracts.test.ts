import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { parseHookDecision, addHook } from '../hooks/hooksStore.js';
import { setCliKnobOverride, _resetCliKnobsCache, resolveCliKnobs } from '../config/config.js';
import { withTempWorkspaceAsync } from './_helpers.js';

/**
 * The agent tests below each mutate PROCESS-GLOBAL state — `globalThis.fetch`,
 * `process.cwd()` + `BRAINROUTER_HOME` (via withTempWorkspaceAsync), and the
 * CLI-knobs override. node:test runs sibling tests concurrently, so without a
 * lock their temp workspaces (and thus hooks.json) clobber each other. `serial`
 * chains them onto one promise so only one runs at a time, regardless of the
 * runner's concurrency.
 */
let _gate: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = _gate.then(fn, fn);
  _gate = run.then(() => undefined, () => undefined);
  return run;
}

/** Two-response LLM mock: a tool call, then a final answer; captures the 2nd request body. */
function toolThenAnswer(toolName: string, args: unknown, onSecond?: (body: any) => void) {
  let calls = 0;
  return (async (_url: string, init: any) => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    onSecond?.(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
}

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

test('cli.hooks config: enabled + enforceWhenSilent default true; both overridable', () => {
  assert.deepEqual(resolveCliKnobs({ activeServer: '', servers: {} }).hooks, { enabled: true, enforceWhenSilent: true });
  assert.deepEqual(resolveCliKnobs({ activeServer: '', servers: {}, cli: { hooks: { enabled: false } } } as any).hooks, { enabled: false, enforceWhenSilent: true });
  assert.deepEqual(resolveCliKnobs({ activeServer: '', servers: {}, cli: { hooks: { enforceWhenSilent: false } } } as any).hooks, { enabled: true, enforceWhenSilent: false });
});

// --- pre-tool decision: deny on exit 0 ----------------------------------------

test('pre-tool hook JSON deny blocks the call even with exit code 0', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    addHook(workspace, {
      event: 'pre-tool',
      match: 'list_dir',
      command: `echo '{"decision":"deny","reason":"listing is forbidden by policy-bot"}'`,
    });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
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
      const answer = await agent.runTurn('list the workspace', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      assert.match(answer, /blocked by policy/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));
});

// --- enforcement on UNATTENDED (silent) agents -------------------------------

test('pre-tool deny hook ALSO blocks a SILENT/unattended agent (enforceWhenSilent default)', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    addHook(workspace, { event: 'pre-tool', match: 'list_dir', command: `echo '{"decision":"deny","reason":"policy: no listing on workers"}'` });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: true, // <-- the unattended case
    });
    const originalFetch = globalThis.fetch;
    let secondBody: any = null;
    try {
      setCliKnobOverride({ hooks: { enabled: true, enforceWhenSilent: true } });
      globalThis.fetch = toolThenAnswer('list_dir', { path: '.' }, (b) => { secondBody = b; });
      await agent.runTurn('list the workspace', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      // The KEY assertion for #3: a pre-tool deny hook fired and BLOCKED the call
      // on a SILENT/unattended agent (it wouldn't before — hooks were !silent-gated).
      assert.match(JSON.stringify(secondBody?.messages ?? []), /Blocked by pre-tool hook/);
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  }));
});

// --- user-prompt-submit gate ---------------------------------------------------

test('user-prompt-submit deny blocks the turn before any LLM call', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
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
      const answer = await agent.runTurn('do something', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      assert.match(answer, /Prompt blocked by user-prompt-submit hook: prompts are frozen/);
      assert.equal(llmCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));
});
