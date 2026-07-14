import test from 'node:test';
import assert from 'node:assert/strict';
import { detectForgeProvider, forgeCapabilitySnapshot } from '../forge/forge.js';
import type { CmdRunner } from '../git/prEmit.js';

test('forge detection recognizes supported and capability-gated providers', () => {
  assert.equal(detectForgeProvider('git@github.com:owner/repo.git')?.id, 'github');
  assert.equal(detectForgeProvider('https://gitlab.example.test/group/repo.git')?.id, 'gitlab');
  assert.equal(detectForgeProvider('https://bitbucket.org/owner/repo.git')?.id, 'bitbucket');
  assert.equal(detectForgeProvider('https://dev.azure.com/org/project/_git/repo')?.id, 'azure-devops');
  assert.equal(detectForgeProvider('ssh://git@gitea.example.test/owner/repo.git')?.id, 'gitea');
  assert.equal(detectForgeProvider('https://example.test/owner/repo.git'), undefined);

  assert.equal(forgeCapabilitySnapshot('https://github.com/o/r').capabilities['review:submit'], true);
  const bitbucket = forgeCapabilitySnapshot('https://bitbucket.org/o/r');
  assert.equal(bitbucket.capabilities['change-request:create'], false);
  assert.equal(bitbucket.reason, 'provider-detected-but-operations-not-enabled');
  assert.equal(forgeCapabilitySnapshot('https://example.test/o/r').reason, 'unknown-forge');
});

test('GitHub provider emits bounded argv for create, checks, review, and Track', () => {
  const provider = detectForgeProvider('git@github.com:o/r.git')!;
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const run: CmdRunner = (cmd, args, cwd) => { calls.push({ cmd, args, cwd }); return { ok: true, stdout: '', stderr: '' }; };
  const ctx = { remote: 'git@github.com:o/r.git', cwd: '/repo', run };
  provider.createChangeRequest!(ctx, { base: 'main', head: 'feat/x', title: 'Title', body: 'Body', draft: true });
  provider.listChecks!(ctx, 17);
  provider.submitReview!(ctx, 17, 'request-changes', 'Please fix');
  provider.listTrack!(ctx);
  assert.deepEqual(calls, [
    { cmd: 'gh', args: ['pr', 'create', '--base', 'main', '--head', 'feat/x', '--title', 'Title', '--body', 'Body', '--draft'], cwd: '/repo' },
    { cmd: 'gh', args: ['pr', 'checks', '17', '--json', 'name,state,bucket,link'], cwd: '/repo' },
    { cmd: 'gh', args: ['pr', 'review', '17', '--request-changes', '--body', 'Please fix'], cwd: '/repo' },
    { cmd: 'gh', args: ['issue', 'list', '--json', 'number,title,state,url,labels,assignees'], cwd: '/repo' },
  ]);
});

test('GitLab provider emits merge-request, pipeline, note, and issue argv', () => {
  const provider = detectForgeProvider('https://gitlab.com/o/r.git')!;
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: CmdRunner = (cmd, args) => { calls.push({ cmd, args }); return { ok: true, stdout: '', stderr: '' }; };
  const ctx = { remote: 'https://gitlab.com/o/r.git', cwd: '/repo', run };
  provider.createChangeRequest!(ctx, { base: 'main', head: 'feat/x', title: 'Title', body: 'Body', draft: true });
  provider.listChecks!(ctx, 8);
  provider.submitReview!(ctx, 8, 'comment', 'Looks close');
  provider.listTrack!(ctx);
  assert.deepEqual(calls.map((call) => call.cmd), ['glab', 'glab', 'glab', 'glab']);
  assert.deepEqual(calls[0]?.args, ['mr', 'create', '--source-branch', 'feat/x', '--target-branch', 'main', '--title', 'Title', '--description', 'Body', '--draft', '--yes']);
  assert.deepEqual(calls[1]?.args, ['ci', 'status']);
  assert.deepEqual(calls[2]?.args, ['mr', 'note', '8', '--message', 'Looks close']);
  assert.deepEqual(calls[3]?.args, ['issue', 'list', '--output', 'json']);
});
