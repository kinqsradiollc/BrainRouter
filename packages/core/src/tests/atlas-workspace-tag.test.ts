import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasWorkspaceTag } from '../atlas/atlasStore.js';

test('atlasWorkspaceTag: stable per root, distinct across roots, slug + hash shape', () => {
  const a = atlasWorkspaceTag('/Users/x/code/BrainRouter');
  // deterministic — the CLI and desktop derive the SAME tag for a workspace
  assert.equal(a, atlasWorkspaceTag('/Users/x/code/BrainRouter'));
  // shape: <basename-slug>-<12 hex>
  assert.match(a, /^brainrouter-[0-9a-f]{12}$/);
  // distinct roots → distinct tags (even with the same basename)
  assert.notEqual(a, atlasWorkspaceTag('/Users/y/code/BrainRouter'));
  // trailing slash doesn't change the basename slug
  assert.match(atlasWorkspaceTag('/srv/My Repo/'), /^my-repo-[0-9a-f]{12}$/);
  // odd roots still produce a usable tag
  assert.match(atlasWorkspaceTag('/'), /^workspace-[0-9a-f]{12}$/);
});
