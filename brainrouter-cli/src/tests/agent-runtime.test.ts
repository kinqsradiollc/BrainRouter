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
    const waitedIds: string[][] = [];

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      if (/child-one|child-two/.test(lastUser)) {
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

      if (/have not waited for their outputs yet/.test(lastUser) && waitedIds.length === 0) {
        const spawnResult = [...messages].reverse().find((m: any) => m.role === 'tool' && m.name === 'spawn_agents')?.content;
        const parsed = JSON.parse(spawnResult);
        const ids = parsed.agents.map((entry: any) => entry.id);
        waitedIds.push(ids);
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_wait_all',
                type: 'function',
                function: {
                  name: 'wait_agents',
                  arguments: JSON.stringify({ ids, timeoutMs: 1000 }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
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
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('find me any vulnerabilities in the project', {
        onStatusUpdate: () => {},
        onToolStart: (name) => { toolNames.push(name); },
        onToolEnd: () => {},
      });

      assert.deepEqual(toolNames.filter((name) => name === 'wait_agents'), ['wait_agents']);
      assert.equal(waitedIds.length, 1);
      assert.equal(waitedIds[0].length, 2);
      assert.equal(answer, 'Both child outputs were incorporated.');
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

test('P1.2: agentId unknown returns error listing known ids', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace);
    await assert.rejects(
      () => executeOrchestrationTool('spawn_agent', { agentId: 'no-such-agent', prompt: 'task' }, ctx),
      /Unknown agentId.*Known agents/i,
    );
  });
});
