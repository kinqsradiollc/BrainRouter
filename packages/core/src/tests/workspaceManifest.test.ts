/**
 * ADR-021 W1 — the workspace manifest chokepoint: preset application, disk
 * round-trip with unknown-field preservation, never-throw loading, and
 * profile-preset self-consistency.
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
  assert.equal(manifest.profile, 'engineering');
  assert.equal(manifest.agents.default, 'engineer');
  assert.ok(manifest.skills.enabled.includes('planning-skill'));
  assert.ok(manifest.tools.profiles.includes('coding'));
  assert.deepEqual(manifest.memory.tags, ['engineering']);
  assert.equal(manifest.instructions, 'AGENT.md');
  assert.equal(manifest.onboarded.by, 'wizard');
  assert.ok(manifest.onboarded.at.length > 0);
});

test('custom profile starts empty — nothing imposed', () => {
  const manifest = createWorkspaceManifest({ name: 'x', profile: 'custom', by: 'wizard' });
  assert.equal(manifest.agents.default, '');
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

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.profile, 'research');
    assert.equal(loaded.agents.default, 'researcher');
    assert.equal(loaded.onboarded.at, '2026-07-21T00:00:00Z');
    assert.deepEqual(loaded.extra, { futureField: { keep: true } }, 'unknown fields survive the round-trip');
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
    assert.deepEqual(loaded.skills.enabled, ['ok', 'also-ok']);
    assert.equal(loaded.onboarded.by, 'import');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('profile presets are self-consistent (every profile usable by the wizard)', () => {
  assert.ok(WORKSPACE_PROFILES.length >= 7);
  assert.equal(WORKSPACE_PROFILES.at(-1)!.id, 'custom', 'custom renders last in pickers');
  for (const preset of WORKSPACE_PROFILES) {
    assert.ok(preset.label.trim().length > 0, `${preset.id}: label`);
    assert.ok(preset.description.trim().length > 0, `${preset.id}: description`);
    assert.equal(getWorkspaceProfile(preset.id), preset);
    if (preset.id !== 'custom') {
      assert.ok(preset.agents.default.length > 0, `${preset.id}: names a default persona`);
      assert.ok(preset.agents.enabled.includes(preset.agents.default), `${preset.id}: default persona is enabled`);
    }
  }
});
