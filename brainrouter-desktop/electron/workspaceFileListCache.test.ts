import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceFileListCache } from './workspaceFileListCache.js';

test('WorkspaceFileListCache returns fresh entries as cached copies', () => {
  const cache = new WorkspaceFileListCache(1000);
  cache.set('/repo', { files: ['a.ts'], truncated: false, source: 'git', generatedAt: 100 });
  const hit = cache.get('/repo', 500);
  assert.deepEqual(hit, { files: ['a.ts'], truncated: false, source: 'git', generatedAt: 100, cached: true });
});

test('WorkspaceFileListCache expires stale entries', () => {
  const cache = new WorkspaceFileListCache(1000);
  cache.set('/repo', { files: ['a.ts'], truncated: false, source: 'filesystem', generatedAt: 100 });
  assert.equal(cache.get('/repo', 1200), null);
  assert.equal(cache.get('/repo', 1201), null);
});

test('WorkspaceFileListCache invalidates one workspace or all workspaces', () => {
  const cache = new WorkspaceFileListCache(1000);
  cache.set('/a', { files: ['a.ts'], truncated: false, source: 'git', generatedAt: 100 });
  cache.set('/b', { files: ['b.ts'], truncated: false, source: 'git', generatedAt: 100 });
  cache.invalidate('/a');
  assert.equal(cache.get('/a', 200), null);
  assert.equal(cache.get('/b', 200)?.files[0], 'b.ts');
  cache.invalidate();
  assert.equal(cache.get('/b', 200), null);
});
