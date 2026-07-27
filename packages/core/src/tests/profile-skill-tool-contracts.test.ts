import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  findWorkspaceProfilePlugin,
  type WorkspaceProfilePluginId,
} from '../workspace/profilePlugins.js';

function allowedTools(profileId: WorkspaceProfilePluginId, skillId: string): string[] {
  const profile = findWorkspaceProfilePlugin(profileId);
  assert.ok(profile);
  const body = fs.readFileSync(path.join(profile.skillsRoot, skillId, 'SKILL.md'), 'utf8');
  const flow = body.match(/^allowed-tools:\s*\[([^\]]*)\]$/m)?.[1];
  assert.notEqual(flow, undefined, `${skillId} must declare a bounded allowed-tools list`);
  return flow!.split(',').map((value) => value.trim()).filter(Boolean);
}

test('folder-backed Study and Writing skills can discover inputs and persist deliverables', () => {
  const study = findWorkspaceProfilePlugin('study');
  const writing = findWorkspaceProfilePlugin('writing');
  assert.ok(study);
  assert.ok(writing);

  for (const skillId of [...study.skillIds, ...writing.skillIds]) {
    const profileId = study.skillIds.includes(skillId) ? 'study' : 'writing';
    assert.ok(allowedTools(profileId, skillId).includes('list_dir'), `${skillId}: workspace discovery`);
  }
  for (const skillId of study.skillIds.filter((id) => id !== 'learner-diagnostic-skill')) {
    assert.ok(allowedTools('study', skillId).includes('artifact_write'), `${skillId}: learning artifact`);
  }
  for (const skillId of writing.skillIds) {
    assert.ok(allowedTools('writing', skillId).includes('artifact_write'), `${skillId}: writing artifact`);
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
