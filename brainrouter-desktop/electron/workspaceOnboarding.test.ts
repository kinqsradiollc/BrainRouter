import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspaceManifest,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
} from '@kinqs/brainrouter-core/workspace';
import {
  getWorkspaceManifestInfo,
  previewWorkspaceOnboardingFromPayload,
  previewWorkspaceInstructionFromPayload,
  saveWorkspaceManifestFromPayload,
  type ManifestSavePayload,
} from './workspaceOnboarding.js';

function tmpWorkspace(files: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboard-ipc-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboard-home-'));
  const previous = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body, 'utf8');
  }
  return {
    root,
    cleanup: () => {
      if (previous === undefined) delete process.env.BRAINROUTER_HOME;
      else process.env.BRAINROUTER_HOME = previous;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function payload(root: string, profileId: string): ManifestSavePayload {
  const info = getWorkspaceManifestInfo(root);
  const profile = info.profiles.find((candidate) => candidate.id === profileId);
  assert.ok(profile);
  return {
    expected: info.review.revision,
    source: 'wizard',
    catalogFingerprint: info.preview.catalogFingerprint,
    profile: profile.id,
    persona: { default: profile.persona.default, enabled: [...profile.persona.enabled] },
    orchestration: {
      mode: profile.orchestration.mode,
      availableRoles: [...profile.orchestration.availableRoles],
      disabledRoles: [...profile.orchestration.disabledRoles],
      maxParallel: profile.orchestration.maxParallel,
    },
    capabilities: { enabled: [...profile.capabilities.enabled], disabled: [] },
    skills: { packs: [...profile.skills.packs], enabled: [...profile.skills.enabled], disabled: [] },
    tools: { profiles: [...profile.tools.profiles], enabled: [], deny: [] },
    memory: { tags: [...profile.memory.tags], captureHint: profile.memory.captureHint },
    instructions: 'AGENT.md',
  };
}

function writeCustomPlan(root: string): void {
  const directory = path.join(root, 'orchestration-profiles');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'custom.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'orchestration-profile',
    id: 'custom',
    displayName: 'Workspace custom orchestration',
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
      description: 'Complete directly.',
      activation: { signals: ['small-scope'], explicitOnly: false },
      stages: [{
        id: 'complete',
        executor: { kind: 'primary' },
        after: [],
        objective: 'Complete the task directly.',
        skillIds: [],
        optional: false,
      }],
    }],
  }));
}

test('manifest-get returns suggestion, complete profiles, and opaque review revisions', () => {
  const env = tmpWorkspace({ 'package.json': '{}' });
  try {
    const info = getWorkspaceManifestInfo(env.root);
    assert.equal(info.onboarded, false);
    assert.equal(info.manifest, null);
    assert.equal(info.suggestion.profile, 'engineering');
    assert.ok(info.profiles.some((preset) => preset.id === 'custom'));
    assert.equal(info.preview.plan?.id, 'engineering');
    assert.equal(info.preview.catalog.some((row) => row.kind === 'role' && row.id === 'worker'), true);
    assert.equal(info.preview.catalog.some((row) => row.kind === 'tool-group' && row.id === 'coding'), true);
    assert.match(info.review.revision.root, /^[0-9a-f]{64}$/);
    assert.match(info.review.revision.manifest, /^[0-9a-f]{64}$/);
    assert.equal(info.review.instruction.existed, false);
  } finally { env.cleanup(); }
});

test('manifest-get and draft preview consume the same resolved workspace plan source', () => {
  const env = tmpWorkspace();
  try {
    writeCustomPlan(env.root);
    const info = getWorkspaceManifestInfo(env.root);
    assert.equal(info.preview.plan?.displayName, 'Workspace custom orchestration');
    assert.deepEqual(info.preview.plan?.source, {
      kind: 'workspace',
      provenance: 'workspace',
    });
    const input = payload(env.root, 'custom');
    const {
      expected: _expected,
      source: _source,
      catalogFingerprint: _catalogFingerprint,
      ...draft
    } = input;
    const result = previewWorkspaceOnboardingFromPayload(env.root, draft);
    assert.equal(result.ok && result.preview.plan?.source.kind, 'workspace');
  } finally { env.cleanup(); }
});

test('plan preview parses a reviewed draft without writing workspace files', () => {
  const env = tmpWorkspace();
  try {
    const input = payload(env.root, 'custom');
    const {
      expected: _expected,
      source: _source,
      catalogFingerprint: _catalogFingerprint,
      ...draft
    } = input;
    const result = previewWorkspaceOnboardingFromPayload(env.root, draft);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.preview.plan?.id, 'custom');
    assert.equal(result.ok && result.preview.plan?.selectedStrategyId, 'direct');
    assert.deepEqual(result.ok && result.preview.roles.effective, []);
    assert.equal(loadWorkspaceManifest(env.root), null);
  } finally { env.cleanup(); }
});

test('instruction-preview returns exact safe text without writing either file', () => {
  const env = tmpWorkspace({ 'AGENT.md': '# Existing\n' });
  try {
    const info = getWorkspaceManifestInfo(env.root);
    const result = previewWorkspaceInstructionFromPayload(env.root, {
      expected: info.review.revision,
      instruction: { path: 'AGENT.md', contents: '# Proposed\n' },
    });
    assert.deepEqual(result, {
      ok: true,
      path: 'AGENT.md',
      existed: true,
      original: '# Existing\n',
      proposed: '# Proposed\n',
      originalBytes: 11,
      proposedBytes: 11,
    });
    assert.equal(fs.readFileSync(path.join(env.root, 'AGENT.md'), 'utf8'), '# Existing\n');
    assert.equal(loadWorkspaceManifest(env.root), null);
  } finally { env.cleanup(); }
});

test('instruction-preview rejects stale revisions without exposing concurrent text', () => {
  const env = tmpWorkspace({ 'AGENT.md': '# Original\n' });
  try {
    const info = getWorkspaceManifestInfo(env.root);
    fs.writeFileSync(path.join(env.root, 'AGENT.md'), '# Concurrent private change\n');
    const result = previewWorkspaceInstructionFromPayload(env.root, {
      expected: info.review.revision,
      instruction: { path: 'AGENT.md', contents: '# Proposed\n' },
    });
    assert.deepEqual(result, {
      ok: false,
      stale: true,
      error: 'Workspace setup changed while the instruction was being reviewed.',
    });
    assert.equal(JSON.stringify(result).includes('Concurrent private change'), false);
  } finally { env.cleanup(); }
});

test('instruction-preview fails closed on secret-bearing or malformed content', () => {
  const env = tmpWorkspace({ 'AGENT.md': 'OPENAI_API_KEY=sk-do-not-expose\n' });
  try {
    const info = getWorkspaceManifestInfo(env.root);
    const unsafeExisting = previewWorkspaceInstructionFromPayload(env.root, {
      expected: info.review.revision,
      instruction: { path: 'AGENT.md', contents: '# Proposed\n' },
    });
    assert.equal(unsafeExisting.ok, false);
    assert.equal(JSON.stringify(unsafeExisting).includes('sk-do-not-expose'), false);

    const malformed = previewWorkspaceInstructionFromPayload(env.root, {
      expected: info.review.revision,
      instruction: { path: '../AGENT.md', contents: '# Proposed\n' },
      extra: true,
    });
    assert.equal(malformed.ok, false);
    assert.equal(fs.readFileSync(path.join(env.root, 'AGENT.md'), 'utf8'), 'OPENAI_API_KEY=sk-do-not-expose\n');
    assert.equal(loadWorkspaceManifest(env.root), null);
  } finally { env.cleanup(); }
});

test('manifest-save writes persona and orchestration independently', () => {
  const env = tmpWorkspace();
  try {
    const input = payload(env.root, 'engineering');
    input.orchestration = {
      mode: 'adaptive',
      availableRoles: ['worker', 'reviewer', 'fleet'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    };
    const result = saveWorkspaceManifestFromPayload(env.root, input);
    assert.ok(result.saved);
    assert.equal(result.saved && result.manifest.persona.default, 'engineer');
    assert.deepEqual(result.saved && result.manifest.persona.enabled, ['engineer']);
    assert.deepEqual(result.saved && result.manifest.orchestration, {
      mode: 'adaptive',
      availableRoles: ['worker', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    });
    assert.deepEqual(result.saved && result.manifest.capabilities.enabled, ['frontend', 'backend']);
    assert.equal(result.saved && result.manifest.version, 3);
    assert.equal(result.saved && result.manifest.tools.mode, 'explicit-catalog');
    assert.ok(result.saved && !JSON.stringify(result.manifest).includes('frontend-builder'));
  } finally { env.cleanup(); }
});

test('manifest-save preserves the staged profile-card contract without allowing re-onboarding', () => {
  const env = tmpWorkspace();
  try {
    const first = saveWorkspaceManifestFromPayload(env.root, { profile: 'research' });
    assert.ok(first.saved);
    assert.equal(first.saved && first.manifest.profile, 'research');
    const second = saveWorkspaceManifestFromPayload(env.root, { profile: 'writing' });
    assert.equal(second.saved, false);
    assert.equal(loadWorkspaceManifest(env.root)?.profile, 'research');
  } finally { env.cleanup(); }
});

test('manifest-save supports complete edit re-entry and preserves safe unknown fields', () => {
  const env = tmpWorkspace();
  try {
    const initial = createWorkspaceManifest({ name: 'kept-name', profile: 'study', by: 'import' });
    initial.extra = { futureOption: { enabled: true } };
    saveWorkspaceManifest(env.root, initial);

    const edit = payload(env.root, 'writing');
    edit.tools = { profiles: ['notes'], enabled: ['web_search'], deny: ['terminal'] };
    const result = saveWorkspaceManifestFromPayload(env.root, edit);
    assert.ok(result.saved);
    assert.equal(result.saved && result.manifest.profile, 'writing');
    assert.equal(result.saved && result.manifest.name, 'kept-name');
    assert.deepEqual(result.saved && result.manifest.extra, { futureOption: { enabled: true } });
    assert.deepEqual(result.saved && result.manifest.tools.deny, ['terminal']);
    assert.deepEqual(result.saved && result.manifest.tools.enabled, ['web_search']);
  } finally { env.cleanup(); }
});

test('manifest-save rejects stale reviews without overwriting concurrent changes', () => {
  const env = tmpWorkspace();
  try {
    const stale = payload(env.root, 'research');
    saveWorkspaceManifest(env.root, createWorkspaceManifest({ name: 'concurrent', profile: 'study', by: 'wizard' }));
    const result = saveWorkspaceManifestFromPayload(env.root, stale);
    assert.equal(result.saved, false);
    assert.equal(!result.saved && result.stale, true);
    assert.equal(loadWorkspaceManifest(env.root)?.name, 'concurrent');
  } finally { env.cleanup(); }
});

test('manifest-save commits an explicitly approved instruction replacement', () => {
  const env = tmpWorkspace({ 'AGENT.md': '# Existing\n' });
  try {
    const input = payload(env.root, 'research');
    input.source = 'agent';
    input.instruction = { path: 'AGENT.md', contents: '# Reviewed instructions\n\nUse verified sources.\n' };
    const result = saveWorkspaceManifestFromPayload(env.root, input);
    assert.ok(result.saved);
    assert.equal(fs.readFileSync(path.join(env.root, 'AGENT.md'), 'utf8'), '# Reviewed instructions\n\nUse verified sources.\n');
    assert.equal(loadWorkspaceManifest(env.root)?.profile, 'research');
  } finally { env.cleanup(); }
});

test('manifest-save rejects unknown profiles and unsafe instruction targets with no writes', () => {
  const env = tmpWorkspace();
  try {
    const unknown = payload(env.root, 'study');
    unknown.profile = 'astrology';
    assert.equal(saveWorkspaceManifestFromPayload(env.root, unknown).saved, false);
    assert.equal(loadWorkspaceManifest(env.root), null);

    const unsafe = payload(env.root, 'study');
    unsafe.instruction = { path: '../AGENT.md', contents: '# Unsafe\n' };
    assert.equal(saveWorkspaceManifestFromPayload(env.root, unsafe).saved, false);
    assert.equal(loadWorkspaceManifest(env.root), null);
  } finally { env.cleanup(); }
});

test('manifest-save rejects malformed review revisions without writing', () => {
  const env = tmpWorkspace();
  try {
    const input = payload(env.root, 'study');
    input.expected = { manifest: '0'.repeat(64), instruction: '0'.repeat(64) };
    const result = saveWorkspaceManifestFromPayload(env.root, input);
    assert.equal(result.saved, false);
    assert.equal(loadWorkspaceManifest(env.root), null);

    const withExtra = { ...payload(env.root, 'study'), unexpected: true };
    assert.equal(saveWorkspaceManifestFromPayload(env.root, withExtra).saved, false);
    const legacy = payload(env.root, 'study') as ManifestSavePayload & { agents: unknown };
    legacy.agents = legacy.persona;
    delete legacy.persona;
    assert.equal(saveWorkspaceManifestFromPayload(env.root, legacy).saved, false);
    const invalidParallelism = payload(env.root, 'study');
    invalidParallelism.orchestration = {
      mode: 'adaptive',
      availableRoles: ['worker'],
      disabledRoles: [],
      maxParallel: 33,
    };
    assert.equal(saveWorkspaceManifestFromPayload(env.root, invalidParallelism).saved, false);
    const unknownRole = payload(env.root, 'study');
    unknownRole.orchestration = {
      mode: 'explicit',
      availableRoles: ['invented'],
      disabledRoles: [],
      maxParallel: 2,
    };
    assert.equal(saveWorkspaceManifestFromPayload(env.root, unknownRole).saved, false);
    const staleCatalog = payload(env.root, 'study');
    staleCatalog.catalogFingerprint = 'f'.repeat(64);
    assert.equal(saveWorkspaceManifestFromPayload(env.root, staleCatalog).saved, false);
    assert.equal(saveWorkspaceManifestFromPayload(env.root, null).saved, false);
    assert.equal(loadWorkspaceManifest(env.root), null);
  } finally { env.cleanup(); }
});
