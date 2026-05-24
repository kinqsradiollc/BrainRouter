import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChatCompletionPayload, LOCAL_TOOLS } from '../agent/agent.js';
import { buildSystemPrompt } from '../prompt/systemPrompt.js';
import { buildRolePrompt, listRoles, resolveRole } from '../orchestration/roles.js';
import { buildSkillPrompt, resolveSkill, SLASH_TO_SKILL } from '../prompt/skillRunner.js';

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

test('systemPrompt: activeSkill="grill-me" appends a CLARIFY-mode block; other activeSkills do not', () => {
  const grill = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:test',
    activeSkill: 'grill-me',
  });
  assert.match(grill, /CLARIFY mode/i, 'CLARIFY header should be present');
  assert.match(grill, /Do NOT make file edits/i, 'must forbid edits this turn');
  assert.match(grill, /ask_user_choice/, 'should steer toward the picker tool');
  assert.match(grill, /2.{0,3}5 questions/i, 'must ask 2–5 questions');

  // Baseline (no activeSkill) and other skills must NOT carry the overlay,
  // otherwise plain `/spec` runs would suddenly refuse to edit files.
  const baseline = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:test',
  });
  assert.doesNotMatch(baseline, /CLARIFY mode/i);

  const specMode = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:test',
    activeSkill: 'spec-driven-skill',
  });
  assert.doesNotMatch(specMode, /CLARIFY mode/i);
});
