import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Config } from '../config/configTypes.js';
import { findResolvedOrchestrationProfile } from '../orchestration/profiles/orchestrationProfileSources.js';
import {
  buildWorkspaceOnboardingPreview,
  buildWorkspaceOnboardingSources,
} from '../workspace/index.js';
import { createWorkspaceManifest } from '../workspace/manifest.js';

function config(enabled: boolean): Config {
  return {
    activeServer: '',
    servers: {},
    cli: { plugins: { enabled: { 'fixture-kit': enabled } } },
  };
}

function writeFixturePlugin(workspaceRoot: string): void {
  const root = path.join(workspaceRoot, '.brainrouter', 'plugins', 'fixture-kit');
  fs.mkdirSync(path.join(root, '.brainrouter-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.brainrouter-plugin', 'plugin.json'), JSON.stringify({
    name: 'fixture-kit',
    version: '1.0.0',
  }));
  fs.mkdirSync(path.join(root, 'skills', 'fixture-review'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'fixture-review', 'SKILL.md'), [
    '---',
    'name: fixture-review',
    'label: Fixture review',
    'description: Review fixture output.',
    'category: review',
    '---',
    '# Fixture review',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'skills', 'planning-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'planning-skill', 'SKILL.md'), [
    '---',
    'name: planning-skill',
    'description: Enabled plugin override.',
    '---',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'orchestration-profiles'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'orchestration-profiles', 'custom.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'orchestration-profile',
      id: 'custom',
      displayName: 'Fixture custom orchestration',
      defaultMode: 'off',
      fallbackStrategyId: 'direct',
      rolePolicy: { availableRoles: [], disabledRoles: [] },
      limits: {
        maxParallel: 1,
        maxStages: 1,
        maxChildrenPerStage: 1,
        maxTotalChildren: 1,
        maxDepth: 1,
        maxRetries: 0,
      },
      strategies: [{
        id: 'direct',
        description: 'Keep fallback independent from contributed skills.',
        activation: { signals: ['small-scope'], explicitOnly: false },
        stages: [{
          id: 'complete',
          executor: { kind: 'primary' },
          after: [],
          objective: 'Complete the task.',
          skillIds: [],
          optional: false,
        }],
      }, {
        id: 'plugin-review',
        description: 'Use the enabled plugin skill on the primary agent.',
        activation: { signals: ['review'], explicitOnly: true },
        stages: [{
          id: 'review',
          executor: { kind: 'primary' },
          after: [],
          objective: 'Review the task.',
          skillIds: ['fixture-review'],
          optional: false,
        }],
      }],
    }),
  );
}

function writeWorkspaceRole(workspaceRoot: string): void {
  const directory = path.join(workspaceRoot, '.brainrouter', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'specialist.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'orchestration-role',
    id: 'specialist',
    displayName: 'Workspace specialist',
    whenToUse: 'Handles one workspace-specific bounded task.',
    prompt: 'PRIVATE ROLE PROMPT MUST NOT ENTER THE ONBOARDING CATALOG.',
    model: null,
    effort: null,
    defaultAccess: 'read',
    toolScope: { local: ['read_file'], mcp: [] },
    disallowedTools: [],
    maxIterations: 8,
    timeoutMs: 30_000,
    maxResultChars: 4_000,
    subagents: [],
    delegateName: 'delegate_specialist',
    tier: 'reasoning',
    outputContract: null,
  }));
}

test('P23-9 onboarding sources align enabled plugin skill provenance and plan references', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboarding-sources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixturePlugin(root);

  const disabled = buildWorkspaceOnboardingSources(root, config(false));
  const disabledSkill = disabled.catalog.entries.find((entry) => entry.id === 'fixture-review');
  assert.equal(disabledSkill?.source, 'plugin');
  assert.equal(disabledSkill?.provenance, 'fixture-kit');
  assert.equal(disabledSkill?.selectable, false);
  assert.match(disabledSkill?.blockedReason ?? '', /disabled/i);
  assert.equal(
    disabled.catalog.entries.find((entry) => entry.id === 'planning-skill')?.source,
    'bundled',
  );
  assert.equal(
    findResolvedOrchestrationProfile(disabled.orchestrationProfiles, 'custom')?.source.kind,
    'bundled',
  );

  const enabled = buildWorkspaceOnboardingSources(root, config(true));
  const enabledSkill = enabled.catalog.entries.find((entry) => entry.id === 'fixture-review');
  assert.equal(enabledSkill?.source, 'plugin');
  assert.equal(enabledSkill?.provenance, 'fixture-kit');
  assert.equal(enabledSkill?.selectable, true);
  assert.equal(
    enabled.catalog.entries.find((entry) => entry.id === 'planning-skill')?.source,
    'plugin',
  );
  const plan = findResolvedOrchestrationProfile(enabled.orchestrationProfiles, 'custom');
  assert.ok(plan, JSON.stringify(enabled.orchestrationProfiles.diagnostics));
  assert.equal(plan?.source.provenance, 'plugin:fixture-kit');
  assert.deepEqual(plan?.definition.strategies[1]?.stages[0]?.skillIds, ['fixture-review']);

  const preview = buildWorkspaceOnboardingPreview(
    createWorkspaceManifest({ name: 'fixture', profile: 'custom', by: 'wizard' }),
    enabled.catalog,
    enabled.orchestrationProfiles,
  );
  assert.deepEqual(preview.plan?.source, {
    kind: 'plugin',
    provenance: 'plugin:fixture-kit',
  });
  assert.equal(preview.plan?.displayName, 'Fixture custom orchestration');
});

test('P23-9 contributed skill roots reject linked skill directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboarding-linked-skill-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboarding-linked-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  writeFixturePlugin(root);
  fs.mkdirSync(path.join(outside, 'linked-skill'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'linked-skill', 'SKILL.md'), [
    '---',
    'name: linked-skill',
    'description: Must stay outside.',
    '---',
  ].join('\n'));
  fs.symlinkSync(
    path.join(outside, 'linked-skill'),
    path.join(root, '.brainrouter', 'plugins', 'fixture-kit', 'skills', 'linked-skill'),
  );

  const sources = buildWorkspaceOnboardingSources(root, config(true));
  assert.equal(sources.catalog.entries.some((entry) => entry.id === 'linked-skill'), false);
});

test('P23-9 onboarding sources expose workspace roles without their executable prompts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboarding-role-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeWorkspaceRole(root);

  const sources = buildWorkspaceOnboardingSources(root);
  const specialist = sources.catalog.entries.find(
    (entry) => entry.kind === 'role' && entry.id === 'specialist',
  );
  assert.equal(specialist?.label, 'Workspace specialist');
  assert.equal(specialist?.source, 'workspace');
  assert.equal(specialist?.provenance, 'workspace-local');
  assert.doesNotMatch(JSON.stringify(sources.catalog), /PRIVATE ROLE PROMPT/);
});
