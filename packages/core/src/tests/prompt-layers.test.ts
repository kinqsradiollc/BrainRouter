import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildPromptLayers, type SystemPromptContext } from '../prompt/systemPrompt.js';
import { INSTRUCTION_FILES } from '../workspace/workspace.js';

const baseCtx: SystemPromptContext = {
  workspaceRoot: '/repo/project',
  launchCwd: '/repo/project/sub',
  sessionKey: 'sess-123',
  instructionSummary: 'Use AGENT.md.\n- build: npm run build',
  connectedMcpTools: ['memory_recall', 'read_file'],
  model: 'qwen3-coder',
};

test('buildPromptLayers: instructions layer holds the stable identity + tool guidance only', () => {
  const { instructions } = buildPromptLayers(baseCtx);
  // present: identity + how-you-work + tool guidelines
  assert.ok(instructions.includes('You are BrainRouter CLI'));
  assert.ok(instructions.includes('# Workspace instruction discovery'));
  assert.ok(instructions.includes('# Text output'));
  assert.ok(instructions.includes('# Using your tools'));
  assert.ok(instructions.includes('# MCP, skills, and dynamic capabilities'));
  assert.ok(instructions.includes('# Multi-agent orchestration'));
  assert.ok(instructions.includes('# Operating behavior'));
  // absent: operational/per-session/environment content lives in other layers
  assert.ok(!instructions.includes('Memory-First Workflow'), 'memory posture is a developer block');
  assert.ok(!instructions.includes('<collaboration_mode>'), 'collaboration mode is a developer block');
  assert.ok(!instructions.includes('# Runtime Context'), 'runtime context is an environment block');
  assert.ok(!instructions.includes('# Workspace Instructions'), 'AGENT.md is an environment block');
});

test('buildPromptLayers: instruction guidance mirrors Codex/Claude tool discipline', () => {
  const { instructions } = buildPromptLayers(baseCtx);
  assert.ok(instructions.includes('Only call tools in the current tool list'));
  assert.ok(instructions.includes('MCP tools are ordinary tools with exact names'));
  assert.ok(instructions.includes('If the user invokes a BrainRouter skill or slash workflow'));
  assert.ok(instructions.includes('Do not narrate hidden chain-of-thought'));
  assert.ok(instructions.includes('Validate from narrow to broad'));
});

test('workspace instruction discovery includes adjacent agent harness files', () => {
  assert.deepEqual(
    [...INSTRUCTION_FILES],
    ['AGENT.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', 'codex.md'],
  );
});

test('buildPromptLayers: developer layer is one block per active overlay; inactive overlays drop out', () => {
  const { developer } = buildPromptLayers({
    ...baseCtx,
    personality: 'concise',
    effort: 'high',
    executionMode: 'fast',
    reviewPolicy: 'request',
    activeSkill: 'grill-me',
  });
  assert.ok(developer.some((b) => b.includes('Memory-First Workflow')), 'memory posture first');
  assert.ok(developer.some((b) => b.includes('<collaboration_mode># Collaboration Mode: Plan')));
  assert.ok(developer.some((b) => b.includes('Communication style: concise')));
  assert.ok(developer.some((b) => b.includes('Reasoning depth: high')));
  assert.ok(developer.some((b) => b.includes('CLARIFY mode')));
  assert.ok(developer.some((b) => b.includes('Reinforced autonomy directives')), 'weak model overlay');
  // each entry is its own discrete block (Codex tags blocks separately)
  assert.ok(developer.every((b) => b.trim().length > 0), 'no empty blocks');

  // a minimal context (strong model, default modes) emits memory + the default review-policy block
  const minimal = buildPromptLayers({ ...baseCtx, model: 'claude-opus-4-8' });
  assert.equal(minimal.developer.length, 3);
  assert.ok(minimal.developer[0].includes('Memory-First Workflow'));
  assert.ok(minimal.developer[1].includes('<collaboration_mode># Collaboration Mode: Plan'));
  assert.ok(minimal.developer[2].includes('Review policy is `request`'));
});

test('buildPromptLayers: collaboration mode maps proceed policy to Codex Default mode', () => {
  const { developer } = buildPromptLayers({ ...baseCtx, reviewPolicy: 'proceed', executionMode: 'fast' });
  const block = developer.find((b) => b.includes('<collaboration_mode>'));
  assert.ok(block);
  assert.ok(block!.includes('# Collaboration Mode: Default'));
  assert.ok(block!.includes('current review policy is `proceed`'));
});

test('buildPromptLayers: environment layer carries AGENT.md before the runtime context (Codex order)', () => {
  const { environment } = buildPromptLayers(baseCtx);
  assert.ok(environment.includes('# Workspace Instructions'));
  assert.ok(environment.includes('# Runtime Context'));
  assert.ok(environment.includes(baseCtx.workspaceRoot));
  assert.ok(
    environment.indexOf('# Workspace Instructions') < environment.indexOf('# Runtime Context'),
    'project guidance precedes <environment_context>',
  );
});

test('buildPromptLayers: brain-offline swaps the memory posture for the offline notice', () => {
  const offline = buildPromptLayers({ ...baseCtx, connectedMcpTools: ['read_file'] });
  assert.ok(offline.developer.some((b) => b.includes('BrainRouter MCP is OFFLINE')));
  assert.ok(!offline.developer.some((b) => b.includes('Memory-First Workflow')));
});

test('buildPromptLayers: the three layers together drop no content from the flat prompt', () => {
  const ctx: SystemPromptContext = {
    ...baseCtx,
    personality: 'pair-programmer',
    effort: 'xhigh',
    executionMode: 'fast',
    reviewPolicy: 'proceed',
  };
  const flat = buildSystemPrompt(ctx);
  const layers = buildPromptLayers(ctx);
  const joined = [layers.instructions, ...layers.developer, layers.environment].join('\n');
  const missing = flat.split('\n').filter((line) => line.trim() && !joined.includes(line));
  assert.deepEqual(missing, [], `every non-empty flat line must survive into a layer; missing: ${missing.slice(0, 5)}`);
});
