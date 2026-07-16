import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDevServerRegistry, readLaunchConfigs, DESKTOP_PORT } from './devServerRegistry.js';

function tmpWorkspace(configs: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsrv-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'launch.json'), JSON.stringify({ version: '0.0.1', configurations: configs }, null, 2));
  return root;
}

test('readLaunchConfigs drops unsafe/invalid configs (launcher, shell-meta, port)', () => {
  const root = tmpWorkspace([
    { name: 'ok', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 4321 },
    { name: 'bad-launcher', runtimeExecutable: 'bash', runtimeArgs: ['x'], port: 4000 },
    { name: 'shell-meta', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev; rm -rf /'], port: 4001 },
    { name: 'zero-port', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 0 },
    { name: '', runtimeExecutable: 'npm', runtimeArgs: [], port: 4002 },
  ]);
  try {
    const configs = readLaunchConfigs(root);
    assert.deepEqual(configs.map((c) => c.name), ['ok'], 'only the safe, well-formed config survives');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addConfig rejects bad launcher / shell-meta / bad port / desktop port / duplicate', () => {
  const root = tmpWorkspace([{ name: 'existing', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 4321 }]);
  try {
    const reg = createDevServerRegistry(root);
    assert.equal(reg.addConfig({ name: '', exe: 'npm', args: [], port: 3000 }).ok, false, 'empty name');
    assert.equal(reg.addConfig({ name: 'x', exe: 'bash', args: [], port: 3000 }).ok, false, 'bad launcher');
    assert.equal(reg.addConfig({ name: 'x', exe: 'npm', args: ['a; b'], port: 3000 }).ok, false, 'shell meta');
    assert.equal(reg.addConfig({ name: 'x', exe: 'npm', args: [], port: 0 }).ok, false, 'port 0');
    assert.equal(reg.addConfig({ name: 'x', exe: 'npm', args: [], port: 70000 }).ok, false, 'port out of range');
    assert.equal(reg.addConfig({ name: 'x', exe: 'npm', args: [], port: DESKTOP_PORT }).ok, false, 'desktop port');
    assert.equal(reg.addConfig({ name: 'existing', exe: 'npm', args: [], port: 3000 }).ok, false, 'duplicate name');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addConfig appends a valid config and preserves existing structure', () => {
  const root = tmpWorkspace([{ name: 'existing', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 4321 }]);
  try {
    const reg = createDevServerRegistry(root);
    const res = reg.addConfig({ name: 'api', exe: 'npm', args: ['run', 'serve'], port: 3001 });
    assert.equal(res.ok, true, res.error);
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8'));
    assert.equal(doc.version, '0.0.1', 'version preserved');
    assert.equal(doc.configurations.length, 2, 'existing config preserved + one appended');
    const added = doc.configurations.find((c: { name: string }) => c.name === 'api');
    assert.ok(added, 'new config present');
    assert.equal(added.runtimeExecutable, 'npm');
    assert.deepEqual(added.runtimeArgs, ['run', 'serve']);
    assert.equal(added.port, 3001);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addConfig creates a skeleton launch.json when none exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsrv-noconf-'));
  try {
    const reg = createDevServerRegistry(root);
    const res = reg.addConfig({ name: 'web', exe: 'npm', args: ['run', 'dev'], port: 4000 });
    assert.equal(res.ok, true, res.error);
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8'));
    assert.equal(doc.configurations.length, 1);
    assert.equal(doc.configurations[0].name, 'web');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start refuses to spawn on the desktop app\'s own dev port', async () => {
  const root = tmpWorkspace([{ name: 'self', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: DESKTOP_PORT }]);
  try {
    const reg = createDevServerRegistry(root);
    const status = await reg.start('self');
    assert.ok(status.error && /own dev port/.test(status.error), 'refused with a dev-port error');
    assert.equal(status.status, 'stopped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start returns an error for an unknown config name', async () => {
  const root = tmpWorkspace([{ name: 'ok', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 4321 }]);
  try {
    const reg = createDevServerRegistry(root);
    const status = await reg.start('nope');
    assert.ok(status.error && /no dev config/.test(status.error));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('list joins launch.json configs with stopped run-state', () => {
  const root = tmpWorkspace([{ name: 'a', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 4321 }]);
  try {
    const reg = createDevServerRegistry(root);
    const list = reg.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'a');
    assert.equal(list[0].status, 'stopped');
    assert.equal(list[0].url, 'http://localhost:4321');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
