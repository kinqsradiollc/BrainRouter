import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSpawnHelperExecutable, PtyRegistry, type PtyLike, type PtySpawn } from './pty.js';

class FakePty implements PtyLike {
  readonly pid = 4321;
  readonly process = 'fake-shell';
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills = 0;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.kills += 1; }
  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  emitData(data: string): void { for (const listener of this.dataListeners) listener(data); }
  emitExit(exitCode = 0): void { for (const listener of this.exitListeners) listener({ exitCode }); }
}

function fixture(bufferLimit = 400_000) {
  const ptys: FakePty[] = [];
  const spawn: PtySpawn = () => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const registry = new PtyRegistry({ workspaceRoot: '/work/repo', bufferLimit, spawn });
  return { registry, ptys };
}

test('restores the executable bit on the native spawn helper', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-node-pty-'));
  try {
    const entry = path.join(root, 'lib', 'index.js');
    const helper = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(entry, '');
    fs.writeFileSync(helper, '');
    fs.chmodSync(helper, 0o644);

    ensureSpawnHelperExecutable(entry);

    assert.notEqual(fs.statSync(helper).mode & 0o111, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opens a PTY with workspace cwd and streams raw terminal data', () => {
  const calls: Parameters<PtySpawn>[] = [];
  const pty = new FakePty();
  const registry = new PtyRegistry({
    workspaceRoot: '/work/repo',
    spawn: (...args) => { calls.push(args); return pty; },
  });

  const opened = registry.open({ shell: '/bin/zsh', args: ['-i'], cols: 120, rows: 40 });
  assert.equal(opened.id, 't1');
  assert.equal(opened.pid, 4321);
  assert.deepEqual(calls[0]?.slice(0, 2), ['/bin/zsh', ['-i']]);
  assert.equal(calls[0]?.[2].cwd, '/work/repo');
  assert.equal(calls[0]?.[2].cols, 120);
  assert.equal(calls[0]?.[2].rows, 40);

  pty.emitData('\u001b[31mhello\u001b[0m\r\n');
  assert.deepEqual(registry.read(opened.id, 0), {
    chunk: '\u001b[31mhello\u001b[0m\r\n', next: 16, alive: true, dropped: 0,
  });
});

test('writes and resizes a live PTY with clamped geometry', () => {
  const { registry, ptys } = fixture();
  const opened = registry.open({ cols: 80, rows: 24 });
  assert.equal(registry.write(opened.id, 'printf ok\r'), true);
  assert.equal(registry.resize(opened.id, 0, 100_000), true);
  assert.deepEqual(ptys[0]?.writes, ['printf ok\r']);
  assert.deepEqual(ptys[0]?.resizes, [[2, 1_000]]);
});

test('keeps absolute read offsets when bounded scrollback drops old output', () => {
  const { registry, ptys } = fixture(8);
  const opened = registry.open({});
  ptys[0]?.emitData('123456');
  const first = registry.read(opened.id, 0);
  assert.equal(first.next, 6);
  ptys[0]?.emitData('abcdef');

  assert.deepEqual(registry.read(opened.id, first.next), {
    chunk: 'abcdef', next: 12, alive: true, dropped: 0,
  });
  assert.deepEqual(registry.read(opened.id, 0), {
    chunk: '56abcdef', next: 12, alive: true, dropped: 4,
  });
});

test('reuses a named workspace terminal and returns its restore snapshot', () => {
  const { registry, ptys } = fixture();
  const first = registry.open({ reuseKey: 'workspace' });
  ptys[0]?.emitData('ready\r\n');
  const second = registry.open({ reuseKey: 'workspace', cols: 100, rows: 30 });

  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal(second.snapshot, 'ready\r\n');
  assert.equal(second.next, 7);
  assert.equal(ptys.length, 1);
  assert.deepEqual(ptys[0]?.resizes, [[100, 30]]);
});

test('marks exits, rejects input, and kills every child during disposal', () => {
  const { registry, ptys } = fixture();
  const first = registry.open({});
  registry.open({});
  ptys[0]?.emitExit(7);

  assert.equal(registry.write(first.id, 'ignored'), false);
  assert.match(registry.read(first.id, 0).chunk, /shell exited 7/);
  registry.dispose();
  assert.deepEqual(ptys.map((pty) => pty.kills), [1, 1]);
  assert.equal(registry.size, 0);
});

test('adopts a remote PTY into the same bounded lifecycle and reuse registry', () => {
  const f = fixture();
  try {
    const remote = new FakePty();
    const opened = f.registry.adopt(remote, { shell: 'ssh://devbox', reuseKey: 'remote:one' });
    remote.emitData('remote output');
    assert.equal(f.registry.snapshot(opened.id)?.snapshot, 'remote output');
    const duplicate = new FakePty();
    const reused = f.registry.adopt(duplicate, { shell: 'ssh://devbox', reuseKey: 'remote:one' });
    assert.equal(reused.id, opened.id);
    assert.equal(reused.reused, true);
    assert.equal(duplicate.kills, 1);
    assert.equal(f.registry.kill(opened.id), true);
    assert.equal(remote.kills, 1);
  } finally { f.registry.dispose(); }
});
