/** HONK-L1/L7 — model-family classification + the bounded-harness profile. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isStrongModelFamily,
  isLocalModelFamily,
  resolveLocalModelProfile,
  localModelProfileActive,
  isLocalModelCoreTool,
  LOCAL_MODEL_CORE_TOOLS,
  type HarnessCaps,
} from '../provider/modelFamily.js';

const BASE: HarnessCaps = {
  maxToolLoops: 60,
  repeatToolSequenceLimit: 12,
  stormThreshold: 4,
  agentMcpToolBudget: 16,
  maxSpawnDepth: 3,
};

test('isStrongModelFamily matches agentic-grade families only', () => {
  for (const m of ['claude-opus-4-8', 'gpt-4o', 'gpt-5-codex', 'o3-mini', 'chatgpt-4o-latest', 'gemini-2.5-pro', 'openai/gpt-4.1', 'anthropic/claude-3.5']) {
    assert.equal(isStrongModelFamily(m), true, `${m} should be strong`);
  }
  for (const m of ['llama-3.1-70b', 'qwen2.5-coder', 'gpt-oss-120b', undefined, '']) {
    assert.equal(isStrongModelFamily(m), false, `${m} should NOT be strong`);
  }
});

test('isLocalModelFamily positively matches small/local families and NOT strong or unknown ones', () => {
  for (const m of ['llama-3.1-8b', 'codellama-13b', 'qwen2.5-coder-7b', 'mistral-nemo', 'mixtral-8x7b', 'deepseek-coder', 'gemma-2-9b', 'phi-3', 'gpt-oss-20b', 'ollama/llama3', 'lmstudio-community/x', 'starcoder2']) {
    assert.equal(isLocalModelFamily(m), true, `${m} should be local`);
  }
  // Strong families and genuinely-unknown ids are NOT clamped.
  for (const m of ['claude-opus-4-8', 'gpt-5', 'gemini-2.5-flash', 'some-new-frontier-model', undefined, '']) {
    assert.equal(isLocalModelFamily(m), false, `${m} should NOT be local`);
  }
});

test('resolveLocalModelProfile: off is always a passthrough', () => {
  const r = resolveLocalModelProfile('llama-3.1-8b', 'off', BASE);
  assert.equal(r.active, false);
  assert.deepEqual({ ...r, active: undefined }, { ...BASE, active: undefined });
});

test('resolveLocalModelProfile: auto clamps a local family but passes strong/unknown through', () => {
  const local = resolveLocalModelProfile('qwen2.5-coder-7b', 'auto', BASE);
  assert.equal(local.active, true);
  assert.equal(local.maxToolLoops, 24);
  assert.equal(local.repeatToolSequenceLimit, 6);
  assert.equal(local.stormThreshold, 3);
  assert.equal(local.agentMcpToolBudget, 8);
  assert.equal(local.maxSpawnDepth, 2);

  const strong = resolveLocalModelProfile('claude-opus-4-8', 'auto', BASE);
  assert.equal(strong.active, false);
  assert.equal(strong.maxToolLoops, 60, 'strong model untouched');

  const unknown = resolveLocalModelProfile('frontier-x', 'auto', BASE);
  assert.equal(unknown.active, false, 'unknown model not clamped');
});

test('resolveLocalModelProfile: on always clamps, regardless of family', () => {
  const r = resolveLocalModelProfile('claude-opus-4-8', 'on', BASE);
  assert.equal(r.active, true);
  assert.equal(r.maxToolLoops, 24);
});

test('resolveLocalModelProfile: clamp is a ceiling — never loosens an already-tighter user setting', () => {
  const tight: HarnessCaps = { maxToolLoops: 10, repeatToolSequenceLimit: 4, stormThreshold: 2, agentMcpToolBudget: 4, maxSpawnDepth: 1 };
  const r = resolveLocalModelProfile('llama-3.1-8b', 'auto', tight);
  assert.equal(r.maxToolLoops, 10, 'keeps the tighter user value');
  assert.equal(r.repeatToolSequenceLimit, 4);
  assert.equal(r.stormThreshold, 2);
  assert.equal(r.maxSpawnDepth, 1);
});

test('localModelProfileActive: shared gate matches the resolver/overlay logic', () => {
  assert.equal(localModelProfileActive('llama-3.1-8b', 'auto'), true);
  assert.equal(localModelProfileActive('claude-opus-4-8', 'auto'), false);
  assert.equal(localModelProfileActive('claude-opus-4-8', 'on'), true);
  assert.equal(localModelProfileActive('llama-3.1-8b', 'off'), false);
});

test('L2 allowlist: keeps file/search/edit/shell + lifecycle, hides the long tail', () => {
  for (const keep of ['read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir', 'grep_search', 'glob_files', 'run_command', 'update_plan', 'goal_complete', 'ask_user_choice']) {
    assert.equal(isLocalModelCoreTool(keep), true, `${keep} stays in the local allowlist`);
  }
  for (const hide of ['computer_use', 'web_search', 'fetch_url', 'research_brief', 'lsp', 'artifact_write', 'track_query', 'spawn_worker_thread', 'mcp_refresh_catalog']) {
    assert.equal(isLocalModelCoreTool(hide), false, `${hide} is hidden for local models`);
  }
  // Orchestration tools are filtered elsewhere — they must NOT be in this set
  // (so they're never accidentally clamped out by the built-in filter).
  assert.equal(LOCAL_MODEL_CORE_TOOLS.has('task_agent'), false);
});
