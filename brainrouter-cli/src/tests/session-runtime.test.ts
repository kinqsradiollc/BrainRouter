import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-home-')));
process.env.BRAINROUTER_HOME = HOME;

const { getSessionRuntime, setSessionRuntime, clearSessionRuntime, resolveSessionRuntime, resolveSessionLlmConfig } =
  await import('../state/sessionRuntimeStore.js');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ws-')));
const GLOBAL = { provider: 'anthropic', model: 'claude-opus-4-8', mcpProfiles: [] };

test('a fresh session has no overrides', () => {
  assert.deepEqual(getSessionRuntime(ws, 'sess:a'), {});
});

test('set persists + merges; empty fields are pruned', () => {
  setSessionRuntime(ws, 'sess:a', { provider: 'openai', model: 'gpt-5.5' });
  assert.deepEqual(getSessionRuntime(ws, 'sess:a'), { provider: 'openai', model: 'gpt-5.5' });
  setSessionRuntime(ws, 'sess:a', { model: 'gpt-5.3-codex' }); // merge
  assert.equal(getSessionRuntime(ws, 'sess:a').model, 'gpt-5.3-codex');
  setSessionRuntime(ws, 'sess:a', { provider: '' }); // prune
  assert.equal(getSessionRuntime(ws, 'sess:a').provider, undefined);
});

test('clear removes the entry (reverts to defaults)', () => {
  setSessionRuntime(ws, 'sess:b', { model: 'x' });
  clearSessionRuntime(ws, 'sess:b');
  assert.deepEqual(getSessionRuntime(ws, 'sess:b'), {});
});

test('two sessions hold DIFFERENT runtimes concurrently', () => {
  setSessionRuntime(ws, 'sess:1', { provider: 'openai', model: 'gpt-5.5', mcpProfiles: ['github'] });
  setSessionRuntime(ws, 'sess:2', { provider: 'deepseek', model: 'deepseek-v4' });
  assert.equal(getSessionRuntime(ws, 'sess:1').provider, 'openai');
  assert.equal(getSessionRuntime(ws, 'sess:2').provider, 'deepseek');
  assert.deepEqual(getSessionRuntime(ws, 'sess:1').mcpProfiles, ['github']);
});

test('resolveSessionRuntime: session overrides win over workspace over global', () => {
  const r = resolveSessionRuntime(
    GLOBAL,
    { provider: 'openai', model: 'gpt-5.5' },          // workspace defaults
    { model: 'gpt-5.3-codex', brainProfile: 'work' },  // session overrides
  );
  assert.equal(r.provider, 'openai', 'provider from workspace (no session override)');
  assert.equal(r.model, 'gpt-5.3-codex', 'model from session override');
  assert.equal(r.brainProfile, 'work');
});

test('resolveSessionRuntime: falls all the way back to global when nothing overrides', () => {
  const r = resolveSessionRuntime(GLOBAL, undefined, undefined);
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, 'claude-opus-4-8');
  assert.deepEqual(r.mcpProfiles, []);
});

test('resolveSessionRuntime: mcpProfiles layer independently', () => {
  const r = resolveSessionRuntime({ ...GLOBAL, mcpProfiles: ['base'] }, { mcpProfiles: ['ws'] }, { mcpProfiles: ['sess'] });
  assert.deepEqual(r.mcpProfiles, ['sess']);
});

test('resolveSessionLlmConfig: desktop and CLI resolve the same per-session model over config.json', () => {
  setSessionRuntime(ws, 'sess:llm', { model: 'qwen3-coder', endpoint: 'http://localhost:1234/v1' });
  const resolved = resolveSessionLlmConfig(
    { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1' },
    ws,
    'sess:llm',
  );
  assert.deepEqual(resolved, {
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'qwen3-coder',
    endpoint: 'http://localhost:1234/v1',
  });
});
