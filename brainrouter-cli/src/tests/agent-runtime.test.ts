import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, buildChatCompletionPayload } from '../agent/agent.js';
import { clearGoal, readGoal, setGoal } from '../state/goalStore.js';
import { makeAgent, withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

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
    // System message replaced; goal etc. would land here if set.
    setGoal(workspace, 'finish the auth refactor', agent.sessionKey);
    agent.refreshSystemPrompt();
    const sys = (agent as any).chatHistory[0];
    assert.equal(sys.role, 'system');
    assert.match(sys.content, /Active Goal/);
    assert.match(sys.content, /finish the auth refactor/);
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

test('buildChatCompletionPayload: does NOT forward reasoning_effort for non-reasoning models / unknown endpoints (0.3.6 item 2f)', () => {
  // gpt-4o-mini on the OpenAI endpoint: not a reasoning model, must not
  // receive reasoning_effort even when /effort is set — sending it would
  // be at best a no-op and at worst a 400 on stricter compatible servers.
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

  // Custom OpenAI-compatible endpoint (LM Studio / Ollama / vLLM): we can't
  // know the model behind a generic local URL, so fall through silently —
  // the system-prompt overlay still steers the model.
  const localCustom = buildChatCompletionPayload(
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
  assert.equal((localCustom as any).reasoning_effort, undefined);
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
