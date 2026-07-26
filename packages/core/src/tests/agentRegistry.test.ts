import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempWorkspace } from './_helpers.js';
import {
  findById,
  listAll,
  loadActiveRegistry,
  loadRegistry,
  parseAgentDefinition,
  type AgentDefinition,
} from '../orchestration/agents/agentRegistry.js';
import { synthesizeDelegateTools } from '../orchestration/tools/toolNames.js';
import { createWorkspaceManifest, saveWorkspaceManifest } from '../workspace/manifest.js';

const ORCHESTRATION_ROLE_HEADER = {
  schemaVersion: 1 as const,
  kind: 'orchestration-role' as const,
};

function writeAgentDefinition(
  workspace: string,
  id: string,
  overrides: Partial<AgentDefinition> = {},
): void {
  const agentsDir = path.join(workspace, '.brainrouter', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const definition: AgentDefinition = {
    ...ORCHESTRATION_ROLE_HEADER,
    id,
    displayName: id,
    whenToUse: `Use ${id} for its enabled project work.`,
    prompt: `Follow the ${id} project execution policy.`,
    model: null,
    effort: null,
    defaultAccess: 'read',
    toolScope: { local: [], mcp: [] },
    disallowedTools: [],
    maxIterations: 10,
    timeoutMs: 30_000,
    maxResultChars: 2_000,
    subagents: [],
    delegateName: `delegate_${id.replaceAll('-', '_')}`,
    tier: 'worker',
    outputContract: null,
    ...overrides,
  };
  fs.writeFileSync(path.join(agentsDir, `${id}.json`), JSON.stringify(definition), 'utf8');
}

test('built-in registry loads all canonical roles', () => {
  const defs = loadRegistry();
  const ids = defs.map((d) => d.def.id).sort();
  assert.deepEqual(ids, ['architect', 'explorer', 'fleet', 'intake', 'reviewer', 'verifier', 'worker']);
});

test('all built-in definitions carry required fields', () => {
  for (const loaded of loadRegistry()) {
    const { def } = loaded;
    assert.equal(def.schemaVersion, 1, `${def.id}: wrong schemaVersion`);
    assert.equal(def.kind, 'orchestration-role', `${def.id}: wrong kind`);
    assert.ok(def.id, `${def.id}: missing id`);
    assert.ok(def.tier, `${def.id}: missing tier`);
    assert.ok(def.defaultAccess, `${def.id}: missing defaultAccess`);
    assert.ok(def.prompt, `${def.id}: missing prompt`);
    assert.equal(loaded.source, 'builtin');
  }
});

test('legacy executable definitions normalize to the orchestration-role contract', () => {
  const parsed = parseAgentDefinition(JSON.stringify({
    id: 'legacy-role',
    displayName: 'Legacy role',
    whenToUse: 'Use for legacy compatibility verification.',
    prompt: 'Complete the bounded delegated task.',
    model: null,
    effort: null,
    defaultAccess: 'read',
    toolScope: { local: [], mcp: [] },
    disallowedTools: [],
    maxIterations: 10,
    timeoutMs: 30_000,
    maxResultChars: 2_000,
    subagents: [],
    delegateName: 'delegate_legacy_role',
    tier: 'worker',
    outputContract: null,
  }), 'legacy-role');

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.kind, 'orchestration-role');
});

test('executable definitions reject persona-only, unknown, and wrong discriminator fields', () => {
  const valid = {
    ...ORCHESTRATION_ROLE_HEADER,
    id: 'bounded-role',
    displayName: 'Bounded role',
    whenToUse: 'Use for a bounded task.',
    prompt: 'Complete the bounded task.',
    model: null,
    effort: null,
    defaultAccess: 'read',
    toolScope: { local: [], mcp: [] },
    disallowedTools: [],
    maxIterations: 10,
    timeoutMs: 30_000,
    maxResultChars: 2_000,
    subagents: [],
    delegateName: 'delegate_bounded_role',
    tier: 'worker',
    outputContract: null,
  };

  assert.throws(
    () => parseAgentDefinition(JSON.stringify({ ...valid, instructions: ['Act as a persona.'] }), 'bounded-role'),
    /persona-only fields: instructions/,
  );
  assert.throws(
    () => parseAgentDefinition(JSON.stringify({ ...valid, arbitraryPolicy: true }), 'bounded-role'),
    /unknown fields: arbitraryPolicy/,
  );
  assert.throws(
    () => parseAgentDefinition(JSON.stringify({ ...valid, kind: 'persona' }), 'bounded-role'),
    /kind must be "orchestration-role"/,
  );
  assert.throws(
    () => parseAgentDefinition(JSON.stringify({ ...valid, schemaVersion: 2 }), 'bounded-role'),
    /schemaVersion must be 1/,
  );
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
      ...ORCHESTRATION_ROLE_HEADER,
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
      ...ORCHESTRATION_ROLE_HEADER,
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
      ...ORCHESTRATION_ROLE_HEADER,
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
      ...ORCHESTRATION_ROLE_HEADER,
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
      ...ORCHESTRATION_ROLE_HEADER,
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

test('W4b active registry is exactly the raw registry when no manifest exists', () => {
  withTempWorkspace((workspace) => {
    writeAgentDefinition(workspace, 'legacy-visible');

    assert.deepEqual(loadActiveRegistry(workspace), loadRegistry(workspace));
    assert.deepEqual(listAll(workspace), loadRegistry(workspace));
    assert.equal(findById('legacy-visible', workspace)?.source, 'workspace');
  });
});

test('manifest orchestration exposes only explicitly available custom roles', () => {
  withTempWorkspace((workspace) => {
    writeAgentDefinition(workspace, 'default-specialist');
    writeAgentDefinition(workspace, 'enabled-specialist');
    writeAgentDefinition(workspace, 'hidden-specialist');
    saveWorkspaceManifest(workspace, createWorkspaceManifest({
      name: 'filtered',
      profile: 'custom',
      by: 'wizard',
      overrides: {
        persona: { default: 'engineer', enabled: ['engineer'] },
        orchestration: {
          mode: 'adaptive',
          availableRoles: ['default-specialist', 'enabled-specialist'],
          disabledRoles: [],
          maxParallel: 2,
        },
      },
    }));

    const rawIds = loadRegistry(workspace).map((entry) => entry.def.id);
    const activeIds = loadActiveRegistry(workspace).map((entry) => entry.def.id);
    assert.ok(rawIds.includes('hidden-specialist'), 'raw inventory remains complete');
    assert.ok(activeIds.includes('default-specialist'), 'available custom role is active');
    assert.ok(activeIds.includes('enabled-specialist'), 'second available custom role is active');
    assert.equal(activeIds.includes('hidden-specialist'), false, 'unlisted custom JSON is not executable');
  });
});

test('manifest orchestration gates reserved roles and preserves an available workspace override', () => {
  withTempWorkspace((workspace) => {
    writeAgentDefinition(workspace, 'explorer', { displayName: 'Project explorer', tier: 'reasoning' });
    saveWorkspaceManifest(workspace, createWorkspaceManifest({
      name: 'harness',
      profile: 'custom',
      by: 'wizard',
      overrides: {
        orchestration: {
          mode: 'adaptive',
          availableRoles: ['explorer'],
          disabledRoles: [],
          maxParallel: 1,
        },
      },
    }));

    const active = loadActiveRegistry(workspace);
    assert.deepEqual(active.map((entry) => entry.def.id), ['explorer']);
    assert.equal(findById('explorer', workspace)?.source, 'workspace');
    assert.equal(findById('explorer', workspace)?.def.displayName, 'Project explorer');
  });
});

test('W4b unreadable manifests preserve exact legacy registry behavior', () => {
  withTempWorkspace((workspace) => {
    writeAgentDefinition(workspace, 'corrupt-fallback');
    fs.writeFileSync(path.join(workspace, '.brainrouter', 'workspace.json'), '{ broken', 'utf8');

    assert.deepEqual(loadActiveRegistry(workspace), loadRegistry(workspace));
    assert.equal(findById('corrupt-fallback', workspace)?.source, 'workspace');
  });
});

test('W4b runtime lookup and delegate tools expose only the active manifest catalog', () => {
  withTempWorkspace((workspace) => {
    writeAgentDefinition(workspace, 'visible-specialist');
    writeAgentDefinition(workspace, 'hidden-specialist');
    saveWorkspaceManifest(workspace, createWorkspaceManifest({
      name: 'runtime',
      profile: 'custom',
      by: 'wizard',
      overrides: {
        orchestration: {
          mode: 'adaptive',
          availableRoles: ['visible-specialist'],
          disabledRoles: [],
          maxParallel: 1,
        },
      },
    }));

    const toolNames = synthesizeDelegateTools(listAll(workspace)).map((tool) => tool.name);
    assert.ok(toolNames.includes('delegate_visible_specialist'));
    assert.equal(toolNames.includes('delegate_hidden_specialist'), false);
    assert.equal(findById('visible-specialist', workspace)?.source, 'workspace');
    assert.equal(findById('hidden-specialist', workspace), undefined);
  });
});

test('selected profile packs never create same-id specialist inventory', () => {
  const cases = [
    { profile: 'research' as const, id: 'researcher' },
    { profile: 'data-science' as const, id: 'data-scientist' },
    { profile: 'study' as const, id: 'tutor' },
    { profile: 'writing' as const, id: 'writer' },
  ];
  const specialistIds = new Set(cases.map(({ id }) => id));

  for (const item of cases) {
    withTempWorkspace((workspace) => {
      saveWorkspaceManifest(workspace, createWorkspaceManifest({
        name: item.profile,
        profile: item.profile,
        by: 'wizard',
      }));

      const rawSpecialists = loadRegistry(workspace)
        .filter((entry) => specialistIds.has(entry.def.id))
        .map((entry) => entry.def.id);
      assert.deepEqual(rawSpecialists, []);
      const active = findById(item.id, workspace);
      assert.equal(active, undefined);
      assert.equal(
        synthesizeDelegateTools(listAll(workspace)).some(
          (tool) => tool.name === `delegate_${item.id.replaceAll('-', '_')}`,
        ),
        false,
      );
    });
  }
});

test('C2 profile personas never become executable orchestration roles', () => {
  const specialistIds = new Set(['researcher', 'data-scientist', 'tutor', 'writer']);
  withTempWorkspace((workspace) => {
    assert.equal(loadRegistry(workspace).some((entry) => specialistIds.has(entry.def.id)), false);

    saveWorkspaceManifest(workspace, createWorkspaceManifest({
      name: 'engineering',
      profile: 'engineering',
      by: 'wizard',
    }));
    assert.equal(loadRegistry(workspace).some((entry) => specialistIds.has(entry.def.id)), false);
    assert.equal(findById('frontend-builder', workspace), undefined);
  });
});

test('C2 selecting a pack does not create executable inventory', () => {
  withTempWorkspace((workspace) => {
    saveWorkspaceManifest(workspace, createWorkspaceManifest({
      name: 'custom research',
      profile: 'custom',
      by: 'wizard',
      overrides: {
        skills: { packs: ['research'], enabled: [], disabled: [] },
      },
    }));

    assert.equal(loadRegistry(workspace).some((entry) => entry.def.id === 'researcher'), false);
    assert.equal(findById('researcher', workspace), undefined);
    assert.equal(
      synthesizeDelegateTools(listAll(workspace)).some((tool) => tool.name === 'delegate_researcher'),
      false,
    );
  });
});
