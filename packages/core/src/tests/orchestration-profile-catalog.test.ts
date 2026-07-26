/**
 * P23-2 parity tests for bundled orchestration-profile assets.
 *
 * The physical package catalog, strict parser output, workspace profile preset,
 * and package publish allowlist must agree exactly before runtime activation is
 * allowed to depend on these files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundledOrchestrationProfileReferences,
  findBundledOrchestrationProfile,
  loadBundledOrchestrationProfiles,
} from '../orchestration/profiles/orchestrationProfileCatalog.js';
import { getWorkspaceProfile } from '../workspace/profiles.js';
import { WORKSPACE_PROFILE_PLUGIN_DEFINITIONS } from '../workspace/profilePlugins.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROFILES_DIR = path.join(PACKAGE_ROOT, 'orchestration-profiles');

test('P23-2 bundled orchestration profile files and parsed ids have exact parity', () => {
  const files = fs.readdirSync(PROFILES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const profiles = loadBundledOrchestrationProfiles();

  assert.deepEqual(files, [
    'data-science.json',
    'engineering.json',
    'research.json',
  ]);
  assert.deepEqual(profiles.map((profile) => `${profile.id}.json`), files);
  assert.equal(profiles.every((profile) => profile.kind === 'orchestration-profile'), true);
});

test('P23-2 bundled reference catalog is derived from physical role and skill assets', () => {
  const references = bundledOrchestrationProfileReferences();

  assert.deepEqual([...references.roles.keys()].sort(), [
    'architect',
    'explorer',
    'fleet',
    'intake',
    'reviewer',
    'verifier',
    'worker',
  ]);
  const coreSkillIds = [
    'adr-skill',
    'bootstrap-skill',
    'changelog-generator',
    'code-review-and-quality',
    'conventions-skill',
    'debugging-and-error-recovery',
    'handover-skill',
    'incremental-skill',
    'planning-skill',
    'shipping-skill',
    'spec-driven-skill',
    'testing-skill',
    'verify-loop',
  ];
  const profileSkillIds = WORKSPACE_PROFILE_PLUGIN_DEFINITIONS
    .flatMap((plugin) => [...plugin.skillIds])
    .sort();
  assert.deepEqual(
    [...references.skillIds].sort(),
    [...coreSkillIds, ...profileSkillIds].sort(),
  );
  assert.deepEqual(
    [...references.roles.values()]
      .flatMap((role) => role.outputContract?.id ?? [])
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .sort(),
    [
      'architect',
      'explorer',
      'reviewer',
      'verifier',
      'worker',
    ],
  );
  assert.deepEqual(
    [...(references.roles.get('explorer')?.outputContract?.sectionAliases ?? [])],
    ['headline', 'files-read', 'facts', 'open-questions', 'next-probe'],
  );
  assert.equal(references.roles.get('worker')?.defaultAccess, 'write');
  assert.equal(references.roles.get('intake')?.outputContract, null);
});

test('P23-2 Engineering plan preserves profile ceilings and expected strategy surface', () => {
  const preset = getWorkspaceProfile('engineering');
  const plan = findBundledOrchestrationProfile('engineering');
  assert.ok(preset);
  assert.ok(plan);

  assert.equal(plan.defaultMode, preset.orchestration.mode);
  assert.equal(plan.fallbackStrategyId, 'direct');
  assert.deepEqual(plan.rolePolicy.availableRoles, preset.orchestration.availableRoles);
  assert.deepEqual(plan.rolePolicy.disabledRoles, preset.orchestration.disabledRoles);
  assert.equal(plan.limits.maxParallel, preset.orchestration.maxParallel);
  assert.deepEqual(plan.strategies.map((strategy) => strategy.id), [
    'direct',
    'investigate',
    'design',
    'delivery',
    'review-only',
  ]);

  const direct = plan.strategies.find((strategy) => strategy.id === 'direct');
  assert.deepEqual(direct?.stages.map((stage) => stage.executor.kind), ['primary']);

  const delivery = plan.strategies.find((strategy) => strategy.id === 'delivery');
  assert.deepEqual(
    delivery?.stages.map((stage) => [stage.id, stage.executor.kind]),
    [
      ['inspect', 'role'],
      ['implement', 'role'],
      ['review', 'role'],
      ['verify', 'role'],
      ['deliver', 'primary'],
    ],
  );
  const mismatchedContracts = plan.strategies.flatMap((strategy) =>
    strategy.stages.flatMap((stage) =>
      stage.executor.kind === 'role' && stage.expectedOutput?.contractId !== stage.executor.roleId
        ? [`${strategy.id}/${stage.id}`]
        : []));
  assert.deepEqual(mismatchedContracts, []);
  const implementation = delivery?.stages.find((stage) => stage.id === 'implement');
  assert.equal(implementation?.fanOut?.max, 1);
});

test('P23-2 package publish allowlist includes orchestration-profile assets', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as { files?: string[] };
  assert.equal(packageJson.files?.includes('orchestration-profiles'), true);
});

test('P23-2/P23-5 packed core archive contains every bundled plan at the loader path', () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-core-pack-'));
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = spawnSync(
      npm,
      ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
      {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
      },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const result = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    assert.equal(result.length, 1);
    const packedPaths = new Set(result[0]?.files.map((file) => file.path));
    for (const plan of [
      'data-science.json',
      'engineering.json',
      'research.json',
    ]) {
      assert.equal(packedPaths.has(`orchestration-profiles/${plan}`), true);
    }
    assert.equal(fs.existsSync(path.join(destination, result[0]!.filename)), true);
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
