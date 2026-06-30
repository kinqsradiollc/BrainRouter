/** Per-tool enable/disable policy (cli.toolOverrides) + protected core. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedCoreTool, resolveToolVisible, PROTECTED_CORE_TOOLS } from '../tool/toolPolicy.js';
import { resolveCliKnobs } from '../config/config.js';

test('isProtectedCoreTool covers lifecycle + file/shell core, not the long tail', () => {
  for (const t of ['update_plan', 'goal_complete', 'ask_user_choice', 'read_file', 'edit_file', 'run_command', 'grep_search', 'apply_patch']) {
    assert.equal(isProtectedCoreTool(t), true, `${t} is protected`);
  }
  for (const t of ['web_search', 'computer_use', 'track_query', 'artifact_write', 'mcp_fs_read', 'lsp']) {
    assert.equal(isProtectedCoreTool(t), false, `${t} is NOT protected`);
  }
});

test('resolveToolVisible: no override is a passthrough of the soft visibility', () => {
  assert.equal(resolveToolVisible('web_search', true, {}), true);
  assert.equal(resolveToolVisible('web_search', false, {}), false);
});

test('resolveToolVisible: force-on re-enables a soft-hidden tool (the local-model re-enable case)', () => {
  // web_search hidden by the L2 allowlist (softVisible=false) → user re-enables it.
  assert.equal(resolveToolVisible('web_search', false, { web_search: true }), true);
});

test('resolveToolVisible: force-off hides a non-protected tool but is ignored for protected core', () => {
  assert.equal(resolveToolVisible('web_search', true, { web_search: false }), false);
  // read_file is protected — a force-off is ignored, stays at its soft visibility.
  assert.equal(resolveToolVisible('read_file', true, { read_file: false }), true);
  assert.equal(resolveToolVisible('run_command', true, { run_command: false }), true);
});

test('resolveCliKnobs.toolOverrides: validated map (drops non-boolean, trims keys, fail-safe)', () => {
  type Cfg = Parameters<typeof resolveCliKnobs>[0];
  const cfg = (toolOverrides: unknown): Cfg => ({ cli: { toolOverrides } }) as Cfg;
  const knobs = resolveCliKnobs(cfg({ web_search: true, ' lsp ': false, bad: 'nope', '': true }));
  assert.deepEqual(knobs.toolOverrides, { web_search: true, lsp: false });
  // Non-object / absent → empty map.
  assert.deepEqual(resolveCliKnobs({} as Cfg).toolOverrides, {});
  assert.deepEqual(resolveCliKnobs(cfg([])).toolOverrides, {});
});

test('the protected set is non-empty and frozen-ish (a Set we read, not mutate)', () => {
  assert.ok(PROTECTED_CORE_TOOLS.size >= 10);
});
