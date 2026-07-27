import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { findWorkspaceProfilePlugin } from '../workspace/profilePlugins.js';

test('frontend skill stacks retain the reviewed build, artifact, and browser surface', () => {
  const frontend = findWorkspaceProfilePlugin('frontend');
  assert.ok(frontend);
  const sharedTools = [
    'write_file',
    'edit_file',
    'apply_patch',
    'run_command',
    'artifact_write',
    'browser_capabilities',
    'browser_list_tabs',
    'browser_snapshot',
    'browser_screenshot',
    'browser_console',
    'browser_network',
    'browser_find_element',
    'browser_assert_visible',
    'browser_open_tab',
    'browser_navigate',
    'browser_reload',
    'browser_back',
    'browser_forward',
    'browser_wait',
    'browser_select_tab',
    'browser_close_tab',
    'browser_reopen_tab',
    'browser_reorder_tab',
    'browser_click',
    'browser_double_click',
    'browser_hover',
    'browser_drag',
    'browser_tap',
    'browser_type',
    'browser_press',
    'browser_scroll',
    'browser_select_option',
    'browser_check',
    'browser_upload_files',
    'browser_downloads',
    'browser_download_action',
    'browser_permission',
    'browser_dialog',
    'browser_stop',
    'browser_set_device',
    'browser_run_flow',
  ];

  for (const skillId of frontend.skillIds) {
    const body = fs.readFileSync(
      path.join(frontend.skillsRoot, skillId, 'SKILL.md'),
      'utf8',
    );
    const flow = body.match(/^allowed-tools:\s*\[([^\]]*)\]$/m)?.[1];
    assert.notEqual(flow, undefined);
    const allowed = new Set(flow!.split(',').map((value) => value.trim()).filter(Boolean));
    for (const toolId of sharedTools) {
      assert.ok(allowed.has(toolId), `${skillId}: ${toolId}`);
    }
  }
});
