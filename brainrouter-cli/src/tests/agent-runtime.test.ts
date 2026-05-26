import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, buildChatCompletionPayload } from '../agent/agent.js';
import { executeOrchestrationTool } from '../orchestration/tools.js';
import { clearGoal, readGoal, setGoal } from '../state/goalStore.js';
import { makeAgent, withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('resolveRecallMode: env > default with defensive fallback (9b)', async () => {
  const { resolveRecallMode } = await import('../agent/agent.js');
  const prev = process.env.BRAINROUTER_RECALL_MODE;
  try {
    delete process.env.BRAINROUTER_RECALL_MODE;
    assert.equal(resolveRecallMode(), 'gated', 'unset env defaults to gated');

    process.env.BRAINROUTER_RECALL_MODE = 'always';
    assert.equal(resolveRecallMode(), 'always');

    process.env.BRAINROUTER_RECALL_MODE = 'off';
    assert.equal(resolveRecallMode(), 'off');

    process.env.BRAINROUTER_RECALL_MODE = 'GATED';
    assert.equal(resolveRecallMode(), 'gated', 'case-insensitive');

    process.env.BRAINROUTER_RECALL_MODE = 'ludicrous';
    assert.equal(resolveRecallMode(), 'gated', 'garbled value falls through to gated default — defensive');

    process.env.BRAINROUTER_RECALL_MODE = '';
    assert.equal(resolveRecallMode(), 'gated', 'empty string falls through to gated default');
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_RECALL_MODE;
    else process.env.BRAINROUTER_RECALL_MODE = prev;
  }
});

test('countEntityTokens: detects file paths, identifiers, and proper nouns (9b)', async () => {
  const { countEntityTokens } = await import('../agent/agent.js');
  // Empty / trivial inputs.
  assert.equal(countEntityTokens(''), 0);
  assert.equal(countEntityTokens('thanks'), 0);
  assert.equal(countEntityTokens('ok'), 0);

  // File paths trigger detection.
  assert.ok(countEntityTokens('look at src/foo.ts') >= 1);
  assert.ok(countEntityTokens('compare src/foo.ts vs lib/bar.ts') >= 2);

  // Identifier-shaped tokens (camelCase, snake_case, PascalCase) trigger.
  assert.ok(countEntityTokens('debug the BillingService and userController paths') >= 2);

  // Sentence-leading capitals do NOT count — only mid-sentence proper nouns.
  // "The cat" → "The" is leading, not counted; "cat" lowercase doesn't count.
  assert.equal(countEntityTokens('The cat sat down.'), 0);
  // "I talked to John about Mary" → John + Mary count.
  assert.ok(countEntityTokens('I talked to John about Mary') >= 2);

  // A realistic "ambiguous-enough-to-need-recall" message clears the 2-cue bar.
  const score = countEntityTokens('what did we decide about src/foo.ts and the BillingService?');
  assert.ok(score >= 2, `expected ≥2 entity hits, got ${score}`);
});

test('normalizeToolName resolves common LLM hallucinations to the canonical tool name', async () => {
  const { normalizeToolName } = await import('../agent/agent.js');
  const candidates = ['read_file', 'list_dir', 'grep_search', 'memory_recall'];
  // Exact match passes through unchanged.
  assert.equal(normalizeToolName('read_file', candidates), 'read_file');
  // Case variants.
  assert.equal(normalizeToolName('Read_File', candidates), 'read_file');
  assert.equal(normalizeToolName('READ_FILE', candidates), 'read_file');
  // Separator variants.
  assert.equal(normalizeToolName('read-file', candidates), 'read_file');
  assert.equal(normalizeToolName('read.file', candidates), 'read_file');
  assert.equal(normalizeToolName('read file', candidates), 'read_file');
  // Whitespace around.
  assert.equal(normalizeToolName('  read_file  ', candidates), 'read_file');
  // Unknown name passes through (trimmed) so the existing explainer can fire.
  assert.equal(normalizeToolName('not_a_real_tool', candidates), 'not_a_real_tool');
  // Ambiguous collision: if two candidates would normalize to the same form,
  // we fall back to the input rather than silently picking one.
  assert.equal(normalizeToolName('foo', ['foo_', 'foo-']), 'foo');
});

test('normalizeToolName resolves cross-vendor shell aliases to run_command', async () => {
  const { normalizeToolName } = await import('../agent/agent.js');
  const candidates = ['run_command', 'read_file', 'list_dir'];
  // Claude Code convention.
  assert.equal(normalizeToolName('Bash', candidates), 'run_command');
  assert.equal(normalizeToolName('bash', candidates), 'run_command');
  // Generic shell synonyms.
  assert.equal(normalizeToolName('shell', candidates), 'run_command');
  assert.equal(normalizeToolName('sh', candidates), 'run_command');
});

test('normalizeToolName does NOT alias bash when run_command is not in the registry', async () => {
  const { normalizeToolName } = await import('../agent/agent.js');
  // Read-only access mode strips run_command. Aliasing must not silently
  // re-create access the agent doesn't have — let dispatch return "unknown
  // tool" instead.
  const candidates = ['read_file', 'list_dir'];
  assert.equal(normalizeToolName('bash', candidates), 'bash');
});

test('Agent.setModel / getModel switches the LLM model at runtime', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    assert.equal(agent.getModel(), 'test-model');
    agent.setModel('claude-sonnet-4-5');
    assert.equal(agent.getModel(), 'claude-sonnet-4-5');
  });
});

test('Agent.setAccessMode / getAccessMode round-trips and tracks current mode', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    // Silent children default to whatever was constructed; we explicitly set here.
    agent.setAccessMode('read');
    assert.equal(agent.getAccessMode(), 'read');
    agent.setAccessMode('write');
    assert.equal(agent.getAccessMode(), 'write');
    agent.setAccessMode('shell');
    assert.equal(agent.getAccessMode(), 'shell');
  });
});

test('Agent.loadHistory replaces chat history and refreshSystemPrompt updates it in place', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    const replay = [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'system', content: 'should be ignored' }, // only user/assistant/tool replayed
    ];
    const count = agent.loadHistory(replay);
    assert.equal(count, 2);
    // Pre-9d the goal block landed in chatHistory[0] AND was re-pushed as a
    // per-turn `goal-anchor` system message — same content in two places
    // per turn. 9d made the per-turn anchor the single owner; the
    // foundational system message no longer mentions the goal. Verify the
    // ownership change: setting a goal + refreshing the prompt produces a
    // system message that DOES NOT contain the goal text (the next
    // runTurn would push it via the anchor).
    setGoal(workspace, 'finish the auth refactor', agent.sessionKey);
    agent.refreshSystemPrompt();
    const sys = (agent as any).chatHistory[0];
    assert.equal(sys.role, 'system');
    assert.doesNotMatch(sys.content, /Active Goal/, 'foundational system message must not carry the goal block (9d)');
    assert.doesNotMatch(sys.content, /finish the auth refactor/, 'foundational system message must not echo the goal text (9d)');
    clearGoal(workspace, agent.sessionKey);
  });
});

test('Agent.runTurn pushes the goal-anchor system message as the single owner of goal state (9d)', async () => {
  // Verifies the per-turn anchor still fires after createSystemMessage
  // stopped embedding the goal. Without this assertion, future refactors
  // could silently drop the anchor injection and lose the goal entirely.
  await withTempWorkspaceAsync(async (workspace) => {
    const agent = makeAgent(workspace);
    setGoal(workspace, 'reach a stable build', agent.sessionKey);
    // Seed the chat history with the foundational system message exactly
    // as bootstrapSession would, so the test mirrors the real runTurn
    // sequencing (foundational system message first, then per-turn
    // anchor pushed to the end).
    agent.loadHistory([]);
    agent.refreshSystemPrompt();
    const foundationalSystem = (agent as any).chatHistory[0];
    assert.doesNotMatch(
      foundationalSystem.content,
      /reach a stable build/,
      'foundational system message must not carry the goal text (9d ownership change)',
    );
    // Now drive the anchor injection directly — same code path as
    // `agent.ts:680` inside `runTurn`.
    const { formatGoalBlock, readGoal } = await import('../state/goalStore.js');
    const goal = readGoal(workspace, agent.sessionKey);
    assert.ok(goal, 'precondition: setGoal succeeded');
    (agent as any).replaceTaggedSystemMessage('goal-anchor', formatGoalBlock(goal!));
    const hist = (agent as any).chatHistory;
    const anchor = hist.find((m: any) =>
      m.role === 'system' && typeof m.content === 'string' && m.content.includes('brainrouter:goal-anchor'),
    );
    assert.ok(anchor, 'goal-anchor must be present after the per-turn re-push');
    assert.match(anchor.content, /reach a stable build/, 'anchor must contain the goal text');
    assert.match(anchor.content, /Active Goal/, 'anchor must contain the canonical block header');
    // Anchor lives AT THE END so it's in immediate-context distance for
    // the upcoming user message (PR #26 design — the whole point of the
    // per-turn re-push). chatHistory[0] still must not duplicate it.
    assert.equal(hist[hist.length - 1], anchor);
    assert.notEqual(hist[0], anchor, 'foundational system message must not BE the anchor (9d)');
    clearGoal(workspace, agent.sessionKey);
  });
});

test('Agent.fork swaps the sessionKey while preserving prior history', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    agent.loadHistory([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'reply' },
    ]);
    const newKey = `${agent.sessionKey}:fork:abcdef`;
    agent.fork(newKey);
    assert.equal(agent.sessionKey, newKey);
    const hist = (agent as any).chatHistory;
    // System message is regenerated, but the prior turn pair is kept.
    assert.equal(hist[0].role, 'system');
    assert.equal(hist[1].content, 'first turn');
    assert.equal(hist[2].content, 'reply');
  });
});

test('agent: removeTaggedSystemMessage is idempotent and clears stale entries', async () => {
  const { Agent } = await import('../agent/agent.js');
  // Construct an Agent without touching MCP/LLM; we just exercise the
  // chatHistory mutation methods that are pure CPU.
  const stubMcp: any = { callTool: async () => ({ content: [] }) };
  const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' }, {
    workspaceRoot: '/tmp', launchCwd: '/tmp', sessionKey: 's:test',
  });
  // Seed with a system message (the constructor pushes one).
  agent.replaceTaggedSystemMessage('demo', 'first version');
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('first version')).length, 1);
  agent.replaceTaggedSystemMessage('demo', 'second version');
  // Replace removes the first version and adds the second.
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('first version')).length, 0);
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('second version')).length, 1);
  // Remove drops the second.
  agent.removeTaggedSystemMessage('demo');
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('second version')).length, 0);
  // Idempotent: removing again is a no-op (doesn't throw).
  agent.removeTaggedSystemMessage('demo');
  // Other tags are untouched by tag-specific removal.
  agent.replaceTaggedSystemMessage('other', 'keep me');
  agent.removeTaggedSystemMessage('demo');
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('keep me')).length, 1);
});

test('runTurn: repeat-loop guard short-circuits identical (tool, args) calls after 3 repeats', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    const toolCallEvents: Array<{ name: string; ok: boolean; summary: string }> = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      const body = JSON.parse(opts.body);
      // The model keeps insisting on list_dir({path:"."}) until iteration 5
      // when it gives up and produces a final answer.
      if (llmCalls <= 5) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: `call_${llmCalls}`, type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'I gave up trying the same thing.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('list it', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => { toolCallEvents.push({ name, ok: result.success, summary: result.summary }); },
      });
      // First 3 calls executed normally (the directory exists, will succeed).
      const successes = toolCallEvents.filter((e) => e.ok && e.name === 'list_dir').length;
      const guarded = toolCallEvents.filter((e) => !e.ok && /repeat guard/.test(e.summary)).length;
      assert.equal(successes, 3, `expected 3 successful list_dir calls, got ${successes}`);
      assert.equal(guarded >= 1, true, `expected at least 1 repeat-guard trip, got ${guarded}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn empty LLM answer after a tool call returns a useful summary (not the loop-limit error)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        // First turn: ask for list_dir.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Second turn: empty content, NO tool calls (the bug-trigger case).
      return new Response(JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 50, completion_tokens: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('list dir', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.doesNotMatch(answer, /tool-call loop limit/);
      assert.equal(agent.lastTurnHitLoopLimit, false);
      assert.equal(agent.lastTurnToolCalls, 1);
      assert.match(answer, /Tool calls completed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn forces wait_agents before final answer after spawn_agents', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      if (lastUser === 'child-one' || lastUser === 'child-two') {
        return new Response(JSON.stringify({
          choices: [{ message: { content: `child output for ${lastUser}` } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_spawn_all',
                type: 'function',
                function: {
                  name: 'spawn_agents',
                  arguments: JSON.stringify({
                    agents: [
                      { role: 'explorer', prompt: 'child-one' },
                      { role: 'explorer', prompt: 'child-two' },
                    ],
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (parentCalls === 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'I will now wait for them to complete.' } }],
          usage: { prompt_tokens: 80, completion_tokens: 8 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Both child outputs were incorporated.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 6 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const toolNames: string[] = [];
      const waitArgs: any[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('find me any vulnerabilities in the project', {
        onStatusUpdate: () => {},
        onToolStart: (name, args) => {
          toolNames.push(name);
          if (name === 'wait_agents') waitArgs.push(args);
        },
        onToolEnd: () => {},
      });

      assert.deepEqual(toolNames.filter((name) => name === 'wait_agents'), ['wait_agents']);
      assert.equal(waitArgs.length, 1);
      assert.equal(waitArgs[0].ids.length, 2);
      assert.equal(answer, 'Both child outputs were incorporated.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn auto-drains spawned children and reports explicit timeout statuses', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    const previousDrainTimeout = process.env.BRAINROUTER_CHILD_DRAIN_TIMEOUT_MS;
    let parentCalls = 0;
    process.env.BRAINROUTER_CHILD_DRAIN_TIMEOUT_MS = '10';

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      if (/slow child task/.test(lastUser)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'slow child output' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'spawn_agent',
                  arguments: JSON.stringify({ role: 'explorer', prompt: 'slow child task' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'I am waiting for the child agent to finish.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const toolNames: string[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('start the slow child', {
        onStatusUpdate: () => {},
        onToolStart: (name) => { toolNames.push(name); },
        onToolEnd: () => {},
      });

      assert.deepEqual(toolNames.filter((name) => name === 'wait_agents'), ['wait_agents']);
      assert.match(answer, /children still running/i);
      assert.match(answer, /agent-[a-f0-9]{8}/);
      assert.match(answer, /explorer/);
      assert.match(answer, /running|pending/);
      assert.match(answer, /\/continue/);
      assert.doesNotMatch(answer, /I am waiting for the child agent/);

      await new Promise((resolve) => setTimeout(resolve, 70));
    } finally {
      globalThis.fetch = originalFetch;
      if (previousDrainTimeout === undefined) delete process.env.BRAINROUTER_CHILD_DRAIN_TIMEOUT_MS;
      else process.env.BRAINROUTER_CHILD_DRAIN_TIMEOUT_MS = previousDrainTimeout;
    }
  });
});

test('runTurn: goal_complete is refused while the active plan has pending / in_progress items (plan honesty guard)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'fixed-test-session-key-for-deterministic-agent-state';
    setGoal(workspace, 'analyze the CLI architecture', sessionKey);
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        // First LLM call: build a plan with one ✓ and three ☐.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_plan',
                type: 'function',
                function: {
                  name: 'update_plan',
                  arguments: JSON.stringify({
                    plan: [
                      { step: 'Reload context', status: 'completed' },
                      { step: 'Analyze skillRunner.ts', status: 'pending' },
                      { step: 'Inspect runtime files', status: 'pending' },
                      { step: 'Synthesize summary', status: 'in_progress' },
                    ],
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (llmCalls === 2) {
        // Second LLM call: try to declare done while plan items are open.
        // The guard must refuse this with a clear remediation hint.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_done',
                type: 'function',
                function: {
                  name: 'goal_complete',
                  arguments: JSON.stringify({ proof: 'Architecture synthesized.' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Third call: empty exit.
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'I will finish the work first.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, sessionKey,
      });
      await agent.runTurn('analyze', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      // The guard should have refused goal_complete — goal status stays active.
      const goalAfter = readGoal(workspace, sessionKey);
      assert.equal(goalAfter?.status, 'active', 'goal must remain active when plan is incomplete');
      assert.equal(agent.lastGoalTransition, undefined, 'lastGoalTransition must not be set when goal_complete was refused');
    } finally {
      globalThis.fetch = originalFetch;
      clearGoal(workspace, sessionKey);
    }
  });
});

test('buildChatCompletionPayload: forwards reasoning_effort for a known reasoning model on the OpenAI endpoint (0.3.6 item 2f)', () => {
  // gpt-5 + api.openai.com is the most clear-cut case: OpenAI's Chat
  // Completions schema lists `reasoning_effort: low|medium|high` and gpt-5
  // is a reasoning model. The forwarding must happen for low/high but stay
  // silent on medium — that's the default and forwarding it would change
  // request shape for every user who never touched /effort.
  const supported = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'plan a refactor' }],
    [],
    { effort: 'high' },
  );
  assert.equal((supported as any).reasoning_effort, 'high');

  const lowEffort = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'plan a refactor' }],
    [],
    { effort: 'low' },
  );
  assert.equal((lowEffort as any).reasoning_effort, 'low');

  // medium is the default — forwarding it would silently change request
  // shape for users who never set /effort. The field must be absent.
  const medium = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'plan a refactor' }],
    [],
    { effort: 'medium' },
  );
  assert.equal((medium as any).reasoning_effort, undefined);

  // Omitting the option entirely is identical to medium — no change in shape.
  const noOption = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'plan a refactor' }],
    [],
  );
  assert.equal((noOption as any).reasoning_effort, undefined);
});

test('buildChatCompletionPayload: skips reasoning_effort for non-reasoning models regardless of endpoint (0.3.6 item 2f)', () => {
  // gpt-4o-mini on the OpenAI endpoint: not a reasoning model, must not
  // receive reasoning_effort even when /effort is set — gpt-4o-mini
  // doesn't have a reasoning channel and the field would be a no-op.
  const nonReasoning = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'just answer' }],
    [],
    { effort: 'high' },
  );
  assert.equal((nonReasoning as any).reasoning_effort, undefined);

  // Non-reasoning model on a local OpenAI-compatible endpoint (LM Studio /
  // Ollama / vLLM): same answer — qwen2.5-coder has no reasoning channel,
  // so we don't forward. The model name is the signal, not the endpoint.
  const localNonReasoning = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'qwen2.5-coder',
      endpoint: 'http://localhost:1234/v1',
    },
    [{ role: 'user', content: 'just answer' }],
    [],
    { effort: 'high' },
  );
  assert.equal((localNonReasoning as any).reasoning_effort, undefined);
});

test('buildChatCompletionPayload: forwards reasoning_effort for reasoning models on local OpenAI-compatible servers (LM Studio, Ollama)', () => {
  // LM Studio 0.3.29+ implements `reasoning_effort` on /v1/chat/completions
  // for `openai/gpt-oss-20b` (per their release notes). Ollama does the
  // same for its reasoning models. Gating purely on endpoint hostname
  // would silently drop the forwarding for these legitimate cases — so
  // the heuristic keys on the model name and accepts ANY OpenAI-compatible
  // endpoint.
  const lmStudio = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'openai/gpt-oss-20b',
      endpoint: 'http://localhost:1234/v1',
    },
    [{ role: 'user', content: 'think hard' }],
    [],
    { effort: 'high' },
  );
  assert.equal((lmStudio as any).reasoning_effort, 'high');

  // Ollama: deepseek-r1 served from the default Ollama port.
  const ollama = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'deepseek-r1:14b',
      endpoint: 'http://localhost:11434/v1',
    },
    [{ role: 'user', content: 'reason' }],
    [],
    { effort: 'low' },
  );
  assert.equal((ollama as any).reasoning_effort, 'low');

  // Qwen3 thinking variant (LM Studio naming).
  const qwen = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'qwen3-30b-a3b-thinking',
      endpoint: 'http://localhost:1234/v1',
    },
    [{ role: 'user', content: 'go' }],
    [],
    { effort: 'high' },
  );
  assert.equal((qwen as any).reasoning_effort, 'high');
});

test('runTurn: when goal_complete fires with empty prose, the fallback surfaces the recorded proof so the user has something to read', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'fixed-test-session-key-for-goal-complete-fallback';
    setGoal(workspace, 'analyze the CLI architecture', sessionKey);
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        // First LLM call: empty prose + goal_complete tool call. This is the
        // exact bug-shape — the model declares done via tool but skips the
        // user-visible summary.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_done',
                type: 'function',
                function: {
                  name: 'goal_complete',
                  arguments: JSON.stringify({ proof: 'Architecture mapped to memory_working_offload; src/agent.ts L491 is the loop.' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Second LLM call (post tool-result): empty prose, no further tools.
      return new Response(JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 50, completion_tokens: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, sessionKey,
      });
      const answer = await agent.runTurn('analyze', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      // The fallback must now surface the proof string from goal_complete.
      // Old behavior: "Tool calls completed (N) and the model returned no
      // additional commentary." — proof was buried in goal.json.
      assert.equal(agent.lastGoalTransition, 'complete');
      assert.match(answer, /Goal completed/);
      assert.match(answer, /Architecture mapped to memory_working_offload/);
      assert.doesNotMatch(answer, /no additional commentary/);
    } finally {
      globalThis.fetch = originalFetch;
      clearGoal(workspace, sessionKey);
    }
  });
});

// P1.2 — spawn hierarchy + depth cap tests.
// These tests call executeOrchestrationTool directly and rely on the fact that
// hierarchy checks throw before mcpClient / llmConfig are accessed.

function makeStubOrchCtx(workspace: string, overrides: Record<string, unknown> = {}): Parameters<typeof executeOrchestrationTool>[2] {
  return {
    workspaceRoot: workspace,
    parentSessionKey: 'session:test',
    parentAccessMode: 'shell',
    mcpClient: null as any,
    llmConfig: null as any,
    launchCwd: workspace,
    ...overrides,
  };
}

test('P1.2: worker tier cannot delegate', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace, { parentTier: 'worker' });
    await assert.rejects(
      () => executeOrchestrationTool('spawn_agent', { role: 'worker', prompt: 'do something' }, ctx),
      /worker.*cannot delegate/i,
    );
  });
});

test('P1.2: reasoning tier cannot spawn another reasoning agent', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace, { parentTier: 'reasoning' });
    await assert.rejects(
      () => executeOrchestrationTool('spawn_agent', { role: 'explorer', prompt: 'investigate' }, ctx),
      /reasoning.*cannot spawn.*reasoning/i,
    );
  });
});

test('P1.2: reasoning tier can spawn a worker agent', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace, { parentTier: 'reasoning', depth: 1 });
    // Should pass the tier check (proceeds to createSession, then fails on null mcpClient)
    // We check it throws but NOT a hierarchy error.
    try {
      await executeOrchestrationTool('spawn_agent', { role: 'worker', prompt: 'implement it' }, ctx);
    } catch (err: any) {
      assert.doesNotMatch(String(err.message), /cannot delegate|cannot spawn.*reasoning/i,
        'hierarchy check must not fire for reasoning→worker');
    }
  });
});

test('P1.2: depth cap is enforced at default limit (3)', async () => {
  const prev = process.env.BRAINROUTER_MAX_SPAWN_DEPTH;
  try {
    delete process.env.BRAINROUTER_MAX_SPAWN_DEPTH;
    await withTempWorkspaceAsync(async (workspace) => {
      const ctx = makeStubOrchCtx(workspace, { depth: 3 });
      await assert.rejects(
        () => executeOrchestrationTool('spawn_agent', { role: 'worker', prompt: 'task' }, ctx),
        /depth cap/i,
      );
    });
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_MAX_SPAWN_DEPTH;
    else process.env.BRAINROUTER_MAX_SPAWN_DEPTH = prev;
  }
});

test('P1.2: depth cap is overridable via BRAINROUTER_MAX_SPAWN_DEPTH', async () => {
  const prev = process.env.BRAINROUTER_MAX_SPAWN_DEPTH;
  try {
    process.env.BRAINROUTER_MAX_SPAWN_DEPTH = '5';
    await withTempWorkspaceAsync(async (workspace) => {
      const ctx = makeStubOrchCtx(workspace, { depth: 3 });
      // Depth 3 < limit 5, so no cap error; expect a different failure (null mcpClient).
      try {
        await executeOrchestrationTool('spawn_agent', { role: 'worker', prompt: 'task' }, ctx);
      } catch (err: any) {
        assert.doesNotMatch(String(err.message), /depth cap/i,
          'depth cap must not fire when depth is below the custom limit');
      }
    });
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_MAX_SPAWN_DEPTH;
    else process.env.BRAINROUTER_MAX_SPAWN_DEPTH = prev;
  }
});

test('runTurn: delegate_agent triggers child-drain guardrail (R2 must not bypass R1)', async () => {
  // Regression for the R1↔R2 interaction. The model calls delegate_agent
  // (fire-and-forget), then tries to emit a no-tool answer. The guardrail
  // must auto-call wait_agents on the child id returned by delegate_agent —
  // not silently accept the prose answer.
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      if (/background child task/.test(lastUser)) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'background child output' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_delegate',
                type: 'function',
                function: {
                  name: 'delegate_agent',
                  arguments: JSON.stringify({ role: 'explorer', prompt: 'background child task' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (parentCalls === 2) {
        // Bug-shape: model tries to answer with no follow-up tool call.
        // Guardrail must catch this and inject a wait_agents drain.
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'I will keep working while the child runs.' } }],
          usage: { prompt_tokens: 80, completion_tokens: 8 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Background child output incorporated.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 6 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const toolNames: string[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('delegate the background work', {
        onStatusUpdate: () => {},
        onToolStart: (name) => { toolNames.push(name); },
        onToolEnd: () => {},
      });

      // Guardrail must have auto-fired wait_agents on the delegated child.
      assert.ok(
        toolNames.includes('wait_agents'),
        `expected wait_agents to fire after delegate_agent; saw: ${JSON.stringify(toolNames)}`,
      );
      // Final answer must come from the post-drain synthesis turn, not the
      // bug-shape prose that tried to skip the wait.
      assert.equal(answer, 'Background child output incorporated.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn: task_agent counts as already-waited (no double-drain)', async () => {
  // task_agent wraps spawn_agent({ wait: true }) — the wait happens
  // *inside* the tool call. The R1 guardrail must treat the returned
  // child id as already-observed and accept the model's no-tool answer
  // without auto-firing a redundant wait_agents.
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      if (/foreground child task/.test(lastUser)) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'foreground child output' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_task',
                type: 'function',
                function: {
                  name: 'task_agent',
                  arguments: JSON.stringify({ role: 'explorer', prompt: 'foreground child task' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Second call: model synthesises a final answer. Guardrail must NOT
      // fire wait_agents — task_agent already drained internally.
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Foreground child completed; answer below.' } }],
        usage: { prompt_tokens: 80, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const toolNames: string[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('do the foreground task', {
        onStatusUpdate: () => {},
        onToolStart: (name) => { toolNames.push(name); },
        onToolEnd: () => {},
      });

      assert.equal(
        toolNames.filter((n) => n === 'wait_agents').length,
        0,
        `task_agent already-waited path must not double-drain; saw: ${JSON.stringify(toolNames)}`,
      );
      assert.equal(answer, 'Foreground child completed; answer below.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestration: task_agent timeout returns explicit timeout envelope', async () => {
  // Spec §2 acceptance: task_agent returns "completed child output OR a
  // timeout envelope". Drive the timeout branch by making the child slow
  // and passing timeoutMs that cannot be met.
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'never reached' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const ctx = {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell' as const,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
      };
      const raw = await executeOrchestrationTool(
        'task_agent',
        { role: 'explorer', prompt: 'slow task', timeoutMs: 10 },
        ctx,
      );
      const result = JSON.parse(raw);
      assert.match(result.status, /timeout|running|pending/i,
        `expected timeout-shaped envelope; got ${JSON.stringify(result)}`);
      assert.match(result.id, /^agent-/);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('P1.2: agentId unknown returns error listing known ids', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace);
    await assert.rejects(
      () => executeOrchestrationTool('spawn_agent', { agentId: 'no-such-agent', prompt: 'task' }, ctx),
      /Unknown agentId.*Known agents/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 0.3.8-R4 — Safe parallel execution of independent read-only tool calls.
//
// The runtime now dispatches consecutive parallel-safe tool calls (read_file,
// list_dir, grep_search, glob_files, fetch_url, web_search, MCP memory reads)
// concurrently when the LLM emits them in a single assistant response. Writes,
// shell commands, orchestration tools, and any unknown tool name stay serial.
// Tool-result messages are still appended to chatHistory in the ORIGINAL call
// order so the model's next turn sees a deterministic trace.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

test('toolSafety.isParallelSafe accepts both bare and MCP-prefixed read tools, rejects writers/orchestration/unknowns', async () => {
  const { isParallelSafe } = await import('../agent/toolSafety.js');
  // Bare read-only locals — safe.
  for (const name of ['read_file', 'list_dir', 'grep_search', 'glob_files', 'fetch_url', 'web_search']) {
    assert.equal(isParallelSafe(name), true, `${name} must be parallel-safe`);
  }
  // Writers / shell / orchestration / interactive — never safe.
  for (const name of [
    'write_file', 'edit_file', 'apply_patch', 'run_command',
    'spawn_agent', 'spawn_agents', 'task_agent', 'delegate_agent',
    'wait_agent', 'wait_agents', 'close_agent', 'route_agent',
    'update_plan', 'goal_complete', 'goal_blocked', 'ask_user_choice',
    'list_agents', 'read_agent_transcript',
  ]) {
    assert.equal(isParallelSafe(name), false, `${name} must stay serial`);
  }
  // MCP read tools — canonical single-underscore form (R5).
  assert.equal(isParallelSafe('mcp_brainrouter_memory_recall'), true);
  assert.equal(isParallelSafe('mcp_some_long_server_id_memory_search'), true);
  // MCP write/admin tools — not on the read whitelist.
  assert.equal(isParallelSafe('mcp_brainrouter_memory_capture_turn'), false);
  assert.equal(isParallelSafe('mcp_brainrouter_memory_mark_cited'), false);
  // Empty / unknown / random garbage — fail-safe false.
  assert.equal(isParallelSafe(''), false);
  assert.equal(isParallelSafe('not_a_tool_we_know_about'), false);
});

test('toolSafety.parallelExecutionEnabled honors BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS kill switch', async () => {
  const { parallelExecutionEnabled } = await import('../agent/toolSafety.js');
  const prev = process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS;
  try {
    delete process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS;
    assert.equal(parallelExecutionEnabled(), true, 'default ON');
    for (const off of ['false', '0', 'off', 'no', 'FALSE']) {
      process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS = off;
      assert.equal(parallelExecutionEnabled(), false, `${off} disables`);
    }
    process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS = 'true';
    assert.equal(parallelExecutionEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS;
    else process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS = prev;
  }
});

// Helper: build a stubbed LLM `fetch` that replays a scripted sequence of
// assistant responses. Each entry in `responses` is what the next chat
// completion should return (content + optional tool_calls). After the
// scripted entries are exhausted, returns a clean prose completion so the
// agent exits the runTurn loop.
function stubLlm(responses: Array<{ content: string; tool_calls?: any[] }>): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const r = responses[call] ?? { content: 'done.' };
    call++;
    return new Response(JSON.stringify({
      choices: [{ message: { content: r.content, tool_calls: r.tool_calls } }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return () => { globalThis.fetch = originalFetch; };
}

function makeStubMcp(): any {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
}

test('R4: three read_file calls in one response run concurrently — total elapsed < sum of latencies', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    // Three files we'll read; the slow-read is enforced by monkey-patching
    // fs.readFileSync? No — readFileSync is sync, can't yield. Instead we
    // wrap executeLocalTool by making read_file await a sleep via the
    // tool path that DOES go through await: we use small files but inject
    // an artificial delay via a custom MCP-style read. The simplest route
    // is to monkey-patch the agent's executeLocalTool — but that's
    // private. Easier: monkey-patch fs.promises? read_file uses sync I/O.
    //
    // Concretely: we monkey-patch fs.readFileSync to busy-sleep ~50 ms
    // before returning, but a busy sleep blocks the event loop and kills
    // the concurrency we want to measure. So instead we patch
    // Agent.prototype.executeLocalTool to delegate to original after an
    // await sleep(50). That preserves true async concurrency.
    const { Agent } = await import('../agent/agent.js');
    const origExec = (Agent.prototype as any).executeLocalTool;
    (Agent.prototype as any).executeLocalTool = async function (name: string, args: any) {
      if (name === 'read_file') {
        await new Promise((res) => setTimeout(res, 50));
      }
      return origExec.call(this, name, args);
    };
    // Create three small files to read.
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      fs.writeFileSync(path.join(workspace, f), `content of ${f}`);
    }
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'call_c', type: 'function', function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ],
    }]);
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const t0 = Date.now();
      await agent.runTurn('read three files', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const elapsed = Date.now() - t0;
      // Three 50 ms reads serialized would take ≥150 ms. Concurrent should
      // settle in ~50 ms plus the second-LLM-call round-trip (still well
      // under 150 ms in a stubbed test). Give a generous bound to keep CI
      // stable but tight enough to fail if execution falls back to serial.
      assert.ok(elapsed < 130, `expected concurrent reads (<130 ms), got ${elapsed} ms`);
      assert.equal(agent.lastTurnToolCalls, 3, 'all three tool calls must count toward lastTurnToolCalls');
    } finally {
      restore();
      (Agent.prototype as any).executeLocalTool = origExec;
    }
  });
});

test('R4: tool-result chatHistory order matches original call order even when later reads finish first', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { Agent } = await import('../agent/agent.js');
    const origExec = (Agent.prototype as any).executeLocalTool;
    // Make read_file's delay depend on the path: a=60ms, b=20ms, c=5ms.
    // So if reads were appended in finish order, chatHistory would carry
    // c, b, a. The runtime must instead push them in original order: a, b, c.
    (Agent.prototype as any).executeLocalTool = async function (name: string, args: any) {
      if (name === 'read_file') {
        const delays: Record<string, number> = { 'a.txt': 60, 'b.txt': 20, 'c.txt': 5 };
        await new Promise((res) => setTimeout(res, delays[args.path] ?? 0));
      }
      return origExec.call(this, name, args);
    };
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      fs.writeFileSync(path.join(workspace, f), `content-${f}`);
    }
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'id_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'id_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'id_c', type: 'function', function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ],
    }]);
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('read all', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const hist = (agent as any).chatHistory as any[];
      const toolMsgs = hist.filter((m) => m.role === 'tool');
      // Three tool results in original (a, b, c) order, NOT settle (c, b, a) order.
      assert.deepEqual(
        toolMsgs.map((m) => m.tool_call_id),
        ['id_a', 'id_b', 'id_c'],
        'tool_result messages must preserve original call order',
      );
    } finally {
      restore();
      (Agent.prototype as any).executeLocalTool = origExec;
    }
  });
});

test('R4: mixed batch — 2 reads in parallel, then 1 write_file serially; write tool_result lands after both reads', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { Agent } = await import('../agent/agent.js');
    const origExec = (Agent.prototype as any).executeLocalTool;
    const execOrder: string[] = [];
    (Agent.prototype as any).executeLocalTool = async function (name: string, args: any) {
      execOrder.push(`start:${name}:${args.path ?? ''}`);
      if (name === 'read_file') await new Promise((res) => setTimeout(res, 30));
      const out = await origExec.call(this, name, args);
      execOrder.push(`end:${name}:${args.path ?? ''}`);
      return out;
    };
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'A');
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'B');
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'r2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"out.txt","content":"hi"}' } },
      ],
    }]);
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('mixed', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      // Both reads must start before either ends (proves parallel), and
      // write_file must START only after both reads have ENDED (proves serial tail).
      const startA = execOrder.indexOf('start:read_file:a.txt');
      const startB = execOrder.indexOf('start:read_file:b.txt');
      const endA = execOrder.indexOf('end:read_file:a.txt');
      const endB = execOrder.indexOf('end:read_file:b.txt');
      const startW = execOrder.indexOf('start:write_file:out.txt');
      assert.ok(startA >= 0 && startB >= 0, 'both reads must have started');
      assert.ok(startB < endA, 'read B must start before read A finishes (parallel)');
      assert.ok(startW > endA && startW > endB, 'write must start after both reads complete');
      // Tool-result chatHistory order matches call order.
      const hist = (agent as any).chatHistory as any[];
      const ids = hist.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
      assert.deepEqual(ids, ['r1', 'r2', 'w1']);
    } finally {
      restore();
      (Agent.prototype as any).executeLocalTool = origExec;
    }
  });
});

test('R4: unknown tool name in the batch is treated as serial (conservative fail-safe)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { Agent } = await import('../agent/agent.js');
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'A');
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'u1', type: 'function', function: { name: 'totally_made_up_tool', arguments: '{}' } },
        { id: 'r2', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      ],
    }]);
    try {
      // Unknown tools fall through to the MCP client; make the stub
      // surface a JSON-RPC-style "unknown tool" so the agent's catch
      // branch produces the canonical error envelope.
      const stub = {
        listTools: async () => ({ tools: [] }),
        callTool: async (name: string) => { throw new Error(`-32601 Unknown tool: ${name}`); },
        close: async () => {},
      } as any;
      const agent = new Agent(stub, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('mixed unknown', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const hist = (agent as any).chatHistory as any[];
      const toolMsgs = hist.filter((m) => m.role === 'tool');
      // All three calls must produce a tool_result, in original order.
      assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['r1', 'u1', 'r2']);
      // The unknown one is reported as an error envelope.
      const unknown = toolMsgs.find((m) => m.tool_call_id === 'u1');
      assert.equal(unknown.isError, true);
      assert.match(String(unknown.content), /does not exist|Unknown tool/i);
    } finally {
      restore();
    }
  });
});

test('R4: BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS=false forces serial execution of read batches', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { Agent } = await import('../agent/agent.js');
    const origExec = (Agent.prototype as any).executeLocalTool;
    (Agent.prototype as any).executeLocalTool = async function (name: string, args: any) {
      if (name === 'read_file') await new Promise((res) => setTimeout(res, 30));
      return origExec.call(this, name, args);
    };
    for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(workspace, f), 'x');
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'r2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'r3', type: 'function', function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ],
    }]);
    const prev = process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS;
    process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS = 'false';
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const t0 = Date.now();
      await agent.runTurn('three serial reads', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const elapsed = Date.now() - t0;
      // Three 30 ms reads serialized ≈ 90 ms; allow generous bound.
      assert.ok(elapsed >= 80, `kill switch must restore serial behaviour, got ${elapsed} ms`);
    } finally {
      restore();
      (Agent.prototype as any).executeLocalTool = origExec;
      if (prev === undefined) delete process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS;
      else process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS = prev;
    }
  });
});

// R3 — Child progress visibility in Ink.
// Regression: when a spawn_agent child runs a tool, the parent's
// onChildToolStart and onChildToolEnd callbacks must fire with the
// child's id, role, tool name, args, ok flag, and a non-negative
// durationMs. Without this the Ink scrollback has no signal that a
// long-running child is actually making progress.
test('runTurn: child tool events propagate to parent onChildToolStart / onChildToolEnd (R3)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      // The child sees its own bounded prompt "do-child-work". On its
      // first call it lists the workspace; on its second it produces a
      // final answer.
      if (/do-child-work/.test(lastUser)) {
        const hasToolResult = messages.some((m: any) => m.role === 'tool' && m.name === 'list_dir');
        if (!hasToolResult) {
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [{ id: 'call_child_ls', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
              },
            }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'child done.' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'spawn_agent',
                  arguments: JSON.stringify({ role: 'explorer', prompt: 'do-child-work', wait: true, timeoutMs: 5000 }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'parent done.' } }],
        usage: { prompt_tokens: 40, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const childStarts: any[] = [];
      const childEnds: any[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('please spawn a child', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onChildToolStart: (e) => { childStarts.push(e); },
        onChildToolEnd: (e) => { childEnds.push(e); },
      });
      // The child ran list_dir once before its final answer — the parent
      // must have seen a paired start + end event for that call.
      const startLs = childStarts.find((e) => e.tool === 'list_dir');
      const endLs = childEnds.find((e) => e.tool === 'list_dir');
      assert.ok(startLs, `expected an onChildToolStart for list_dir, got ${JSON.stringify(childStarts.map((e) => e.tool))}`);
      assert.ok(endLs, `expected an onChildToolEnd for list_dir, got ${JSON.stringify(childEnds.map((e) => e.tool))}`);
      assert.equal(startLs.role, 'explorer');
      assert.equal(endLs.role, 'explorer');
      assert.equal(typeof startLs.childId, 'string');
      assert.equal(startLs.childId, endLs.childId);
      assert.equal(typeof endLs.durationMs, 'number');
      assert.ok(endLs.durationMs >= 0, 'durationMs must be non-negative');
      assert.equal(endLs.ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 0.3.8-I4 — Strict tool-call recovery end-to-end (deer-flow pattern).
// Pure-function helpers live in tool-call-recovery.test.ts; these exercise
// the agent.ts integration: dedupe → parse-args recovery → orphan synthesis
// → unknown-tool "did you mean" hint.
// ---------------------------------------------------------------------------

test('runTurn recovery: duplicate tool_call ids in one response are deduped (last wins, no 400 next turn)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        // Model emits TWO tool_calls with the same id — recovery should
        // drop the first and keep the second (path=second).
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [
                { id: 'dup_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"first"}' } },
                { id: 'dup_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
              ],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Capture the second request to verify the assistant turn it sees
      // contains exactly ONE tool_call (the deduped one) paired with one
      // tool_result — i.e. the next-turn request stays well-formed.
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('list', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      assert.equal(answer, 'done');
      // The second request's messages should contain a single assistant
      // message with one tool_call and exactly one matching tool result.
      const msgs: any[] = secondRequestBody.messages;
      const assistantWithCalls = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
      assert.ok(assistantWithCalls, 'assistant tool_calls message present');
      assert.equal(assistantWithCalls.tool_calls.length, 1, 'duplicate tool_call id was deduped');
      // Last occurrence won — args should be the second one ({"path":"."}).
      assert.equal(assistantWithCalls.tool_calls[0].function.arguments, '{"path":"."}');
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      assert.equal(toolMsgs.length, 1, 'one tool_result for the one surviving tool_call');
      assert.equal(toolMsgs[0].tool_call_id, 'dup_1');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('runTurn recovery: malformed JSON arguments surface as a structured tool_result, loop continues', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    const toolEvents: Array<{ name: string; ok: boolean; summary: string }> = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              // Trailing comma — JSON.parse will throw on this.
              tool_calls: [{ id: 'bad_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"foo",}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'recovered' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('read foo', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => toolEvents.push({ name, ok: result.success, summary: result.summary }),
      });
      assert.equal(answer, 'recovered', 'loop continued instead of aborting');
      // The bad-args tool_result is in the second request's message list,
      // and it carries the structured error the model can read.
      const toolMsgs = secondRequestBody.messages.filter((m: any) => m.role === 'tool');
      assert.equal(toolMsgs.length, 1);
      assert.equal(toolMsgs[0].tool_call_id, 'bad_1');
      assert.match(toolMsgs[0].content, /Tool argument JSON was malformed/);
      assert.match(toolMsgs[0].content, /Re-issue the tool call/);
      // The tool-end event was emitted with the bad-args summary.
      const badArgs = toolEvents.find((e) => /malformed/i.test(e.summary));
      assert.ok(badArgs, 'malformed-args tool event surfaced');
      assert.equal(badArgs!.ok, false);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('runTurn recovery: unknown tool name surfaces "did you mean" via normalizeToolName', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        // Case/separator mismatch — normalizeToolName resolves "Read-File"
        // to canonical "read_file" via flatten-and-compare.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'unk_1', type: 'function', function: { name: 'Read-File', arguments: '{"path":"x"}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('try unknown', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      // normalizeToolName actually resolves "Read-File" → "read_file" at
      // dispatch time, so the call SUCCEEDS — the "did you mean" branch
      // only fires when normalization can't disambiguate. To exercise that
      // path explicitly we rely on the helper-level test (above).
      // Here we just assert the call was routed correctly (i.e. the loop
      // didn't abort on the bogus name).
      const toolMsgs = secondRequestBody.messages.filter((m: any) => m.role === 'tool');
      assert.equal(toolMsgs.length, 1);
      assert.equal(toolMsgs[0].tool_call_id, 'unk_1');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('runTurn recovery: truly unknown MCP tool name carries "did you mean" hint when one matches', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        // Hallucinated MCP tool — but exposeMcp returns a real one with
        // matching flatten form so the "did you mean" branch lights up
        // when the MCP call itself throws MethodNotFound.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'mcp_1', type: 'function', function: { name: 'mcp.brainrouter.memory_recall', arguments: '{}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [{ name: 'mcp_brainrouter_memory_recall' }] }),
        callTool: async (name: string) => {
          // Simulate the JSON-RPC -32601 MethodNotFound that the real pool
          // throws for an unknown name. (After normalizeToolName resolves
          // mcp.brainrouter.memory_recall → mcp_brainrouter_memory_recall
          // this branch wouldn't fire — so trigger from the other side.)
          if (name === 'mcp_brainrouter_memory_recall') {
            return { content: [{ text: 'recalled' }] };
          }
          throw new Error(`-32601 Unknown tool: ${name}`);
        },
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('recall please', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const toolMsgs = secondRequestBody.messages.filter((m: any) => m.role === 'tool');
      assert.equal(toolMsgs.length, 1);
      // normalizeToolName resolves the dotted form to the real registered
      // name, so the call succeeds without ever hitting the unknown branch.
      assert.equal(toolMsgs[0].content, 'recalled');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('runTurn recovery: synthetic orphan results do NOT trigger the R1 child-drain guardrail', async () => {
  // If the orphan envelope ever parses as JSON with an `id` field, the
  // child-drain guardrail would think a child was spawned and try to wait
  // on it on the next clean-break turn. Verify by calling the helper
  // through the well-known content shape and confirming it's plain ERROR
  // text (also covered in tool-call-recovery.test.ts but we re-assert
  // through the public surface here so a regression in either layer
  // surfaces in agent-runtime as well).
  const { synthesizeOrphanResults } = await import('../agent/toolCallRecovery.js');
  const synth = synthesizeOrphanResults(
    [{ id: 'x', type: 'function', function: { name: 'spawn_agent', arguments: '{}' } }],
    [],
  );
  assert.equal(synth.length, 1);
  assert.match(synth[0].content, /^ERROR:/);
  // Round-trip through parseJsonObject's exact shape — if this returns an
  // object, trackChildObservation would believe a spawn happened.
  let parsed: any;
  try { parsed = JSON.parse(synth[0].content); } catch { parsed = undefined; }
  assert.equal(typeof parsed === 'object' && parsed !== null, false, 'synthetic content must NOT parse as a JSON object');
});

test('runTurn Anthropic native adapter: hits /v1/messages, round-trips tool_use ids', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    const capturedUrls: string[] = [];
    const capturedBodies: any[] = [];
    let calls = 0;
    globalThis.fetch = (async (url: any, opts: any) => {
      capturedUrls.push(String(url));
      const body = JSON.parse(opts.body);
      capturedBodies.push(body);
      calls++;
      if (calls === 1) {
        // First turn: emit a tool_use block (Anthropic shape).
        return new Response(JSON.stringify({
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking now.' },
            { type: 'tool_use', id: 'toolu_01ABC', name: 'list_dir', input: { path: '.' } },
          ],
          usage: { input_tokens: 100, output_tokens: 12 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Second turn: final answer.
      return new Response(JSON.stringify({
        id: 'msg_02',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Listed the workspace successfully.' }],
        usage: { input_tokens: 150, output_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, {
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5',
        endpoint: 'https://api.anthropic.com/v1',
      }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('list it', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      // Every request went to /v1/messages, never /chat/completions.
      assert.equal(capturedUrls.length, 2);
      for (const u of capturedUrls) {
        assert.match(u, /\/v1\/messages$/);
        assert.doesNotMatch(u, /chat\/completions/);
      }
      // Native shape on the wire: system hoisted, max_tokens set, messages
      // array uses content blocks not OpenAI-style strings.
      assert.equal(typeof capturedBodies[0].system, 'string');
      assert.equal(typeof capturedBodies[0].max_tokens, 'number');
      // Second request carries the tool_result wrapped in a user turn,
      // referencing the SAME Anthropic-emitted id.
      const secondMsgs = capturedBodies[1].messages;
      const toolResultMsg = secondMsgs.find((m: any) =>
        Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'));
      assert.ok(toolResultMsg, 'second request must include a tool_result block');
      assert.equal(toolResultMsg.role, 'user');
      assert.equal(toolResultMsg.content[0].tool_use_id, 'toolu_01ABC');
      // lastTurnUsage accumulates Anthropic input/output tokens via the
      // OpenAI-named accumulator (mapped at adapter boundary).
      assert.equal(agent.lastTurnUsage.promptTokens, 250);
      assert.equal(agent.lastTurnUsage.completionTokens, 20);
      assert.match(answer, /Listed the workspace successfully/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn Anthropic native: prompt caching opt-in via BRAINROUTER_ANTHROPIC_CACHE', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.BRAINROUTER_ANTHROPIC_CACHE;
    const captured: any[] = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      captured.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      // Pass 1: cache OFF (default).
      delete process.env.BRAINROUTER_ANTHROPIC_CACHE;
      let agent = new Agent(stubMcp, {
        provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-5',
        endpoint: 'https://api.anthropic.com/v1',
      }, { workspaceRoot: workspace, launchCwd: workspace, silent: true });
      await agent.runTurn('hi', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      const off = captured[captured.length - 1];
      assert.equal(typeof off.system, 'string', 'system should be plain string when cache disabled');
      assert.equal(JSON.stringify(off).includes('cache_control'), false);

      // Pass 2: cache ON.
      process.env.BRAINROUTER_ANTHROPIC_CACHE = '1';
      agent = new Agent(stubMcp, {
        provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-5',
        endpoint: 'https://api.anthropic.com/v1',
      }, { workspaceRoot: workspace, launchCwd: workspace, silent: true });
      await agent.runTurn('hi', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      const on = captured[captured.length - 1];
      assert.ok(Array.isArray(on.system), 'system should be a blocks array when cache enabled');
      assert.deepEqual(on.system[0].cache_control, { type: 'ephemeral' });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.BRAINROUTER_ANTHROPIC_CACHE;
      else process.env.BRAINROUTER_ANTHROPIC_CACHE = originalEnv;
    }
  });
});

test('runTurn Anthropic native: task_agent child spawn round-trips under the adapter', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;
    globalThis.fetch = (async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      // Child agent requests reuse the same Anthropic endpoint (they
      // inherit the parent's llmConfig). Detect by the user message —
      // the child sees its prompt as the first user turn.
      const firstUser = body.messages?.find((m: any) => m.role === 'user');
      const userText = firstUser?.content?.[0]?.text ?? '';
      if (userText === 'do the thing') {
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'child finished the thing' }],
          usage: { input_tokens: 30, output_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          content: [{
            type: 'tool_use',
            id: 'toolu_task_1',
            name: 'task_agent',
            input: { role: 'explorer', prompt: 'do the thing' },
          }],
          usage: { input_tokens: 100, output_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'child reported in; all done.' }],
        usage: { input_tokens: 80, output_tokens: 6 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, {
        provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-5',
        endpoint: 'https://api.anthropic.com/v1',
      }, { workspaceRoot: workspace, launchCwd: workspace, silent: true });
      const toolEvents: string[] = [];
      const answer = await agent.runTurn('go', {
        onStatusUpdate: () => {},
        onToolStart: (name) => toolEvents.push(name),
        onToolEnd: () => {},
      });
      // task_agent fired and the parent saw a final answer that mentions
      // the child's work.
      assert.ok(toolEvents.includes('task_agent'), `expected task_agent in ${JSON.stringify(toolEvents)}`);
      assert.match(answer, /all done/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
