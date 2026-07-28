import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKSPACE_TOOL_PROFILES,
  type WorkspaceOnboardingPreview,
} from '@kinqs/brainrouter-core/workspace';
import {
  buildDevOnboardingPreview,
  devDraftForProfile,
} from './devOnboardingPreview.js';

test('browser-development onboarding uses the Core tool-group catalog', () => {
  const preview = buildDevOnboardingPreview(
    devDraftForProfile('research', '/workspace'),
  ) as unknown as WorkspaceOnboardingPreview;
  const toolGroupIds = preview.catalog
    .filter((row) => row.kind === 'tool-group')
    .map((row) => row.id);

  assert.deepEqual(
    toolGroupIds,
    WORKSPACE_TOOL_PROFILES.map((profile) => profile.id),
  );
  assert.ok(toolGroupIds.includes('research-browser'));
  assert.ok(toolGroupIds.includes('project-knowledge'));
  assert.ok(toolGroupIds.includes('memory-context'));
  assert.ok(toolGroupIds.includes('planning-session'));
  assert.ok(toolGroupIds.includes('orchestration'));
});

test('browser-development Research preview exposes its recommended effective tools', () => {
  const preview = buildDevOnboardingPreview(
    devDraftForProfile('research', '/workspace'),
  ) as unknown as WorkspaceOnboardingPreview;
  const effectiveTools = new Set(preview.tools.effectiveToolIds);
  const computationalResearch = preview.catalog.find(
    (row) => row.kind === 'capability' && row.id === 'computational-research',
  );

  for (const toolId of [
    'list_dir',
    'write_file',
    'browser_snapshot',
    'research_note',
    'artifact_write',
  ]) {
    assert.ok(effectiveTools.has(toolId), `expected Research to include ${toolId}`);
  }
  assert.ok(computationalResearch?.expandsTo?.includes('coding'));
  assert.ok(computationalResearch?.expandsTo?.includes('shell'));
});
