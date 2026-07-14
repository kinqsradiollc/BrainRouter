import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedAgentManager } from './hostedAgents.js';
import { PtyRegistry, type PtyLike } from './pty.js';

class FakePty implements PtyLike {
  pid = 9;
  process = 'fake';
  writes: string[] = [];
  killed = false;
  private data = new Set<(value: string) => void>();
  private exits = new Set<(value: { exitCode: number }) => void>();
  write(value: string): void { this.writes.push(value); }
  resize(): void {}
  kill(): void { this.killed = true; }
  onData(listener: (value: string) => void) { this.data.add(listener); return { dispose: () => this.data.delete(listener) }; }
  onExit(listener: (value: { exitCode: number }) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
  emit(value: string): void { for (const listener of this.data) listener(value); }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-hosted-'));
  const bin = path.join(dir, 'brainrouter');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  fs.chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  const ptys: FakePty[] = [];
  const registry = new PtyRegistry({ workspaceRoot: dir, spawn: () => { const p = new FakePty(); ptys.push(p); return p; } });
  const transitions: string[] = [];
  const manager = new HostedAgentManager({ workspaceRoot: dir, ptyRegistry: registry, onTransition: (session) => transitions.push(session.status) });
  return { dir, ptys, registry, manager, transitions, cleanup: () => { process.env.PATH = oldPath; registry.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('launches a detected adapter and controls it through the shared PTY', async () => {
  const f = fixture();
  try {
    const opened = f.manager.start({ sessionKey: 's1', adapterId: 'brainrouter', prompt: 'do the task' });
    assert.ok('id' in opened);
    await new Promise((resolve) => setTimeout(resolve, 275));
    assert.deepEqual(f.ptys[0]?.writes, ['do the task\r']);
    assert.equal(f.manager.control('s1', 'interrupt'), true);
    assert.equal(f.ptys[0]?.writes.at(-1), '\u0003');
  } finally { f.cleanup(); }
});

test('normalizes terminal output and returns a restorable attachment', () => {
  const f = fixture();
  try {
    f.manager.start({ sessionKey: 's1', adapterId: 'brainrouter' });
    f.ptys[0]?.emit('Approve this command?');
    assert.equal(f.manager.refresh('s1')?.status, 'blocked');
    const attached = f.manager.attach('s1');
    assert.equal(attached?.snapshot, 'Approve this command?');
    assert.equal(attached?.status, 'blocked');
  } finally { f.cleanup(); }
});

test('kill terminates the PTY and removes the restorable hosted session', () => {
  const f = fixture();
  try {
    f.manager.start({ sessionKey: 's1', adapterId: 'brainrouter' });
    assert.equal(f.manager.kill('s1'), true);
    assert.equal(f.ptys[0]?.killed, true);
    assert.equal(f.manager.attach('s1'), null);
    assert.equal(f.manager.control('s1', 'interrupt'), false);
    assert.equal(f.manager.kill('s1'), false);
  } finally { f.cleanup(); }
});

test('dispose terminates every hosted PTY', () => {
  const f = fixture();
  try {
    f.manager.start({ sessionKey: 's1', adapterId: 'brainrouter' });
    f.manager.start({ sessionKey: 's2', adapterId: 'brainrouter' });
    f.manager.dispose();
    assert.equal(f.ptys.length, 2);
    assert.ok(f.ptys.every((pty) => pty.killed));
    assert.equal(f.manager.attach('s1'), null);
    assert.equal(f.manager.attach('s2'), null);
  } finally { f.cleanup(); }
});
