import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChatCompletionPayload, LOCAL_TOOLS, resolveWireEffort } from '@kinqs/brainrouter-core/agent';
import { _resetModelReasoningCapabilities, registerModelReasoningCapabilities } from '@kinqs/brainrouter-core/provider';
import { buildSystemPrompt } from '@kinqs/brainrouter-core/prompt';
import { buildRolePrompt, listRoles, resolveRole } from '@kinqs/brainrouter-core/orchestration';
import { buildSkillPrompt, resolveSkill, SLASH_TO_SKILL } from '../prompt/skillRunner.js';
import { setCliKnobOverride, _resetCliKnobsCache } from '@kinqs/brainrouter-core/config';

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

test('buildChatCompletionPayload omits max_tokens by default and forwards cli.maxOutputTokens when set', () => {
  const cfg = { provider: 'openai', apiKey: '', model: 'test-model' } as const;
  const msgs = [{ role: 'user', content: 'hi' }];

  // Default: no cap on the wire so the provider's own default applies.
  _resetCliKnobsCache();
  const bare = buildChatCompletionPayload(cfg, msgs, []) as { max_tokens?: number };
  assert.equal(bare.max_tokens, undefined);

  // Cut-off fix — the knob lifts a too-low provider default.
  setCliKnobOverride({ maxOutputTokens: 8192 });
  const capped = buildChatCompletionPayload(cfg, msgs, []) as { max_tokens?: number };
  assert.equal(capped.max_tokens, 8192);

  // A zero / non-positive value is treated as "unset" (no cap forwarded).
  setCliKnobOverride({ maxOutputTokens: 0 });
  const zeroed = buildChatCompletionPayload(cfg, msgs, []) as { max_tokens?: number };
  assert.equal(zeroed.max_tokens, undefined);

  _resetCliKnobsCache();
});

test('resolveWireEffort is provider-aware (reasoning_effort value per provider/model)', () => {
  const cfg = (provider: string, model: string) => ({ provider, apiKey: 'k', model });
  // OpenAI: reasoning models get the field; xhigh downgrades to high; medium/non-reasoning omit.
  assert.equal(resolveWireEffort(cfg('openai', 'gpt-5'), 'low'), 'low');
  assert.equal(resolveWireEffort(cfg('openai', 'gpt-5'), 'xhigh'), 'high');
  assert.equal(resolveWireEffort(cfg('openai', 'gpt-5'), 'medium'), null);
  assert.equal(resolveWireEffort(cfg('openai', 'gpt-4o'), 'high'), null); // not a reasoning model
  // DeepSeek v4: xhigh → 'max', low → 'high'; the always-on reasoner rejects the field.
  assert.equal(resolveWireEffort(cfg('deepseek', 'deepseek-v4-pro'), 'xhigh'), 'max');
  assert.equal(resolveWireEffort(cfg('deepseek', 'deepseek-v4-pro'), 'low'), 'high');
  assert.equal(resolveWireEffort(cfg('deepseek', 'deepseek-reasoner'), 'high'), null);
  // LM Studio: graded effort for reasoning models (low/medium/high; no xhigh tier,
  // so xhigh caps at high). Lenient 'any' gate — it accepts-and-ignores the field,
  // so even a non-reasoning model gets it (the server drops it).
  assert.equal(resolveWireEffort(cfg('lmstudio', 'gpt-oss-20b'), 'high'), 'high');
  assert.equal(resolveWireEffort(cfg('lmstudio', 'gpt-oss-20b'), 'xhigh'), 'high');
  assert.equal(resolveWireEffort(cfg('lmstudio', 'qwen2.5-coder'), 'high'), 'high');
  // Ollama: caps at high (no xhigh).
  assert.equal(resolveWireEffort(cfg('ollama', 'qwen3-30b'), 'xhigh'), 'high');
  // opencode: keeps xhigh natively.
  assert.equal(resolveWireEffort(cfg('opencode', 'gpt-5.1-codex'), 'xhigh'), 'xhigh');
});

test('resolveWireEffort: non-OpenAI providers send effort for UNLISTED reasoning models (lenient gate); OpenAI gates strictly', () => {
  // A reasoning model whose NAME isn't in our allowlist (glm, minimax, a custom
  // finetune): on EVERY OpenAI-compatible provider except OpenAI the field is
  // still sent (the server ignores it if N/A), so effort isn't restricted to the
  // names we happen to enumerate.
  for (const provider of ['openai-compatible', 'lmstudio', 'ollama', 'opencode', 'deepseek']) {
    assert.equal(resolveWireEffort({ provider, apiKey: 'k', model: 'glm-4.6' } as any, 'high'), 'high', provider);
    assert.equal(resolveWireEffort({ provider, apiKey: 'k', model: 'minimax-m2' } as any, 'high'), 'high', provider);
  }
  // OpenAI is strict — it ERRORS on a non-reasoning model, so an unlisted name is omitted.
  assert.equal(resolveWireEffort({ provider: 'openai', apiKey: 'k', model: 'glm-4.6' } as any, 'high'), null);
  // Known rejecters stay excluded EVERYWHERE, even under the lenient gate.
  assert.equal(resolveWireEffort({ provider: 'lmstudio', apiKey: '', model: 'deepseek-reasoner' } as any, 'high'), null);
  assert.equal(resolveWireEffort({ provider: 'ollama', apiKey: '', model: 'gpt-5-chat-latest' } as any, 'high'), null);
});

test('resolveWireEffort: strict providers can use live reasoning metadata for unlisted models', () => {
  _resetModelReasoningCapabilities();
  const cfg = { provider: 'openai', apiKey: 'k', model: 'future-reasoner-2026' } as any;
  assert.equal(resolveWireEffort(cfg, 'high'), null);

  registerModelReasoningCapabilities('future-reasoner-2026', { reasoning: true, effort: true });
  assert.equal(resolveWireEffort(cfg, 'high'), 'high');

  _resetModelReasoningCapabilities();
});

test('resolveWireEffort is ENDPOINT-aware: a cloud endpoint overrides a mismatched provider id (DeepSeek reached via openai)', () => {
  // DeepSeek is reached as provider:'openai' + the DeepSeek base URL (it's a
  // hidden, pickerVisible:false provider). The CLOUD endpoint resolves to the
  // deepseek definition, so DeepSeek's own map applies — xhigh→max, low→high —
  // instead of silently inheriting OpenAI's xhigh→high.
  const ds = (model: string, effort: any, endpoint = 'https://api.deepseek.com/v1') =>
    resolveWireEffort({ provider: 'openai', apiKey: 'k', model, endpoint } as any, effort);
  assert.equal(ds('deepseek-v4-pro', 'xhigh'), 'max');
  assert.equal(ds('deepseek-v4-pro', 'low'), 'high');
  // The canonical no-/v1 base URL (DeepSeek docs say both forms work) resolves identically.
  assert.equal(ds('deepseek-v4-pro', 'xhigh', 'https://api.deepseek.com'), 'max');
  // A LOCAL endpoint is NOT used to infer the provider (localhost:1234 could be
  // LM Studio / vLLM / llama.cpp) — the explicit provider:'openai' wins, so a
  // reasoning model still gets 'param' behavior rather than LM Studio's 'ignored'.
  assert.equal(
    resolveWireEffort(
      { provider: 'openai', apiKey: '', model: 'openai/gpt-oss-20b', endpoint: 'http://localhost:1234/v1' } as any,
      'high',
    ),
    'high',
  );
});

test('resolveWireEffort: non-reasoning chat variants reject the field (OpenAI errors on *-chat)', () => {
  // gpt-5-chat-latest / gpt-5.1-chat match /^gpt-5/ but are NON-reasoning chat
  // models — OpenAI returns an invalid-parameter error if sent reasoning_effort,
  // so the field must be OMITTED for them.
  for (const model of ['gpt-5-chat-latest', 'gpt-5.1-chat', 'gpt-5-chat']) {
    assert.equal(resolveWireEffort({ provider: 'openai', apiKey: 'k', model } as any, 'high'), null, model);
  }
});

test('resolveWireEffort: xhigh-capable OpenAI models keep xhigh; others keep the high cap', () => {
  const x = (model: string) => resolveWireEffort({ provider: 'openai', apiKey: 'k', model } as any, 'xhigh');
  // Models that introduced / accept xhigh pass it through (no silent downgrade).
  assert.equal(x('gpt-5.1-codex-max'), 'xhigh');
  assert.equal(x('gpt-5.2'), 'xhigh');
  assert.equal(x('gpt-5.2-codex'), 'xhigh');
  assert.equal(x('gpt-5.5'), 'xhigh');
  // Models WITHOUT xhigh keep the conservative high cap (sending xhigh would error).
  assert.equal(x('gpt-5'), 'high');
  assert.equal(x('gpt-5.1'), 'high');
  assert.equal(x('gpt-5.1-codex'), 'high'); // only codex-MAX added xhigh, not plain codex
  assert.equal(x('o3'), 'high');
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

test('agent role registry lists built-in roles and DEGRADES unknown ones to a best-fit', () => {
  const names = listRoles().map(r => r.name).sort();
  assert.deepEqual(names, ['architect', 'explorer', 'fleet', 'intake', 'reviewer', 'verifier', 'worker']);
  assert.equal(resolveRole('explorer').defaultAccess, 'read');
  assert.equal(resolveRole('worker').defaultAccess, 'write');
  // FS-FIX: an unknown/custom role no longer THROWS (which killed whole workflows
  // when a model named a phase agent `security-auditor`). It maps to the best-fit
  // built-in, defaulting to the safe read-only `explorer`.
  assert.equal(resolveRole('nope').name, 'explorer');
  assert.equal(resolveRole('security-auditor').name, 'reviewer');
  assert.equal(resolveRole('qa-engineer').name, 'verifier');
  assert.equal(resolveRole('implementer').name, 'worker');
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

test('systemPrompt: prefixed BrainRouter MCP tools still count as brain online', () => {
  const prompt = buildSystemPrompt({
    workspaceRoot: '/tmp/x',
    launchCwd: '/tmp/x',
    sessionKey: 's',
    connectedMcpTools: ['mcp_remote_memory_recall', 'mcp_github_create_issue'],
  });

  assert.match(prompt, /Memory-First Workflow/);
  assert.doesNotMatch(prompt, /BrainRouter MCP is OFFLINE/);
});

test('SLASH_TO_SKILL maps the documented commands to skill names', () => {
  assert.equal(SLASH_TO_SKILL['/feature-dev'], 'agentic-engineering-workflow');
  assert.equal(SLASH_TO_SKILL['/review'], 'code-review-and-quality');
  assert.equal(SLASH_TO_SKILL['/implement-plan'], 'incremental-skill');
  // PARITY-R2 — /simplify is a first-class command backed by code-simplification.
  assert.equal(SLASH_TO_SKILL['/simplify'], 'code-simplification');
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

test('systemPrompt: documents the reasoning-step offload rule (0.3.6 item 2c)', () => {
  // The CLI steers the agent to emit a structured `kind:"reasoning"` step
  // via memory_working_offload after every non-trivial tool batch — that
  // is what populates the "why trail" in working memory and what the
  // briefing surfaces back on the next turn. The rule lives in the system
  // prompt, so a silent prompt refactor would erase the discipline. Pin
  // the wording loosely enough to allow rewording, tightly enough that
  // the kind value + the >=3-call / >2KB triggers + the "Why:" title
  // convention can't drift apart from the canvas/briefing code.
  const prompt = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:reasoning',
  });
  assert.match(prompt, /memory_working_offload/);
  assert.match(prompt, /kind:\s*"reasoning"/);
  assert.match(prompt, /Why:/);
  assert.match(prompt, /(≥\s*3|3 or more)/);
  assert.match(prompt, /2\s*KB|2KB/i);
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

test('systemPrompt: token budget — base prompt fits in ~4,900 tokens (9a)', () => {
  // 9a: pre-trim the system prompt clocked ~4,750 tokens. Most of it was
  // tool-mechanics prose, orchestration paragraphs, and anti-hallucination
  // repetition the model could derive from tool descriptions and a few
  // sharp rules. Target was originally ~1,800 tokens; 0.3.9 intentionally
  // re-added an "Autonomy and persistence" block + examples
  // + Task-tool orchestration section to push weaker OS models off the
  // "please clarify" default. The cap accommodates that tradeoff while
  // guarding against unbounded lecturing.
  // PARITY-Q: deliberately raised 4,500 → 4,900 to carry high-value
  // behavioral guidance — the question-quality bar (consequence-laden
  // options, recommend-first), the planning bar (verifiable outcomes +
  // acceptance), and the 5-part delegation contract — into the always-on
  // prompt instead of leaving it in seldom-loaded skills. A duplicate
  // update_plan line was removed to partly offset the addition.
  // 0.4.15: raised 4,900 → 5,000 for injection-surface hardening — fencing
  // untrusted workspace AGENT.md + goal text with an explicit "this does not
  // override your core operating/safety/tool-permission rules" instruction.
  const prompt = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:budget',
    instructionSummary: 'No workspace AGENT.md or AGENTS.md instruction file was found.',
  });
  const estimatedTokens = Math.ceil(prompt.length / 4);
  const CAP = 5000;
  assert.ok(
    estimatedTokens <= CAP,
    `system prompt over budget: ${estimatedTokens} tokens (cap ${CAP.toLocaleString()}). prompt length ${prompt.length} chars.`,
  );
});

test('systemPrompt: prompt ordering puts static identity first, workspace last (9c)', () => {
  // 9c: prompt-cache hits depend on prefix stability. Static blocks
  // (identity, tool-call mechanics, tool policy, memory section) must
  // precede the dynamic Runtime Context + Workspace Instructions, which
  // change per-workspace. Asserting the index ordering lets the cache
  // hits compound across sessions in the same workspace.
  const prompt = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:order',
    instructionSummary: 'workspace-specific instructions',
  });
  // 0.3.9 rewrite mirrors claude-code's section headings (`# Doing tasks`,
  // `# Using your tools`, etc.) so the cache-stable prefix order is now
  // identity → Doing tasks → Using your tools → Memory-First → Runtime → Workspace.
  const identityIdx = prompt.indexOf('autonomous software engineering agent');
  const usingToolsIdx = prompt.indexOf('# Using your tools');
  const memoryIdx = prompt.indexOf('# Memory-First Workflow');
  const runtimeIdx = prompt.indexOf('# Runtime Context');
  const workspaceIdx = prompt.indexOf('# Workspace Instructions');

  assert.ok(identityIdx >= 0 && usingToolsIdx >= 0 && memoryIdx >= 0 && runtimeIdx >= 0 && workspaceIdx >= 0, 'expected sections present');
  assert.ok(identityIdx < usingToolsIdx, 'identity precedes using-your-tools');
  assert.ok(usingToolsIdx < memoryIdx, 'using-your-tools precedes memory section');
  assert.ok(memoryIdx < runtimeIdx, 'memory section precedes the (dynamic) runtime context');
  assert.ok(runtimeIdx < workspaceIdx, 'runtime context precedes workspace instructions');
});

test('systemPrompt: brain-offline mode omits memory section + tool names (10b)', () => {
  // 10b: when `connectedMcpTools` is provided but lacks `memory_recall`,
  // the BrainRouter MCP is offline this turn. The prompt must NOT lie
  // about which tools exist — drop the entire memory section + every
  // memory_* tool name + replace with a single offline notice so the
  // model doesn't waste an iteration on `Unknown tool` errors.
  const offlinePrompt = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:offline',
    connectedMcpTools: [], // brain offline — zero MCP tools connected
  });
  assert.match(offlinePrompt, /BrainRouter MCP is OFFLINE/);
  assert.doesNotMatch(offlinePrompt, /Memory-First Workflow/, 'offline prompt must not claim memory section exists');
  assert.doesNotMatch(offlinePrompt, /memory_recall/, 'offline prompt must not name memory_recall');
  assert.doesNotMatch(offlinePrompt, /memory_working_offload/, 'offline prompt must not name memory_working_offload');

  // Same context with the brain online — full memory section back.
  const onlinePrompt = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:online',
    connectedMcpTools: ['memory_recall', 'memory_search', 'list_skills'],
  });
  assert.match(onlinePrompt, /Memory-First Workflow/);
  assert.match(onlinePrompt, /memory_recall/);
  assert.doesNotMatch(onlinePrompt, /BrainRouter MCP is OFFLINE/);

  // Back-compat: when connectedMcpTools is undefined, assume the brain is
  // online (older callers that didn't pass the inventory still get the
  // memory section, no regression).
  const undefinedPrompt = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:undefined',
  });
  assert.match(undefinedPrompt, /Memory-First Workflow/);
});

test('systemPrompt: effort overlay emits for low/high and stays silent for medium (0.3.6 item 2f)', () => {
  // `medium` is the default — emitting an overlay for it would silently
  // change every user's behaviour on upgrade and waste prompt tokens. The
  // low/high overlays must mention "Reasoning depth" so we can pin the
  // header without freezing the exact body wording.
  const baseline = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:test',
  });
  assert.doesNotMatch(baseline, /Reasoning depth/i, 'no effort field → no overlay');

  const mediumExplicit = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:test',
    effort: 'medium',
  });
  assert.doesNotMatch(mediumExplicit, /Reasoning depth/i, 'medium is the default → still no overlay');

  const low = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:test',
    effort: 'low',
  });
  assert.match(low, /Reasoning depth/i, 'low must emit an overlay header');
  assert.match(low, /terse/i, 'low overlay should encourage terseness');

  const high = buildSystemPrompt({
    workspaceRoot: '/tmp/ws',
    launchCwd: '/tmp/ws',
    sessionKey: 'sess:test',
    effort: 'high',
  });
  assert.match(high, /Reasoning depth/i, 'high must emit an overlay header');
  assert.match(high, /step.?by.?step/i, 'high overlay should encourage step-by-step reasoning');
});
