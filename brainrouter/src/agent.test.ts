import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPatchEnvelope,
  buildChatCompletionPayload,
  globFiles,
  isPathInside,
  LOCAL_TOOLS,
  matchGlob,
  resolveWorkspacePath,
} from './agent/agent.js';
import { getCliStateDir, getCliStateFile } from './state/cliState.js';
import { appendTranscriptEntry, readTranscriptEntries, redactText } from './state/sessionStore.js';
import { buildSystemPrompt } from './prompt/systemPrompt.js';
import { formatPlan, readPlan, updatePlan } from './state/taskStore.js';
import { findWorkspaceRoot } from './config/workspace.js';
import { buildRolePrompt, listRoles, resolveRole } from './orchestration/roles.js';
import { createSession, getSession, listSessions, updateSession } from './orchestration/orchestrator.js';
import { buildSkillPrompt, resolveSkill, SLASH_TO_SKILL } from './prompt/skillRunner.js';
import { buildMemoryBriefing, selectCitedRecordIds } from './memory/briefing.js';
import { callMcpTool, childSessionKey, extractToolText, safeJsonParse } from './runtime/mcpUtils.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, getWorkflowDir, listWorkflows, slugify, updateWorkflowStatus } from './state/workflowArtifacts.js';
import { initAgentMd } from './prompt/initAgentMd.js';
import { expandMentions } from './memory/mentions.js';
import { listTranscripts } from './state/sessionStore.js';
import { clearGoal, formatGoalBlock, readGoal, setGoal } from './state/goalStore.js';
import { addHook, readHooks, removeHook, runHooks, setHookEnabled } from './state/hooksStore.js';
import { parseInterval, isLoopRunning, startLoop, stopLoop, getLoopState } from './runtime/loopRunner.js';
import { Agent } from './agent/agent.js';
import { readPreferences, writePreferences } from './state/preferencesStore.js';
import { resolveSandboxConfig } from './runtime/sandbox.js';
import { startSpan, traceEnabled } from './runtime/tracing.js';
import { clampPayload, extractMemories, renderMemoryCards } from './memory/formatters.js';

// Construct an Agent without touching MCP or the LLM. We only exercise the
// pure state-machine extensions added in Tier 1/2 (model, accessMode, history,
// fork, refreshSystemPrompt), so MCP isn't invoked.
function makeAgent(workspace: string): Agent {
  const stubMcp: any = {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
  const llm = { provider: 'openai' as const, apiKey: 'k', model: 'test-model' };
  return new Agent(stubMcp, llm, {
    workspaceRoot: workspace,
    launchCwd: workspace,
    sessionKey: 'session:test',
    silent: true, // skip bootstrap + briefing so we don't touch MCP at all
  });
}

function withTempWorkspace(fn: (workspace: string) => void) {
  const previousCwd = process.cwd();
  const previousWorkspace = process.env.BRAINROUTER_WORKSPACE;
  const previousHome = process.env.BRAINROUTER_HOME;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-'));
  // Pin BRAINROUTER_HOME to a sibling tmp dir so tests never touch the real
  // ~/.brainrouter on the developer's machine.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-home-'));
  try {
    delete process.env.BRAINROUTER_WORKSPACE;
    process.env.BRAINROUTER_HOME = home;
    process.chdir(workspace);
    fn(workspace);
  } finally {
    process.chdir(previousCwd);
    if (previousWorkspace === undefined) delete process.env.BRAINROUTER_WORKSPACE;
    else process.env.BRAINROUTER_WORKSPACE = previousWorkspace;
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('resolveWorkspacePath rejects parent traversal outside workspace', () => {
  withTempWorkspace(() => {
    assert.throws(
      () => resolveWorkspacePath('../outside.txt'),
      /escapes workspace root/,
    );
  });
});

test('resolveWorkspacePath rejects absolute paths outside workspace', () => {
  withTempWorkspace(() => {
    assert.throws(
      () => resolveWorkspacePath(os.tmpdir()),
      /escapes workspace root/,
    );
  });
});

test('resolveWorkspacePath allows nested write targets inside workspace', () => {
  withTempWorkspace((workspace) => {
    const resolved = resolveWorkspacePath('src/new-file.ts', { forWrite: true });
    assert.equal(resolved, path.join(fs.realpathSync(workspace), 'src', 'new-file.ts'));
  });
});

test('isPathInside treats equal and nested paths as inside', () => {
  const root = path.resolve('/tmp/example');
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, path.join(root, 'child')), true);
  assert.equal(isPathInside(root, path.resolve('/tmp/example-sibling')), false);
});

test('matchGlob handles recursive and basename patterns', () => {
  assert.equal(matchGlob('src/**/*.ts', 'src/index.ts'), true);
  assert.equal(matchGlob('src/**/*.ts', 'src/cli/agent.ts'), true);
  assert.equal(matchGlob('*.md', 'README.md'), true);
  assert.equal(matchGlob('*.md', 'docs/README.md'), true);
  assert.equal(matchGlob('docs/*.md', 'src/README.md'), false);
});

test('globFiles ignores generated directories and returns workspace-relative matches', () => {
  withTempWorkspace(() => {
    fs.mkdirSync('src', { recursive: true });
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('src/index.ts', 'export {};\n');
    fs.writeFileSync('dist/index.ts', 'export {};\n');

    assert.deepEqual(globFiles('**/*.ts'), ['src/index.ts']);
  });
});

test('CLI state helpers live under ~/.brainrouter, not the workspace', () => {
  withTempWorkspace((workspace) => {
    const stateDir = getCliStateDir(workspace);
    const home = process.env.BRAINROUTER_HOME!;
    // CLI state lives at <home>/workspaces/<encoded>/cli — NOT in the workspace.
    assert.equal(stateDir.startsWith(path.join(fs.realpathSync(home), 'workspaces')), true);
    assert.equal(stateDir.endsWith(path.join('cli')), true);
    assert.equal(fs.existsSync(stateDir), true);
    // The workspace itself stays clean of personal CLI state.
    assert.equal(fs.existsSync(path.join(fs.realpathSync(workspace), '.brainrouter', 'cli')), false);
    assert.equal(getCliStateFile(workspace, 'tasks.json'), path.join(stateDir, 'tasks.json'));
    assert.throws(() => getCliStateFile(workspace, '../tasks.json'), /Invalid CLI state file name/);
  });
});

test('plan store persists and validates durable plan state', () => {
  withTempWorkspace((workspace) => {
    assert.deepEqual(readPlan(workspace).items, []);

    const state = updatePlan(workspace, {
      explanation: 'phase one',
      plan: [
        { step: 'Add state helpers', status: 'completed' },
        { step: 'Wire update_plan', status: 'in_progress' },
      ],
    });

    assert.equal(state.items.length, 2);
    assert.match(formatPlan(readPlan(workspace)), /\[\/\] Wire update_plan/);
    assert.throws(
      () => updatePlan(workspace, {
        plan: [
          { step: 'one', status: 'in_progress' },
          { step: 'two', status: 'in_progress' },
        ],
      }),
      /At most one plan item/,
    );
  });
});

test('transcript store redacts secrets and reads recent entries', () => {
  withTempWorkspace((workspace) => {
    assert.equal(redactText('OPENAI_API_KEY="sk-secretvalue123"'), 'OPENAI_API_KEY="[REDACTED]"');

    appendTranscriptEntry(workspace, 'session:one', {
      role: 'user',
      content: 'token br_secretvalue123 should be hidden',
    });
    const entries = readTranscriptEntries(workspace, 'session:one');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'token [REDACTED] should be hidden');
    assert.equal(typeof entries[0].timestamp, 'string');
  });
});

test('buildChatCompletionPayload exposes local and MCP tools to the LLM', () => {
  const payload = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'test-model',
    },
    [{ role: 'user', content: 'remember this' }],
    [
      ...LOCAL_TOOLS,
      {
        name: 'memory_recall',
        description: 'Recall relevant BrainRouter memories.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ],
  );

  assert.equal(payload.tool_choice, 'auto');
  assert.equal(payload.tools?.some(tool => tool.function.name === 'read_file'), true);
  assert.equal(payload.tools?.some(tool => tool.function.name === 'memory_recall'), true);
  const memoryTool = payload.tools?.find(tool => tool.function.name === 'memory_recall');
  assert.deepEqual(memoryTool?.function.parameters.required, ['query']);
  assert.equal(payload.tools?.some(tool => tool.function.name === 'update_plan'), true);
});

test('buildSystemPrompt includes workspace, session, and raw MCP tool names', () => {
  const prompt = buildSystemPrompt({
    workspaceRoot: '/repo/project',
    launchCwd: '/repo/project/brainrouter',
    sessionKey: 'session-123',
    instructionSummary: 'Use AGENT.md.',
  });

  assert.match(prompt, /Workspace root: \/repo\/project/);
  assert.match(prompt, /BrainRouter sessionKey: session-123/);
  assert.match(prompt, /memory_resolve_session/);
  assert.match(prompt, /update_plan/);
  assert.doesNotMatch(prompt, /mcp_brainrouter_memory_resolve_session/);
});

test('agent role registry lists built-in roles and rejects unknown ones', () => {
  const names = listRoles().map(r => r.name).sort();
  assert.deepEqual(names, ['architect', 'explorer', 'reviewer', 'verifier', 'worker']);
  assert.equal(resolveRole('explorer').defaultAccess, 'read');
  assert.equal(resolveRole('worker').defaultAccess, 'write');
  assert.throws(() => resolveRole('nope'), /Unknown agent role/);
});

test('buildRolePrompt embeds overlay and task into base prompt', () => {
  const out = buildRolePrompt(resolveRole('reviewer'), 'BASE', 'Find bugs in repl.ts');
  assert.match(out, /BASE/);
  assert.match(out, /Role: Reviewer/);
  assert.match(out, /Find bugs in repl.ts/);
});

test('every built-in role overlay enforces a memory-first opening', () => {
  for (const role of listRoles()) {
    assert.match(role.promptOverlay, /Memory-first opening/, `${role.name} role lacks memory directive`);
    assert.match(role.promptOverlay, /memory_(search|recall|file_history|graph_query|task_state|contradictions)/, `${role.name} role doesn't name a memory tool`);
  }
});

test('system prompt enforces memory-first workflow', () => {
  const prompt = buildSystemPrompt({
    workspaceRoot: '/tmp/x',
    launchCwd: '/tmp/x',
    sessionKey: 's',
  });
  assert.match(prompt, /Memory-First Workflow/);
  assert.match(prompt, /non-negotiable/);
  assert.match(prompt, /memory_recall/);
  assert.match(prompt, /memory_search/);
  assert.match(prompt, /memory_graph_query/);
  assert.match(prompt, /memory_file_history/);
  assert.match(prompt, /Never say "I do not have information/);
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

test('SLASH_TO_SKILL maps the documented commands to skill names', () => {
  assert.equal(SLASH_TO_SKILL['/feature-dev'], 'agentic-engineering-workflow');
  assert.equal(SLASH_TO_SKILL['/review'], 'code-review-and-quality');
  assert.equal(SLASH_TO_SKILL['/implement-plan'], 'incremental-skill');
});

test('resolveSkill falls back to filesystem when MCP is unavailable', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-skill-'));
  try {
    const skillDir = path.join(workspace, 'skills', 'agent', 'planning-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Planning Skill\nBody.\n');

    const stubClient: any = { callTool: async () => { throw new Error('no mcp'); } };
    const skill = await resolveSkill(stubClient, 'planning-skill', workspace);
    assert.equal(skill.source, 'filesystem');
    assert.match(skill.body, /Planning Skill/);

    const prompt = buildSkillPrompt(skill, { input: 'Plan the X feature', orchestration: 'Use update_plan.' });
    assert.match(prompt, /Executing skill: planning-skill/);
    assert.match(prompt, /Plan the X feature/);
    assert.match(prompt, /Use update_plan/);
    assert.match(prompt, /spawn_agent/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('resolveSkill prefers MCP when get_skill succeeds', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-skill-'));
  try {
    const stubClient: any = {
      callTool: async () => ({ content: [{ text: 'MCP skill body' }], isError: false }),
    };
    const skill = await resolveSkill(stubClient, 'whatever', workspace);
    assert.equal(skill.source, 'mcp');
    assert.equal(skill.body, 'MCP skill body');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('resolveSkill returns a fallback record when no source has the skill', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-skill-'));
  try {
    const stubClient: any = { callTool: async () => { throw new Error('no mcp'); } };
    const skill = await resolveSkill(stubClient, 'no-such-skill', workspace);
    assert.equal(skill.source, 'fallback');
    assert.match(skill.body, /No SKILL\.md found/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildMemoryBriefing merges parallel memory sources into one block with redacted secrets', async () => {
  const calls: string[] = [];
  const stubClient: any = {
    callTool: async (name: string) => {
      calls.push(name);
      if (name === 'memory_recall') {
        return {
          content: [{
            text: JSON.stringify({
              // Canonical MCP key as emitted by recall.ts. The CLI previously
              // looked for `recalledCognitiveRecords` (typo) which made every
              // briefing return 0 records. The dedicated regression test
              // below covers the canonical-key-only path.
              recalledCognitiveMemories: [
                { recordId: 'rec_a', content: 'BrainRouter uses sqlite for memory storage and runs hybrid recall.', type: 'codebase_fact' },
                { recordId: 'rec_b', content: 'The CLI lives in brainrouter/src.', type: 'codebase_fact' },
              ],
            }),
          }],
        };
      }
      if (name === 'memory_working_context') {
        return { content: [{ text: 'API key sk-secretvalue123 should never leak.' }] };
      }
      if (name === 'memory_task_state') {
        return { content: [{ text: 'No open tasks.' }] };
      }
      return { isError: true };
    },
  };
  const briefing = await buildMemoryBriefing({
    mcpClient: stubClient,
    mcpTools: [{ name: 'memory_recall' }, { name: 'memory_working_context' }, { name: 'memory_task_state' }],
    sessionKey: 'session:x',
    workspaceRoot: '/tmp/example',
    query: 'how do we store memory?',
  });

  assert.deepEqual(briefing.sourcesQueried.sort(), ['memory_recall', 'memory_task_state', 'memory_working_context']);
  assert.deepEqual(briefing.recalledRecordIds.sort(), ['rec_a', 'rec_b']);
  assert.match(briefing.block, /BrainRouter Memory Briefing/);
  assert.match(briefing.block, /Recalled cognitive memories/);
  assert.match(briefing.block, /sqlite/);
  assert.doesNotMatch(briefing.block, /sk-secretvalue123/);
  assert.match(briefing.block, /\[REDACTED\]/);
});

test('orchestration: extractChildPreview prefers a Headline/Summary section over head-of-output', async () => {
  const { extractChildPreview } = await import('./orchestration/tools.js');
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

test('sessionStore: appendTranscriptEntry dedupes consecutive identical user prompts', async () => {
  const { appendTranscriptEntry, readTranscriptEntries } = await import('./state/sessionStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:dedup';
    appendTranscriptEntry(workspace, sk, { role: 'user', content: 'help me with X' });
    appendTranscriptEntry(workspace, sk, { role: 'user', content: 'help me with X' }); // dup — skip
    appendTranscriptEntry(workspace, sk, { role: 'assistant', content: 'sure!' });
    appendTranscriptEntry(workspace, sk, { role: 'user', content: 'help me with X' }); // not consecutive — keep
    const entries = readTranscriptEntries(workspace, sk, 100);
    const userEntries = entries.filter((e) => e.role === 'user');
    assert.equal(userEntries.length, 2, 'consecutive duplicate user prompts should collapse to one; non-consecutive duplicates are kept');
    assert.equal(entries.length, 3); // 1 user + 1 assistant + 1 user
  });
});

test('callOpenAI: rejects malformed LLM responses with a useful error instead of TypeError', async () => {
  // Stub the global fetch with three scenarios that have historically crashed
  // the agent loop with `Cannot read properties of undefined (reading '0')`
  // when the upstream returned HTTP 200 + a non-standard body.
  const { callOpenAI } = await import('./agent/agent.js');
  const realFetch = global.fetch;
  const llmConfig = { provider: 'openai' as const, apiKey: 'test', model: 'gpt-oss-120b', endpoint: 'http://localhost:9999/v1' };

  const cases: Array<{ name: string; body: any; expectMatch: RegExp }> = [
    {
      name: 'error envelope with HTTP 200 (common with OpenRouter upstream failures)',
      body: { error: { message: 'Model "gpt-oss-120b" not found' } },
      expectMatch: /error envelope.*Model "gpt-oss-120b" not found/,
    },
    {
      name: 'missing choices array (some local servers under load)',
      body: { id: 'cmpl-xxx', object: 'chat.completion' },
      expectMatch: /no choices.*gpt-oss-120b/,
    },
    {
      name: 'empty choices array',
      body: { choices: [] },
      expectMatch: /no choices/,
    },
  ];

  try {
    for (const c of cases) {
      global.fetch = (async () => new Response(JSON.stringify(c.body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as any;
      await assert.rejects(
        () => callOpenAI(llmConfig, [], []),
        (err: any) => c.expectMatch.test(err.message ?? ''),
        `case "${c.name}" should reject with descriptive error, not TypeError`,
      );
    }
  } finally {
    global.fetch = realFetch;
  }
});

test('llmSemaphore: caps concurrent acquires and queues the rest', async () => {
  const { acquireLLMSlot, getLLMSemaphoreState, resetLLMSemaphoreForTests } =
    await import('./runtime/llmSemaphore.js');
  // Force a known cap of 2 for this test.
  process.env.BRAINROUTER_LLM_MAX_CONCURRENT = '2';
  resetLLMSemaphoreForTests();
  try {
    const r1 = await acquireLLMSlot();
    const r2 = await acquireLLMSlot();
    assert.equal(getLLMSemaphoreState().inFlight, 2);

    // Third caller must queue, not resolve until something releases.
    let r3Resolved = false;
    const r3Promise = acquireLLMSlot().then((release) => {
      r3Resolved = true;
      return release;
    });
    // Yield the event loop so the queued promise has a chance to resolve
    // (it should NOT, because in-flight is still at cap).
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r3Resolved, false, 'third acquire must wait for a release');
    assert.equal(getLLMSemaphoreState().queued, 1);

    // Releasing one slot should let the queued waiter proceed.
    r1();
    const r3 = await r3Promise;
    assert.equal(r3Resolved, true);
    assert.equal(getLLMSemaphoreState().inFlight, 2);

    // Double-release should be a no-op (release idempotency).
    r1();
    assert.equal(getLLMSemaphoreState().inFlight, 2);

    r2();
    r3();
    assert.equal(getLLMSemaphoreState().inFlight, 0);
  } finally {
    delete process.env.BRAINROUTER_LLM_MAX_CONCURRENT;
    resetLLMSemaphoreForTests();
  }
});

test('breadthHint: realistic broad prompts trigger fan-out; narrow ones do not', async () => {
  const { shouldSuggestFanOut } = await import('./prompt/breadthHint.js');
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

test('normalizeToolName resolves common LLM hallucinations to the canonical tool name', async () => {
  const { normalizeToolName } = await import('./agent/agent.js');
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

test('orchestration: clampAccess prevents a child from exceeding the parent\'s access mode', async () => {
  const { clampAccess } = await import('./orchestration/tools.js');
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

test('buildMemoryBriefing extracts records from the canonical recalledCognitiveMemories key', async () => {
  // Tight regression test for the typo fix: previously the CLI looked for
  // `recalledCognitiveRecords` which the MCP never emitted, so every briefing
  // silently returned 0 records. Asserting against ONLY the canonical key
  // ensures we don't regress to the old fallback-driven behavior.
  const stubClient: any = {
    callTool: async (name: string) => {
      if (name === 'memory_recall') {
        return {
          content: [{
            text: JSON.stringify({
              recalledCognitiveMemories: [
                { recordId: 'mem_only_1', content: 'Canonical-key record one.', type: 'codebase_fact' },
                { recordId: 'mem_only_2', content: 'Canonical-key record two.', type: 'instruction' },
              ],
            }),
          }],
        };
      }
      return { isError: true };
    },
  };
  const briefing = await buildMemoryBriefing({
    mcpClient: stubClient,
    mcpTools: [{ name: 'memory_recall' }],
    sessionKey: 'session:canonical',
    workspaceRoot: '/tmp/example',
    query: 'verify canonical key',
  });
  assert.deepEqual(briefing.recalledRecordIds.sort(), ['mem_only_1', 'mem_only_2']);
});

test('selectCitedRecordIds picks records whose ID or distinctive snippet appears in the final answer', () => {
  const recalled = [
    { recordId: 'rec_a', content: 'BrainRouter uses sqlite for memory storage and runs hybrid recall.' },
    { recordId: 'rec_b', content: 'Unrelated note about coffee preferences.' },
    { recordId: 'rec_c', content: 'short' },
  ];
  const answer = 'We answer with: BrainRouter uses sqlite for memory storage and runs hybrid recall. We also mention rec_c by id.';
  const cited = selectCitedRecordIds(recalled, answer).sort();
  assert.deepEqual(cited, ['rec_a', 'rec_c']);
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

test('mcpUtils: childSessionKey applies the canonical naming scheme', () => {
  assert.equal(childSessionKey('br:main', 'agent-abc'), 'br:main:child:agent-abc');
});

test('workflowArtifacts: slugify produces safe URL-style slugs and rejects path traversal', () => {
  assert.equal(slugify('Spec-Driven Feature: Login (v2)'), 'spec-driven-feature-login-v2');
  assert.equal(slugify(''), 'workflow');
  assert.equal(slugify('../escape'), 'escape');
  assert.equal(slugify('A'.repeat(200)).length <= 60, true);
});

test('workflowArtifacts: createWorkflow writes meta.json and sets current pointer', () => {
  withTempWorkspace((workspace) => {
    const meta = createWorkflow(workspace, { title: 'Add auth', kind: 'feature-dev' });
    assert.equal(meta.slug, 'add-auth');
    assert.equal(meta.status, 'draft');
    assert.equal(getCurrentWorkflow(workspace), 'add-auth');
    const metaPath = path.join(getWorkflowDir(workspace, 'add-auth'), 'meta.json');
    assert.equal(fs.existsSync(metaPath), true);
    const stored = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(stored.title, 'Add auth');
  });
});

test('workflowArtifacts: artifactRelativePath stays inside workspace and listWorkflows includes every workflow', () => {
  withTempWorkspace((workspace) => {
    createWorkflow(workspace, { title: 'one', kind: 'spec' });
    createWorkflow(workspace, { title: 'two', kind: 'feature-dev' });
    const slugs = listWorkflows(workspace).map((w) => w.slug).sort();
    assert.deepEqual(slugs, ['one', 'two']);
    const rel = artifactRelativePath(workspace, 'two', ARTIFACT.spec);
    assert.equal(rel.split(path.sep).join('/').startsWith('.brainrouter/workflows/two/'), true);
    assert.equal(rel.endsWith('spec.md'), true);
    assert.equal(rel.includes('..'), false);
  });
});

test('applyPatchEnvelope handles update, add, and delete operations in one envelope', () => {
  withTempWorkspace(() => {
    fs.writeFileSync('alpha.txt', 'hello world\n');
    fs.writeFileSync('legacy.txt', 'remove me\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: alpha.txt',
      '-hello world',
      '+hello BrainRouter',
      '*** Add File: notes/new.md',
      '+# New file',
      '+Created by apply_patch.',
      '*** Delete File: legacy.txt',
      '*** End Patch',
    ].join('\n');
    const result = applyPatchEnvelope(patch);
    const parsed = JSON.parse(result);
    assert.equal(parsed.applied.length, 3);
    assert.equal(fs.readFileSync('alpha.txt', 'utf8'), 'hello BrainRouter\n');
    assert.equal(fs.readFileSync('notes/new.md', 'utf8'), '# New file\nCreated by apply_patch.');
    assert.equal(fs.existsSync('legacy.txt'), false);
  });
});

test('applyPatchEnvelope rejects malformed envelopes and ambiguous context', () => {
  withTempWorkspace(() => {
    assert.throws(() => applyPatchEnvelope('not a patch'), /Begin Patch/);
    fs.writeFileSync('dup.txt', 'same\nsame\n');
    const ambiguous = [
      '*** Begin Patch',
      '*** Update File: dup.txt',
      '-same',
      '+changed',
      '*** End Patch',
    ].join('\n');
    assert.throws(() => applyPatchEnvelope(ambiguous), /matched 2 times/);
  });
});

test('initAgentMd creates AGENT.md when missing and is idempotent', () => {
  withTempWorkspace((workspace) => {
    const first = initAgentMd(workspace);
    assert.equal(first.status, 'created');
    assert.equal(fs.existsSync(path.join(workspace, 'AGENT.md')), true);
    const second = initAgentMd(workspace);
    assert.equal(second.status, 'exists');
  });
});

test('initAgentMd respects pre-existing AGENTS.md', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# existing\n');
    const result = initAgentMd(workspace);
    assert.equal(result.status, 'exists');
    assert.equal(fs.existsSync(path.join(workspace, 'AGENT.md')), false);
  });
});

test('expandMentions inlines workspace files and skips outside-of-workspace paths', () => {
  withTempWorkspace((workspace) => {
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const x = 1;\n');
    const { expanded, mentions } = expandMentions('Please review @src/index.ts plus @../../../etc/passwd', workspace);
    // Only the safe in-workspace file got attached; the escape attempt was skipped.
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].token, 'src/index.ts');
    assert.match(expanded, /Attached files/);
    assert.match(expanded, /export const x = 1;/);
    // No fenced reference header was created for the dangerous mention.
    assert.doesNotMatch(expanded, /referenced via @\.\.\//);
  });
});

test('expandMentions truncates oversize files and marks them', () => {
  withTempWorkspace((workspace) => {
    const big = 'x'.repeat(30_000);
    fs.writeFileSync(path.join(workspace, 'big.txt'), big);
    const { expanded, mentions } = expandMentions('see @big.txt', workspace, 1000);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].truncated, true);
    assert.match(expanded, /truncated at 1000 chars/);
  });
});

test('listTranscripts surfaces persisted sessions newest first with previews', () => {
  withTempWorkspace((workspace) => {
    appendTranscriptEntry(workspace, 'session:one', { role: 'user', content: 'first thing about Zod' });
    appendTranscriptEntry(workspace, 'session:one', { role: 'assistant', content: 'ok' });
    appendTranscriptEntry(workspace, 'session:two', { role: 'user', content: 'second different session' });
    const list = listTranscripts(workspace);
    assert.equal(list.length, 2);
    const one = list.find((t) => t.sessionKey === 'session:one')!;
    assert.equal(one.turnCount, 2);
    assert.match(one.firstUserMessage ?? '', /Zod/);
  });
});

test('goalStore: set/read/clear round-trip and formatGoalBlock includes outcome + budget', () => {
  withTempWorkspace((workspace) => {
    assert.equal(readGoal(workspace), null);
    const saved = setGoal(workspace, '   ship the auth refactor   ');
    assert.equal(saved.text, 'ship the auth refactor');
    assert.equal(saved.status, 'active');
    assert.equal(saved.budget.iterationsUsed, 0);
    assert.equal(saved.budget.maxIterations > 0, true);
    const block = formatGoalBlock(saved);
    assert.match(block, /Active Goal — ACTIVE/);
    assert.match(block, /ship the auth refactor/);
    assert.match(block, /Iteration:\*{0,2}\s+1 of/);
    clearGoal(workspace);
    assert.equal(readGoal(workspace), null);
  });
});

test('goalStore: setGoal rejects text longer than GOAL_TEXT_MAX_CHARS', async () => {
  const { GoalTooLongError, GOAL_TEXT_MAX_CHARS } = await import('./state/goalStore.js');
  withTempWorkspace((workspace) => {
    // At-cap input is accepted.
    const atCap = 'x'.repeat(GOAL_TEXT_MAX_CHARS);
    const ok = setGoal(workspace, atCap);
    assert.equal(ok.text.length, GOAL_TEXT_MAX_CHARS);
    clearGoal(workspace);

    // One over the cap throws GoalTooLongError, carrying the original length.
    const overCap = 'y'.repeat(GOAL_TEXT_MAX_CHARS + 1);
    assert.throws(
      () => setGoal(workspace, overCap),
      (err: unknown) => err instanceof GoalTooLongError && (err as any).length === GOAL_TEXT_MAX_CHARS + 1,
    );
    // No file should have been written on rejection.
    assert.equal(readGoal(workspace), null);
  });
});

test('goalStore: lifecycle helpers — pause, resume, complete, blocked, budget, tick', async () => {
  const { pauseGoal, resumeGoal, completeGoal, blockGoal, setGoalBudget, tickGoalIteration } = await import('./state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sessionKey = 'brainrouter-cli:test:main';
    setGoal(workspace, 'reach the moon', sessionKey);

    let g = pauseGoal(workspace, sessionKey)!;
    assert.equal(g.status, 'paused');
    g = resumeGoal(workspace, sessionKey)!;
    assert.equal(g.status, 'active');

    g = setGoalBudget(workspace, sessionKey, 25)!;
    assert.equal(g.budget.maxIterations, 25);

    g = tickGoalIteration(workspace, sessionKey)!;
    assert.equal(g.budget.iterationsUsed, 1);

    g = blockGoal(workspace, sessionKey, 'need launch codes')!;
    assert.equal(g.status, 'blocked');
    assert.equal(g.blockedReason, 'need launch codes');

    g = completeGoal(workspace, sessionKey, 'we touched the moon')!;
    assert.equal(g.status, 'complete');
    assert.equal(typeof g.completedAt, 'string');
  });
});

test('goalStore: legacy { text, setAt } gets normalized with active status and default budget', async () => {
  const { getCliStateFile } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    fs.writeFileSync(
      getCliStateFile(workspace, 'goal.json'),
      JSON.stringify({ text: 'legacy goal', setAt: '2026-01-01T00:00:00Z' }),
    );
    const g = readGoal(workspace)!;
    assert.equal(g.text, 'legacy goal');
    assert.equal(g.status, 'active');
    assert.equal(g.budget.iterationsUsed, 0);
    assert.equal(g.budget.maxIterations > 0, true);
  });
});

test('hooksStore: add → enable/disable → run → remove', () => {
  withTempWorkspace((workspace) => {
    assert.deepEqual(readHooks(workspace), []);
    const created = addHook(workspace, { event: 'post-tool', command: 'true' });
    assert.equal(readHooks(workspace).length, 1);
    const results = runHooks(workspace, 'post-tool', { tool: 'read_file' });
    assert.equal(results.length, 1);
    assert.equal(results[0].exitCode, 0);
    setHookEnabled(workspace, created.id, false);
    assert.equal(runHooks(workspace, 'post-tool', { tool: 'read_file' }).length, 0);
    assert.equal(removeHook(workspace, created.id), true);
    assert.deepEqual(readHooks(workspace), []);
  });
});

test('hooksStore: pre-tool hook with non-zero exit signals denial', () => {
  withTempWorkspace((workspace) => {
    addHook(workspace, { event: 'pre-tool', command: 'false' });
    const results = runHooks(workspace, 'pre-tool', { tool: 'run_command' });
    assert.equal(results.length, 1);
    assert.notEqual(results[0].exitCode, 0);
  });
});

test('loopRunner: parseInterval accepts s/m/h/ms', () => {
  assert.equal(parseInterval('5s'), 5_000);
  assert.equal(parseInterval('2m'), 120_000);
  assert.equal(parseInterval('1h'), 3_600_000);
  assert.equal(parseInterval('500ms'), 500);
  assert.equal(parseInterval('notatime'), undefined);
});

test('loopRunner: only one loop runs at a time and stop releases the slot', async () => {
  assert.equal(isLoopRunning(), false);
  const first = startLoop('one', 60_000, async () => {});
  assert.equal(first.started, true);
  const second = startLoop('two', 60_000, async () => {});
  assert.equal(second.started, false);
  assert.match(second.reason ?? '', /already running/);
  assert.equal(getLoopState()?.prompt, 'one');
  assert.equal(stopLoop(), true);
  assert.equal(isLoopRunning(), false);
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
    setGoal(workspace, 'finish the auth refactor');
    agent.refreshSystemPrompt();
    const sys = (agent as any).chatHistory[0];
    assert.equal(sys.role, 'system');
    assert.match(sys.content, /Active Goal/);
    assert.match(sys.content, /finish the auth refactor/);
    clearGoal(workspace);
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

test('expandMentions deduplicates repeated mentions of the same file', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, 'README.md'), '# hello\n');
    const { mentions, expanded } = expandMentions('see @README.md and again @README.md', workspace);
    assert.equal(mentions.length, 1);
    const headerOccurrences = expanded.split('### README.md').length - 1;
    assert.equal(headerOccurrences, 1);
  });
});

test('preferencesStore round-trips autoReview, editorMode, and statusline', () => {
  withTempWorkspace((workspace) => {
    const defaults = readPreferences(workspace);
    assert.equal(defaults.autoReview, false);
    assert.equal(defaults.editorMode, 'emacs');
    assert.equal(defaults.statusline, 'mode');
    writePreferences(workspace, { autoReview: true, statusline: 'mode,branch,tokens' });
    const after = readPreferences(workspace);
    assert.equal(after.autoReview, true);
    assert.equal(after.statusline, 'mode,branch,tokens');
    assert.equal(after.editorMode, 'emacs'); // unchanged
  });
});

test('initAgentMd populates AGENT.md from repo signals when package.json present', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'demo',
      scripts: { build: 'tsc', test: 'vitest run', dev: 'tsx src/index.ts' },
    }));
    fs.writeFileSync(path.join(workspace, 'tsconfig.json'), '{}');
    const result = initAgentMd(workspace);
    assert.equal(result.status, 'created');
    const body = fs.readFileSync(result.path, 'utf8');
    assert.match(body, /Detected project signals/);
    assert.match(body, /Node\.js/);
    assert.match(body, /TypeScript/);
    assert.match(body, /npm run build/);
    assert.match(body, /npm test/);
  });
});

test('initAgentMd falls back to bare template when no signals detected', () => {
  withTempWorkspace((workspace) => {
    const result = initAgentMd(workspace);
    assert.equal(result.status, 'created');
    const body = fs.readFileSync(result.path, 'utf8');
    // Fallback template doesn't carry the "Detected project signals" block.
    assert.doesNotMatch(body, /Detected project signals/);
    assert.match(body, /AGENT\.md/);
  });
});

test('resolveSandboxConfig reflects env toggles', () => {
  const prevEnabled = process.env.BRAINROUTER_SANDBOX;
  const prevReads = process.env.BRAINROUTER_SANDBOX_READ_PATHS;
  try {
    process.env.BRAINROUTER_SANDBOX = 'on';
    process.env.BRAINROUTER_SANDBOX_READ_PATHS = '/usr/local:/opt';
    const cfg = resolveSandboxConfig('/tmp/x');
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.readPaths, ['/usr/local', '/opt']);
    assert.equal(cfg.allowNetwork, false);
  } finally {
    if (prevEnabled === undefined) delete process.env.BRAINROUTER_SANDBOX; else process.env.BRAINROUTER_SANDBOX = prevEnabled;
    if (prevReads === undefined) delete process.env.BRAINROUTER_SANDBOX_READ_PATHS; else process.env.BRAINROUTER_SANDBOX_READ_PATHS = prevReads;
  }
});

test('tracing.startSpan is a no-op when BRAINROUTER_TRACE_LOG is unset', () => {
  const prev = process.env.BRAINROUTER_TRACE_LOG;
  delete process.env.BRAINROUTER_TRACE_LOG;
  try {
    assert.equal(traceEnabled(), false);
    const span = startSpan('test', { foo: 'bar' });
    span.end({ done: true });
    // No throw, no file created — that's the test.
    assert.equal(typeof span.end, 'function');
  } finally {
    if (prev !== undefined) process.env.BRAINROUTER_TRACE_LOG = prev;
  }
});

test('memoryFormatters: extractMemories parses both direct arrays and prependContext XML', () => {
  const direct = extractMemories({
    recalledCognitiveRecords: [
      { recordId: 'rec_a', type: 'codebase_fact', content: 'A is true', sceneName: 'scene-x' },
      { record_id: 'rec_b', type: 'instruction', content: 'Always do B' }, // snake_case key
    ],
  });
  assert.equal(direct.length, 2);
  assert.equal(direct[0].recordId, 'rec_a');
  assert.equal(direct[1].recordId, 'rec_b');

  const fallback = extractMemories({
    prependContext: `<relevant-memories>
  - [codebase_fact|scene-y] The CLI uses sqlite. (skill: storage)
  - [instruction|scene-z] Prefer Zod over Yup. (skill: validation)
</relevant-memories>`,
  });
  assert.equal(fallback.length, 2);
  assert.equal(fallback[0].type, 'codebase_fact');
  assert.match(fallback[0].content, /sqlite/);
  // synthetic recordIds for the inline path
  assert.match(fallback[0].recordId, /^inline-/);
});

test('memoryFormatters: renderMemoryCards limits and respects empty state', () => {
  const empty = renderMemoryCards([], 'Recall');
  assert.match(empty, /no records returned/);

  const many = Array.from({ length: 15 }, (_, i) => ({
    recordId: `rec_${i}`,
    type: 'fact',
    content: `fact #${i}`,
  }));
  const rendered = renderMemoryCards(many, 'Recall', 5);
  assert.match(rendered, /Recall/);
  assert.match(rendered, /…and 10 more/);
});

test('memoryFormatters: clampPayload truncates with marker', () => {
  const big = 'x'.repeat(10_000);
  const clamped = clampPayload(big, 1000);
  assert.equal(clamped.length <= 1000 + 80, true);
  assert.match(clamped, /9000 chars truncated/);
});

test('findWorkspaceRoot promotes BrainRouter package cwd to parent monorepo', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync('AGENT.md', '# Root instructions\n');
    fs.writeFileSync('package.json', JSON.stringify({ workspaces: ['brainrouter'] }));
    fs.mkdirSync('brainrouter', { recursive: true });
    fs.writeFileSync(path.join('brainrouter', 'package.json'), JSON.stringify({ name: 'brainrouter' }));

    const info = findWorkspaceRoot(path.join(workspace, 'brainrouter'));
    assert.equal(info.workspaceRoot, fs.realpathSync(workspace));
    assert.match(info.reason, /workspace/);
  });
});

test('preferencesStore: defaults include theme + personality + statusline fields', () => {
  withTempWorkspace((workspace) => {
    const prefs = readPreferences(workspace);
    assert.equal(prefs.theme, 'auto');
    assert.equal(prefs.personality, 'standard');
    assert.equal(prefs.rawScrollback, false);
    assert.equal(prefs.experimental, false);
    assert.equal(prefs.memoriesEnabled, true);
  });
});

test('preferencesStore: writePreferences merges new theme/personality fields', () => {
  withTempWorkspace((workspace) => {
    writePreferences(workspace, { theme: 'dark', personality: 'concise' });
    const prefs = readPreferences(workspace);
    assert.equal(prefs.theme, 'dark');
    assert.equal(prefs.personality, 'concise');
    // Old defaults still present
    assert.equal(prefs.statusline, 'mode');
  });
});

test('hookifyStore: parse, create, list, toggle, delete roundtrip', async () => {
  const { createHookifyRule, listHookifyRules, toggleHookifyRule, deleteHookifyRule, parseHookifyFile, evaluateHookify, buildHookifyContext } = await import('./state/hookifyStore.js');
  withTempWorkspace((workspace) => {
    const rule = createHookifyRule(workspace, {
      name: 'block-rm-rf',
      event: 'bash',
      pattern: 'rm\\s+-rf',
      action: 'block',
      message: 'Dangerous rm detected. Verify path.',
    });
    assert.equal(rule.id, 'block-rm-rf');
    assert.equal(rule.action, 'block');
    assert.equal(rule.enabled, true);

    const parsed = parseHookifyFile(rule.sourcePath)!;
    assert.equal(parsed.pattern, 'rm\\s+-rf');

    const rules = listHookifyRules(workspace);
    assert.equal(rules.length, 1);

    const ctx = buildHookifyContext('run_command', { command: 'rm -rf /tmp/foo' });
    const matches = evaluateHookify(rules, ctx);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].action, 'block');

    const ctxSafe = buildHookifyContext('run_command', { command: 'ls /tmp' });
    assert.equal(evaluateHookify(rules, ctxSafe).length, 0);

    assert.equal(toggleHookifyRule(workspace, 'block-rm-rf', false), true);
    assert.equal(listHookifyRules(workspace)[0].enabled, false);

    assert.equal(deleteHookifyRule(workspace, 'block-rm-rf'), true);
    assert.equal(listHookifyRules(workspace).length, 0);
  });
});

test('hookifyStore: condition-based file event matches new_text and file_path', async () => {
  const { createHookifyRule, evaluateHookify, buildHookifyContext, listHookifyRules } = await import('./state/hookifyStore.js');
  withTempWorkspace((workspace) => {
    createHookifyRule(workspace, {
      name: 'no-console-log',
      event: 'file',
      action: 'warn',
      conditions: [
        { field: 'file_path', operator: 'regex_match', pattern: '\\.tsx?$' },
        { field: 'new_text', operator: 'contains', pattern: 'console.log' },
      ],
      message: 'console.log in TypeScript',
    });
    const rules = listHookifyRules(workspace);
    const hit = buildHookifyContext('write_file', { path: 'src/foo.ts', content: 'console.log("debug")' });
    assert.equal(evaluateHookify(rules, hit).length, 1);
    const miss = buildHookifyContext('write_file', { path: 'README.md', content: 'console.log("debug")' });
    assert.equal(evaluateHookify(rules, miss).length, 0);
  });
});

test('memoryConsolidation: writes per-type files and MEMORY.md index', async () => {
  const { consolidateMemories, memoriesDir } = await import('./memory/consolidation.js');
  await withTempWorkspaceAsync(async (workspace) => {
    const stubMcp: any = {
      listTools: async () => ({ tools: [] }),
      callTool: async (name: string) => {
        if (name !== 'memory_search') throw new Error(`unexpected ${name}`);
        return {
          content: [{
            text: JSON.stringify({
              records: [
                { recordId: 'rec_user_1', type: 'user', content: 'User is a senior Go engineer learning React.' },
                { recordId: 'rec_fb_1', type: 'feedback', content: 'Always run integration tests against real DB.' },
                { recordId: 'rec_proj_1', type: 'project', content: 'Freeze starts 2026-03-05; mobile release branch is cut.' },
                { recordId: 'rec_ref_1', type: 'reference', content: 'Linear project INGEST tracks pipeline bugs.' },
                { recordId: 'rec_misc_1', type: 'codebase_fact', content: 'Misc memory should land in raw_memories.md.' },
              ],
            }),
          }],
        };
      },
      close: async () => {},
    };
    const result = await consolidateMemories(stubMcp, workspace);
    assert.equal(result.totalRecords, 5);
    assert.equal(result.perType.user, 1);
    assert.equal(result.perType.feedback, 1);
    assert.equal(result.perType.project, 1);
    assert.equal(result.perType.reference, 1);
    assert.equal(result.perType.raw, 1);
    const dir = memoriesDir(workspace);
    assert.match(fs.readFileSync(path.join(dir, 'user.md'), 'utf8'), /senior Go engineer/);
    assert.match(fs.readFileSync(path.join(dir, 'feedback.md'), 'utf8'), /integration tests/);
    assert.match(fs.readFileSync(path.join(dir, 'project.md'), 'utf8'), /Freeze starts/);
    assert.match(fs.readFileSync(path.join(dir, 'reference.md'), 'utf8'), /Linear project INGEST/);
    assert.match(fs.readFileSync(path.join(dir, 'raw_memories.md'), 'utf8'), /raw_memories\.md/);
    assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /5 consolidated memory records/);
  });
});

test('compactor: renderCompactSystemMessage tags the summary clearly', async () => {
  const { renderCompactSystemMessage } = await import('./prompt/compactor.js');
  const rendered = renderCompactSystemMessage('# Goals\n- Ship feature X');
  assert.match(rendered, /Compacted conversation summary/);
  assert.match(rendered, /Ship feature X/);
});

test('goalStore: per-session goals are isolated from each other', () => {
  withTempWorkspace((workspace) => {
    const sessionA = 'brainrouter-cli:project:main';
    const sessionB = 'brainrouter-cli:project:fork-xyz';

    setGoal(workspace, 'ship auth refactor', sessionA);
    setGoal(workspace, 'investigate flaky test', sessionB);

    assert.equal(readGoal(workspace, sessionA)?.text, 'ship auth refactor');
    assert.equal(readGoal(workspace, sessionB)?.text, 'investigate flaky test');

    clearGoal(workspace, sessionA);
    assert.equal(readGoal(workspace, sessionA), null);
    assert.equal(readGoal(workspace, sessionB)?.text, 'investigate flaky test');
  });
});

test('goalStore: setGoal throws GoalConflictError when overwriting an active goal without force', async () => {
  const { GoalConflictError, completeGoal } = await import('./state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:conflict';
    setGoal(workspace, 'first goal', sk);
    // Same key, new text — must conflict.
    assert.throws(
      () => setGoal(workspace, 'second goal', sk),
      (err: unknown) => err instanceof GoalConflictError && (err as any).existing.text === 'first goal',
    );
    // Existing goal preserved.
    assert.equal(readGoal(workspace, sk)?.text, 'first goal');
    // force=true overrides.
    const replaced = setGoal(workspace, 'second goal', sk, { force: true });
    assert.equal(replaced.text, 'second goal');
    assert.equal(readGoal(workspace, sk)?.text, 'second goal');
    // Completing the goal lifts the conflict shield — fresh setGoal without
    // force should now succeed because the old work is done.
    completeGoal(workspace, sk, 'manually closed');
    const next = setGoal(workspace, 'third goal', sk);
    assert.equal(next.text, 'third goal');
    assert.equal(next.status, 'active');
  });
});

test('goalStore: GoalConflictError message reflects the actual existing status', async () => {
  // Copilot review noted that the prior message hardcoded "already active"
  // even when the existing goal was paused / blocked / usage_limited,
  // misleading users via the REPL's catch path. Verify status-aware wording.
  const { GoalConflictError, pauseGoal, blockGoal, usageLimitGoal } = await import('./state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:conflict-msg';
    setGoal(workspace, 'first', sk);
    // Active → "is in progress"
    const active = (() => { try { setGoal(workspace, 'second', sk); return null; } catch (e) { return e as InstanceType<typeof GoalConflictError>; } })();
    assert.ok(active instanceof GoalConflictError);
    assert.match(active.message, /already is in progress/);

    pauseGoal(workspace, sk);
    const paused = (() => { try { setGoal(workspace, 'third', sk); return null; } catch (e) { return e as InstanceType<typeof GoalConflictError>; } })();
    assert.ok(paused instanceof GoalConflictError);
    assert.match(paused.message, /already exists with status: paused/);

    blockGoal(workspace, sk, 'stuck');
    const blocked = (() => { try { setGoal(workspace, 'fourth', sk); return null; } catch (e) { return e as InstanceType<typeof GoalConflictError>; } })();
    assert.match(blocked!.message, /already exists with status: blocked/);

    usageLimitGoal(workspace, sk, 'cap reached');
    const limited = (() => { try { setGoal(workspace, 'fifth', sk); return null; } catch (e) { return e as InstanceType<typeof GoalConflictError>; } })();
    // The status label spells out 'usage limited' (underscore-stripped).
    assert.match(limited!.message, /already exists with status: usage limited/);
  });
});

test('goalStore: buildBudgetSteeringMessage differentiates iteration vs token tightness', async () => {
  // Copilot review: the message used to always say "one turn left within
  // the iteration budget" even when only the token heuristic tripped.
  // Verify each trigger gets the right wording.
  const { buildBudgetSteeringMessage } = await import('./state/goalStore.js');
  const baseGoal = {
    text: 't', setAt: '', status: 'active' as const, startedAt: '', updatedAt: '',
  };

  // Iteration-tight only.
  const iterationCase = buildBudgetSteeringMessage({
    ...baseGoal,
    budget: { maxIterations: 10, iterationsUsed: 9 },
  });
  assert.match(iterationCase, /iteration budget/);
  assert.doesNotMatch(iterationCase, /token cap/);

  // Token-tight only (iterations have headroom: 4/20 used).
  const tokenCase = buildBudgetSteeringMessage({
    ...baseGoal,
    budget: { maxIterations: 20, iterationsUsed: 4, maxTokens: 10_000, tokensUsed: 8_500 },
  });
  assert.match(tokenCase, /token cap will trip/);
  assert.match(tokenCase, /8,500\/10,000/);

  // Both tight.
  const bothCase = buildBudgetSteeringMessage({
    ...baseGoal,
    budget: { maxIterations: 10, iterationsUsed: 9, maxTokens: 5_000, tokensUsed: 4_500 },
  });
  assert.match(bothCase, /Both budgets are nearly exhausted/);
});

test('agent: removeTaggedSystemMessage is idempotent and clears stale entries', async () => {
  const { Agent } = await import('./agent/agent.js');
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

test('goalStore: token budget tracking + usage_limited transition', async () => {
  const { setGoalTokenBudget, addGoalTokens, usageLimitGoal, goalHasBudgetLeft, goalIsOnFinalBudgetTurn } = await import('./state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:tokens';
    const g0 = setGoal(workspace, 'finish auth refactor', sk);
    assert.equal(g0.budget.maxTokens, undefined);

    // Set a token cap of 1000.
    const g1 = setGoalTokenBudget(workspace, sk, 1000)!;
    assert.equal(g1.budget.maxTokens, 1000);
    assert.equal(g1.budget.tokensUsed, 0);
    assert.equal(goalHasBudgetLeft(g1), true);

    // Tally usage in chunks.
    const g2 = addGoalTokens(workspace, sk, 400)!;
    assert.equal(g2.budget.tokensUsed, 400);
    assert.equal(goalIsOnFinalBudgetTurn(g2), false);

    // 850/1000 — > 80%, considered the "final turn" for steering.
    const g3 = addGoalTokens(workspace, sk, 450)!;
    assert.equal(g3.budget.tokensUsed, 850);
    assert.equal(goalIsOnFinalBudgetTurn(g3), true);

    // Cross the cap.
    const g4 = addGoalTokens(workspace, sk, 200)!;
    assert.equal(g4.budget.tokensUsed, 1050);
    assert.equal(goalHasBudgetLeft(g4), false);

    // Transition to usage_limited.
    const limited = usageLimitGoal(workspace, sk, 'token budget reached')!;
    assert.equal(limited.status, 'usage_limited');
    assert.equal(limited.blockedReason, 'token budget reached');

    // Clearing the token cap with 0.
    const cleared = setGoalTokenBudget(workspace, sk, 0)!;
    assert.equal(cleared.budget.maxTokens, undefined);
    assert.equal(cleared.budget.tokensUsed, undefined);
  });
});

test('goalStore: editGoal unified update changes text/status/budget/tokens in one call', async () => {
  const { editGoal } = await import('./state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:edit';
    setGoal(workspace, 'initial outcome', sk);
    const edited = editGoal(workspace, sk, {
      text: 'refined outcome with sharper boundary',
      maxIterations: 25,
      maxTokens: 50_000,
    })!;
    assert.equal(edited.text, 'refined outcome with sharper boundary');
    assert.equal(edited.budget.maxIterations, 25);
    assert.equal(edited.budget.maxTokens, 50_000);
    assert.equal(edited.status, 'active');
    // Status-only edit.
    const paused = editGoal(workspace, sk, { status: 'paused' })!;
    assert.equal(paused.status, 'paused');
    // Empty text refused.
    assert.throws(() => editGoal(workspace, sk, { text: '   ' }), /empty/);
  });
});

test('goalStore: legacy workspace-level goal is read as a fallback', async () => {
  const { getCliStateFile, getSessionStateDir } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    // Old layout — write directly to the workspace-level file.
    fs.writeFileSync(getCliStateFile(workspace, 'goal.json'), JSON.stringify({ text: 'legacy goal', setAt: '2026-01-01T00:00:00Z' }));
    const sessionKey = 'brainrouter-cli:project:main';
    assert.equal(readGoal(workspace, sessionKey)?.text, 'legacy goal');

    // Setting a per-session goal shadows the legacy one without removing it.
    // The legacy fallback DOES count as an existing goal under the new
    // conflict-detection rule, so pass force=true to bypass the prompt
    // path (REPL will do this after confirming with the user).
    setGoal(workspace, 'session-scoped', sessionKey, { force: true });
    assert.equal(readGoal(workspace, sessionKey)?.text, 'session-scoped');
    // Bucket exists at the expected path.
    assert.equal(fs.existsSync(path.join(getSessionStateDir(workspace, sessionKey), 'goal.json')), true);
  });
});

test('taskStore: per-session plans are isolated and updatePlan writes the bucket', async () => {
  const { getSessionStateDir } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    const sessionA = 'brainrouter-cli:project:main';
    const sessionB = 'brainrouter-cli:project:side';

    updatePlan(workspace, { plan: [{ step: 'do A1', status: 'in_progress' }] }, sessionA);
    updatePlan(workspace, { plan: [{ step: 'do B1', status: 'pending' }] }, sessionB);

    const planA = readPlan(workspace, sessionA);
    const planB = readPlan(workspace, sessionB);
    assert.equal(planA.items[0].step, 'do A1');
    assert.equal(planB.items[0].step, 'do B1');
    // File lives in the bucket folder.
    assert.equal(fs.existsSync(path.join(getSessionStateDir(workspace, sessionA), 'tasks.json')), true);
  });
});

test('sessionStore: transcripts land in sessions/<key>/transcript.jsonl', async () => {
  const { getSessionStateDir } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    appendTranscriptEntry(workspace, 'brainrouter-cli:project:main', { role: 'user', content: 'hi there' });
    const bucket = getSessionStateDir(workspace, 'brainrouter-cli:project:main');
    assert.equal(fs.existsSync(path.join(bucket, 'transcript.jsonl')), true);
    const entries = readTranscriptEntries(workspace, 'brainrouter-cli:project:main');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'hi there');
  });
});

test('sessionStore: legacy transcripts/<encoded>.jsonl remains discoverable', async () => {
  const { getCliStateDir, encodeSessionKey } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    const stateDir = getCliStateDir(workspace);
    const legacyDir = path.join(stateDir, 'transcripts');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyKey = 'legacy-session:abc';
    fs.writeFileSync(
      path.join(legacyDir, `${encodeSessionKey(legacyKey)}.jsonl`),
      JSON.stringify({ role: 'user', content: 'legacy hello', timestamp: '2026-01-01T00:00:00Z' }) + '\n',
    );

    // New layout entry for a different session.
    appendTranscriptEntry(workspace, 'new-session:xyz', { role: 'user', content: 'new hello' });

    const all = listTranscripts(workspace);
    const keys = all.map((s) => s.sessionKey).sort();
    assert.deepEqual(keys, ['legacy-session:abc', 'new-session:xyz']);

    // Reading by the legacy key still works.
    const legacyEntries = readTranscriptEntries(workspace, legacyKey);
    assert.equal(legacyEntries.length, 1);
    assert.equal(legacyEntries[0].content, 'legacy hello');
  });
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

test('detectBreadthIntent flags "do everything in 1 go" / "as much as I could" / parallel hints', async () => {
  const { detectBreadthIntent, shouldSuggestFanOut } = await import('./prompt/breadthHint.js');

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
  const { inferRoleFromTask } = await import('./orchestration/tools.js');
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
  const { explainUnknownToolName } = await import('./agent/agent.js');
  assert.match(explainUnknownToolName('incremental-implementation'), /tried to invoke a SKILL/);
  assert.match(explainUnknownToolName('spec-driven-skill'), /load its instructions/);
  assert.match(explainUnknownToolName('code-structure-cleanup'), /tried to invoke a SKILL/);
  // Non-skill-shaped names fall to the generic guidance.
  assert.match(explainUnknownToolName('fetch_url_v2'), /Verify the tool name/);
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

test('resolveWorkspacePath uses the explicit workspace, not process.cwd()', async () => {
  withTempWorkspace((workspace) => {
    // Make a SECOND tmp dir and pretend it's the workspace; cwd is still the
    // first one. The function must honor the explicit workspace argument.
    const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-other-'));
    try {
      const resolved = resolveWorkspacePath(otherWorkspace, 'test/file.txt', { forWrite: true });
      assert.equal(resolved.startsWith(fs.realpathSync(otherWorkspace)), true);
      assert.equal(resolved.startsWith(fs.realpathSync(workspace)), false);
    } finally {
      fs.rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });
});

test('cliState: migration neutralizes the legacy <workspace>/.brainrouter (preserves workflows/)', async () => {
  const { getCliStateDir } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    const legacy = path.join(workspace, '.brainrouter');
    fs.mkdirSync(path.join(legacy, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'workflows', 'feat-x'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'cli', 'tasks.json'), JSON.stringify({ items: [] }));
    fs.writeFileSync(path.join(legacy, 'workflows', 'feat-x', 'spec.md'), '# Committable spec');

    getCliStateDir(workspace); // triggers migration

    // Legacy cli/ and hooks/ archived; workflows/ kept in workspace.
    assert.equal(fs.existsSync(path.join(legacy, 'cli')), false);
    assert.equal(fs.existsSync(path.join(legacy, 'hooks')), false);
    assert.equal(fs.existsSync(path.join(legacy, 'workflows', 'feat-x', 'spec.md')), true);
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter.migrated', 'cli', 'tasks.json')), true);
  });
});

test('cliState: BRAINROUTER_HOME pins the user-global state root', async () => {
  const { getBrainrouterHome, getWorkspaceStateRoot } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    const home = process.env.BRAINROUTER_HOME!;
    assert.equal(getBrainrouterHome(), fs.realpathSync(home));
    const wsRoot = getWorkspaceStateRoot(workspace);
    assert.equal(wsRoot.startsWith(path.join(fs.realpathSync(home), 'workspaces')), true);
    // Encoded directory should include the workspace basename and an 8-char hash.
    const tail = path.basename(wsRoot);
    assert.match(tail, /-[0-9a-f]{8}$/);
  });
});

test('cliState: legacy <workspace>/.brainrouter/ migrates to the user home on first use', async () => {
  const { getCliStateDir } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    // Plant legacy files inside the workspace as if they came from an older build.
    const legacyDir = path.join(workspace, '.brainrouter', 'cli');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'tasks.json'), JSON.stringify({ items: [{ step: 'legacy', status: 'pending' }] }));
    fs.writeFileSync(path.join(legacyDir, 'goal.json'), JSON.stringify({ text: 'old goal', setAt: '2026-01-01T00:00:00Z' }));

    const newDir = getCliStateDir(workspace);
    // Migrated files now exist in the user-home location.
    assert.equal(fs.existsSync(path.join(newDir, 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(newDir, 'goal.json')), true);
    // Migration marker is dropped.
    assert.equal(fs.existsSync(path.join(path.dirname(newDir), '.migrated-from-workspace')), true);
    // Second call is a no-op (idempotent — files already present, marker stays).
    getCliStateDir(workspace);
  });
});

test('workflowArtifacts: stay in the workspace so they can be committed', async () => {
  const { getWorkflowsRoot } = await import('./state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const root = getWorkflowsRoot(workspace);
    assert.equal(root, path.join(fs.realpathSync(workspace), '.brainrouter', 'workflows'));
    assert.equal(fs.existsSync(root), true);
  });
});

test('cliState: listSessionDirs surfaces every session bucket newest first', async () => {
  const { listSessionDirs } = await import('./state/cliState.js');
  withTempWorkspace((workspace) => {
    appendTranscriptEntry(workspace, 'sess:a', { role: 'user', content: 'A' });
    appendTranscriptEntry(workspace, 'sess:b', { role: 'user', content: 'B' });
    const dirs = listSessionDirs(workspace);
    const keys = dirs.map((d) => d.sessionKey).sort();
    assert.deepEqual(keys, ['sess:a', 'sess:b']);
    for (const d of dirs) {
      assert.equal(fs.existsSync(d.dir), true);
    }
  });
});

test('systemPrompt: personality overlay adjusts communication style', () => {
  const concise = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'brainrouter-cli:/tmp/ws',
    personality: 'concise',
  });
  assert.match(concise, /Communication style: concise/);
  const standard = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'brainrouter-cli:/tmp/ws',
  });
  assert.doesNotMatch(standard, /Communication style:/);
});

async function withTempWorkspaceAsync<T>(fn: (workspace: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-home-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  process.chdir(tmp);
  try {
    return await fn(tmp);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
