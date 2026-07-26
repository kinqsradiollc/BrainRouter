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

const BACKEND_AVAILABILITY = {
  skillPacks: ['backend'],
  skills: [
    'api-service-design-skill',
    'authorization-boundary-skill',
    'data-integrity-migration-skill',
    'background-work-skill',
    'production-readiness-skill',
    'backend-testing-skill',
  ],
  toolProfiles: ['coding', 'terminal'],
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

test('engineering activates backend workflows without changing persona', () => {
  const manifest = createWorkspaceManifest({ name: 'service', profile: 'engineering', by: 'wizard' });
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    task: 'Add an authenticated REST endpoint backed by a database migration.',
    availability: BACKEND_AVAILABILITY,
  });

  assert.deepEqual(resolved.active, ['backend']);
  assert.ok(resolved.reasons.includes('task describes server or API work'));
  assert.ok(resolved.reasons.includes('task names a backend trust or persistence concern'));
  assert.deepEqual(resolved.skillPacks, ['backend']);
  assert.deepEqual(resolved.skills, BACKEND_AVAILABILITY.skills);
  assert.deepEqual(resolved.toolProfiles, ['coding', 'terminal']);
  assert.match(resolved.promptBlocks[0]!, /Stay in the engineer persona/);
  assert.deepEqual(manifest.persona, { default: 'engineer', enabled: ['engineer'] });
});

test('backend source, migration, and deployment files activate deterministically', () => {
  const manifest = createWorkspaceManifest({ name: 'service', profile: 'engineering', by: 'wizard' });
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    files: [
      'src/server/routes/users.ts',
      'migrations/20260726_add_users.sql',
      'deploy/helm/api/values.yaml',
    ],
  });

  assert.deepEqual(resolved.active, ['backend']);
  assert.deepEqual(resolved.reasons, [
    'task includes a backend service or persistence file',
    'task includes backend deployment or operations configuration',
  ]);
});

test('full-stack work may activate frontend and backend under one engineer persona', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    task: 'Build a React settings form and the authenticated API endpoint that saves it.',
    files: ['src/settings/Form.tsx', 'src/server/routes/settings.ts'],
    availability: {
      skillPacks: ['frontend', 'backend'],
      skills: [...FRONTEND_AVAILABILITY.skills, ...BACKEND_AVAILABILITY.skills],
      toolProfiles: ['browser', 'design', 'coding', 'terminal'],
    },
  });

  assert.deepEqual(resolved.active, ['frontend', 'backend']);
  assert.equal(new Set(resolved.skills).size, resolved.skills.length);
  assert.equal(resolved.promptBlocks.length, 2);
  assert.ok(resolved.promptBlocks.every((block) => block.includes('engineer persona')));
});

test('irrelevant signals leave an enabled capability inactive', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  assert.deepEqual(
    resolveWorkspaceCapabilities({ manifest, task: 'Rename a local parser helper.', files: ['src/parser.ts'] }),
    EMPTY_RESOLUTION,
  );
});

test('generic session, token, repository, and metrics language does not imply backend work', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest,
      task: 'Summarize this session token budget and repository metrics.',
      files: ['README.md'],
      availability: BACKEND_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
});

test('ambiguous backend component language and paths do not activate frontend', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    task: 'Refactor the responsive component registry, navigation graph, and theme tokens.',
    files: ['src/backend/components/registry.ts'],
    availability: FRONTEND_AVAILABILITY,
  });
  assert.deepEqual(resolved.active, ['backend']);
  assert.equal(resolved.active.includes('frontend'), false);
});

test('the ordinary verb react is not treated as the React framework without a frontend co-signal', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  const incident = resolveWorkspaceCapabilities({
    manifest,
    task: 'React to the API outage and summarize the incident.',
    availability: FRONTEND_AVAILABILITY,
  });
  assert.deepEqual(incident.active, ['backend']);
  assert.equal(incident.active.includes('frontend'), false);
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

test('backend requires an enabled engineer and respects explicit disable', () => {
  const research = createWorkspaceManifest({ name: 'research', profile: 'research', by: 'wizard' });
  research.capabilities.enabled.push('backend');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: research,
      task: 'Add an API endpoint.',
      availability: BACKEND_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );

  const engineering = createWorkspaceManifest({ name: 'service', profile: 'engineering', by: 'wizard' });
  engineering.capabilities.disabled.push('backend');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: engineering,
      task: 'Add an API endpoint.',
      availability: BACKEND_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
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
