import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { browserPartitionForWorkspace } from './browserProfile.js';

test('workspace browser profiles are stable across chat sessions', () => {
  const root = path.join(path.sep, 'workspace', 'project-a');
  assert.equal(
    browserPartitionForWorkspace(root),
    browserPartitionForWorkspace(root),
  );
});

test('workspace browser profiles isolate projects without exposing local paths', () => {
  const first = browserPartitionForWorkspace(path.join(path.sep, 'workspace', 'project-a'));
  const second = browserPartitionForWorkspace(path.join(path.sep, 'workspace', 'project-b'));
  assert.notEqual(first, second);
  assert.match(first, /^persist:brainrouter-browser-[a-f0-9]{24}$/);
  assert.doesNotMatch(first, /workspace|project/i);
});
