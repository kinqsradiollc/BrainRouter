import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  buildRemoteCommand,
  RemoteWorktreeManager,
  SshHostRegistry,
  SshTransport,
  sshHostKeyFingerprint,
  type RemoteCommandResult,
  type SshHostConfig,
} from './sshRemote.js';

test('SSH command planning quotes every field and rejects control-line injection', () => {
  assert.equal(
    buildRemoteCommand('git', ['status', "a'b;$(touch nope)"], "/srv/team's repo"),
    "cd '/srv/team'\"'\"'s repo' && exec 'git' 'status' 'a'\"'\"'b;$(touch nope)'",
  );
  assert.throws(() => buildRemoteCommand('-sh', [], '/srv/repo'), /Unsafe/);
  assert.throws(() => buildRemoteCommand('git', ['ok\nwhoami'], '/srv/repo'), /control/);
  assert.throws(() => buildRemoteCommand('git', [], 'relative/repo'), /absolute POSIX/);
});

test('SSH host-key fingerprint uses the OpenSSH SHA256 representation', () => {
  const key = Buffer.from('binary-host-key');
  const expected = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  assert.equal(sshHostKeyFingerprint(key), `SHA256:${expected}`);
});

test('workspace SSH host registry persists only pinned non-secret connection metadata', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ssh-home-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ssh-workspace-'));
  const oldHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const registry = new SshHostRegistry(workspace);
    const saved = registry.put({
      host: 'dev.example.test', username: 'developer', port: 2222,
      workspaceRoot: '/srv/brainrouter', hostKeySha256: `SHA256:${'A'.repeat(43)}`,
    });
    assert.equal(registry.get(saved.id)?.workspaceRoot, '/srv/brainrouter');
    const files = fs.readdirSync(path.join(home, 'workspaces'), { recursive: true }).map(String);
    assert.ok(files.some((file) => file.endsWith('sshHosts.json')));
    const target = files.find((file) => file.endsWith('sshHosts.json'))!;
    const body = fs.readFileSync(path.join(home, 'workspaces', target), 'utf8');
    assert.doesNotMatch(body, /password|privateKey|accessToken/i);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'workspaces', target)).mode & 0o777, 0o600);
  } finally {
    process.env.BRAINROUTER_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('remote worktree state machine proves the base, captures a complete patch, and removes through git', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ssh-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ssh-state-'));
  const oldHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
  const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const result = (stdout = '', stderr = '', ok = true): RemoteCommandResult => ({ ok, stdout, stderr, status: ok ? 0 : 1 });
  const fake = {
    exec: async (_host: SshHostConfig, command: string, args: string[], cwd: string): Promise<RemoteCommandResult> => {
      calls.push({ command, args, cwd });
      if (args[0] === 'rev-parse') return result(oid);
      if (args.includes('--name-only')) return result('new.txt\n');
      if (args.includes('--binary')) return result('diff --git a/new.txt b/new.txt\nnew file mode 100644\n');
      if (args[0] === 'diff' && args.includes('--cached')) return result('diff preview\n');
      return result();
    },
  } as unknown as SshTransport;
  try {
    const manager = new RemoteWorktreeManager(root, fake);
    const host = manager.registry.put({ host: 'dev.test', username: 'dev', workspaceRoot: '/srv/repo', hostKeySha256: `SHA256:${'B'.repeat(43)}` });
    const created = await manager.create(host.id, 'candidate-1', 'HEAD');
    assert.equal(created.baseOid, oid);
    assert.match(created.worktreeRoot, /\.brainrouter-worktrees\/repo-candidate-1$/);
    const patchFile = path.join(home, 'candidate.patch');
    const captured = await manager.capture(host.id, 'candidate-1', created.worktreeRoot, patchFile, created.baseOid);
    assert.equal(captured.changedFiles, 1);
    assert.equal(fs.readFileSync(patchFile, 'utf8'), 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n');
    assert.ok(calls.some((call) => call.args.includes(created.baseOid) && call.args.includes('--binary')));
    assert.equal((await manager.remove(host.id, 'candidate-1', created.worktreeRoot, oid)).ok, true);
    assert.ok(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'));
    assert.ok(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove'));
  } finally {
    process.env.BRAINROUTER_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
