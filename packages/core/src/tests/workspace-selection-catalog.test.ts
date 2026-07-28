import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWorkspaceManifest,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  workspaceManifestPath,
} from '../workspace/manifest.js';
import {
  buildWorkspaceSelectionCatalog,
  diagnoseWorkspaceToolSelectionMigration,
  isSelectableWorkspaceCatalogToolId,
  migrateWorkspaceManifestToolSelection,
  validateReviewedWorkspaceCapabilitySelection,
  validateReviewedWorkspaceRoleSelection,
  validateReviewedWorkspaceSkillSelection,
  validateReviewedWorkspaceToolSelection,
} from '../workspace/selectionCatalog.js';

test('P23-3b catalog projects safe roles, capabilities, tool groups, tools, skill packs, and skills', () => {
  const catalog = buildWorkspaceSelectionCatalog({
    runtimeTools: [{
      id: 'mcp_example_lookup',
      label: 'Example lookup',
      description: 'Live server tool',
    }],
  });

  const coding = catalog.entries.find((entry) => entry.kind === 'tool-group' && entry.id === 'coding');
  const projectKnowledge = catalog.entries.find((entry) =>
    entry.kind === 'tool-group' && entry.id === 'project-knowledge');
  const memoryContext = catalog.entries.find((entry) =>
    entry.kind === 'tool-group' && entry.id === 'memory-context');
  const architect = catalog.entries.find((entry) => entry.kind === 'role' && entry.id === 'architect');
  const frontend = catalog.entries.find((entry) => entry.kind === 'capability' && entry.id === 'frontend');
  const frontendPack = catalog.entries.find((entry) => entry.kind === 'skill-pack' && entry.id === 'frontend');
  const academicPaper = catalog.entries.find((entry) =>
    entry.kind === 'capability' && entry.id === 'academic-paper');
  const academicPaperPack = catalog.entries.find((entry) =>
    entry.kind === 'skill-pack' && entry.id === 'academic-paper');
  const computationalResearch = catalog.entries.find((entry) =>
    entry.kind === 'capability' && entry.id === 'computational-research');
  const dataVisualization = catalog.entries.find((entry) =>
    entry.kind === 'capability' && entry.id === 'data-visualization');
  const dataVisualizationPack = catalog.entries.find((entry) =>
    entry.kind === 'skill-pack' && entry.id === 'data-visualization');
  const programmingLab = catalog.entries.find((entry) =>
    entry.kind === 'capability' && entry.id === 'programming-lab');
  const programmingLabPack = catalog.entries.find((entry) =>
    entry.kind === 'skill-pack' && entry.id === 'programming-lab');
  const webSearch = catalog.entries.find((entry) => entry.kind === 'tool' && entry.id === 'web_search');
  const research = catalog.entries.find((entry) => entry.kind === 'skill-pack' && entry.id === 'research');
  const researchQuestion = catalog.entries.find((entry) => entry.kind === 'skill' && entry.id === 'research-question-skill');
  const runtimeTool = catalog.entries.find((entry) => entry.kind === 'runtime-tool');

  assert.ok(coding?.expandsTo?.includes('read_file'));
  assert.deepEqual(projectKnowledge?.expandsTo, ['mcp:knowledge_list', 'mcp:knowledge_search']);
  assert.deepEqual(memoryContext?.expandsTo, [
    'mcp:memory_recall',
    'mcp:memory_search',
    'mcp:memory_find_related',
    'mcp:memory_graph_query',
  ]);
  assert.equal(architect?.label, 'Architect');
  assert.equal(architect?.source, 'bundled');
  assert.equal(architect?.provenance, 'bundled-roles');
  assert.equal(frontend?.source, 'capability-plugin');
  assert.ok(frontend?.expandsTo?.includes('a11y-skill'));
  assert.ok(frontend?.expandsTo?.includes('artifacts'));
  assert.ok(frontend?.expandsTo?.includes('interactive-browser'));
  assert.equal(frontendPack?.managedByCapability, 'frontend');
  assert.ok(academicPaper?.expandsTo?.includes('academic-paper-drafting-skill'));
  assert.ok(academicPaper?.expandsTo?.includes('workspace-files'));
  assert.equal(academicPaperPack?.managedByCapability, 'academic-paper');
  assert.ok(computationalResearch?.expandsTo?.includes('data-analysis-skill'));
  assert.ok(computationalResearch?.expandsTo?.includes('shell'));
  assert.ok(dataVisualization?.expandsTo?.includes('data-visualization-skill'));
  assert.ok(dataVisualization?.expandsTo?.includes('interactive-browser'));
  assert.equal(dataVisualizationPack?.managedByCapability, 'data-visualization');
  assert.ok(programmingLab?.expandsTo?.includes('programming-lab-skill'));
  assert.ok(programmingLab?.expandsTo?.includes('shell'));
  assert.equal(programmingLabPack?.managedByCapability, 'programming-lab');
  assert.equal(webSearch?.source, 'core');
  assert.equal(webSearch?.accessTier, 'read');
  assert.equal(webSearch?.actionKind, 'network');
  assert.equal(research?.source, 'profile-plugin');
  assert.ok(research?.expandsTo?.includes('research-question-skill'));
  assert.equal(researchQuestion?.provenance, 'profile-research');
  assert.equal(runtimeTool?.persistable, false);
  assert.equal(runtimeTool?.selectable, false);
  assert.match(catalog.fingerprint, /^[a-f0-9]{64}$/);

  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /\/Users\/|\/home\/|Bearer\s|sk-[A-Za-z0-9]{16}/i);
  assert.doesNotMatch(serialized, /## Role:/);
});

test('P23-3b capability selections use contributed capability IDs and reject typos', () => {
  const catalog = buildWorkspaceSelectionCatalog();
  const valid = validateReviewedWorkspaceCapabilitySelection({
    enabled: [
      'frontend',
      'backend',
      'academic-paper',
      'computational-research',
      'data-visualization',
      'programming-lab',
    ],
    disabled: [],
  }, catalog);
  assert.equal(valid.ok, true);

  const invalid = validateReviewedWorkspaceCapabilitySelection({
    enabled: ['mobile'],
    disabled: [],
  }, catalog);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.deepEqual(invalid.issues.map((issue) => issue.code), ['unknown-entry']);
});

test('P23-3b role selections use the executable-role catalog and reject unknown IDs', () => {
  const catalog = buildWorkspaceSelectionCatalog();
  const valid = validateReviewedWorkspaceRoleSelection({
    availableRoles: ['explorer', 'worker'],
    disabledRoles: ['fleet'],
  }, catalog);
  assert.equal(valid.ok, true);

  const invalid = validateReviewedWorkspaceRoleSelection({
    availableRoles: ['invented'],
    disabledRoles: [],
  }, catalog);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.deepEqual(invalid.issues.map((issue) => issue.code), ['unknown-entry']);
});

test('P23-3b current runtime availability is visible but cannot grant a blocked tool', () => {
  const catalog = buildWorkspaceSelectionCatalog({
    availability: {
      computerUseAvailable: false,
      rootAgent: true,
      mcpDiscovery: false,
    },
  });
  const computerUse = catalog.entries.find((entry) => entry.kind === 'tool' && entry.id === 'computer_use');

  assert.equal(computerUse?.selectable, false);
  assert.match(computerUse?.blockedReason ?? '', /computer-use/);
  const reviewed = validateReviewedWorkspaceToolSelection({
    profiles: [],
    enabled: ['computer_use'],
    deny: [],
  }, catalog);
  assert.equal(reviewed.ok, false);
  if (!reviewed.ok) assert.equal(reviewed.issues[0]?.code, 'blocked-entry');
});

test('P23-3b runtime uses the same exact direct-tool eligibility as the catalog', () => {
  assert.equal(isSelectableWorkspaceCatalogToolId('web_search'), true);
  assert.equal(isSelectableWorkspaceCatalogToolId('delegate_agent'), true);
  assert.equal(isSelectableWorkspaceCatalogToolId('delegate_unreviewed'), false);
  assert.equal(isSelectableWorkspaceCatalogToolId('spawn_agent'), false);
  assert.equal(isSelectableWorkspaceCatalogToolId('<script>'), false);
});

test('P23-3b reviewed migration creates v3 without mutating a v2 workspace', () => {
  const catalog = buildWorkspaceSelectionCatalog();
  const legacy = createWorkspaceManifest({
    name: 'app',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-26T00:00:00.000Z',
  });
  const before = JSON.stringify(legacy);
  const migrated = migrateWorkspaceManifestToolSelection({
    manifest: legacy,
    reviewed: {
      profiles: ['coding', 'terminal'],
      enabled: ['web_search'],
      deny: ['computer_use'],
    },
    catalog,
    reviewedCatalogFingerprint: catalog.fingerprint,
  });

  assert.equal(JSON.stringify(legacy), before);
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.tools, {
    mode: 'explicit-catalog',
    profiles: ['coding', 'terminal'],
    enabled: ['web_search'],
    deny: ['computer_use'],
  });
});

test('P23-3b reviewed selections reject typos, hidden tools, and live runtime names', () => {
  const catalog = buildWorkspaceSelectionCatalog({
    runtimeTools: [{ id: 'mcp_example_lookup' }],
  });
  const result = validateReviewedWorkspaceToolSelection({
    profiles: ['codign'],
    enabled: ['spawn_agent', 'mcp_example_lookup'],
    deny: [],
  }, catalog);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.issues.map((issue) => issue.code).sort(),
      ['blocked-entry', 'not-persistable', 'unknown-entry'],
    );
  }
});

test('P23-3b stale catalog snapshots fail before migration', () => {
  const catalog = buildWorkspaceSelectionCatalog();
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'custom', by: 'wizard' });

  assert.throws(
    () => migrateWorkspaceManifestToolSelection({
      manifest,
      reviewed: { profiles: [], enabled: [], deny: [] },
      catalog,
      reviewedCatalogFingerprint: '0'.repeat(64),
    }),
    (error: unknown) => {
      const candidate = error as Error & { issues?: Array<{ code: string }> };
      return candidate.name === 'WorkspaceSelectionReviewError'
        && candidate.issues?.[0]?.code === 'stale-catalog';
    },
  );
});

test('P23-3b migration whitelists manifest fields instead of spreading hostile properties', () => {
  const catalog = buildWorkspaceSelectionCatalog();
  const hostile = createWorkspaceManifest({ name: 'app', profile: 'custom', by: 'wizard' });
  Object.defineProperty(hostile, '__proto__', {
    value: { polluted: true },
    enumerable: true,
  });

  const migrated = migrateWorkspaceManifestToolSelection({
    manifest: hostile,
    reviewed: { profiles: [], enabled: [], deny: [] },
    catalog,
  }) as WorkspaceManifestWithPollution;

  assert.equal(Object.getPrototypeOf(migrated), Object.prototype);
  assert.equal(migrated.polluted, undefined);
  assert.equal(Object.hasOwn(migrated, '__proto__'), false);
});

test('P23-3b skill selections use the same catalog and reject unknown IDs', () => {
  const catalog = buildWorkspaceSelectionCatalog();
  const valid = validateReviewedWorkspaceSkillSelection({
    packs: ['research'],
    enabled: ['planning-skill', 'research-question-skill'],
    disabled: ['research-review-skill'],
  }, catalog);
  assert.equal(valid.ok, true);

  const invalid = validateReviewedWorkspaceSkillSelection({
    packs: ['unknown-pack'],
    enabled: ['missing-skill'],
    disabled: [],
  }, catalog);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.deepEqual(invalid.issues.map((issue) => issue.code), ['unknown-entry', 'unknown-entry']);
});

test('P23-3b v2 diagnostics are content-free and loading does not infer v3', () => {
  const catalog = buildWorkspaceSelectionCatalog();
  const legacy = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  legacy.tools.profiles.push('future-tools');
  const diagnostic = diagnoseWorkspaceToolSelectionMigration(legacy, catalog);

  assert.deepEqual(diagnostic, {
    required: true,
    sourceVersion: 2,
    unknownProfileCount: 1,
    unknownEnabledCount: 0,
    blockedSelectionCount: 1,
  });
  assert.equal('mode' in legacy.tools, false);
  assert.equal('enabled' in legacy.tools, false);
});

test('P23-3b manifest v3 survives the normal save/load chokepoint', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-v3-tools-'));
  try {
    const catalog = buildWorkspaceSelectionCatalog();
    const migrated = migrateWorkspaceManifestToolSelection({
      manifest: createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
      reviewed: { profiles: ['coding'], enabled: ['web_search'], deny: ['run_command'] },
      catalog,
    });
    saveWorkspaceManifest(workspace, migrated);

    const loaded = loadWorkspaceManifest(workspace);
    assert.ok(loaded);
    assert.equal(loaded.version, 3);
    assert.deepEqual(loaded.tools, migrated.tools);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('P23-3b v3 normalization strips credentials and local paths from selections', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-v3-safe-'));
  try {
    fs.mkdirSync(path.dirname(workspaceManifestPath(workspace)), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(workspace), JSON.stringify({
      version: 3,
      profile: 'custom',
      tools: {
        mode: 'explicit-catalog',
        profiles: ['coding', '/Users/example/private'],
        enabled: ['web_search', 'Bearer private-token'],
        deny: ['computer_use', 'sk-abcdefghijklmnopqrstuvwxyz'],
      },
    }));

    assert.deepEqual(loadWorkspaceManifest(workspace)?.tools, {
      mode: 'explicit-catalog',
      profiles: ['coding'],
      enabled: ['web_search'],
      deny: ['computer_use'],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

type WorkspaceManifestWithPollution = ReturnType<typeof createWorkspaceManifest> & {
  polluted?: boolean;
};
