import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import {
  parseHookDecision, addHook, hookMatchesTool, readHooks, removeHook,
  applyMessageDisplayHooks, parseSessionStartDirectives, collectStopAdditionalContext,
  type HookRunResult,
} from '../hooks/hooksStore.js';
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

test('parseHookDecision: accepts additionalContext / updatedOutput / isError', () => {
  assert.deepEqual(parseHookDecision('{"additionalContext":"note"}'), { additionalContext: 'note' });
  assert.deepEqual(parseHookDecision('{"updatedOutput":"redacted"}'), { updatedOutput: 'redacted' });
  assert.deepEqual(parseHookDecision('{"isError":true}'), { isError: true });
});

// --- CC-hooks parity: pure helpers -------------------------------------------

test('parseHookDecision: accepts sessionTitle / reloadSkills (CC-hooks parity)', () => {
  assert.deepEqual(parseHookDecision('{"sessionTitle":"Nightly refactor"}'), { sessionTitle: 'Nightly refactor' });
  assert.deepEqual(parseHookDecision('{"reloadSkills":true}'), { reloadSkills: true });
  assert.deepEqual(parseHookDecision('{"sessionTitle":"X","reloadSkills":true}'), { sessionTitle: 'X', reloadSkills: true });
});

/** Minimal HookRunResult factory — only stdout/exitCode matter to the folders. */
function res(stdout: string, exitCode = 0): HookRunResult {
  return { hook: { id: 'h', event: 'stop', command: 'c', enabled: true, createdAt: '' } as any, exitCode, stdout, stderr: '' };
}

test('applyMessageDisplayHooks: transform replaces, deny hides, no-op passes through', () => {
  // no hooks → unchanged
  assert.deepEqual(applyMessageDisplayHooks('hello', []), { text: 'hello', hidden: false, transformed: false });
  // transform
  assert.deepEqual(applyMessageDisplayHooks('hello', [res('{"updatedOutput":"HELLO"}')]),
    { text: 'HELLO', hidden: false, transformed: true });
  // deny hides (empty text)
  assert.deepEqual(applyMessageDisplayHooks('secret', [res('{"decision":"deny"}')]),
    { text: '', hidden: true, transformed: false });
  // deny short-circuits a later transform
  assert.deepEqual(applyMessageDisplayHooks('secret', [res('{"decision":"deny"}'), res('{"updatedOutput":"X"}')]),
    { text: '', hidden: true, transformed: false });
  // non-JSON / exit-only stdout is a no-op
  assert.deepEqual(applyMessageDisplayHooks('hi', [res('all good')]), { text: 'hi', hidden: false, transformed: false });
  // last transform wins when chained
  assert.deepEqual(applyMessageDisplayHooks('a', [res('{"updatedOutput":"b"}'), res('{"updatedOutput":"c"}')]),
    { text: 'c', hidden: false, transformed: true });
});

test('parseSessionStartDirectives: title (last wins), reloadSkills OR, additionalContext accumulates', () => {
  assert.deepEqual(parseSessionStartDirectives([]), { reloadSkills: false });
  assert.deepEqual(
    parseSessionStartDirectives([res('{"sessionTitle":"First"}'), res('{"sessionTitle":"Second"}')]),
    { reloadSkills: false, sessionTitle: 'Second' },
  );
  assert.deepEqual(
    parseSessionStartDirectives([res('{"reloadSkills":false}'), res('{"reloadSkills":true}')]),
    { reloadSkills: true },
  );
  assert.deepEqual(
    parseSessionStartDirectives([res('{"additionalContext":"a"}'), res('{"additionalContext":"b"}')]),
    { reloadSkills: false, additionalContext: 'a\nb' },
  );
  // whitespace-only title / context is ignored
  assert.deepEqual(parseSessionStartDirectives([res('{"sessionTitle":"   "}')]), { reloadSkills: false });
});

test('collectStopAdditionalContext: accumulates in order, empty → undefined', () => {
  assert.equal(collectStopAdditionalContext([]), undefined);
  assert.equal(collectStopAdditionalContext([res('not json')]), undefined);
  assert.equal(collectStopAdditionalContext([res('{"additionalContext":"one"}'), res('{"additionalContext":"two"}')]), 'one\ntwo');
});

test('hookMatchesTool: anchored glob, substring back-compat, empty', () => {
  // glob is anchored
  assert.ok(hookMatchesTool('read_*', 'read_file'));
  assert.ok(!hookMatchesTool('read_*', 'write_file'));
  assert.ok(hookMatchesTool('*_file', 'write_file'));
  assert.ok(hookMatchesTool('read_?ile', 'read_file'));
  assert.ok(!hookMatchesTool('read_*', 'list_dir'));
  // no glob char → legacy substring
  assert.ok(hookMatchesTool('list', 'list_dir'));
  assert.ok(!hookMatchesTool('write', 'list_dir'));
  // empty matches everything
  assert.ok(hookMatchesTool('', 'anything'));
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

// --- user-prompt-submit: inject context (non-denying) -------------------------

test('user-prompt-submit additionalContext is injected into the prompt the model sees', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id); // isolate from any leaked deny hook
    addHook(workspace, {
      event: 'user-prompt-submit',
      command: `echo '{"additionalContext":"REMEMBER prod is frozen"}'`,
    });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const originalFetch = globalThis.fetch;
    // Capture EVERY request body — the turn makes a planner pre-call plus the main
    // call(s), and the injected context must reach the model in at least one.
    const bodies: string[] = [];
    try {
      globalThis.fetch = (async (_url: string, init: any) => {
        bodies.push(init?.body ? String(init.body) : '');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;
      const ans = await agent.runTurn('ship the feature', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      assert.match(bodies.join('\n'), /REMEMBER prod is frozen/, `fetches=${bodies.length} answer=${JSON.stringify(ans).slice(0, 200)}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));
});

// --- post-tool: replace the model-visible output ------------------------------

test('post-tool updatedOutput replaces the tool result the model receives', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id); // isolate from any leaked deny hook
    addHook(workspace, {
      event: 'post-tool',
      match: 'list_dir',
      command: `echo '{"updatedOutput":"REDACTED-BY-HOOK"}'`,
    });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const originalFetch = globalThis.fetch;
    const bodies: string[] = [];
    let toolEmitted = false;
    try {
      // Emit list_dir once from the MAIN agent loop (not the planner pre-call),
      // so the tool runs and the post-tool hook redacts its output; the redacted
      // text then appears in the next request body sent to the model.
      globalThis.fetch = (async (_url: string, init: any) => {
        const body = init?.body ? String(init.body) : '';
        bodies.push(body);
        if (!toolEmitted && !body.includes('PLANNER') && body.includes('"tools"')) {
          toolEmitted = true;
          return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;
      await agent.runTurn('list the workspace', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      assert.ok(bodies.some((b) => b.includes('REDACTED-BY-HOOK')), 'redacted output should reach the LLM');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));
});

// --- CC-hooks parity: stop additionalContext injection ------------------------

test('stop hook additionalContext is injected into the NEXT turn the model sees', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id);
    addHook(workspace, {
      event: 'stop',
      command: `echo '{"additionalContext":"CARRYOVER: verify the migration ran"}'`,
    });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const originalFetch = globalThis.fetch;
    const bodies: string[] = [];
    try {
      setCliKnobOverride({ hooks: { enabled: true, enforceWhenSilent: true } });
      globalThis.fetch = (async (_url: string, init: any) => {
        bodies.push(init?.body ? String(init.body) : '');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;
      // Turn 1 fires the stop hook, which stashes additionalContext for turn 2.
      await agent.runTurn('first task', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      assert.equal(agent.pendingStopContext, 'CARRYOVER: verify the migration ran', 'stop hook context stashed');
      const before = bodies.length;
      // Turn 2 DRAINS the turn-1 stash into the prompt the model sees. (The stop
      // hook then fires again at the END of turn 2 and re-stashes — that is
      // correct: the injection is drain-once-per-turn, not fire-once-ever.)
      await agent.runTurn('second task', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      assert.match(bodies.slice(before).join('\n'), /CARRYOVER: verify the migration ran/, 'stashed context reaches the model on the next turn');
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  }));
});

// --- CC-hooks parity: notification hook fires on completion -------------------

test('notification-agent-completed hook fires through the hooks runner on finish', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id);
    // The hook writes a sentinel file into the workspace when it fires — a
    // side-effect the test can observe without a live notifier.
    const sentinel = `${workspace}/notified.txt`;
    addHook(workspace, { event: 'notification-agent-completed', command: `echo done > '${sentinel}'` });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const originalFetch = globalThis.fetch;
    try {
      setCliKnobOverride({ hooks: { enabled: true, enforceWhenSilent: true } });
      globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
      await agent.runTurn('do it', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any);
      const fs = await import('node:fs');
      assert.ok(fs.existsSync(sentinel), 'completion notification hook ran (sentinel written)');
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  }));
});
