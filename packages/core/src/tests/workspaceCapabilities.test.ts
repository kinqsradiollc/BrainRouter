/**
 * ADR-021 W4 — dynamic workspace capabilities remain task-scoped, respect
 * explicit disables, and are an exact no-op for legacy workspaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceCapabilities } from '../workspace/capabilities.js';
import { createWorkspaceManifest } from '../workspace/manifest.js';

const EMPTY_RESOLUTION = {
  active: [],
  reasons: [],
  skillPacks: [],
  skills: [],
  toolProfiles: [],
  promptBlocks: [],
};

const FRONTEND_AVAILABILITY = {
  skillPacks: ['frontend'],
  skills: ['a11y-skill', 'browser-testing-skill', 'taste-skill'],
  toolProfiles: ['browser', 'design'],
};

test('no manifest is an exact capability no-op even for a frontend task', () => {
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: null,
      task: 'Build a responsive React dashboard.',
      files: ['src/components/Dashboard.tsx'],
    }),
    EMPTY_RESOLUTION,
  );
});

test('engineering activates frontend contributions from task signals without changing persona', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    task: 'Improve the responsive user interface.',
    availability: FRONTEND_AVAILABILITY,
  });

  assert.deepEqual(resolved.active, ['frontend']);
  assert.ok(resolved.reasons.includes('task describes user-interface work'));
  assert.deepEqual(resolved.skillPacks, ['frontend']);
  assert.ok(resolved.skills.includes('a11y-skill'));
  assert.ok(resolved.skills.includes('browser-testing-skill'));
  assert.deepEqual(resolved.toolProfiles, ['browser', 'design']);
  assert.equal(resolved.promptBlocks.length, 1);
  assert.match(resolved.promptBlocks[0]!, /Stay in the engineer persona/);
  assert.deepEqual(manifest.agents, { default: 'engineer', enabled: ['engineer'] });
});

test('frontend source and configuration files activate the capability deterministically', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    files: ['src/App.tsx', 'tailwind.config.ts', 'DESIGN.md'],
  });

  assert.deepEqual(resolved.active, ['frontend']);
  assert.deepEqual(resolved.reasons, [
    'task includes a frontend source or presentation file',
    'task includes a frontend build or styling configuration',
  ]);
});

test('frontend file paths named in task text activate without a separate file list', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    task: 'Please repair src/components/Card.tsx and then verify it.',
  });

  assert.deepEqual(resolved.active, ['frontend']);
  assert.deepEqual(resolved.reasons, ['task names a frontend source or presentation file']);
});

test('irrelevant signals leave an enabled capability inactive', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  assert.deepEqual(
    resolveWorkspaceCapabilities({ manifest, task: 'Optimize a database query.', files: ['src/store/query.sql'] }),
    EMPTY_RESOLUTION,
  );
});

test('ambiguous backend component language and paths do not activate frontend', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest,
      task: 'Refactor the responsive component registry, navigation graph, and theme tokens.',
      files: ['src/backend/components/registry.ts'],
      availability: FRONTEND_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
});

test('the ordinary verb react is not treated as the React framework without a frontend co-signal', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest,
      task: 'React to the API outage and summarize the incident.',
      availability: FRONTEND_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest,
      task: 'Build a React component for the incident dashboard.',
      availability: FRONTEND_AVAILABILITY,
    }).active,
    ['frontend'],
  );
});

test('frontend requires an enabled engineer to be the active domain agent', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'research', by: 'wizard' });
  manifest.capabilities.enabled.push('frontend');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest,
      task: 'Build a React research dashboard.',
      availability: FRONTEND_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );

  manifest.agents.enabled.push('engineer');
  const delegated = resolveWorkspaceCapabilities({
    manifest,
    activeAgent: 'engineer',
    task: 'Build a React research dashboard.',
    availability: FRONTEND_AVAILABILITY,
  });
  assert.deepEqual(delegated.active, ['frontend']);
});

test('live availability filters capability contributions and prevents phantom ids', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  const withoutCatalog = resolveWorkspaceCapabilities({ manifest, task: 'Fix the React dashboard.' });
  assert.deepEqual(withoutCatalog.active, ['frontend']);
  assert.deepEqual(withoutCatalog.skillPacks, []);
  assert.deepEqual(withoutCatalog.skills, []);
  assert.deepEqual(withoutCatalog.toolProfiles, []);
  assert.equal(withoutCatalog.promptBlocks.length, 1);

  const partialCatalog = resolveWorkspaceCapabilities({
    manifest,
    task: 'Fix the React dashboard.',
    availability: { skills: ['taste-skill', 'unrelated-skill'], toolProfiles: ['browser'] },
  });
  assert.deepEqual(partialCatalog.skillPacks, []);
  assert.deepEqual(partialCatalog.skills, ['taste-skill']);
  assert.deepEqual(partialCatalog.toolProfiles, ['browser']);
});

test('explicit disable wins over enabled values and matching signals', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  manifest.capabilities.disabled.push('frontend');

  assert.deepEqual(
    resolveWorkspaceCapabilities({ manifest, task: 'Build a React component.', files: ['src/Card.tsx'] }),
    EMPTY_RESOLUTION,
  );
});

test('unknown enabled capabilities are preserved but safely inactive', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'custom', by: 'wizard' });
  manifest.capabilities.enabled.push('future-capability');

  assert.deepEqual(resolveWorkspaceCapabilities({ manifest, task: 'Use the future capability.' }), EMPTY_RESOLUTION);
  assert.deepEqual(manifest.capabilities.enabled, ['future-capability'], 'resolver does not mutate manifest data');
});
