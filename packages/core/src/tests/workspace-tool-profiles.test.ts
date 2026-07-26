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

test('engineering profiles expose coding terminal and web tools but not task-only design tools', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  const selection = resolveWorkspaceToolSelection({ manifest });

  assert.deepEqual(selection.activeProfileIds, ['coding', 'terminal', 'browser']);
  assert.equal(allowed(selection, 'edit_file', 'filesystem'), true);
  assert.equal(allowed(selection, 'run_command', 'shell'), true);
  assert.equal(allowed(selection, 'web_search', 'web-research'), true);
  assert.equal(allowed(selection, 'artifact_write', 'planning-state'), false);
  assert.equal(allowed(selection, 'browser_screenshot', 'browser'), false);
});

test('frontend task profiles add design extension tools without changing the manifest', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  const before = JSON.stringify(manifest);
  const selection = resolveWorkspaceToolSelection({
    manifest,
    activeToolProfiles: ['browser', 'design'],
  });

  assert.deepEqual(selection.activeProfileIds, ['coding', 'terminal', 'browser', 'design']);
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
  assert.deepEqual(workspaceToolProfileIds(), ['coding', 'terminal', 'browser', 'notes', 'design']);
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
