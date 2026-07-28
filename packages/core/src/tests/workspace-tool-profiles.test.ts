import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceCapabilities } from '../workspace/capabilities.js';
import { createWorkspaceManifest } from '../workspace/manifest.js';
import {
  resolveWorkspaceToolSelection,
  workspaceDynamicMcpAllowed,
  workspaceMcpToolAllowed,
  workspaceToolAllowed,
  workspaceToolProfileIds,
} from '../workspace/toolProfiles.js';

const allowed = (
  selection: ReturnType<typeof resolveWorkspaceToolSelection>,
  toolId: string,
  extensionId?: string,
) => workspaceToolAllowed(selection, { toolId, extensionId });
const mcpAllowed = (
  selection: ReturnType<typeof resolveWorkspaceToolSelection>,
  toolId: string,
  brainrouterOwned = true,
) => workspaceMcpToolAllowed(selection, { toolId, brainrouterOwned });

test('missing manifests preserve every existing tool decision exactly', () => {
  const selection = resolveWorkspaceToolSelection({ manifest: null });
  assert.equal(selection.managed, false);
  assert.equal(allowed(selection, 'write_file', 'filesystem'), true);
  assert.equal(allowed(selection, 'browser_screenshot', 'browser'), true);
});

test('engineering defaults include production, planning, and orchestration without high-authority integrations', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.deepEqual(selection.activeProfileIds, [
    'coding', 'shell', 'browser', 'project-knowledge', 'memory-context',
    'artifacts', 'planning-session', 'orchestration',
    'pull-request-observation',
  ]);
  assert.equal(allowed(selection, 'edit_file', 'filesystem'), true);
  assert.equal(allowed(selection, 'run_command', 'shell'), true);
  assert.equal(allowed(selection, 'web_search', 'web-research'), true);
  assert.equal(allowed(selection, 'artifact_write', 'planning-state'), true);
  assert.equal(allowed(selection, 'computer_use', 'computer-control'), false);
  assert.equal(allowed(selection, 'connector_run', 'connectors'), false);
  assert.equal(allowed(selection, 'browser_screenshot', 'browser'), false);
  assert.equal(allowed(selection, 'pull_request_watch', 'pull-request-observer'), true);
});

test('frontend task profiles add interactive browser tools without changing the manifest', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  const before = JSON.stringify(manifest);
  const selection = resolveWorkspaceToolSelection({
    manifest,
    activeToolProfiles: ['browser', 'artifacts', 'interactive-browser'],
  });

  assert.deepEqual(selection.activeProfileIds, [
    'coding', 'shell', 'browser', 'project-knowledge', 'memory-context', 'artifacts',
    'planning-session', 'orchestration', 'pull-request-observation',
    'interactive-browser',
  ]);
  assert.equal(allowed(selection, 'browser_screenshot', 'browser'), true);
  assert.equal(allowed(selection, 'artifact_write', 'planning-state'), true);
  assert.equal(JSON.stringify(manifest), before, 'task resolution never mutates reviewed workspace state');
});

test('research profiles can inspect and author workspace files without code or shell authority', () => {
  const manifest = createWorkspaceManifest({ name: 'sources', profile: 'research', by: 'wizard' });
  manifest.version = 3;
  manifest.tools.mode = 'explicit-catalog';
  manifest.tools.enabled = [];
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.equal(allowed(selection, 'list_dir', 'filesystem'), true);
  assert.equal(allowed(selection, 'glob_files', 'filesystem'), true);
  assert.equal(allowed(selection, 'write_file', 'filesystem'), true);
  assert.equal(allowed(selection, 'apply_patch', 'filesystem'), true);
  assert.equal(allowed(selection, 'fetch_url', 'web-research'), true);
  assert.equal(allowed(selection, 'research_note', 'web-research'), true);
  assert.equal(allowed(selection, 'artifact_write', 'planning-state'), true);
  assert.equal(allowed(selection, 'browser_snapshot', 'browser'), true);
  assert.equal(allowed(selection, 'browser_click', 'browser'), true);
  assert.equal(allowed(selection, 'browser_type', 'browser'), true);
  assert.equal(allowed(selection, 'browser_close_tab', 'browser'), true);
  assert.equal(allowed(selection, 'browser_upload_files', 'browser'), false);
  assert.equal(allowed(selection, 'browser_permission', 'browser'), false);
  assert.equal(allowed(selection, 'browser_set_device', 'browser'), false);
  assert.equal(allowed(selection, 'browser_run_flow', 'browser'), false);
  assert.equal(allowed(selection, 'notebook_edit', 'filesystem'), false);
  assert.equal(allowed(selection, 'lsp', 'filesystem'), false);
  assert.equal(allowed(selection, 'run_command', 'shell'), false);
  assert.equal(mcpAllowed(selection, 'knowledge_list'), true);
  assert.equal(mcpAllowed(selection, 'knowledge_search'), true);
  assert.equal(mcpAllowed(selection, 'knowledge_ingest'), false);
  assert.equal(mcpAllowed(selection, 'knowledge_search', false), false);
});

test('study and writing profiles can produce folder-backed learning and writing material', () => {
  for (const profile of ['study', 'writing'] as const) {
    const manifest = createWorkspaceManifest({ name: profile, profile, by: 'wizard' });
    manifest.version = 3;
    manifest.tools.mode = 'explicit-catalog';
    manifest.tools.enabled = [];
    const selection = resolveWorkspaceToolSelection({ manifest });

    assert.equal(allowed(selection, 'list_dir', 'filesystem'), true, `${profile}: list`);
    assert.equal(allowed(selection, 'read_file', 'filesystem'), true, `${profile}: read`);
    assert.equal(allowed(selection, 'write_file', 'filesystem'), true, `${profile}: write`);
    assert.equal(allowed(selection, 'artifact_write', 'planning-state'), true, `${profile}: artifact`);
    assert.equal(allowed(selection, 'notebook_edit', 'filesystem'), false, `${profile}: notebook`);
    assert.equal(allowed(selection, 'lsp', 'filesystem'), false, `${profile}: lsp`);
    assert.equal(allowed(selection, 'run_command', 'shell'), false, `${profile}: shell`);
    assert.equal(allowed(selection, 'delegate_agent'), true, `${profile}: orchestration`);
    assert.equal(mcpAllowed(selection, 'memory_search'), true, `${profile}: memory search`);
    assert.equal(mcpAllowed(selection, 'memory_graph_query'), true, `${profile}: memory graph`);
  }
});

test('custom empty profiles hide registered groups but retain baseline and unknown extension tools', () => {
  const manifest = createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' });
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.equal(allowed(selection, 'write_file', 'filesystem'), false);
  assert.equal(allowed(selection, 'web_search', 'web-research'), false);
  assert.equal(allowed(selection, 'read_file', 'filesystem'), true);
  assert.equal(allowed(selection, 'update_plan', 'planning-state'), true);
  assert.equal(allowed(selection, 'custom_extension_tool', 'custom-extension'), true);
});

test('explicit tool and extension denies win over selected profiles', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  manifest.tools.deny = ['run_command', 'browser'];
  const selection = resolveWorkspaceToolSelection({ manifest, activeToolProfiles: ['design'] });

  assert.equal(allowed(selection, 'run_command', 'shell'), false);
  assert.equal(allowed(selection, 'kill_command', 'shell'), true);
  assert.equal(allowed(selection, 'browser_screenshot', 'browser'), false);
  assert.equal(allowed(selection, 'artifact_write', 'planning-state'), true);
});

test('unknown profile ids never grant a registered tool group', () => {
  const manifest = createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' });
  manifest.tools.profiles = ['future-tools'];
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.deepEqual(selection.activeProfileIds, []);
  assert.equal(allowed(selection, 'write_file', 'filesystem'), false);
  assert.deepEqual(workspaceToolProfileIds(), [
    'workspace-files', 'coding', 'shell', 'browser', 'research-browser',
    'project-knowledge', 'memory-context', 'research-notes', 'artifacts',
    'planning-session', 'orchestration', 'interactive-browser',
    'mcp-resources', 'connectors', 'computer-control', 'workflow-launch',
    'background-workers', 'pull-request-observation', 'security-review',
    'terminal', 'notes', 'design',
  ]);
});

test('v3 activates only tool groups implied by a reviewed task capability', () => {
  const fixtures = [
    {
      profile: 'engineering',
      capability: 'frontend',
      task: 'Improve the responsive user interface.',
      expected: ['browser', 'artifacts', 'interactive-browser'],
      requiredTool: ['browser_run_flow', 'browser'],
    },
    {
      profile: 'writing',
      capability: 'academic-paper',
      task: 'Audit the citations and revise this academic paper.',
      expected: [
        'workspace-files', 'browser', 'research-browser', 'research-notes', 'artifacts',
      ],
      requiredTool: ['browser_snapshot', undefined],
    },
    {
      profile: 'research',
      capability: 'computational-research',
      task: 'Run a reproducible computational analysis for this research question.',
      expected: ['coding', 'shell', 'browser', 'research-notes', 'artifacts'],
      requiredTool: ['run_command', undefined],
    },
    {
      profile: 'data-science',
      capability: 'data-visualization',
      task: 'Create and visually verify a data visualization dashboard.',
      expected: ['coding', 'shell', 'artifacts', 'interactive-browser'],
      requiredTool: ['browser_run_flow', 'browser'],
    },
    {
      profile: 'study',
      capability: 'programming-lab',
      task: 'Create an executable programming lab with tests.',
      expected: ['coding', 'shell', 'artifacts'],
      requiredTool: ['run_command', undefined],
    },
    {
      profile: 'writing',
      capability: 'technical-documentation',
      task: 'Write repository-grounded technical documentation with runnable examples.',
      expected: ['workspace-files', 'shell', 'browser', 'artifacts'],
      requiredTool: ['run_command', undefined],
    },
  ] as const;

  for (const fixture of fixtures) {
    const manifest = createWorkspaceManifest({
      name: fixture.profile,
      profile: fixture.profile,
      by: 'wizard',
    });
    manifest.version = 3;
    manifest.tools.mode = 'explicit-catalog';
    if (!manifest.capabilities.enabled.includes(fixture.capability)) {
      manifest.capabilities.enabled.push(fixture.capability);
    }
    const capability = resolveWorkspaceCapabilities({
      manifest,
      task: fixture.task,
      availability: {
        skillPacks: [],
        skills: [],
        toolProfiles: fixture.expected,
      },
    });
    assert.deepEqual(capability.active, [fixture.capability], fixture.profile);
    assert.deepEqual(capability.toolProfiles, fixture.expected, fixture.profile);

    const selection = resolveWorkspaceToolSelection({
      manifest,
      activeToolProfiles: capability.toolProfiles,
    });
    assert.equal(
      allowed(selection, fixture.requiredTool[0], fixture.requiredTool[1]),
      true,
      `${fixture.profile}: ${fixture.requiredTool[0]}`,
    );
  }
});

test('an existing reviewed Research folder keeps its selected production tools after catalog expansion', () => {
  const manifest = createWorkspaceManifest({
    name: 'EconomicsResearch',
    profile: 'research',
    by: 'wizard',
  });
  manifest.version = 3;
  manifest.tools = {
    mode: 'explicit-catalog',
    profiles: [
      'workspace-files',
      'browser',
      'research-notes',
      'artifacts',
      'planning-session',
      'orchestration',
    ],
    enabled: [],
    deny: [],
  };

  const selection = resolveWorkspaceToolSelection({ manifest });
  for (const toolId of [
    'read_file',
    'list_dir',
    'grep_search',
    'glob_files',
    'write_file',
    'edit_file',
    'apply_patch',
    'research_note',
    'artifact_write',
    'update_plan',
    'delegate_agent',
  ]) {
    assert.equal(allowed(selection, toolId), true, toolId);
  }
  assert.equal(allowed(selection, 'run_command'), false);
  assert.equal(allowed(selection, 'browser_snapshot'), false);
  assert.equal(mcpAllowed(selection, 'knowledge_search'), false);
});

test('v3 rejects arbitrary, incompatible, and disabled capability tool additions', () => {
  const manifest = createWorkspaceManifest({
    name: 'research',
    profile: 'research',
    by: 'wizard',
  });
  manifest.version = 3;
  manifest.tools.mode = 'explicit-catalog';
  manifest.capabilities.enabled.push('computational-research');
  manifest.capabilities.disabled.push('computational-research');

  const selection = resolveWorkspaceToolSelection({
    manifest,
    activeToolProfiles: [
      'coding',
      'shell',
      'interactive-browser',
      'computer-control',
      'security-review',
    ],
  });

  assert.equal(allowed(selection, 'run_command', 'shell'), false);
  assert.equal(allowed(selection, 'browser_run_flow', 'browser'), false);
  assert.equal(allowed(selection, 'computer_use', 'computer-control'), false);
  assert.equal(allowed(selection, 'file_vulnerability'), false);
  assert.equal(selection.activeProfileIds.includes('coding'), false);
});

test('manifest v3 engineering defaults expose the reviewed matrix and keep advanced groups closed', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  manifest.version = 3;
  manifest.tools.mode = 'explicit-catalog';
  manifest.tools.enabled = [];
  const selection = resolveWorkspaceToolSelection({ manifest });

  for (const toolId of [
    'read_file', 'edit_file', 'run_command', 'web_search', 'artifact_write',
    'update_plan', 'route_task', 'delegate_agent',
  ]) {
    assert.equal(allowed(selection, toolId), true, toolId);
  }
  for (const toolId of [
    'computer_use', 'connector_run', 'mcp_call',
    'run_workflow', 'spawn_worker_thread', 'file_vulnerability',
  ]) {
    assert.equal(allowed(selection, toolId), false, toolId);
  }
  for (const toolId of [
    'memory_recall', 'memory_search', 'memory_find_related', 'memory_graph_query',
  ]) {
    assert.equal(mcpAllowed(selection, toolId), true, toolId);
  }
});

test('legacy composite group expansions remain unchanged in explicit manifests', () => {
  const manifest = createWorkspaceManifest({ name: 'compat', profile: 'custom', by: 'wizard' });
  manifest.version = 3;
  manifest.tools = {
    mode: 'explicit-catalog',
    profiles: ['terminal', 'notes', 'design'],
    enabled: [],
    deny: [],
  };
  const selection = resolveWorkspaceToolSelection({ manifest });

  for (const toolId of [
    'run_command', 'task_output', 'wait_until', 'kill_command',
    'computer_use', 'connector_run', 'research_note', 'research_brief', 'artifact_write',
  ]) {
    assert.equal(allowed(selection, toolId), true, toolId);
  }
  assert.equal(allowed(selection, 'connector_list'), false);
  assert.equal(allowed(selection, 'browser_screenshot', 'browser'), true);
});

test('manifest v3 explicit selections hide every unselected local tool', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'custom', by: 'wizard' });
  manifest.version = 3;
  manifest.tools = {
    mode: 'explicit-catalog',
    profiles: ['coding'],
    enabled: ['web_search', 'list_mcp_resources'],
    deny: ['apply_patch'],
  };
  const selection = resolveWorkspaceToolSelection({
    manifest,
    activeToolProfiles: ['design'],
  });

  assert.equal(selection.mode, 'explicit-catalog');
  assert.deepEqual(selection.activeProfileIds, ['coding']);
  assert.equal(allowed(selection, 'read_file', 'filesystem'), true);
  assert.equal(allowed(selection, 'edit_file', 'filesystem'), true);
  assert.equal(allowed(selection, 'apply_patch', 'filesystem'), false);
  assert.equal(allowed(selection, 'web_search', 'web-research'), true);
  assert.equal(allowed(selection, 'update_plan', 'planning-state'), false);
  assert.equal(allowed(selection, 'custom_extension_tool', 'custom-extension'), false);
  assert.equal(allowed(selection, 'browser_screenshot', 'browser'), false);
  assert.equal(workspaceDynamicMcpAllowed(selection), true);
});

test('manifest v3 keeps dynamic MCP closed until a stable MCP surface is reviewed', () => {
  const manifest = createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' });
  manifest.version = 3;
  manifest.tools = {
    mode: 'explicit-catalog',
    profiles: [],
    enabled: [],
    deny: [],
  };
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.equal(workspaceDynamicMcpAllowed(selection), false);
  assert.equal(mcpAllowed(selection, 'list_skills'), true);
  assert.equal(mcpAllowed(selection, 'get_skill'), true);
  assert.equal(mcpAllowed(selection, 'search_skills'), true);
  assert.equal(mcpAllowed(selection, 'knowledge_search'), false);
  assert.equal(mcpAllowed(selection, 'list_skills', false), false);
  assert.equal(mcpAllowed(selection, 'third_party_search', false), false);
  manifest.tools.enabled = ['mcp_search'];
  const broadSelection = resolveWorkspaceToolSelection({ manifest });
  assert.equal(workspaceDynamicMcpAllowed(broadSelection), true);
  assert.equal(mcpAllowed(broadSelection, 'third_party_search', false), true);
});

test('v2 ignores catalog-only fields and retains legacy baseline behavior', () => {
  const manifest = createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' });
  manifest.tools.mode = 'explicit-catalog';
  manifest.tools.enabled = ['web_search'];
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.equal(selection.mode, 'legacy-groups');
  assert.equal(allowed(selection, 'read_file', 'filesystem'), true);
  assert.equal(allowed(selection, 'web_search', 'web-research'), false);
  assert.equal(allowed(selection, 'custom_extension_tool', 'custom-extension'), true);
  assert.equal(workspaceDynamicMcpAllowed(selection), true);
});

test('manifest v3 ignores unknown, dynamic, and hidden tool IDs at runtime', () => {
  const manifest = createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' });
  manifest.version = 3;
  manifest.tools = {
    mode: 'explicit-catalog',
    profiles: ['future-tools'],
    enabled: ['future_tool', 'delegate_unreviewed', 'spawn_agent', 'web_search'],
    deny: ['future_deny'],
  };
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.deepEqual(selection.activeProfileIds, []);
  assert.deepEqual([...selection.allowedToolIds], ['web_search']);
  assert.deepEqual([...selection.deniedIds], []);
  assert.equal(allowed(selection, 'future_tool', 'future-extension'), false);
  assert.equal(allowed(selection, 'delegate_agent', 'orchestration'), false);
  assert.equal(allowed(selection, 'spawn_agent', 'orchestration'), false);
  assert.equal(allowed(selection, 'web_search', 'web-research'), true);
});
