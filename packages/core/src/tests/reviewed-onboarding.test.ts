import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitReviewedWorkspaceOnboarding,
  createWorkspaceManifest,
  inspectWorkspaceOnboardingReview,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
} from '../workspace/index.js';

function workspace(): { root: string; home: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-reviewed-onboard-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-reviewed-home-'));
  const previous = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  return {
    root,
    home,
    cleanup: () => {
      if (previous === undefined) delete process.env.BRAINROUTER_HOME;
      else process.env.BRAINROUTER_HOME = previous;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('reviewed onboarding creates the normalized manifest only after confirmation', () => {
  const env = workspace();
  try {
    const review = inspectWorkspaceOnboardingReview(env.root);
    const result = commitReviewedWorkspaceOnboarding(env.root, {
      expected: review.revision,
      manifest: createWorkspaceManifest({ name: 'sample', profile: 'engineering', by: 'wizard' }),
    });

    assert.equal(result.manifest.profile, 'engineering');
    assert.equal(result.manifest.agents.default, 'engineer');
    assert.deepEqual(result.manifest.capabilities.enabled, ['frontend']);
    assert.equal(loadWorkspaceManifest(env.root)?.name, 'sample');
    assert.equal(fs.existsSync(path.join(env.root, 'AGENT.md')), false);
    assert.notDeepEqual(result.review.revision.manifest, review.revision.manifest);
  } finally { env.cleanup(); }
});

test('reviewed onboarding commits an approved instruction and manifest as one pair', () => {
  const env = workspace();
  try {
    fs.writeFileSync(path.join(env.root, 'AGENT.md'), '# Existing\n', 'utf8');
    const review = inspectWorkspaceOnboardingReview(env.root);
    const result = commitReviewedWorkspaceOnboarding(env.root, {
      expected: review.revision,
      manifest: createWorkspaceManifest({ name: 'research', profile: 'research', by: 'agent' }),
      instruction: { path: 'AGENT.md', contents: '# Project instructions\n\nUse verified sources.\n' },
    });

    assert.equal(fs.readFileSync(path.join(env.root, 'AGENT.md'), 'utf8'), '# Project instructions\n\nUse verified sources.\n');
    assert.equal(loadWorkspaceManifest(env.root)?.profile, 'research');
    assert.equal(result.instructionPath, 'AGENT.md');
  } finally { env.cleanup(); }
});

test('reviewed onboarding rejects stale manifest and instruction revisions without overwriting', () => {
  const env = workspace();
  try {
    const initial = createWorkspaceManifest({ name: 'initial', profile: 'study', by: 'wizard' });
    saveWorkspaceManifest(env.root, initial);
    fs.writeFileSync(path.join(env.root, 'AGENT.md'), '# Initial\n', 'utf8');
    const review = inspectWorkspaceOnboardingReview(env.root);

    const concurrent = createWorkspaceManifest({ name: 'concurrent', profile: 'writing', by: 'wizard' });
    saveWorkspaceManifest(env.root, concurrent);
    fs.writeFileSync(path.join(env.root, 'AGENT.md'), '# Concurrent\n', 'utf8');

    assert.throws(() => commitReviewedWorkspaceOnboarding(env.root, {
      expected: review.revision,
      manifest: createWorkspaceManifest({ name: 'stale', profile: 'engineering', by: 'wizard' }),
      instruction: { path: 'AGENT.md', contents: '# Stale\n' },
    }), /changed during review/);
    assert.equal(loadWorkspaceManifest(env.root)?.name, 'concurrent');
    assert.equal(fs.readFileSync(path.join(env.root, 'AGENT.md'), 'utf8'), '# Concurrent\n');
  } finally { env.cleanup(); }
});

test('reviewed onboarding rejects unsafe instruction contents before either file changes', () => {
  const env = workspace();
  try {
    const review = inspectWorkspaceOnboardingReview(env.root);
    assert.throws(() => commitReviewedWorkspaceOnboarding(env.root, {
      expected: review.revision,
      manifest: createWorkspaceManifest({ name: 'unsafe', profile: 'engineering', by: 'agent' }),
      instruction: { path: 'AGENT.md', contents: 'Authorization: Bearer secret-token-value-1234567890\n' },
    }), /unsafe content/);
    assert.equal(loadWorkspaceManifest(env.root), null);
    assert.equal(fs.existsSync(path.join(env.root, 'AGENT.md')), false);
  } finally { env.cleanup(); }
});

test('reviewed onboarding binds the manifest pointer to an approved instruction', () => {
  const env = workspace();
  try {
    const review = inspectWorkspaceOnboardingReview(env.root);
    assert.throws(() => commitReviewedWorkspaceOnboarding(env.root, {
      expected: review.revision,
      manifest: createWorkspaceManifest({
        name: 'mismatch',
        profile: 'engineering',
        by: 'agent',
        overrides: { instructions: '' },
      }),
      instruction: { path: 'AGENT.md', contents: '# Project instructions\n' },
    }), /must point to the reviewed instruction proposal/);
    assert.equal(loadWorkspaceManifest(env.root), null);
    assert.equal(fs.existsSync(path.join(env.root, 'AGENT.md')), false);
  } finally { env.cleanup(); }
});

test('reviewed onboarding rejects a revision from a different workspace root', () => {
  const env = workspace();
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-reviewed-other-'));
  try {
    const review = inspectWorkspaceOnboardingReview(env.root);
    assert.throws(() => commitReviewedWorkspaceOnboarding(otherRoot, {
      expected: review.revision,
      manifest: createWorkspaceManifest({ name: 'wrong-root', profile: 'engineering', by: 'wizard' }),
    }), /changed during review/);
    assert.equal(loadWorkspaceManifest(otherRoot), null);
  } finally {
    fs.rmSync(otherRoot, { recursive: true, force: true });
    env.cleanup();
  }
});
