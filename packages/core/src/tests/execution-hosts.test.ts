import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeSshTarget,
  planHostCommand,
  runOnHost,
  type HostCommandExecutor,
} from '../exec/hosts.js';

test('execution host planner keeps local commands as argv with an explicit cwd', () => {
  assert.deepEqual(planHostCommand(
    { id: 'local', kind: 'local', platform: 'darwin' },
    'git', ['status', '--short'], '/workspace/repo',
  ), {
    executable: 'git',
    args: ['status', '--short'],
    cwd: '/workspace/repo',
  });
});

test('execution host planner routes WSL through wsl.exe without a shell string', () => {
  assert.deepEqual(planHostCommand(
    { id: 'wsl:ubuntu', kind: 'wsl', distro: 'Ubuntu-24.04' },
    'git', ['status', '--short'], '/home/ada/repo',
  ), {
    executable: 'wsl.exe',
    args: ['-d', 'Ubuntu-24.04', '--cd', '/home/ada/repo', '--', 'git', 'status', '--short'],
  });
});

test('execution host planner quotes every SSH command component and rejects target injection', () => {
  const plan = planHostCommand(
    { id: 'ssh:build', kind: 'ssh', target: 'ada@build.example.test' },
    'printf', ["hello'; touch /tmp/should-not-exist", '$HOME'], "/srv/repo with space",
  );
  assert.equal(plan.executable, 'ssh');
  assert.deepEqual(plan.args.slice(0, 6), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', 'ada@build.example.test']);
  assert.deepEqual(plan.args.slice(6, 8), ['sh', '-lc']);
  assert.match(plan.args[8] ?? '', /^cd '\/srv\/repo with space' && exec 'printf' /);
  assert.match(plan.args[8] ?? '', /'hello'"'"'; touch \/tmp\/should-not-exist'/);
  assert.match(plan.args[8] ?? '', /'\$HOME'$/);

  for (const target of ['-oProxyCommand=evil', 'user@host;touch-x', 'user@host\nother', 'user@@host']) {
    assert.equal(isSafeSshTarget(target), false, target);
    assert.throws(() => planHostCommand({ id: 'bad', kind: 'ssh', target }, 'git', ['status'], '/repo'), /Unsafe SSH target/);
  }
});

test('execution host planner rejects a flag-shaped or control-character command', () => {
  assert.throws(() => planHostCommand({ id: 'local', kind: 'local' }, '--upload-pack=evil', [], '/repo'), /Unsafe execution command/);
  assert.throws(() => planHostCommand({ id: 'local', kind: 'local' }, 'git\nwhoami', [], '/repo'), /Unsafe execution command/);
});

test('runOnHost delegates the pure plan to an injected executor', () => {
  const calls: Array<{ executable: string; args: string[]; cwd?: string; timeout: number }> = [];
  const executor: HostCommandExecutor = {
    run: (plan, timeout) => {
      calls.push({ ...plan, timeout });
      return { ok: true, stdout: 'done', stderr: '', status: 0 };
    },
  };

  const result = runOnHost(
    { id: 'local', kind: 'local' },
    'git',
    ['status', '--short'],
    '/workspace',
    1_500,
    executor,
  );

  assert.deepEqual(calls, [{
    executable: 'git',
    args: ['status', '--short'],
    cwd: '/workspace',
    timeout: 1_500,
  }]);
  assert.deepEqual(result, { ok: true, stdout: 'done', stderr: '', status: 0 });
});
