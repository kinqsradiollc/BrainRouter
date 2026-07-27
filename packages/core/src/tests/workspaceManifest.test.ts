/**
 * ADR-021 W1/W1c — the workspace manifest chokepoint: preset application,
 * capability migration, disk round-trip with unknown-field preservation,
 * never-throw loading, and profile-preset self-consistency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_PROFILES,
  createWorkspaceManifest,
  getWorkspaceProfile,
  isWorkspaceOnboarded,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  workspaceManifestPath,
} from '../workspace/manifest.js';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-wsm-'));
}

test('createWorkspaceManifest applies the profile preset', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  assert.equal(manifest.version, 2);
  assert.equal(manifest.profile, 'engineering');
  assert.deepEqual(manifest.persona, { default: 'engineer', enabled: ['engineer'] });
  assert.equal(manifest.agents.default, 'engineer');
  assert.deepEqual(manifest.agents.enabled, ['engineer']);
  assert.deepEqual(manifest.orchestration, {
    mode: 'adaptive',
    availableRoles: ['explorer', 'architect', 'worker', 'reviewer', 'verifier'],
    disabledRoles: ['fleet'],
    maxParallel: 4,
  });
  assert.deepEqual(manifest.capabilities, { enabled: ['frontend', 'backend'], disabled: [] });
  assert.ok(manifest.skills.enabled.includes('planning-skill'));
  assert.ok(manifest.tools.profiles.includes('coding'));
  assert.ok(manifest.tools.profiles.includes('artifacts'));
  assert.ok(!manifest.tools.profiles.includes('interactive-browser'),
    'interactive browser control remains a reviewed capability-sensitive choice');
  assert.deepEqual(manifest.memory.tags, ['engineering']);
  assert.equal(manifest.instructions, 'AGENT.md');
  assert.equal(manifest.onboarded.by, 'wizard');
  assert.ok(manifest.onboarded.at.length > 0);
});

test('custom profile starts empty — nothing imposed', () => {
  const manifest = createWorkspaceManifest({ name: 'x', profile: 'custom', by: 'wizard' });
  assert.deepEqual(manifest.persona, { default: '', enabled: [] });
  assert.equal(manifest.agents.default, '');
  assert.deepEqual(manifest.orchestration, {
    mode: 'off',
    availableRoles: [],
    disabledRoles: [],
    maxParallel: 1,
  });
  assert.deepEqual(manifest.capabilities, { enabled: [], disabled: [] });
  assert.deepEqual(manifest.skills.packs, []);
  assert.deepEqual(manifest.tools.profiles, []);
});

test('save → load round-trips, marks onboarded, and preserves unknown fields', () => {
  const ws = tmpWorkspace();
  try {
    assert.equal(isWorkspaceOnboarded(ws), false);
    const manifest = createWorkspaceManifest({ name: 'demo', profile: 'research', by: 'agent', at: '2026-07-21T00:00:00Z' });
    manifest.extra = { futureField: { keep: true } };
    saveWorkspaceManifest(ws, manifest);
    assert.equal(isWorkspaceOnboarded(ws), true);
    const persisted = JSON.parse(fs.readFileSync(workspaceManifestPath(ws), 'utf8')) as {
      version: number;
      persona: unknown;
      orchestration: unknown;
    };
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.persona, manifest.persona);
    assert.deepEqual(persisted.orchestration, manifest.orchestration);

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.profile, 'research');
    assert.equal(loaded.persona.default, 'researcher');
    assert.equal(loaded.agents.default, 'researcher');
    assert.equal(loaded.onboarded.at, '2026-07-21T00:00:00Z');
    assert.deepEqual(loaded.extra, { futureField: { keep: true } }, 'unknown fields survive the round-trip');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest v2 orchestration is bounded, deduplicated, and deny-first', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      version: 2,
      profile: 'custom',
      persona: { default: 'engineer', enabled: ['engineer'] },
      orchestration: {
        mode: 'adaptive',
        availableRoles: ['worker', 'reviewer', 'worker', 'fleet'],
        disabledRoles: ['fleet', 'fleet'],
        maxParallel: 99,
      },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.deepEqual(loaded.orchestration, {
      mode: 'adaptive',
      availableRoles: ['worker', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 1,
    });
    assert.deepEqual(loaded.persona, { default: 'engineer', enabled: ['engineer'] });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('committable manifest drops sensitive extras and local paths but preserves safe future fields', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'engineering',
      instructions: '/Users/example/private/AGENT.md',
      futureField: {
        keep: true,
        tokenBudget: 4096,
        maxTokens: 8192,
        inputTokens: 128,
        outputTokens: 256,
        tokenizerModel: 'example-tokenizer',
        authToken: 'hidden',
        githubToken: 'hidden',
        apiSecretKey: 'hidden',
        accessTokenValue: 'hidden',
        authTokenValue: 'hidden',
        oauthTokenValue: 'hidden',
        csrfTokenValue: 'hidden',
        projectId: 'project-secret',
        orgIds: ['org-secret'],
        projectIds: ['project-secret'],
        buildCommand: 'node /Users/example/private/build.js',
        bracketedUnixPath: 'paths=[/Users/example/private]',
        bracketedWindowsPath: 'paths=[C:\\Users\\example\\private]',
        labelledPath: 'path:/Users/example/private',
        safeUrl: 'https://example.test/api',
        authorizationUrl: 'https://example.test/oauth/authorize',
        cookiePolicy: 'strict',
        passwordPolicy: { minimumLength: 16 },
        requestExample: 'curl -H "Authorization: Bearer private-token" https://example.test',
        nested: ['safe', '/home/example/private.txt', { clientSecret: 'hidden', note: 'keep me' }],
      },
      apiKey: 'sk-exampleexamplesecret',
      opaque: 'ghp_abcdefghijklmnopqrstuvwxyz',
      agents: { default: 'engineer', enabled: ['engineer', 'ghp_abcdefghijklmnopqrstuvwxyz'] },
      capabilities: { enabled: ['frontend', '/Users/example/private-capability'], disabled: [] },
      skills: { packs: ['engineering'], enabled: ['file:///Users/example/private-skill'], disabled: [] },
      tools: { profiles: ['coding'], deny: ['Bearer private-token'] },
      memory: { tags: ['engineering', 'sk-anotherexamplesecret'], captureHint: 'code' },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.instructions, 'AGENT.md');
    assert.deepEqual(loaded.agents, { default: 'engineer', enabled: ['engineer'] });
    assert.deepEqual(loaded.capabilities, { enabled: ['frontend'], disabled: [] });
    assert.deepEqual(loaded.skills, { packs: ['engineering'], enabled: [], disabled: [] });
    assert.deepEqual(loaded.tools, { profiles: ['coding'], deny: [] });
    assert.deepEqual(loaded.memory, { tags: ['engineering'], captureHint: 'code' });
    assert.deepEqual(loaded.extra, {
      futureField: {
        keep: true,
        tokenBudget: 4096,
        maxTokens: 8192,
        inputTokens: 128,
        outputTokens: 256,
        tokenizerModel: 'example-tokenizer',
        safeUrl: 'https://example.test/api',
        authorizationUrl: 'https://example.test/oauth/authorize',
        cookiePolicy: 'strict',
        passwordPolicy: { minimumLength: 16 },
        nested: ['safe', { note: 'keep me' }],
      },
    });

    saveWorkspaceManifest(ws, loaded);
    const persisted = fs.readFileSync(workspaceManifestPath(ws), 'utf8');
    assert.ok(!persisted.includes('project-secret'));
    assert.ok(!persisted.includes('/home/example'));
    assert.ok(!persisted.includes('/Users/example'));
    assert.ok(!persisted.includes('private-token'));
    assert.ok(!persisted.includes('ghp_'));
    assert.deepEqual(loadWorkspaceManifest(ws)?.extra, loaded.extra);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('loading never throws: absent → null, corrupt → null, hostile shapes normalize', () => {
  const ws = tmpWorkspace();
  try {
    assert.equal(loadWorkspaceManifest(ws), null, 'absent manifest');

    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), '{not json', 'utf8');
    assert.equal(loadWorkspaceManifest(ws), null, 'corrupt JSON');

    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'astrology', // unknown → custom
      name: 42, // wrong type → default
      agents: 'nope', // wrong shape → defaults
      skills: { enabled: ['ok', 7, null, 'also-ok'] }, // junk filtered
      onboarded: { by: 'aliens' }, // unknown source → import
    }), 'utf8');
    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.profile, 'custom');
    assert.equal(loaded.name, 'workspace');
    assert.deepEqual(loaded.agents, { default: '', enabled: [] });
    assert.deepEqual(loaded.capabilities, { enabled: [], disabled: [] });
    assert.deepEqual(loaded.skills.enabled, ['ok', 'also-ok']);
    assert.equal(loaded.onboarded.by, 'import');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('profile presets are self-consistent (every profile usable by the wizard)', () => {
  assert.ok(WORKSPACE_PROFILES.length >= 6);
  assert.equal(WORKSPACE_PROFILES.at(-1)!.id, 'custom', 'custom renders last in pickers');
  // Frontend is a task-scoped engineering capability, not a top-level profile or persona.
  assert.ok(!WORKSPACE_PROFILES.some((preset) => (preset.id as string) === 'frontend'));
  const engineering = WORKSPACE_PROFILES.find((preset) => preset.id === 'engineering')!;
  assert.deepEqual(engineering.persona, { default: 'engineer', enabled: ['engineer'] });
  assert.deepEqual(engineering.agents, { default: 'engineer', enabled: ['engineer'] });
  assert.equal(engineering.orchestration.mode, 'adaptive');
  assert.equal(engineering.orchestration.disabledRoles.includes('fleet'), true);
  assert.deepEqual(engineering.capabilities, {
    available: ['frontend', 'backend'],
    recommended: ['frontend', 'backend'],
    enabled: ['frontend', 'backend'],
  });
  const custom = WORKSPACE_PROFILES.find((preset) => preset.id === 'custom')!;
  assert.deepEqual(custom.capabilities, {
    available: ['frontend', 'backend', 'academic-paper', 'computational-research'],
    recommended: [],
    enabled: [],
  });
  const writing = WORKSPACE_PROFILES.find((preset) => preset.id === 'writing')!;
  assert.deepEqual(writing.capabilities, {
    available: ['academic-paper'],
    recommended: [],
    enabled: [],
  });
  const research = WORKSPACE_PROFILES.find((preset) => preset.id === 'research')!;
  const dataScience = WORKSPACE_PROFILES.find((preset) => preset.id === 'data-science')!;
  assert.deepEqual(research.capabilities.available, ['computational-research']);
  assert.deepEqual(dataScience.capabilities.available, ['computational-research']);
  assert.ok(engineering.tools.profiles.includes('artifacts'));
  assert.ok(engineering.tools.profiles.includes('pull-request-observation'));
  assert.ok(!engineering.tools.profiles.includes('interactive-browser'),
    'interactive browser control is not a baseline Engineering grant');
  for (const preset of WORKSPACE_PROFILES) {
    assert.ok(preset.label.trim().length > 0, `${preset.id}: label`);
    assert.ok(preset.description.trim().length > 0, `${preset.id}: description`);
    assert.equal(getWorkspaceProfile(preset.id), preset);
    assert.deepEqual(
      preset.capabilities.enabled,
      preset.capabilities.recommended,
      `${preset.id}: compatibility alias mirrors recommended defaults`,
    );
    assert.equal(
      preset.capabilities.recommended.every((id) => preset.capabilities.available.includes(id)),
      true,
      `${preset.id}: every recommended capability is compatible`,
    );
    if (preset.id !== 'custom') {
      assert.ok(preset.persona.default.length > 0, `${preset.id}: names a default persona`);
      assert.ok(preset.persona.enabled.includes(preset.persona.default), `${preset.id}: default persona is enabled`);
    }
  }
});

test('legacy frontend-builder manifests normalize to engineer plus the frontend capability', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'engineering',
      agents: { default: 'frontend-builder', enabled: ['worker', 'frontend-builder', 'engineer'] },
      capabilities: { enabled: ['future-capability'], disabled: ['blocked-capability'] },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.persona.default, 'engineer');
    assert.equal(loaded.agents.default, 'engineer');
    assert.deepEqual(loaded.agents.enabled, ['worker', 'engineer']);
    assert.deepEqual(
      loaded.capabilities,
      { enabled: ['future-capability', 'frontend'], disabled: ['blocked-capability'] },
      'unknown capability ids survive legacy migration',
    );
    assert.ok(loaded.orchestration.availableRoles.includes('worker'));
    assert.ok(loaded.orchestration.availableRoles.includes('reviewer'));
    saveWorkspaceManifest(ws, loaded);
    assert.deepEqual(
      loadWorkspaceManifest(ws)?.capabilities,
      loaded.capabilities,
      'unknown capability ids survive a normalized save and reload',
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('capability normalization deduplicates ids and explicit disables win', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'engineering',
      agents: { default: 'frontend-builder', enabled: ['frontend-builder'] },
      capabilities: {
        enabled: ['frontend', 'future-capability', 'future-capability'],
        disabled: ['frontend', 'blocked-capability', 'blocked-capability'],
      },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.deepEqual(loaded.capabilities, {
      enabled: ['future-capability'],
      disabled: ['frontend', 'blocked-capability'],
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('legacy frontend-builder default enables engineer even when the legacy enabled list is absent', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'engineering',
      agents: { default: 'frontend-builder' },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.deepEqual(loaded.agents, { default: 'engineer', enabled: ['engineer'] });
    assert.deepEqual(loaded.capabilities, { enabled: ['frontend'], disabled: [] });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest writers never emit the legacy frontend persona id', () => {
  const ws = tmpWorkspace();
  try {
    const manifest = createWorkspaceManifest({
      name: 'demo',
      profile: 'custom',
      by: 'wizard',
      overrides: {
        agents: { default: 'frontend-builder', enabled: ['frontend-builder'] },
      },
    });
    assert.deepEqual(manifest.agents, { default: 'engineer', enabled: ['engineer'] });
    assert.deepEqual(manifest.capabilities, { enabled: ['frontend'], disabled: [] });

    manifest.agents = { default: 'frontend-builder', enabled: ['frontend-builder'] };
    saveWorkspaceManifest(ws, manifest);
    const persisted = fs.readFileSync(workspaceManifestPath(ws), 'utf8');
    assert.ok(!persisted.includes('frontend-builder'));
    assert.deepEqual(loadWorkspaceManifest(ws)?.agents, { default: 'engineer', enabled: ['engineer'] });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
