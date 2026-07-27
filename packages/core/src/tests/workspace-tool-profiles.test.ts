import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceManifest } from '../workspace/manifest.js';
import {
  resolveWorkspaceToolSelection,
  workspaceDynamicMcpAllowed,
  workspaceToolAllowed,
  workspaceToolProfileIds,
} from '../workspace/toolProfiles.js';

const allowed = (
  selection: ReturnType<typeof resolveWorkspaceToolSelection>,
  toolId: string,
  extensionId?: string,
) => workspaceToolAllowed(selection, { toolId, extensionId });

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
    'coding', 'shell', 'browser', 'artifacts', 'planning-session', 'orchestration',
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
    'coding', 'shell', 'browser', 'artifacts',
    'planning-session', 'orchestration', 'pull-request-observation',
    'interactive-browser',
  ]);
  assert.equal(allowed(selection, 'browser_screenshot', 'browser'), true);
  assert.equal(allowed(selection, 'artifact_write', 'planning-state'), true);
  assert.equal(JSON.stringify(manifest), before, 'task resolution never mutates reviewed workspace state');
});

test('research profiles expose browser and notes while coding and terminal stay hidden', () => {
  const manifest = createWorkspaceManifest({ name: 'sources', profile: 'research', by: 'wizard' });
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.equal(allowed(selection, 'fetch_url', 'web-research'), true);
  assert.equal(allowed(selection, 'research_note', 'web-research'), true);
  assert.equal(allowed(selection, 'artifact_write', 'planning-state'), true);
  assert.equal(allowed(selection, 'write_file', 'filesystem'), false);
  assert.equal(allowed(selection, 'run_command', 'shell'), false);
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
    'coding', 'shell', 'browser', 'research-notes', 'artifacts',
    'planning-session', 'orchestration', 'interactive-browser',
    'mcp-resources', 'connectors', 'computer-control', 'workflow-launch',
    'background-workers', 'pull-request-observation', 'security-review',
    'terminal', 'notes', 'design',
  ]);
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
  manifest.tools.enabled = ['mcp_search'];
  assert.equal(workspaceDynamicMcpAllowed(resolveWorkspaceToolSelection({ manifest })), true);
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
