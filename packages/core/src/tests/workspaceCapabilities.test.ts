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
  // ADR-031 D1 — `hallmark` is the vendored design skill, carried by the shipped
  // library rather than the pack, and named by the capability like the rest.
  skills: ['a11y-skill', 'browser-testing-skill', 'hallmark'],
  toolProfiles: ['browser', 'artifacts', 'interactive-browser'],
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
  toolProfiles: ['coding', 'shell', 'artifacts'],
};

const ACADEMIC_PAPER_AVAILABILITY = {
  skillPacks: ['academic-paper'],
  skills: [
    'source-synthesis-skill',
    'citation-verification-skill',
    'academic-paper-drafting-skill',
    'academic-paper-review-skill',
  ],
  toolProfiles: [
    'workspace-files',
    'browser',
    'research-browser',
    'research-notes',
    'artifacts',
  ],
};

const COMPUTATIONAL_RESEARCH_AVAILABILITY = {
  skillPacks: ['computational-research'],
  skills: ['data-analysis-skill', 'experiment-validation-skill'],
  toolProfiles: ['coding', 'shell', 'browser', 'research-notes', 'artifacts'],
};

const DATA_VISUALIZATION_AVAILABILITY = {
  skillPacks: ['data-visualization'],
  skills: ['data-visualization-skill'],
  toolProfiles: ['coding', 'shell', 'artifacts', 'interactive-browser'],
};

const PROGRAMMING_LAB_AVAILABILITY = {
  skillPacks: ['programming-lab'],
  skills: ['programming-lab-skill'],
  toolProfiles: ['coding', 'shell', 'artifacts'],
};

const TECHNICAL_DOCUMENTATION_AVAILABILITY = {
  skillPacks: ['technical-documentation'],
  skills: ['technical-documentation-skill'],
  toolProfiles: ['workspace-files', 'shell', 'browser', 'artifacts'],
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
  assert.ok(resolved.skills.includes('hallmark'));
  assert.deepEqual(resolved.toolProfiles, ['browser', 'artifacts', 'interactive-browser']);
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
  assert.deepEqual(resolved.toolProfiles, ['coding', 'shell', 'artifacts']);
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

test('Writing activates academic-paper workflows without changing persona', () => {
  const manifest = createWorkspaceManifest({ name: 'paper', profile: 'writing', by: 'wizard' });
  manifest.capabilities.enabled.push('academic-paper');
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    task: 'Revise this research paper and perform a citation audit.',
    files: ['paper/main.tex', 'paper/references.bib'],
    availability: ACADEMIC_PAPER_AVAILABILITY,
  });

  assert.deepEqual(resolved.active, ['academic-paper']);
  assert.deepEqual(resolved.reasons, [
    'task describes academic-paper work',
    'task includes an academic manuscript or citation file',
  ]);
  assert.deepEqual(resolved.skillPacks, ['academic-paper']);
  assert.deepEqual(resolved.skills, ACADEMIC_PAPER_AVAILABILITY.skills);
  assert.deepEqual(resolved.toolProfiles, [
    'workspace-files', 'browser', 'research-browser', 'research-notes', 'artifacts',
  ]);
  assert.match(resolved.promptBlocks[0]!, /Stay in the writer persona/);
  assert.deepEqual(manifest.persona, { default: 'writer', enabled: ['writer'] });
});

test('academic-paper capability rejects incompatible profiles and explicit disable', () => {
  const research = createWorkspaceManifest({ name: 'research', profile: 'research', by: 'wizard' });
  research.capabilities.enabled.push('academic-paper');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: research,
      task: 'Draft an academic paper.',
      availability: ACADEMIC_PAPER_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );

  const writing = createWorkspaceManifest({ name: 'paper', profile: 'writing', by: 'wizard' });
  writing.capabilities.enabled.push('academic-paper');
  writing.capabilities.disabled.push('academic-paper');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: writing,
      task: 'Draft an academic paper.',
      availability: ACADEMIC_PAPER_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
});

test('Research and Data Science activate computational-research workflows', () => {
  for (const profile of ['research', 'data-science'] as const) {
    const manifest = createWorkspaceManifest({ name: profile, profile, by: 'wizard' });
    manifest.capabilities.enabled.push('computational-research');
    const resolved = resolveWorkspaceCapabilities({
      manifest,
      task: 'Run a reproducible computational analysis with uncertainty and limitations.',
      files: ['analysis/model.ipynb'],
      availability: COMPUTATIONAL_RESEARCH_AVAILABILITY,
    });

    assert.deepEqual(resolved.active, ['computational-research']);
    assert.deepEqual(resolved.reasons, [
      'task describes computational research',
      'task includes a computational research file',
    ]);
    assert.deepEqual(resolved.skillPacks, ['computational-research']);
    assert.deepEqual(resolved.skills, COMPUTATIONAL_RESEARCH_AVAILABILITY.skills);
    assert.deepEqual(resolved.toolProfiles, [
      'coding', 'shell', 'browser', 'research-notes', 'artifacts',
    ]);
    assert.match(resolved.promptBlocks[0]!, /Preserve the active domain persona/);
    assert.equal(
      manifest.persona.default,
      profile === 'research' ? 'researcher' : 'data-scientist',
    );
  }
});

test('computational-research rejects incompatible personas and explicit disable', () => {
  const study = createWorkspaceManifest({ name: 'study', profile: 'study', by: 'wizard' });
  study.capabilities.enabled.push('computational-research');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: study,
      task: 'Run a reproducible computational analysis.',
      availability: COMPUTATIONAL_RESEARCH_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );

  const research = createWorkspaceManifest({ name: 'research', profile: 'research', by: 'wizard' });
  research.capabilities.enabled.push('computational-research');
  research.capabilities.disabled.push('computational-research');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: research,
      task: 'Run a reproducible computational analysis.',
      availability: COMPUTATIONAL_RESEARCH_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
});

test('Data Science activates data visualization without changing persona', () => {
  const manifest = createWorkspaceManifest({
    name: 'visual-analysis',
    profile: 'data-science',
    by: 'wizard',
  });
  manifest.capabilities.enabled.push('data-visualization');
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    task: 'Build an accessible analytical dashboard and audit every chart scale.',
    files: ['visualizations/retention.vega.json'],
    availability: DATA_VISUALIZATION_AVAILABILITY,
  });

  assert.deepEqual(resolved.active, ['data-visualization']);
  assert.deepEqual(resolved.reasons, [
    'task describes data-visualization work',
    'task includes a visualization artifact',
  ]);
  assert.deepEqual(resolved.skillPacks, ['data-visualization']);
  assert.deepEqual(resolved.skills, ['data-visualization-skill']);
  assert.deepEqual(resolved.toolProfiles, [
    'coding', 'shell', 'artifacts', 'interactive-browser',
  ]);
  assert.match(resolved.promptBlocks[0]!, /Stay in the data-scientist persona/);
  assert.deepEqual(manifest.persona, {
    default: 'data-scientist',
    enabled: ['data-scientist'],
  });
});

test('data-visualization rejects incompatible profiles and explicit disable', () => {
  const research = createWorkspaceManifest({
    name: 'research',
    profile: 'research',
    by: 'wizard',
  });
  research.capabilities.enabled.push('data-visualization');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: research,
      task: 'Build an analytical dashboard.',
      availability: DATA_VISUALIZATION_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );

  const data = createWorkspaceManifest({
    name: 'data',
    profile: 'data-science',
    by: 'wizard',
  });
  data.capabilities.enabled.push('data-visualization');
  data.capabilities.disabled.push('data-visualization');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: data,
      task: 'Build an analytical dashboard.',
      availability: DATA_VISUALIZATION_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
});

test('Study activates a programming lab without changing the tutor persona', () => {
  const manifest = createWorkspaceManifest({
    name: 'coding-course',
    profile: 'study',
    by: 'wizard',
  });
  manifest.capabilities.enabled.push('programming-lab');
  const resolved = resolveWorkspaceCapabilities({
    manifest,
    task: 'Create a guided coding exercise with progressive hints and tests.',
    files: ['exercises/parser.ts'],
    availability: PROGRAMMING_LAB_AVAILABILITY,
  });

  assert.deepEqual(resolved.active, ['programming-lab']);
  assert.deepEqual(resolved.reasons, [
    'task describes a programming lab',
    'task includes a programming source file',
  ]);
  assert.deepEqual(resolved.skillPacks, ['programming-lab']);
  assert.deepEqual(resolved.skills, ['programming-lab-skill']);
  assert.deepEqual(resolved.toolProfiles, ['coding', 'shell', 'artifacts']);
  assert.match(resolved.promptBlocks[0]!, /Stay in the tutor persona/);
  assert.deepEqual(manifest.persona, { default: 'tutor', enabled: ['tutor'] });
});

test('programming-lab rejects incompatible profiles and explicit disable', () => {
  const engineering = createWorkspaceManifest({
    name: 'app',
    profile: 'engineering',
    by: 'wizard',
  });
  engineering.capabilities.enabled.push('programming-lab');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: engineering,
      task: 'Create a coding exercise.',
      availability: PROGRAMMING_LAB_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );

  const study = createWorkspaceManifest({
    name: 'course',
    profile: 'study',
    by: 'wizard',
  });
  study.capabilities.enabled.push('programming-lab');
  study.capabilities.disabled.push('programming-lab');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: study,
      task: 'Create a coding exercise.',
      availability: PROGRAMMING_LAB_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
});

test('Engineering and Writing activate technical documentation without changing persona', () => {
  for (const profile of ['engineering', 'writing'] as const) {
    const manifest = createWorkspaceManifest({ name: profile, profile, by: 'wizard' });
    manifest.capabilities.enabled.push('technical-documentation');
    const resolved = resolveWorkspaceCapabilities({
      manifest,
      task: 'Write repository-grounded developer documentation with runnable examples.',
      files: ['docs/guides/integration.md'],
      availability: TECHNICAL_DOCUMENTATION_AVAILABILITY,
    });

    assert.deepEqual(resolved.active, ['technical-documentation']);
    assert.deepEqual(resolved.reasons, [
      'task describes technical-documentation work',
      'task includes a technical-documentation artifact',
    ]);
    assert.deepEqual(resolved.skillPacks, ['technical-documentation']);
    assert.deepEqual(resolved.skills, ['technical-documentation-skill']);
    assert.deepEqual(resolved.toolProfiles, [
      'workspace-files', 'shell', 'browser', 'artifacts',
    ]);
    assert.match(resolved.promptBlocks[0]!, /Preserve the active engineer or writer persona/);
    assert.equal(
      manifest.persona.default,
      profile === 'engineering' ? 'engineer' : 'writer',
    );
  }
});

test('technical-documentation rejects incompatible personas and explicit disable', () => {
  const study = createWorkspaceManifest({ name: 'study', profile: 'study', by: 'wizard' });
  study.capabilities.enabled.push('technical-documentation');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: study,
      task: 'Write API documentation.',
      availability: TECHNICAL_DOCUMENTATION_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );

  const writing = createWorkspaceManifest({
    name: 'writing',
    profile: 'writing',
    by: 'wizard',
  });
  writing.capabilities.enabled.push('technical-documentation');
  writing.capabilities.disabled.push('technical-documentation');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: writing,
      task: 'Write API documentation.',
      availability: TECHNICAL_DOCUMENTATION_AVAILABILITY,
    }),
    EMPTY_RESOLUTION,
  );
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
      toolProfiles: [
        'browser', 'artifacts', 'interactive-browser', 'coding', 'shell',
      ],
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

test('frontend requires both a compatible profile and an enabled engineer persona', () => {
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
  assert.deepEqual(delegated, EMPTY_RESOLUTION);

  const custom = createWorkspaceManifest({ name: 'custom', profile: 'custom', by: 'wizard' });
  custom.persona = { default: 'engineer', enabled: ['engineer'] };
  custom.capabilities.enabled.push('frontend');
  assert.deepEqual(
    resolveWorkspaceCapabilities({
      manifest: custom,
      task: 'Build a React research dashboard.',
      availability: FRONTEND_AVAILABILITY,
    }).active,
    ['frontend'],
  );
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
    availability: { skills: ['a11y-skill', 'unrelated-skill'], toolProfiles: ['browser'] },
  });
  assert.deepEqual(partialCatalog.skillPacks, []);
  assert.deepEqual(partialCatalog.skills, ['a11y-skill']);
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
