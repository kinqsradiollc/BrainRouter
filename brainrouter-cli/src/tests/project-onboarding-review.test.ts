import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspaceManifest,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  workspaceManifestPath,
} from '@kinqs/brainrouter-core/workspace';
import {
  runProjectOnboarding,
  type ProjectOnboardingPrompt,
  type ProjectOnboardingPromptId,
} from '../cli/commands/init/projectOnboard.js';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-reviewed-onboard-'));
}

function acceptingPrompt(options: {
  profile?: string;
  text?: Partial<Record<ProjectOnboardingPromptId, string>>;
  choices?: Partial<Record<ProjectOnboardingPromptId, string[]>>;
  beforeConfirm?: () => void;
} = {}): ProjectOnboardingPrompt {
  return async (request) => {
    if (request.id === 'start') return { kind: 'submit', value: 'continue' };
    if (request.id === 'profile') return { kind: 'submit', value: options.profile ?? 'engineering' };
    if (request.id === 'orchestration-mode') {
      return { kind: 'submit', value: options.text?.[request.id] ?? request.initialChoice ?? 'off' };
    }
    if (request.id === 'confirm') {
      options.beforeConfirm?.();
      return { kind: 'submit', value: 'save' };
    }
    if (request.multiSelect) {
      return {
        kind: 'submit',
        value: options.choices?.[request.id] ?? request.initialChoices ?? [],
      };
    }
    return { kind: 'submit', value: options.text?.[request.id] ?? request.initialValue ?? '' };
  };
}

test('skip leaves a new workspace completely untouched', async () => {
  const root = makeWorkspace();
  try {
    const result = await runProjectOnboarding(root, {
      prompt: async () => ({ kind: 'skip' }),
      print: () => undefined,
    });
    assert.equal(result.status, 'skipped');
    assert.equal(fs.existsSync(workspaceManifestPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI review separates included profile setup from optional catalog choices', async () => {
  const root = makeWorkspace();
  let sawOptionalCapabilities = false;
  let sawAdditionalSkillPacks = false;
  try {
    const base = acceptingPrompt();
    const result = await runProjectOnboarding(root, {
      prompt: async (request) => {
        if (request.id === 'capabilities-enabled') {
          sawOptionalCapabilities = request.title === 'Optional capabilities';
        }
        if (request.id === 'skill-packs') {
          sawAdditionalSkillPacks = request.title === 'Additional skill packs';
          assert.equal(request.rows?.some((row) => row.id === 'engineering'), false);
          assert.equal(request.initialChoices?.includes('engineering'), false);
        }
        return base(request);
      },
      print: () => undefined,
    });
    assert.equal(result.status, 'committed');
    assert.equal(sawOptionalCapabilities, true);
    assert.equal(sawAdditionalSkillPacks, true);
    assert.ok(loadWorkspaceManifest(root)?.skills.packs.includes('engineering'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancellation at profile, field, or confirmation writes nothing', async (t) => {
  for (const cancelAt of ['profile', 'capabilities-enabled', 'confirm'] as const) {
    await t.test(cancelAt, async () => {
      const root = makeWorkspace();
      try {
        const base = acceptingPrompt();
        const result = await runProjectOnboarding(root, {
          prompt: async (request) => request.id === cancelAt ? { kind: 'cancel' } : base(request),
          print: () => undefined,
        });
        assert.equal(result.status, 'cancelled');
        assert.equal(fs.existsSync(workspaceManifestPath(root)), false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('final confirmation saves the reviewed persona, orchestration, and engineering capability shape', async () => {
  const root = makeWorkspace();
  try {
    const result = await runProjectOnboarding(root, {
      prompt: acceptingPrompt(),
      now: () => '2026-01-02T03:04:05.000Z',
      print: () => undefined,
    });
    assert.equal(result.status, 'committed');
    const saved = loadWorkspaceManifest(root);
    assert.ok(saved);
    assert.deepEqual(saved.persona, { default: 'engineer', enabled: ['engineer'] });
    assert.deepEqual(saved.orchestration, {
      mode: 'adaptive',
      availableRoles: ['explorer', 'architect', 'worker', 'reviewer', 'verifier'],
      disabledRoles: ['fleet'],
      maxParallel: 4,
    });
    assert.deepEqual(saved.capabilities.enabled, ['frontend', 'backend']);
    assert.equal(saved.version, 3);
    assert.equal(saved.tools.mode, 'explicit-catalog');
    assert.ok(!JSON.stringify(saved).includes('frontend-builder'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit mode preserves safe forward fields while applying reviewed changes', async () => {
  const root = makeWorkspace();
  try {
    saveWorkspaceManifest(root, {
      ...createWorkspaceManifest({ name: 'kept', profile: 'engineering', by: 'import' }),
      extra: { futureFlag: true },
    });
    const result = await runProjectOnboarding(root, {
      edit: true,
      prompt: acceptingPrompt({
        text: {
          'orchestration-max-parallel': 'not-a-number',
        },
        choices: {
          'orchestration-available': ['worker', 'reviewer', 'fleet'],
          'orchestration-disabled': ['fleet'],
          'capabilities-enabled': ['frontend'],
        },
      }),
      print: () => undefined,
    });
    assert.equal(result.status, 'committed');
    const saved = loadWorkspaceManifest(root);
    assert.ok(saved);
    assert.deepEqual(saved.orchestration.availableRoles, ['worker', 'reviewer']);
    assert.deepEqual(saved.orchestration.disabledRoles, ['fleet']);
    assert.equal(saved.orchestration.maxParallel, 4);
    assert.deepEqual(saved.capabilities.enabled, ['frontend']);
    assert.deepEqual(saved.extra, { futureFlag: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('catalog review rejects a capability ID that was never offered', async () => {
  const root = makeWorkspace();
  try {
    await assert.rejects(
      runProjectOnboarding(root, {
        prompt: acceptingPrompt({
          choices: { 'capabilities-enabled': ['browser'] },
        }),
        print: () => undefined,
      }),
      /capability selection is no longer available/i,
    );
    assert.equal(fs.existsSync(workspaceManifestPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a concurrent manifest change is preserved and rejects the stale review', async () => {
  const root = makeWorkspace();
  const external = createWorkspaceManifest({ name: 'external', profile: 'research', by: 'import' });
  try {
    await assert.rejects(
      runProjectOnboarding(root, {
        prompt: acceptingPrompt({ beforeConfirm: () => { saveWorkspaceManifest(root, external); } }),
        print: () => undefined,
      }),
      /changed during review|changed while setup/i,
    );
    assert.equal(loadWorkspaceManifest(root)?.name, 'external');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable existing manifest is never replaced by onboarding', async () => {
  const root = makeWorkspace();
  const target = workspaceManifestPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{not-json', 'utf8');
  try {
    await assert.rejects(
      runProjectOnboarding(root, { prompt: acceptingPrompt(), print: () => undefined }),
      /exists but cannot be read safely/i,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '{not-json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
