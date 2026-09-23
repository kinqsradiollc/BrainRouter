/**
 * The model cannot know its session key or its workspace's identities, so a
 * model-issued memory read went out unscoped — a user-wide search. The
 * dispatcher fills them in, but only for BrainRouter's own brain: adding
 * arguments to a third-party server's `memory_search` could fail its schema.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceTagFromPath } from '@kinqs/brainrouter-types';
import { applyMemoryScope } from '../util/agentloop/memoryScope.js';
import { workspaceMemoryTags } from '../memory/workspaceScope.js';
import { repoTag } from '../track/git/repoIdentity.js';

const SCOPE = { sessionKey: 'sess-real', workspaceTags: ['ws_folder', 'ws_repo'] };

test('a brain memory read gets the real session and every workspace identity', () => {
  for (const tool of ['memory_search', 'memory_recall']) {
    const out = applyMemoryScope(tool, { query: 'auth', sessionKey: 'sess-the-model-made-up' }, SCOPE, true) as any;
    assert.equal(out.query, 'auth', `${tool}: the model's own arguments survive`);
    assert.equal(out.sessionKey, 'sess-real', `${tool}: an invented session key is replaced`);
    assert.deepEqual(out.workspaceTags, ['ws_folder', 'ws_repo']);
  }
});

test('a third-party server with a tool of the same name is left alone', () => {
  const args = { query: 'auth' };
  assert.equal(applyMemoryScope('memory_search', args, SCOPE, false), args, 'untouched, same object');
});

test('every other tool passes straight through — and never pays for resolving the scope', () => {
  let resolved = 0;
  const lazy = () => { resolved += 1; return SCOPE; };
  const args = { path: 'x' };
  assert.equal(applyMemoryScope('read_file', args, lazy, true), args);
  assert.equal(applyMemoryScope('memory_capture_turn', args, lazy, true), args, 'writes are not reads');
  assert.equal(resolved, 0, 'the git lookup behind the scope must not run for these');
  applyMemoryScope('memory_search', {}, lazy, true);
  assert.equal(resolved, 1);
});

test('an empty scope adds nothing, and malformed args become an object', () => {
  assert.deepEqual(applyMemoryScope('memory_search', { query: 'q' }, {}, true), { query: 'q' });
  assert.deepEqual(applyMemoryScope('memory_search', undefined, SCOPE, true), {
    sessionKey: 'sess-real',
    workspaceTags: ['ws_folder', 'ws_repo'],
  });
});

test('a git checkout has two identities: its folder, then its remote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-scope-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const url = 'https://github.com/acme/widget.git';
    spawnSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
    const tags = workspaceMemoryTags(dir, 1);
    // The folder hash must be of the path EXACTLY as capture sends it.
    assert.equal(tags[0], workspaceTagFromPath(dir));
    // The remote hash must be the one repository ingest files things under.
    assert.equal(tags[1], repoTag(url));
    assert.equal(tags.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder that is not a repository has only its path, and no root has none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-scope-plain-'));
  try {
    assert.deepEqual(workspaceMemoryTags(dir, 1), [workspaceTagFromPath(dir)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(workspaceMemoryTags(undefined), []);
  assert.deepEqual(workspaceMemoryTags('   '), []);
});
