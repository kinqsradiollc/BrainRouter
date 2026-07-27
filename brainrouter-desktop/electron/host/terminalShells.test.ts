/**
 * Native terminal shell catalog tests.
 *
 * Discovery is exercised with injected platform state so Windows and macOS
 * behavior stays verifiable on every CI host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverTerminalShells, resolveTerminalShell } from './terminalShells.js';

test('puts the configured macOS shell first and exposes installed alternatives', () => {
  const installed = new Set(['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish', '/bin/sh']);
  const catalog = discoverTerminalShells({
    platform: 'darwin',
    env: { SHELL: '/bin/zsh' },
    exists: (candidate) => installed.has(candidate),
  });

  assert.equal(catalog.defaultId, 'zsh');
  assert.deepEqual(catalog.shells.map(({ id, isDefault }) => ({ id, isDefault })), [
    { id: 'zsh', isDefault: true },
    { id: 'bash', isDefault: false },
    { id: 'fish', isDefault: false },
    { id: 'sh', isDefault: false },
  ]);
});

test('discovers Command Prompt, PowerShell, Git Bash, and WSL on Windows', () => {
  const installed = new Set([
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Windows\\System32\\wsl.exe',
  ]);
  const catalog = discoverTerminalShells({
    platform: 'win32',
    env: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      PATH: 'C:\\Program Files\\PowerShell\\7',
    },
    exists: (candidate) => installed.has(candidate),
  });

  assert.equal(catalog.defaultId, 'cmd');
  assert.deepEqual(catalog.shells.map((shell) => shell.id), [
    'cmd',
    'powershell',
    'git-bash',
    'wsl',
  ]);
  assert.deepEqual(resolveTerminalShell('powershell', {
    platform: 'win32',
    env: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Program Files\\PowerShell\\7',
    },
    exists: (candidate) => installed.has(candidate),
  }).args, ['-NoLogo']);
});

test('unknown renderer shell IDs resolve to the host default', () => {
  const shell = resolveTerminalShell('../../untrusted', {
    platform: 'darwin',
    env: { SHELL: '/bin/bash' },
    exists: (candidate) => candidate === '/bin/bash',
  });
  assert.equal(shell.id, 'bash');
  assert.equal(shell.shell, '/bin/bash');
});
