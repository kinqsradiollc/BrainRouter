import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspaceManifest,
  saveWorkspaceManifest,
} from '@kinqs/brainrouter-core/workspace';
import {
  applyWorkspaceSkillCatalogPolicy,
  listFilesystemSkills,
  resolveWorkspaceSkillCatalogPolicy,
  skillSearchRoots,
} from '../prompt/skillCatalog.js';
import { resolveSkill } from '../prompt/skillRunner.js';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-workspace-skills-'));
}

function writeWorkspaceSkill(workspace: string, name: string): void {
  const root = path.join(workspace, 'skills', name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`);
}

test('missing manifest preserves legacy ambient and explicit search roots', () => {
  const workspace = makeWorkspace();
  try {
    assert.deepEqual(
      skillSearchRoots(workspace, { visibility: 'explicit' }),
      skillSearchRoots(workspace),
    );
    assert.equal(resolveWorkspaceSkillCatalogPolicy(workspace).managed, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('profile manifest contributes selected package skills without exposing other profiles', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'research', profile: 'research', by: 'wizard' }),
    );
    const skills = listFilesystemSkills(workspace);
    const names = new Set(skills.map((skill) => skill.name));
    assert.equal(names.has('evidence-research-skill'), true);
    assert.equal(names.has('source-synthesis-skill'), true);
    assert.equal(names.has('learning-plan-skill'), false);
    assert.equal(names.has('a11y-skill'), false);
    assert.equal(skills.find((skill) => skill.name === 'evidence-research-skill')?.scope, 'plugin');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('frontend package skills activate only for a live engineer frontend task', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
    );
    const backendNames = new Set(
      listFilesystemSkills(workspace, { task: 'Optimize the database transaction.' })
        .map((skill) => skill.name),
    );
    const frontendNames = new Set(
      listFilesystemSkills(workspace, { task: 'Fix the responsive React dashboard.' })
        .map((skill) => skill.name),
    );
    assert.equal(backendNames.has('taste-skill'), false);
    assert.equal(frontendNames.has('taste-skill'), true);
    assert.equal(frontendNames.has('a11y-skill'), true);
    assert.equal(frontendNames.has('browser-testing-skill'), true);
    assert.equal(
      listFilesystemSkills(workspace, { task: 'Fix the responsive React dashboard.' })
        .find((skill) => skill.name === 'a11y-skill')?.scope,
      'plugin',
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('disabled package skill is ambient-hidden but remains explicitly resolvable', async () => {
  const workspace = makeWorkspace();
  try {
    const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
    manifest.skills.disabled = ['a11y-skill'];
    saveWorkspaceManifest(workspace, manifest);

    const names = new Set(
      listFilesystemSkills(workspace, { task: 'Build an accessible responsive UI.' })
        .map((skill) => skill.name),
    );
    assert.equal(names.has('a11y-skill'), false);

    let mcpCalls = 0;
    const mcpClient = {
      callTool: async () => {
        mcpCalls += 1;
        return { content: [{ type: 'text', text: '# Legacy global collision' }] };
      },
    } as any;
    const resolved = await resolveSkill(mcpClient, 'a11y-skill', workspace);
    assert.equal(resolved.source, 'filesystem');
    assert.match(resolved.body, /Accessibility and responsive acceptance/);
    assert.ok(resolved.allowedTools?.includes('read_file'));
    assert.equal(mcpCalls, 0, 'package definition wins before the global MCP collision');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('managed catalog keeps workspace skills and applies the same visibility to MCP rows', () => {
  const workspace = makeWorkspace();
  try {
    writeWorkspaceSkill(workspace, 'project-check');
    const manifest = createWorkspaceManifest({ name: 'study', profile: 'study', by: 'wizard' });
    manifest.skills.disabled = ['hidden-mcp'];
    saveWorkspaceManifest(workspace, manifest);

    assert.equal(
      listFilesystemSkills(workspace).some((skill) => skill.name === 'project-check'),
      true,
    );

    const policy = resolveWorkspaceSkillCatalogPolicy(workspace);
    const filtered = applyWorkspaceSkillCatalogPolicy([
      { name: 'ordinary-mcp' },
      { name: 'hidden-mcp' },
      { name: 'retrieval-practice-skill' },
    ], policy);
    assert.deepEqual(
      filtered.map((skill) => skill.name),
      ['retrieval-practice-skill', 'ordinary-mcp'],
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
