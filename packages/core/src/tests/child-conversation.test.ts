import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  closeChildConversation,
  createChildConversation,
  getChildConversation,
  listChildConversations,
} from '../session/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
}

test('child conversations inherit parent runtime, repo, branch, and model', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    git(ws, 'init', '-q');
    git(ws, 'checkout', '-b', 'feature/child', '-q');
    git(ws, 'remote', 'add', 'origin', 'git@github.com:acme/project.git');
    fs.writeFileSync(`${ws}/seed.txt`, 'seed\n');
    git(ws, 'add', 'seed.txt');
    git(ws, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'seed');

    const child = createChildConversation(ws, {
      parentSessionKey: 'session:parent',
      parentRuntimeId: 'rt_parent',
      model: 'test-model',
      title: 'Investigate failing check',
    });

    assert.equal(child.parentSessionKey, 'session:parent');
    assert.equal(child.parentRuntimeId, 'rt_parent');
    assert.equal(child.repo, 'acme/project');
    assert.equal(child.branch, 'feature/child');
    assert.equal(child.model, 'test-model');
    assert.equal(child.status, 'open');
    assert.match(child.sessionKey, /^session:parent:child:conv_/);
    assert.deepEqual(listChildConversations(ws).map((c) => c.id), [child.id]);
    assert.equal(getChildConversation(ws, child.sessionKey)?.id, child.id);

    const closed = closeChildConversation(ws, child.id);
    assert.equal(closed?.status, 'closed');
    assert.ok(closed?.closedAt);
  });
});

test('child conversation creation validates required parent identity', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    assert.throws(
      () => createChildConversation(ws, { parentSessionKey: '', parentRuntimeId: 'rt', model: 'm' }),
      /parentSessionKey/,
    );
    assert.throws(
      () => createChildConversation(ws, { parentSessionKey: 's', parentRuntimeId: '', model: 'm' }),
      /parentRuntimeId/,
    );
  });
});
