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
} from './agent.js';
import { getCliStateDir, getCliStateFile } from './cliState.js';
import { appendTranscriptEntry, readTranscriptEntries, redactText } from './sessionStore.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { formatPlan, readPlan, updatePlan } from './taskStore.js';
import { findWorkspaceRoot } from './workspace.js';
import { buildRolePrompt, listRoles, resolveRole } from './agentRoles.js';
import { createSession, getSession, listSessions, updateSession } from './orchestrator.js';
import { buildSkillPrompt, resolveSkill, SLASH_TO_SKILL } from './skillRunner.js';
import { buildMemoryBriefing, selectCitedRecordIds } from './memoryBriefing.js';
import { callMcpTool, childSessionKey, extractToolText, safeJsonParse } from './mcpUtils.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, getWorkflowDir, listWorkflows, slugify, updateWorkflowStatus } from './workflowArtifacts.js';
import { initAgentMd } from './initAgentMd.js';
import { expandMentions } from './mentions.js';
import { listTranscripts } from './sessionStore.js';
import { clearGoal, formatGoalBlock, readGoal, setGoal } from './goalStore.js';
import { addHook, readHooks, removeHook, runHooks, setHookEnabled } from './hooksStore.js';
import { parseInterval, isLoopRunning, startLoop, stopLoop, getLoopState } from './loopRunner.js';

function withTempWorkspace(fn: (workspace: string) => void) {
  const previousCwd = process.cwd();
  const previousWorkspace = process.env.BRAINROUTER_WORKSPACE;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-'));
  try {
    delete process.env.BRAINROUTER_WORKSPACE;
    process.chdir(workspace);
    fn(workspace);
  } finally {
    process.chdir(previousCwd);
    if (previousWorkspace === undefined) {
      delete process.env.BRAINROUTER_WORKSPACE;
    } else {
      process.env.BRAINROUTER_WORKSPACE = previousWorkspace;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
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

test('CLI state helpers create workspace-local state files', () => {
  withTempWorkspace((workspace) => {
    const stateDir = getCliStateDir(workspace);
    assert.equal(stateDir, path.join(fs.realpathSync(workspace), '.brainrouter', 'cli'));
    assert.equal(fs.existsSync(stateDir), true);
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
              recalledCognitiveRecords: [
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
    assert.equal(rel.split(path.sep).join('/').startsWith('.brainrouter/cli/workflows/two/'), true);
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

test('goalStore: set/read/clear round-trip and formatGoalBlock includes the text', () => {
  withTempWorkspace((workspace) => {
    assert.equal(readGoal(workspace), null);
    const saved = setGoal(workspace, '   ship the auth refactor   ');
    assert.equal(saved.text, 'ship the auth refactor');
    const block = formatGoalBlock(saved);
    assert.match(block, /Sticky Goal/);
    assert.match(block, /ship the auth refactor/);
    clearGoal(workspace);
    assert.equal(readGoal(workspace), null);
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
