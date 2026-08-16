/**
 * ADR-034 discovery-title regressions: first-turn proposals are bounded,
 * precedence-safe metadata and never become a routing address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { proposeSessionTitleWithModel } from '../agent/adapters/sessionTitleModel.js';
import { scheduleFirstTurnSessionTitleProposal } from '../agent/runtime/turnFinalizationPhase.js';
import { deriveSessionTitle } from '../session/sessionTitle.js';
import { getSessionMeta, setSessionTitle } from '../session/state/sessionMetaStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

const llm = { provider: 'openai', apiKey: 'key', model: 'model' };

test('turn finalization contains a rejected opportunistic title proposal', async () => {
  let invoked = 0;
  let unhandled: unknown;
  const onUnhandled = (error: unknown): void => { unhandled = error; };
  process.on('unhandledRejection', onUnhandled);
  try {
    scheduleFirstTurnSessionTitleProposal({
      sessionUsage: {
        promptTokens: 0, completionTokens: 0, calls: 0, turns: 0,
        cachedTokens: 0, missedTokens: 0,
      },
      proposeFirstTurnSessionTitle: async () => {
        invoked += 1;
        throw new Error('injected metadata failure');
      },
    } as any, 'First prompt', 'Completed answer', {} as any);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(invoked, 1);
    assert.equal(unhandled, undefined);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('title model call is low-effort, bounded, and treats turn text as data', async () => {
  const result = await proposeSessionTitleWithModel(llm, {
    firstUserMessage: 'Fix the release build',
    answerPreview: 'Updated the workflow.',
  }, async (_config, messages, tools, options) => {
    assert.equal(options.effort, 'low');
    assert.equal(options.allowCompatibilityRetry, false);
    assert.ok(options.maxResponseBytes <= 4 * 1024);
    assert.deepEqual(tools, []);
    assert.match(messages[0]?.content ?? '', /untrusted data/i);
    assert.match(messages[1]?.content ?? '', /<request>/);
    return { content: 'Fix release build' };
  });
  assert.equal(result, 'Fix release build');
});

test('first-turn title proposal emits derived but cannot overwrite a racing human title', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    let release!: (value: { content: string }) => void;
    const pending = new Promise<{ content: string }>((resolve) => { release = resolve; });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
    const agent = new Agent(stubMcp, llm, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      sessionKey: 'title:race',
      sessionTitleModelCall: async () => pending,
    });
    const events: Array<{ title: string; source: string }> = [];
    const derived = deriveSessionTitle('Please inspect the release build');
    const proposal = agent.proposeFirstTurnSessionTitle(
      'Please inspect the release build',
      'I found the failure.',
      { onSessionTitle: (event) => events.push(event) },
    );
    assert.deepEqual(getSessionMeta(workspace, 'title:race'), {
      title: derived, titleSource: 'derived',
    });
    setSessionTitle(workspace, 'title:race', 'Human release decision', 'human');
    release({ content: 'Inspect release build' });
    assert.equal(await proposal, null);
    assert.deepEqual(events, [{ title: derived, source: 'derived' }]);
    assert.equal(getSessionMeta(workspace, 'title:race').title, 'Human release decision');
  });
});

test('first-turn title proposal CASes a valid agent title over the derived floor', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
    const agent = new Agent(stubMcp, llm, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      sessionKey: 'title:first',
      sessionTitleModelCall: async () => ({ content: 'Verify release branch' }),
    });
    const events: Array<{ title: string; source: string }> = [];
    const derived = deriveSessionTitle('Can you verify the release branch?');
    assert.equal(await agent.proposeFirstTurnSessionTitle(
      'Can you verify the release branch?',
      'The checks pass.',
      { onSessionTitle: (event) => events.push(event) },
    ), 'Verify release branch');
    assert.deepEqual(getSessionMeta(workspace, 'title:first'), {
      title: 'Verify release branch', titleSource: 'agent',
    });
    assert.deepEqual(events, [
      { title: derived, source: 'derived' },
      { title: 'Verify release branch', source: 'agent' },
    ]);
    assert.equal(await agent.proposeFirstTurnSessionTitle('again', 'again'), null);
  });
});

test('invalid, refusal, thrown, and timed-out title calls retain and emit the derived floor', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
    const cases: Array<{ key: string; call: (...args: any[]) => Promise<{ content?: unknown }>; timeoutMs?: number }> = [
      { key: 'invalid', call: async () => ({ content: '# Invalid markdown' }) },
      { key: 'refusal', call: async () => ({ content: "I can't provide a title" }) },
      { key: 'thrown', call: async () => { throw new Error('provider unavailable'); } },
      {
        key: 'timeout',
        call: async (_config: unknown, _messages: unknown, _tools: unknown, options: { signal: AbortSignal }) =>
          await new Promise<never>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        timeoutMs: 10,
      },
    ];

    for (const entry of cases) {
      const sessionKey = `title:${entry.key}`;
      const prompt = `Investigate ${entry.key} title fallback`;
      const derived = deriveSessionTitle(prompt);
      const agent = new Agent(stubMcp, llm, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        sessionKey,
        sessionTitleModelCall: entry.call,
        sessionTitleModelTimeoutMs: entry.timeoutMs,
      });
      const events: Array<{ title: string; source: string }> = [];
      assert.equal(await agent.proposeFirstTurnSessionTitle(
        prompt,
        'Completed the investigation.',
        { onSessionTitle: (event) => events.push(event) },
      ), derived);
      assert.deepEqual(getSessionMeta(workspace, sessionKey), {
        title: derived, titleSource: 'derived',
      });
      assert.deepEqual(events, [{ title: derived, source: 'derived' }]);
    }
  });
});

test('racing hook and human titles each block a late agent proposal', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
    for (const source of ['hook', 'human'] as const) {
      let release!: (value: { content: string }) => void;
      const pending = new Promise<{ content: string }>((resolve) => { release = resolve; });
      const sessionKey = `title:${source}-race`;
      const prompt = `Inspect ${source} precedence`;
      const derived = deriveSessionTitle(prompt);
      const agent = new Agent(stubMcp, llm, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        sessionKey,
        sessionTitleModelCall: async () => pending,
      });
      const events: Array<{ title: string; source: string }> = [];
      const proposal = agent.proposeFirstTurnSessionTitle(
        prompt,
        'Found the issue.',
        { onSessionTitle: (event) => events.push(event) },
      );
      setSessionTitle(workspace, sessionKey, `${source} assigned title`, source);
      release({ content: 'Late agent proposal' });

      assert.equal(await proposal, null);
      assert.deepEqual(getSessionMeta(workspace, sessionKey), {
        title: `${source} assigned title`, titleSource: source,
      });
      assert.deepEqual(events, [{ title: derived, source: 'derived' }]);
    }
  });
});

test('a reused Agent proposes independently after an A-to-B logical session switch', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
    const requested: string[] = [];
    const agent = new Agent(stubMcp, llm, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      sessionKey: 'title:switch-a',
      sessionTitleModelCall: async (_config, messages) => {
        const prompt = messages.at(-1)?.content ?? '';
        requested.push(prompt);
        return { content: prompt.includes('second logical session') ? 'Second session title' : 'First session title' };
      },
    });

    assert.equal(await agent.proposeFirstTurnSessionTitle(
      'Inspect the first logical session',
      'First result.',
    ), 'First session title');

    agent.sessionKey = 'title:switch-b';
    agent.resetSessionCounters();
    assert.equal(await agent.proposeFirstTurnSessionTitle(
      'Inspect the second logical session',
      'Second result.',
    ), 'Second session title');

    assert.equal(requested.length, 2);
    assert.deepEqual(getSessionMeta(workspace, 'title:switch-a'), {
      title: 'First session title', titleSource: 'agent',
    });
    assert.deepEqual(getSessionMeta(workspace, 'title:switch-b'), {
      title: 'Second session title', titleSource: 'agent',
    });
  });
});

test('a late A proposal remains pinned to A after switching the reused Agent to B', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    type Deferred = {
      promise: Promise<{ content: string }>;
      resolve: (value: { content: string }) => void;
    };
    const deferred = (): Deferred => {
      let resolve!: Deferred['resolve'];
      const promise = new Promise<{ content: string }>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const calls = [deferred(), deferred()];
    let callIndex = 0;
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
    const agent = new Agent(stubMcp, llm, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      sessionKey: 'title:pinned-a',
      sessionTitleModelCall: async () => calls[callIndex++]!.promise,
    });
    const prompt = 'Inspect the same release boundary';
    const derived = deriveSessionTitle(prompt);

    const proposalA = agent.proposeFirstTurnSessionTitle(prompt, 'A answer.');
    agent.sessionKey = 'title:pinned-b';
    agent.resetSessionCounters();
    const proposalB = agent.proposeFirstTurnSessionTitle(prompt, 'B answer.');
    assert.deepEqual(getSessionMeta(workspace, 'title:pinned-b'), {
      title: derived, titleSource: 'derived',
    });

    calls[0]!.resolve({ content: 'Session A final title' });
    assert.equal(await proposalA, 'Session A final title');
    assert.deepEqual(getSessionMeta(workspace, 'title:pinned-a'), {
      title: 'Session A final title', titleSource: 'agent',
    });
    assert.deepEqual(getSessionMeta(workspace, 'title:pinned-b'), {
      title: derived, titleSource: 'derived',
    });

    calls[1]!.resolve({ content: 'Session B final title' });
    assert.equal(await proposalB, 'Session B final title');
    assert.deepEqual(getSessionMeta(workspace, 'title:pinned-b'), {
      title: 'Session B final title', titleSource: 'agent',
    });
  });
});

test('a resumed session preserves even a derived title without another model proposal', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'title:resumed-derived';
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
    const persistedTitle = deriveSessionTitle('Persist this fallback across resume');
    const first = new Agent(stubMcp, llm, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      sessionKey,
      sessionTitleModelCall: async () => { throw new Error('provider unavailable'); },
    });
    assert.equal(await first.proposeFirstTurnSessionTitle(
      'Persist this fallback across resume',
      'Initial answer.',
    ), persistedTitle);

    let modelCalls = 0;
    const resumed = new Agent(stubMcp, llm, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      sessionKey,
      sessionTitleModelCall: async () => {
        modelCalls += 1;
        return { content: 'Late replacement title' };
      },
    });
    resumed.resetSessionCounters();
    const events: Array<{ title: string; source: string }> = [];

    assert.equal(await resumed.proposeFirstTurnSessionTitle(
      'A new prompt after resume',
      'A new answer after resume.',
      { onSessionTitle: (event) => events.push(event) },
    ), null);
    assert.equal(modelCalls, 0);
    assert.deepEqual(events, []);
    assert.deepEqual(getSessionMeta(workspace, sessionKey), {
      title: persistedTitle, titleSource: 'derived',
    });
  });
});
