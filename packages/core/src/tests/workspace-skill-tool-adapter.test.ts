import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBundledOrchestrationProfiles } from '../orchestration/profiles/orchestrationProfileCatalog.js';
import { createWorkspaceManifest, saveWorkspaceManifest } from '../workspace/manifest.js';
import { isWorkspaceProfileId } from '../workspace/profiles.js';
import {
  adaptWorkspaceSkillCatalogText,
  resolveBundledWorkspaceSkill,
  resolveWorkspaceManagedSkill,
} from '../workspace/skillToolAdapter.js';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-skill-tools-'));
}

function names(text: string): string[] {
  return (JSON.parse(text) as Array<{ name: string }>).map((entry) => entry.name);
}

test('missing manifest preserves MCP catalog text and package lookup exactly', () => {
  const workspace = makeWorkspace();
  try {
    const text = '[{"name":"taste-skill","scope":"global"}]';
    assert.equal(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text,
      tool: 'list_skills',
    }), text);
    assert.equal(resolveWorkspaceManagedSkill(workspace, 'taste-skill', 'full'), undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('bundled workflow fallback works offline without shadowing a workspace skill', () => {
  const workspace = makeWorkspace();
  try {
    const bundled = resolveBundledWorkspaceSkill(workspace, 'shipping-skill', 'full');
    assert.equal(bundled?.metadata.scope, 'bundled');
    assert.match(bundled?.content[0].text ?? '', /# Shipping and Launch/);

    const local = path.join(workspace, 'skills', 'shipping-skill');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(
      path.join(local, 'SKILL.md'),
      '---\nname: shipping-skill\ndescription: Local override.\n---\n\n## Workflow\n\nUse the local workflow.\n',
      'utf8',
    );
    assert.equal(
      resolveBundledWorkspaceSkill(workspace, 'shipping-skill', 'full'),
      undefined,
      'workspace-authored skill remains the higher-precedence source',
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('every built-in primary-stage skill has a package-local activation path', () => {
  const workspace = makeWorkspace();
  try {
    for (const profile of loadBundledOrchestrationProfiles()) {
      assert.equal(isWorkspaceProfileId(profile.id), true, profile.id);
      if (!isWorkspaceProfileId(profile.id)) continue;
      saveWorkspaceManifest(
        workspace,
        createWorkspaceManifest({
          name: profile.id,
          profile: profile.id,
          by: 'wizard',
        }),
      );
      for (const strategy of profile.strategies) {
        for (const stage of strategy.stages) {
          if (stage.executor.kind !== 'primary') continue;
          for (const skillId of stage.skillIds) {
            const resolved =
              resolveWorkspaceManagedSkill(workspace, skillId, 'full')
              ?? resolveBundledWorkspaceSkill(workspace, skillId, 'full');
            assert.ok(
              resolved?.content[0].text.trim(),
              `${profile.id}/${strategy.id}/${stage.id}: ${skillId} is not locally activatable`,
            );
          }
        }
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('selected profile skills lead the managed catalog and replace global collisions', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'study', profile: 'study', by: 'wizard' }),
    );
    const adapted = adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: JSON.stringify([
        { name: 'ordinary-skill', category: 'agent', scope: 'global' },
        { name: 'retrieval-practice-skill', description: 'legacy copy', category: 'legacy', scope: 'global' },
        { name: 'taste-skill', category: 'design', scope: 'global' },
      ]),
      tool: 'list_skills',
    });
    const entries = JSON.parse(adapted) as Array<Record<string, unknown>>;
    assert.deepEqual(names(adapted), [
      'learner-diagnostic-skill',
      'learning-plan-skill',
      'tutoring-explanation-skill',
      'learning-assessment-skill',
      'error-remediation-skill',
      'retrieval-practice-skill',
      'learning-source-skill',
      'ordinary-skill',
    ]);
    assert.equal(entries[5].scope, 'plugin');
    assert.equal(entries[5].category, 'study');
    assert.notEqual(entries[5].description, 'legacy copy');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('frontend package skills appear only for the active task capability', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
    );
    const remote = JSON.stringify([
      { name: 'taste-skill', category: 'design', scope: 'global' },
      { name: 'ordinary-skill', category: 'agent', scope: 'global' },
    ]);
    const inactive = adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: remote,
      tool: 'list_skills',
    });
    const active = adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      activeCapabilities: ['frontend'],
      text: remote,
      tool: 'list_skills',
    });
    assert.deepEqual(names(inactive), ['ordinary-skill']);
    assert.deepEqual(names(active), [
      'a11y-skill',
      'browser-testing-skill',
      'taste-skill',
      'ordinary-skill',
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('backend package skills appear only for the active task capability', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'service', profile: 'engineering', by: 'wizard' }),
    );
    const remote = JSON.stringify([
      { name: 'api-service-design-skill', category: 'legacy', scope: 'global' },
      { name: 'ordinary-skill', category: 'agent', scope: 'global' },
    ]);
    const inactive = adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: remote,
      tool: 'list_skills',
    });
    const active = adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      activeCapabilities: ['backend'],
      text: remote,
      tool: 'list_skills',
    });

    assert.deepEqual(names(inactive), ['ordinary-skill']);
    assert.deepEqual(names(active), [
      'api-service-design-skill',
      'authorization-boundary-skill',
      'data-integrity-migration-skill',
      'background-work-skill',
      'production-readiness-skill',
      'backend-testing-skill',
      'ordinary-skill',
    ]);
    const explicit = resolveWorkspaceManagedSkill(workspace, 'authorization-boundary-skill', 'workflow');
    assert.match(explicit?.content[0].text ?? '', /Map trust boundaries from ingress to side effect/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('academic-paper skills appear only for an active reviewed Writing capability', () => {
  const workspace = makeWorkspace();
  try {
    const manifest = createWorkspaceManifest({ name: 'paper', profile: 'writing', by: 'wizard' });
    manifest.capabilities.enabled.push('academic-paper');
    saveWorkspaceManifest(workspace, manifest);
    const remote = JSON.stringify([
      { name: 'academic-paper-drafting-skill', category: 'legacy', scope: 'global' },
      { name: 'ordinary-skill', category: 'agent', scope: 'global' },
    ]);
    assert.deepEqual(names(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: remote,
      tool: 'list_skills',
    })), [
      'structured-writing-skill',
      'revision-skill',
      'writing-critique-skill',
      'ordinary-skill',
    ]);

    assert.deepEqual(names(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      activeCapabilities: ['academic-paper'],
      text: remote,
      tool: 'list_skills',
    })), [
      'structured-writing-skill',
      'revision-skill',
      'writing-critique-skill',
      'source-synthesis-skill',
      'citation-verification-skill',
      'academic-paper-drafting-skill',
      'academic-paper-review-skill',
      'ordinary-skill',
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('computational-research skills activate for a reviewed Research capability', () => {
  const workspace = makeWorkspace();
  try {
    const manifest = createWorkspaceManifest({ name: 'study', profile: 'research', by: 'wizard' });
    manifest.capabilities.enabled.push('computational-research');
    saveWorkspaceManifest(workspace, manifest);
    const remote = JSON.stringify([
      { name: 'data-analysis-skill', category: 'legacy', scope: 'global' },
      { name: 'ordinary-skill', category: 'agent', scope: 'global' },
    ]);
    assert.equal(names(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: remote,
      tool: 'list_skills',
    })).includes('data-analysis-skill'), false);

    const active = names(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      activeCapabilities: ['computational-research'],
      text: remote,
      tool: 'list_skills',
    }));
    assert.ok(active.includes('data-analysis-skill'));
    assert.ok(active.includes('experiment-validation-skill'));
    assert.ok(active.includes('ordinary-skill'));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('data-visualization skill appears only for an active reviewed Data Science capability', () => {
  const workspace = makeWorkspace();
  try {
    const manifest = createWorkspaceManifest({
      name: 'visual-analysis',
      profile: 'data-science',
      by: 'wizard',
    });
    manifest.capabilities.enabled.push('data-visualization');
    saveWorkspaceManifest(workspace, manifest);
    const remote = JSON.stringify([
      { name: 'data-visualization-skill', category: 'legacy', scope: 'global' },
      { name: 'ordinary-skill', category: 'agent', scope: 'global' },
    ]);
    assert.equal(names(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: remote,
      tool: 'list_skills',
    })).includes('data-visualization-skill'), false);

    const active = names(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      activeCapabilities: ['data-visualization'],
      text: remote,
      tool: 'list_skills',
    }));
    assert.ok(active.includes('data-visualization-skill'));
    assert.ok(active.includes('ordinary-skill'));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('programming-lab skill appears only for an active reviewed Study capability', () => {
  const workspace = makeWorkspace();
  try {
    const manifest = createWorkspaceManifest({
      name: 'coding-course',
      profile: 'study',
      by: 'wizard',
    });
    manifest.capabilities.enabled.push('programming-lab');
    saveWorkspaceManifest(workspace, manifest);
    const remote = JSON.stringify([
      { name: 'programming-lab-skill', category: 'legacy', scope: 'global' },
      { name: 'ordinary-skill', category: 'agent', scope: 'global' },
    ]);
    assert.equal(names(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: remote,
      tool: 'list_skills',
    })).includes('programming-lab-skill'), false);

    const active = names(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      activeCapabilities: ['programming-lab'],
      text: remote,
      tool: 'list_skills',
    }));
    assert.ok(active.includes('programming-lab-skill'));
    assert.ok(active.includes('ordinary-skill'));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('disabled package skills stay ambient-hidden but explicit reads use package policy', () => {
  const workspace = makeWorkspace();
  try {
    const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
    manifest.skills.disabled = ['a11y-skill'];
    saveWorkspaceManifest(workspace, manifest);

    const adapted = adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      activeCapabilities: ['frontend'],
      text: JSON.stringify([{ name: 'a11y-skill', scope: 'global' }]),
      tool: 'list_skills',
    });
    assert.equal(names(adapted).includes('a11y-skill'), false);

    const full = resolveWorkspaceManagedSkill(workspace, 'a11y-skill', 'full');
    assert.ok(full);
    assert.equal(full.metadata.scope, 'plugin');
    assert.match(full.content[0].text, /^---\nname: a11y-skill/m);
    assert.match(full.content[0].text, /allowed-tools:/);
    const workflow = resolveWorkspaceManagedSkill(workspace, 'a11y-skill', 'workflow');
    assert.match(workflow?.content[0].text ?? '', /^## Workflow/m);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('workspace-authored same-name skill keeps explicit lookup precedence', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
    );
    const skillDir = path.join(workspace, 'skills', 'custom-accessibility');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: a11y-skill\ndescription: workspace override\n---\n# Local\n',
    );
    assert.equal(resolveWorkspaceManagedSkill(workspace, 'a11y-skill', 'full'), undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('symlinked workspace skill roots cannot shadow package skills', () => {
  const workspace = makeWorkspace();
  const outside = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
    );
    const skillDir = path.join(outside, 'custom-accessibility');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: a11y-skill\ndescription: outside override\n---\n# Outside\n',
    );
    fs.symlinkSync(outside, path.join(workspace, 'skills'));

    const resolved = resolveWorkspaceManagedSkill(workspace, 'a11y-skill', 'full');
    assert.ok(resolved);
    assert.doesNotMatch(resolved.content[0].text, /outside override/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('managed catalog leaves malformed MCP payloads untouched', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'study', profile: 'study', by: 'wizard' }),
    );
    const text = '{not-json';
    assert.equal(adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text,
      tool: 'list_skills',
    }), text);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('search applies query and scope to selected package additions', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'research', profile: 'research', by: 'wizard' }),
    );
    const global = adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: '[]',
      tool: 'search_skills',
      args: { query: 'evidence', scope: 'global' },
    });
    const local = adaptWorkspaceSkillCatalogText({
      workspaceRoot: workspace,
      text: '[]',
      tool: 'search_skills',
      args: { query: 'evidence', scope: 'local' },
    });
    assert.deepEqual(names(global), [
      'research-question-skill',
      'iterative-evidence-skill',
      'evidence-research-skill',
      'research-review-skill',
      'academic-paper-drafting-skill',
    ]);
    assert.deepEqual(names(local), []);
    const entries = JSON.parse(global) as Array<Record<string, unknown>>;
    assert.equal(entries.find((entry) => entry.name === 'evidence-research-skill')?.relevance, 'name match');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('research workflow bodies load independently for the current task', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'research', profile: 'research', by: 'wizard' }),
    );

    const question = resolveWorkspaceManagedSkill(workspace, 'research-question-skill', 'workflow');
    assert.match(question?.content[0].text ?? '', /Express one primary question/);
    assert.doesNotMatch(question?.content[0].text ?? '', /Enumerate every citation anchor/);
    assert.deepEqual(question?.metadata.allowedTools, ['read_file', 'list_dir', 'grep_search', 'glob_files']);
    assert.deepEqual(question?.metadata.disallowedTools, []);

    const iterative = resolveWorkspaceManagedSkill(workspace, 'iterative-evidence-skill', 'workflow');
    assert.match(iterative?.content[0].text ?? '', /no more than three cycles/);
    assert.match(iterative?.content[0].text ?? '', /knowledge_list/);
    assert.match(iterative?.content[0].text ?? '', /do not grant Project Knowledge access to explorer children/);

    const citation = resolveWorkspaceManagedSkill(workspace, 'citation-verification-skill', 'workflow');
    assert.match(citation?.content[0].text ?? '', /Enumerate every citation anchor/);
    assert.doesNotMatch(citation?.content[0].text ?? '', /Cluster claims by sub-question/);

    const review = resolveWorkspaceManagedSkill(workspace, 'research-review-skill', 'workflow');
    assert.match(review?.content[0].text ?? '', /Classify findings as blocking/);
    assert.doesNotMatch(review?.content[0].text ?? '', /Retrieve small result sets/);

    const drafting = resolveWorkspaceManagedSkill(
      workspace,
      'academic-paper-drafting-skill',
      'workflow',
    );
    assert.match(drafting?.content[0].text ?? '', /Create a claim-evidence map/);
    assert.match(drafting?.content[0].text ?? '', /Reverse-outline the draft/);

    const paperReview = resolveWorkspaceManagedSkill(
      workspace,
      'academic-paper-review-skill',
      'workflow',
    );
    assert.match(paperReview?.content[0].text ?? '', /Classify at most ten findings/);
    assert.match(paperReview?.content[0].text ?? '', /Blocking:/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('tutoring workflow bodies load independently for the current task', () => {
  const workspace = makeWorkspace();
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'study', profile: 'study', by: 'wizard' }),
    );

    const diagnostic = resolveWorkspaceManagedSkill(workspace, 'learner-diagnostic-skill', 'workflow');
    assert.match(diagnostic?.content[0].text ?? '', /Give one or two low-stakes diagnostic tasks/);
    assert.doesNotMatch(diagnostic?.content[0].text ?? '', /Apply the smallest correction/);

    const assessment = resolveWorkspaceManagedSkill(workspace, 'learning-assessment-skill', 'workflow');
    assert.match(assessment?.content[0].text ?? '', /Choose evidence appropriate to type/);
    assert.doesNotMatch(assessment?.content[0].text ?? '', /Present one coherent model/);

    const remediation = resolveWorkspaceManagedSkill(workspace, 'error-remediation-skill', 'workflow');
    assert.match(remediation?.content[0].text ?? '', /Apply the smallest correction/);
    assert.doesNotMatch(remediation?.content[0].text ?? '', /schedule the next prerequisite-valid objective/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
