import test from 'node:test';
import assert from 'node:assert/strict';
import { callMcpTool, childSessionKey, extractToolText, safeJsonParse } from '../runtime/mcpUtils.js';
import { createSession, getSession, listSessions, updateSession } from '../orchestration/orchestrator.js';
import { executeOrchestrationTool } from '../orchestration/tools.js';
import { normalizeSkillsList } from '../cli/commands/workflow.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('McpClientWrapper.isConnected is false before connect', async () => {
  const { McpClientWrapper } = await import('../runtime/mcpClient.js');
  const wrapper = new McpClientWrapper();
  assert.equal(wrapper.isConnected(), false);
});

test('resolveIdentityFromConfig: explicit identity wins over heuristics (10a)', async () => {
  const { resolveIdentityFromConfig } = await import('../runtime/mcpClient.js');
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.com', identity: 'third-party' }, 'brainrouter-cloud'),
    'third-party',
    'explicit `identity: third-party` beats a brainrouter-shaped name',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'stdio', command: '/usr/bin/foo', identity: 'brainrouter' }),
    'brainrouter',
    'explicit `identity: brainrouter` beats a non-brainrouter command path',
  );
});

test('resolveIdentityFromConfig: name prefix and URL host detect BrainRouter (10a)', async () => {
  const { resolveIdentityFromConfig } = await import('../runtime/mcpClient.js');
  // Name prefix.
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.com' }, 'brainrouter-cloud'),
    'brainrouter',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.com' }, 'BrainRouter'),
    'brainrouter',
    'case-insensitive name prefix',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.com' }, 'github'),
    'unknown',
    'non-brainrouter name → unknown (let tool-signature decide)',
  );

  // URL host pattern.
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://api.brainrouter.cloud' }, 'local-http'),
    'brainrouter',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.brainrouter.dev/mcp' }, 'staging'),
    'brainrouter',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://random.example.com' }, 'whatever'),
    'unknown',
  );

  // Stdio command basename.
  assert.equal(
    resolveIdentityFromConfig({ type: 'stdio', command: '/usr/local/bin/brainrouter-mcp' }),
    'brainrouter',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'stdio', command: 'github-mcp' }),
    'unknown',
  );
});

test('McpClientWrapper.getIdentity returns "unknown" before listTools (10a)', async () => {
  const { McpClientWrapper } = await import('../runtime/mcpClient.js');
  const wrapper = new McpClientWrapper();
  assert.equal(wrapper.getIdentity(), 'unknown');
});

test('McpClientWrapper.listTools returns empty list when disconnected (offline mode)', async () => {
  const { McpClientWrapper } = await import('../runtime/mcpClient.js');
  const wrapper = new McpClientWrapper();
  const res = await wrapper.listTools();
  assert.deepEqual(res, { tools: [] });
});

test('McpClientWrapper.callTool returns an error envelope when disconnected (offline mode)', async () => {
  const { McpClientWrapper } = await import('../runtime/mcpClient.js');
  const wrapper = new McpClientWrapper();
  const res = await wrapper.callTool('memory_recall', { query: 'anything' });
  const env = res as { isError: boolean; content: Array<{ type: string; text: string }> };
  assert.equal(env.isError, true);
  assert.match(env.content[0].text, /MCP server is not connected/);
  assert.match(env.content[0].text, /memory_recall/);
});

test('mcpUtils: extractToolText handles content arrays, strings, and unknown shapes', () => {
  assert.equal(extractToolText({ content: [{ text: 'a' }, { text: 'b' }] }), 'a\nb');
  assert.equal(extractToolText({ content: [{ text: '' }, {}] }), '\n');
  assert.equal(extractToolText('plain string'), 'plain string');
  assert.equal(extractToolText({ foo: 1 }), '{"foo":1}');
  assert.equal(extractToolText(undefined), '""');
});

test('mcpUtils: safeJsonParse returns undefined/fallback on failure', () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  assert.equal(safeJsonParse('not json'), undefined);
  assert.equal(safeJsonParse('not json', 'fallback'), 'fallback');
  assert.equal(safeJsonParse(''), undefined);
});

test('mcpUtils: callMcpTool normalizes success, error flag, and thrown errors', async () => {
  const okClient: any = { callTool: async () => ({ content: [{ text: '{"x":1}' }] }) };
  const ok = await callMcpTool(okClient, 'whatever', {});
  assert.equal(ok.isError, false);
  assert.equal(ok.text, '{"x":1}');
  assert.deepEqual(ok.parsed, { x: 1 });

  const errClient: any = { callTool: async () => ({ isError: true, content: [{ text: 'boom' }] }) };
  const err = await callMcpTool(errClient, 'whatever', {});
  assert.equal(err.isError, true);
  assert.equal(err.text, 'boom');

  const throwClient: any = { callTool: async () => { throw new Error('network gone'); } };
  const thrown = await callMcpTool(throwClient, 'whatever', {});
  assert.equal(thrown.isError, true);
  assert.equal(thrown.text, 'network gone');
});

test('normalizeSkillsList accepts array and wrapped skill-list payloads', () => {
  assert.deepEqual(
    normalizeSkillsList([{ name: 'adr-skill', scope: 'global', description: 'Records decisions' }]),
    [{ name: 'adr-skill', scope: 'global', description: 'Records decisions' }],
  );
  assert.deepEqual(
    normalizeSkillsList({ skills: [{ name: 'debugging-skill' }] }),
    [{ name: 'debugging-skill' }],
  );
  assert.equal(normalizeSkillsList({ ok: true }), undefined);
});

test('mcpUtils: childSessionKey applies the canonical naming scheme', () => {
  assert.equal(childSessionKey('br:main', 'agent-abc'), 'br:main:child:agent-abc');
});

test('orchestrator session registry persists lifecycle transitions', () => {
  withTempWorkspace((workspace) => {
    assert.deepEqual(listSessions(workspace), []);
    const created = createSession(workspace, {
      role: 'explorer',
      prompt: 'Map auth code',
      parentSessionKey: 'parent:x',
    });
    assert.equal(created.status, 'pending');
    assert.equal(created.access, 'read');
    const updated = updateSession(workspace, created.id, { status: 'running' });
    assert.equal(updated.status, 'running');
    const fetched = getSession(workspace, created.id);
    assert.equal(fetched?.status, 'running');
    assert.equal(listSessions(workspace).length, 1);
    assert.throws(() => updateSession(workspace, 'missing', { status: 'failed' }), /No child session/);
  });
});

test('orchestration: task_agent waits and returns child output', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
      return new Response(JSON.stringify({
        choices: [{ message: { content: `child completed: ${lastUser}` } }],
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
      const raw = await executeOrchestrationTool('task_agent', { role: 'explorer', prompt: 'map auth' }, ctx);
      const result = JSON.parse(raw);
      assert.equal(result.role, 'explorer');
      assert.equal(result.status, 'completed');
      assert.match(result.finalOutput, /child completed: map auth/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestration: delegate_agent returns running child id with continue semantics', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'background child complete' } }],
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
      const raw = await executeOrchestrationTool('delegate_agent', { role: 'explorer', prompt: 'map auth' }, ctx);
      const result = JSON.parse(raw);
      assert.equal(result.role, 'explorer');
      assert.equal(result.status, 'running');
      assert.match(result.id, /^agent-/);
      assert.match(result.nextAction, /continue working/i);

      const record = getSession(workspace, result.id);
      assert.equal(record?.status, 'running');
      const waited = JSON.parse(await executeOrchestrationTool('wait_agent', { id: result.id, timeoutMs: 1000 }, ctx));
      assert.equal(waited.status, 'completed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestration: spawn_agent wait=true remains backward-compatible', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
      return new Response(JSON.stringify({
        choices: [{ message: { content: `legacy child completed: ${lastUser}` } }],
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
      const raw = await executeOrchestrationTool('spawn_agent', { role: 'explorer', prompt: 'map auth', wait: true }, ctx);
      const result = JSON.parse(raw);
      assert.equal(result.status, 'completed');
      assert.match(result.finalOutput, /legacy child completed: map auth/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestration: extractChildPreview prefers a Headline/Summary section over head-of-output', async () => {
  const { extractChildPreview } = await import('../orchestration/tools.js');
  // When the child wrote a Headline block, the preview returns THAT,
  // not the framing intro the head-slice would have captured.
  const withHeadline =
    'Long intro paragraph that explains what the child explored and why and ' +
    'how it set up its environment. '.repeat(10) +
    '\n\n## Headline\n' +
    'BLOCKER found in agent.ts:687 — captureTurn skipped on loop-limit.\n' +
    'Two HIGH issues in repl.ts.\n' +
    '\n## Details\n' +
    'long details follow…';
  const preview = extractChildPreview(withHeadline, 400);
  assert.match(preview, /## Headline/);
  assert.match(preview, /BLOCKER found in agent\.ts/);
  // Falls back to head + tail when no headline is present so the conclusion
  // at the end isn't silently dropped.
  const noHeadline = 'A'.repeat(1000) + 'CONCLUSION_MARKER_AT_END';
  const preview2 = extractChildPreview(noHeadline, 200);
  assert.match(preview2, /CONCLUSION_MARKER_AT_END/);
  assert.match(preview2, /…/); // contains the divider
});

test('orchestration: clampAccess prevents a child from exceeding the parent\'s access mode', async () => {
  const { clampAccess } = await import('../orchestration/tools.js');
  // Same level: no clamp.
  assert.equal(clampAccess('shell', 'shell'), 'shell');
  assert.equal(clampAccess('write', 'write'), 'write');
  assert.equal(clampAccess('read', 'read'), 'read');
  // Stepping down is fine.
  assert.equal(clampAccess('shell', 'read'), 'read');
  assert.equal(clampAccess('write', 'read'), 'read');
  // The security-critical cases: the child asked for MORE than the parent.
  // Without the clamp, spawn_agent({access:'shell'}) from a read-mode parent
  // would silently elevate. Clamped, the child is pinned to the parent's mode.
  assert.equal(clampAccess('read', 'write'), 'read');
  assert.equal(clampAccess('read', 'shell'), 'read');
  assert.equal(clampAccess('write', 'shell'), 'write');
});

test('breadthHint: realistic broad prompts trigger fan-out; narrow ones do not', async () => {
  const { shouldSuggestFanOut } = await import('../prompt/breadthHint.js');
  // Prompts that obviously want fan-out — the original calibration missed
  // several of these (they all scored 1.5, just under the old 1.8 threshold).
  const broad = [
    'test all the MCP tools',
    'review every file in the repo',
    'audit the whole codebase for security issues',
    'manually review our brainrouter cli for everything every single line',
    'explore the codebase thoroughly',
    'check each tool definition',
  ];
  for (const p of broad) {
    const result = shouldSuggestFanOut(p);
    assert.ok(result.suggest, `expected fan-out for: "${p}" (got score=${result.intent.score})`);
  }
  // Narrow, surgical prompts should NOT trigger fan-out.
  const narrow = [
    'fix that single typo',
    'what is the recall pipeline?',
    'list the slash commands',
    'show me the goal store',
  ];
  for (const p of narrow) {
    const result = shouldSuggestFanOut(p);
    assert.ok(!result.suggest, `expected NO fan-out for: "${p}" (got score=${result.intent.score})`);
  }
});

test('breadthHint: explicit no-fan-out hints in the prompt veto suggestion even at high score', async () => {
  const { shouldSuggestFanOut, detectFanOutVeto } = await import('../prompt/breadthHint.js');
  // These prompts ALL score high on breadth (verb-object-broad, every,
  // etc.) but the user explicitly opted out. We must honor that.
  const vetoed = [
    'audit every file in src/ (no spawn_agent, no fan-out, files are small)',
    'review all the tools — do this in one turn',
    'test every config combination, don\'t fan out — directly with read_file',
    'check each module yourself, no children',
  ];
  for (const p of vetoed) {
    const r = shouldSuggestFanOut(p);
    assert.ok(!r.suggest, `expected veto on: "${p}" (got score=${r.intent.score}, signals=${r.intent.signals.join(',')})`);
    assert.ok(r.veto, `expected r.veto string on: "${p}"`);
    assert.ok(r.intent.signals.some((s) => s.startsWith('vetoed:')), 'expected a vetoed:<phrase> signal');
  }
  // Direct unit test of the veto detector for clarity.
  assert.equal(detectFanOutVeto('audit everything (no fan-out)').vetoed, true);
  assert.equal(detectFanOutVeto('audit everything fast').vetoed, false);
  assert.equal(detectFanOutVeto('do not spawn children').vetoed, true);
  assert.equal(detectFanOutVeto('').vetoed, false);
});

test('detectBreadthIntent flags "do everything in 1 go" / "as much as I could" / parallel hints', async () => {
  const { detectBreadthIntent, shouldSuggestFanOut } = await import('../prompt/breadthHint.js');

  const cases: Array<{ prompt: string; expectFanOut: boolean; expectSignal?: string }> = [
    { prompt: 'test all the MCP tools in 1 go, as much as you could', expectFanOut: true, expectSignal: 'one-shot' },
    { prompt: 'explore the entire codebase comprehensively', expectFanOut: true, expectSignal: 'coverage' },
    { prompt: 'investigate the auth middleware', expectFanOut: false },
    { prompt: 'fix this typo', expectFanOut: false },
    { prompt: 'spawn 3 agents in parallel covering every memory tool', expectFanOut: true, expectSignal: 'parallel' },
  ];
  for (const c of cases) {
    const { suggest, intent } = shouldSuggestFanOut(c.prompt);
    assert.equal(suggest, c.expectFanOut, `expected suggest=${c.expectFanOut} for "${c.prompt}", got ${suggest} (signals: ${intent.signals.join(',')}, score ${intent.score})`);
    if (c.expectSignal) {
      assert.equal(intent.signals.includes(c.expectSignal), true, `expected signal "${c.expectSignal}" in ${JSON.stringify(intent.signals)}`);
    }
  }

  // detectBreadthIntent returns a clean shape for empty prompts.
  assert.deepEqual(detectBreadthIntent(''), { score: 0, signals: [] });
});

test('inferRoleFromTask routes verbs to the right child role', async () => {
  const { inferRoleFromTask } = await import('../orchestration/tools.js');
  assert.equal(inferRoleFromTask('investigate the auth middleware'), 'explorer');
  assert.equal(inferRoleFromTask('Map the MCP package layout'), 'explorer');
  assert.equal(inferRoleFromTask('Design the data model for the chat feature'), 'architect');
  assert.equal(inferRoleFromTask('Review the diff for security issues'), 'reviewer');
  assert.equal(inferRoleFromTask('verify the build passes'), 'verifier');
  assert.equal(inferRoleFromTask('test the recall pipeline'), 'verifier');
  assert.equal(inferRoleFromTask('implement the new search filter'), 'worker');
  // Unmatched verbs fall through to worker.
  assert.equal(inferRoleFromTask('do the thing'), 'worker');
});

test('explainUnknownToolName: skill-shaped names get the skill correction; others get the generic hint', async () => {
  const { explainUnknownToolName } = await import('../agent/agent.js');
  assert.match(explainUnknownToolName('incremental-implementation'), /tried to invoke a SKILL/);
  assert.match(explainUnknownToolName('spec-driven-skill'), /load its instructions/);
  assert.match(explainUnknownToolName('code-structure-cleanup'), /tried to invoke a SKILL/);
  // Non-skill-shaped names fall to the generic guidance.
  assert.match(explainUnknownToolName('fetch_url_v2'), /Verify the tool name/);
});
