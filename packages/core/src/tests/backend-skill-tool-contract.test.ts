import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { findWorkspaceProfilePlugin } from '../workspace/profilePlugins.js';

test('backend skill stacks retain production file, language, shell, and artifact tools', () => {
  const backend = findWorkspaceProfilePlugin('backend');
  assert.ok(backend);

  for (const skillId of backend.skillIds) {
    const body = fs.readFileSync(path.join(backend.skillsRoot, skillId, 'SKILL.md'), 'utf8');
    const flow = body.match(/^allowed-tools:\s*\[([^\]]*)\]$/m)?.[1];
    assert.notEqual(flow, undefined);
    const allowed = new Set(flow!.split(',').map((value) => value.trim()).filter(Boolean));
    for (const toolId of [
      'list_dir',
      'write_file',
      'edit_file',
      'apply_patch',
      'lsp',
      'run_command',
      'artifact_write',
    ]) {
      assert.ok(allowed.has(toolId), `${skillId}: ${toolId}`);
    }
  }
});
