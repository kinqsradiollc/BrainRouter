import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempWorkspace } from './_helpers.js';
import { loadRegistry, findById, listAll, type AgentDefinition } from '../orchestration/agents/agentRegistry.js';

test('built-in registry loads all canonical roles', () => {
  const defs = loadRegistry();
  const ids = defs.map((d) => d.def.id).sort();
  assert.deepEqual(ids, ['architect', 'explorer', 'fleet', 'intake', 'reviewer', 'verifier', 'worker']);
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
  assert.equal(all.length, 7);
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
    assert.equal(defs.length, 8, '7 builtins + 1 custom');
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

test('W4b agent definitions fail closed on invalid execution policy fields', () => {
  withTempWorkspace((workspace) => {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const invalid = {
      id: 'unsafe',
      displayName: 'Unsafe',
      whenToUse: 'Never.',
      prompt: 'Try to run.',
      model: null,
      effort: null,
      defaultAccess: 'admin',
      toolScope: { local: [], mcp: [] },
      disallowedTools: [],
      maxIterations: 10,
      timeoutMs: 30_000,
      maxResultChars: 2_000,
      subagents: [],
      delegateName: 'delegate_unsafe',
      tier: 'worker',
      outputContract: null,
    };
    fs.writeFileSync(path.join(agentsDir, 'unsafe.json'), JSON.stringify(invalid), 'utf8');

    assert.equal(findById('unsafe', workspace), undefined, 'unknown access modes never reach execution');
  });
});

test('W4b agent definitions require the id to match the JSON filename', () => {
  withTempWorkspace((workspace) => {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const custom: AgentDefinition = {
      id: 'actual-id',
      displayName: 'Actual id',
      whenToUse: 'Use for a bounded task.',
      prompt: 'Do the bounded task.',
      model: null,
      effort: null,
      defaultAccess: 'read',
      toolScope: { local: [], mcp: [] },
      disallowedTools: [],
      maxIterations: 10,
      timeoutMs: 30_000,
      maxResultChars: 2_000,
      subagents: [],
      delegateName: 'delegate_actual_id',
      tier: 'worker',
      outputContract: null,
    };
    fs.writeFileSync(path.join(agentsDir, 'different-id.json'), JSON.stringify(custom), 'utf8');

    assert.equal(findById('actual-id', workspace), undefined, 'deceptive filenames are rejected');
  });
});

test('W4b agent definitions reject oversized and symlinked project files', () => {
  withTempWorkspace((workspace) => {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'oversized.json'), ' '.repeat(64 * 1024 + 1), 'utf8');

    const outside = path.join(workspace, 'linked.json');
    fs.writeFileSync(outside, JSON.stringify({ id: 'linked' }), 'utf8');
    fs.symlinkSync(outside, path.join(agentsDir, 'linked.json'));

    const ids = loadRegistry(workspace).map((entry) => entry.def.id);
    assert.equal(ids.includes('oversized'), false, 'oversized project definitions are skipped');
    assert.equal(ids.includes('linked'), false, 'symlinked project definitions are skipped');
  });
});

test('W4b agent definitions reject a symlinked project metadata ancestor', () => {
  withTempWorkspace((workspace) => {
    const outside = fs.mkdtempSync(path.join(path.dirname(workspace), 'br-agent-outside-'));
    try {
      const agentsDir = path.join(outside, 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'escaped.json'), JSON.stringify({ id: 'escaped' }), 'utf8');
      fs.symlinkSync(outside, path.join(workspace, '.brainrouter'));

      assert.equal(findById('escaped', workspace), undefined, 'ancestor links cannot escape the workspace root');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('W4b pack agent directories cannot escape either the source root or pack root', () => {
  withTempWorkspace((workspace) => {
    const packRoot = path.join(workspace, '.brainrouter', 'packs', 'demo');
    const siblingAgents = path.join(workspace, '.brainrouter', 'packs', 'other', 'agents');
    fs.mkdirSync(packRoot, { recursive: true });
    fs.mkdirSync(siblingAgents, { recursive: true });
    const escaped: AgentDefinition = {
      id: 'escaped',
      displayName: 'Escaped',
      whenToUse: 'Never load this definition.',
      prompt: 'This definition is outside its declaring pack.',
      model: null,
      effort: null,
      defaultAccess: 'shell',
      toolScope: { local: ['*'], mcp: [] },
      disallowedTools: [],
      maxIterations: 10,
      timeoutMs: 30_000,
      maxResultChars: 2_000,
      subagents: [],
      delegateName: 'delegate_escaped',
      tier: 'worker',
      outputContract: null,
    };
    fs.writeFileSync(path.join(siblingAgents, 'escaped.json'), JSON.stringify(escaped), 'utf8');
    fs.writeFileSync(
      path.join(packRoot, 'pack.json'),
      JSON.stringify({ name: 'demo', agentsDir: '../other/agents' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspace, '.brainrouter', 'packs.json'),
      JSON.stringify({ enabled: ['demo'] }),
      'utf8',
    );

    assert.equal(
      findById('escaped', workspace),
      undefined,
      'a pack manifest cannot point its agentsDir at a sibling pack',
    );
  });
});

test('W4b legacy CLI delegate names normalize to a routable typed tool', () => {
  withTempWorkspace((workspace) => {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const custom: AgentDefinition = {
      id: 'project-specialist',
      displayName: 'Project specialist',
      whenToUse: 'Use for project-specific work.',
      prompt: 'Follow the project execution policy.',
      model: null,
      effort: null,
      defaultAccess: 'read',
      toolScope: { local: [], mcp: [] },
      disallowedTools: [],
      maxIterations: 10,
      timeoutMs: 30_000,
      maxResultChars: 2_000,
      subagents: [],
      delegateName: 'project-specialist',
      tier: 'worker',
      outputContract: null,
    };
    fs.writeFileSync(path.join(agentsDir, 'project-specialist.json'), JSON.stringify(custom), 'utf8');

    assert.equal(
      findById('project-specialist', workspace)?.def.delegateName,
      'delegate_project_specialist',
      'legacy generated definitions remain usable after validation',
    );
  });
});
