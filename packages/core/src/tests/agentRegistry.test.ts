import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempWorkspace } from './_helpers.js';
import { loadRegistry, findById, listAll, type AgentDefinition } from '../orchestration/agentRegistry.js';

test('built-in registry loads all 5 roles', () => {
  const defs = loadRegistry();
  const ids = defs.map((d) => d.def.id).sort();
  assert.deepEqual(ids, ['architect', 'explorer', 'reviewer', 'verifier', 'worker']);
});

test('all built-in definitions carry required fields', () => {
  for (const loaded of loadRegistry()) {
    const { def } = loaded;
    assert.ok(def.id, `${def.id}: missing id`);
    assert.ok(def.tier, `${def.id}: missing tier`);
    assert.ok(def.defaultAccess, `${def.id}: missing defaultAccess`);
    assert.ok(def.prompt, `${def.id}: missing prompt`);
    assert.equal(loaded.source, 'builtin');
  }
});

test('explorer, architect, reviewer are reasoning tier', () => {
  for (const id of ['explorer', 'architect', 'reviewer']) {
    const loaded = findById(id);
    assert.ok(loaded, `${id} not found`);
    assert.equal(loaded.def.tier, 'reasoning', `${id} should be reasoning tier`);
  }
});

test('worker and verifier are worker tier', () => {
  for (const id of ['worker', 'verifier']) {
    const loaded = findById(id);
    assert.ok(loaded, `${id} not found`);
    assert.equal(loaded.def.tier, 'worker', `${id} should be worker tier`);
  }
});

test('findById returns undefined for unknown id', () => {
  assert.equal(findById('no-such-agent'), undefined);
});

test('listAll without workspace returns all builtins', () => {
  const all = listAll();
  assert.equal(all.length, 5);
});

test('workspace definition overrides builtin with same id', () => {
  withTempWorkspace((workspace) => {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const custom: AgentDefinition = {
      id: 'explorer',
      displayName: 'Custom Explorer',
      whenToUse: 'custom',
      prompt: 'custom prompt',
      model: null,
      effort: null,
      defaultAccess: 'read',
      toolScope: { local: ['*'], mcp: ['memory_*'] },
      disallowedTools: [],
      maxIterations: 10,
      timeoutMs: 60000,
      maxResultChars: 4000,
      subagents: [],
      delegateName: 'delegate_explorer',
      tier: 'reasoning',
      outputContract: null,
    };
    fs.writeFileSync(path.join(agentsDir, 'explorer.json'), JSON.stringify(custom), 'utf-8');

    const loaded = findById('explorer', workspace);
    assert.ok(loaded, 'workspace explorer found');
    assert.equal(loaded.def.displayName, 'Custom Explorer');
    assert.equal(loaded.source, 'workspace');
  });
});

test('malformed JSON in workspace agents dir is skipped, not a crash', () => {
  withTempWorkspace((workspace) => {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'broken.json'), '{ not valid json }', 'utf-8');

    const defs = loadRegistry(workspace);
    assert.ok(defs.length >= 5, 'builtins still present after malformed workspace file');
    assert.equal(defs.filter((d) => d.source === 'workspace').length, 0, 'broken def not loaded');
  });
});

test('workspace-only id coexists with builtins', () => {
  withTempWorkspace((workspace) => {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const custom: AgentDefinition = {
      id: 'my-custom-agent',
      displayName: 'My Custom Agent',
      whenToUse: 'custom',
      prompt: 'do stuff',
      model: null,
      effort: null,
      defaultAccess: 'read',
      toolScope: { local: ['*'], mcp: [] },
      disallowedTools: [],
      maxIterations: 10,
      timeoutMs: 30000,
      maxResultChars: 2000,
      subagents: [],
      delegateName: 'delegate_my_custom_agent',
      tier: 'worker',
      outputContract: null,
    };
    fs.writeFileSync(path.join(agentsDir, 'my-custom-agent.json'), JSON.stringify(custom), 'utf-8');

    const defs = loadRegistry(workspace);
    const ids = defs.map((d) => d.def.id).sort();
    assert.ok(ids.includes('my-custom-agent'), 'custom agent present');
    assert.ok(ids.includes('explorer'), 'builtin still present');
    assert.equal(defs.length, 6, '5 builtins + 1 custom');
  });
});

test('definition with missing id field is skipped', () => {
  withTempWorkspace((workspace) => {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'no-id.json'),
      JSON.stringify({ displayName: 'No Id', tier: 'worker' }),
      'utf-8',
    );

    const defs = loadRegistry(workspace);
    assert.equal(defs.filter((d) => d.source === 'workspace').length, 0, 'missing-id def skipped');
  });
});
