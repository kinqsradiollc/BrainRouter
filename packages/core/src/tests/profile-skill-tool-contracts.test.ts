import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  findWorkspaceProfilePlugin,
  type WorkspaceProfilePluginId,
} from '../workspace/profilePlugins.js';
import { createWorkspaceManifest } from '../workspace/manifest.js';
import { WORKSPACE_PROFILES } from '../workspace/profiles.js';
import { resolveWorkspaceSkillSelection } from '../workspace/skillSelection.js';
import {
  resolveWorkspaceToolSelection,
  workspaceMcpToolAllowed,
  workspaceToolAllowed,
} from '../workspace/toolProfiles.js';

function allowedTools(profileId: WorkspaceProfilePluginId, skillId: string): string[] {
  const profile = findWorkspaceProfilePlugin(profileId);
  assert.ok(profile);
  const body = fs.readFileSync(path.join(profile.skillsRoot, skillId, 'SKILL.md'), 'utf8');
  const flow = body.match(/^allowed-tools:\s*\[([^\]]*)\]$/m)?.[1];
  assert.notEqual(flow, undefined, `${skillId} must declare a bounded allowed-tools list`);
  return flow!.split(',').map((value) => value.trim()).filter(Boolean);
}

test('folder-backed Study and Writing skills discover inputs while producing skills persist deliverables', () => {
  const study = findWorkspaceProfilePlugin('study');
  const writing = findWorkspaceProfilePlugin('writing');
  assert.ok(study);
  assert.ok(writing);

  for (const skillId of [...study.skillIds, ...writing.skillIds]) {
    const profileId = study.skillIds.includes(skillId) ? 'study' : 'writing';
    assert.ok(allowedTools(profileId, skillId).includes('list_dir'), `${skillId}: workspace discovery`);
  }
  for (const skillId of study.skillIds.filter((id) =>
    !['learner-diagnostic-skill', 'learning-source-skill'].includes(id))) {
    assert.ok(allowedTools('study', skillId).includes('artifact_write'), `${skillId}: learning artifact`);
  }
  for (const skillId of writing.skillIds.filter((id) => id !== 'writing-critique-skill')) {
    assert.ok(allowedTools('writing', skillId).includes('artifact_write'), `${skillId}: writing artifact`);
  }
  for (const [profileId, skillId] of [
    ['study', 'learning-source-skill'],
    ['writing', 'writing-critique-skill'],
  ] as const) {
    assert.equal(
      allowedTools(profileId, skillId).includes('artifact_write'),
      false,
      `${skillId}: read-only delegated skill`,
    );
  }
});

test('Data Science skills retain notebook, language, shell, and artifact tools when stacked', () => {
  const data = findWorkspaceProfilePlugin('data');
  assert.ok(data);
  const required = [
    'list_dir',
    'notebook_edit',
    'lsp',
    'run_command',
    'artifact_write',
  ];
  for (const skillId of data.skillIds) {
    const tools = allowedTools('data', skillId);
    for (const tool of required) {
      assert.ok(tools.includes(tool), `${skillId}: ${tool}`);
    }
  }
});

test('every built-in profile has an explicit folder, workflow, and production tool contract', () => {
  const expectedGroups = {
    engineering: [
      'coding', 'shell', 'browser', 'project-knowledge', 'memory-context',
      'artifacts', 'planning-session', 'orchestration',
      'pull-request-observation',
    ],
    research: [
      'workspace-files', 'browser', 'research-browser', 'project-knowledge',
      'memory-context', 'research-notes', 'artifacts', 'planning-session',
      'orchestration',
    ],
    'data-science': [
      'coding', 'shell', 'browser', 'project-knowledge', 'memory-context',
      'research-notes', 'artifacts', 'planning-session', 'orchestration',
    ],
    study: [
      'workspace-files', 'browser', 'project-knowledge', 'memory-context',
      'research-notes', 'artifacts', 'planning-session', 'orchestration',
    ],
    writing: [
      'workspace-files', 'browser', 'project-knowledge', 'memory-context',
      'research-notes', 'artifacts', 'planning-session', 'orchestration',
    ],
    'product-management': [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser', 'orchestration',
    ],
    design: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser', 'artifacts',
    ],
    education: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser',
    ],
    marketing: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser',
    ],
    sales: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser',
    ],
    operations: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser', 'orchestration',
    ],
    finance: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser',
    ],
    legal: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser',
    ],
    people: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser',
    ],
    healthcare: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser',
    ],
    consulting: [
      'workspace-files', 'project-knowledge', 'memory-context', 'artifacts', 'planning-session', 'browser', 'orchestration',
    ],
    custom: [],
  } as const;

  for (const profile of WORKSPACE_PROFILES) {
    assert.deepEqual(profile.tools.profiles, expectedGroups[profile.id], profile.id);
    const manifest = createWorkspaceManifest({
      name: profile.id,
      profile: profile.id,
      by: 'wizard',
    });
    manifest.version = 3;
    manifest.tools.mode = 'explicit-catalog';
    const tools = resolveWorkspaceToolSelection({ manifest });

    if (profile.id === 'custom') {
      assert.equal(tools.activeProfileIds.length, 0);
      continue;
    }
    for (const toolId of ['read_file', 'list_dir', 'grep_search', 'glob_files']) {
      assert.equal(
        workspaceToolAllowed(tools, { toolId }),
        true,
        `${profile.id}: folder discovery ${toolId}`,
      );
    }
    assert.equal(
      workspaceToolAllowed(tools, { toolId: 'artifact_write' }),
      true,
      `${profile.id}: artifact production`,
    );
    assert.equal(
      workspaceToolAllowed(tools, { toolId: 'update_plan' }),
      true,
      `${profile.id}: planning`,
    );
  }
});

test('every default profile-plugin skill can execute its declared tools under the profile ceiling', () => {
  const pluginByProfile = {
    research: 'research',
    'data-science': 'data',
    study: 'study',
    writing: 'writing',
  } as const;

  for (const [profileId, pluginId] of Object.entries(pluginByProfile) as Array<
    [keyof typeof pluginByProfile, WorkspaceProfilePluginId]
  >) {
    const manifest = createWorkspaceManifest({
      name: profileId,
      profile: profileId,
      by: 'wizard',
    });
    manifest.version = 3;
    manifest.tools.mode = 'explicit-catalog';
    const toolSelection = resolveWorkspaceToolSelection({ manifest });
    const skillSelection = resolveWorkspaceSkillSelection({ manifest });
    const plugin = findWorkspaceProfilePlugin(pluginId);
    assert.ok(plugin);
    assert.deepEqual(
      skillSelection.ambientSkillIds.filter((id) => plugin.skillIds.includes(id)),
      [...plugin.skillIds],
      `${profileId}: every profile skill is active`,
    );

    for (const skillId of plugin.skillIds) {
      for (const toolId of allowedTools(pluginId, skillId)) {
        const permitted = isBrainRouterMcpTool(toolId)
          ? workspaceMcpToolAllowed(toolSelection, {
              toolId,
              brainrouterOwned: true,
            })
          : workspaceToolAllowed(toolSelection, { toolId });
        assert.equal(permitted, true, `${profileId}/${skillId}: ${toolId}`);
      }
    }
  }
});

function isBrainRouterMcpTool(toolId: string): boolean {
  return toolId.startsWith('knowledge_')
    || toolId.startsWith('memory_')
    || ['list_skills', 'get_skill', 'search_skills'].includes(toolId);
}
