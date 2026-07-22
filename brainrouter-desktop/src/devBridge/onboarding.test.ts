import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDevOnboardingState,
  getDevWorkspaceManifest,
  saveDevWorkspaceManifest,
} from './onboarding.js';

const root = '/Users/dev/example';

function proposal(info: Record<string, unknown>): Record<string, unknown> {
  const profiles = info.profiles as Array<Record<string, unknown>>;
  const engineering = profiles.find((profile) => profile.id === 'engineering');
  assert.ok(engineering);
  return {
    expected: (info.review as { revision: Record<string, string> }).revision,
    source: 'wizard',
    profile: engineering.id,
    agents: engineering.agents,
    capabilities: engineering.capabilities,
    skills: engineering.skills,
    tools: engineering.tools,
    memory: engineering.memory,
    instructions: 'AGENT.md',
  };
}

test('starts un-onboarded with the shared engineer/frontend profile catalog', () => {
  const info = getDevWorkspaceManifest(createDevOnboardingState(), root);
  assert.equal(info.onboarded, false);
  assert.equal(info.manifest, null);
  const profiles = info.profiles as Array<Record<string, unknown>>;
  const engineering = profiles.find((profile) => profile.id === 'engineering');
  assert.ok(engineering);
  assert.deepEqual((engineering.agents as { enabled: string[] }).enabled, ['engineer']);
  assert.deepEqual((engineering.capabilities as { enabled: string[] }).enabled, ['frontend']);
  assert.ok(!JSON.stringify(engineering).includes('frontend-builder'));
});

test('saves reviewed fields in memory and advances the opaque revision', () => {
  const state = createDevOnboardingState();
  const before = getDevWorkspaceManifest(state, root);
  const payload = proposal(before);
  const saved = saveDevWorkspaceManifest(state, root, payload);
  assert.equal(saved.saved, true);

  const after = getDevWorkspaceManifest(state, root);
  assert.equal(after.onboarded, true);
  assert.notDeepEqual(
    (after.review as { revision: unknown }).revision,
    (before.review as { revision: unknown }).revision,
  );
  assert.equal((after.manifest as { name: string }).name, 'example');
});

test('rejects stale reviews and tracks an approved instruction replacement', () => {
  const state = createDevOnboardingState();
  const before = getDevWorkspaceManifest(state, root);
  const payload = proposal(before);
  assert.equal(saveDevWorkspaceManifest(state, root, payload).saved, true);
  const stale = saveDevWorkspaceManifest(state, root, payload);
  assert.deepEqual(stale, {
    saved: false,
    stale: true,
    error: 'Workspace setup changed while it was open.',
  });

  const latest = getDevWorkspaceManifest(state, root);
  const withInstruction = {
    ...proposal(latest),
    source: 'agent',
    instruction: { path: 'AGENT.md', contents: '# Reviewed project instructions\n' },
  };
  assert.equal(saveDevWorkspaceManifest(state, root, withInstruction).saved, true);
  const summary = (getDevWorkspaceManifest(state, root).review as {
    instruction: { existed: boolean; bytes: number };
  }).instruction;
  assert.equal(summary.existed, true);
  assert.ok(summary.bytes > 0);
});

test('rejects empty and oversized instruction replacements', () => {
  const state = createDevOnboardingState();
  const current = getDevWorkspaceManifest(state, root);
  const base = proposal(current);
  assert.equal(saveDevWorkspaceManifest(state, root, {
    ...base,
    instruction: { path: 'AGENT.md', contents: '' },
  }).saved, false);
  assert.equal(saveDevWorkspaceManifest(state, root, {
    ...base,
    instruction: { path: 'AGENT.md', contents: 'x'.repeat(65_537) },
  }).saved, false);
});
