/**
 * DESK-FANOUT — isolated candidate lifecycle checks. Tests pin preflight
 * no-write behavior, process-restart reconciliation, and winner promotion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createFanoutRun,
  getFanoutRun,
  listFanoutRuns,
  updateFanoutCandidate,
} from '@kinqs/brainrouter-core/fanout';
import { FanoutManager } from './fanoutManager.js';
import { HostedAgentManager } from './hostedAgents.js';
import { PtyRegistry, type PtyLike } from './pty.js';

class FakePty implements PtyLike {
  pid = 1; process = 'fake';
  killed = false;
  write(): void {} resize(): void {} kill(): void { this.killed = true; }
  onData() { return { dispose() {} }; }
  onExit() { return { dispose() {} }; }
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('fan-out launches isolated candidates, ranks them, and promotes only the winner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-state-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-bin-'));
  const oldHome = process.env.BRAINROUTER_HOME;
  const oldPath = process.env.PATH;
  process.env.BRAINROUTER_HOME = home;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  fs.writeFileSync(path.join(bin, 'brainrouter'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'brainrouter'), 0o755);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'answer.txt'), 'base\n');
  git(root, ['add', 'answer.txt']);
  git(root, ['commit', '-m', 'base']);

  const spawned: FakePty[] = [];
  const ptys = new PtyRegistry({ workspaceRoot: root, spawn: () => { const pty = new FakePty(); spawned.push(pty); return pty; } });
  const hosted = new HostedAgentManager({ workspaceRoot: root, ptyRegistry: ptys });
  const fanout = new FanoutManager({ workspaceRoot: root, hostedAgents: hosted, capacity: 2 });
  try {
    const created = fanout.start({
      task: 'Change the answer',
      adapterIds: ['brainrouter', 'claude-code'],
      trusted: true,
      sessionKey: 's1',
    });
    let run = created;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = fanout.refresh(created.id) ?? run;
      if (run.candidates.every((candidate) => candidate.worktreeRoot)) break;
    }
    assert.equal(run.candidates.length, 2);
    assert.ok(run.candidates.every((candidate) => candidate.worktreeRoot && candidate.terminalId));

    const winner = run.candidates[0]!;
    const loser = run.candidates[1]!;
    fs.writeFileSync(path.join(winner.worktreeRoot!, 'answer.txt'), 'winner\n');
    run = fanout.rank(created.id)!;
    assert.equal(run.candidates.find((candidate) => candidate.id === winner.id)?.changedFiles, 1);

    const promoted = (await fanout.promote(created.id, winner.id, 'merge'))!;
    assert.equal(promoted.status, 'promoted');
    assert.equal(promoted.winnerId, winner.id);
    assert.equal(fs.readFileSync(path.join(root, 'answer.txt'), 'utf8'), 'winner\n');
    assert.equal(spawned[0]?.killed, true, 'winner PTY is frozen before its patch is captured');
    assert.equal(fs.existsSync(loser.worktreeRoot!), true, 'non-winner is preserved until explicit cleanup');
    await fanout.cleanup(created.id, loser.id);
    assert.equal(fs.existsSync(loser.worktreeRoot!), false);
    assert.equal(spawned[1]?.killed, true, 'cleanup terminates the candidate PTY before removing its checkout');
  } finally {
    fanout.dispose(); hosted.dispose(); ptys.dispose();
    process.env.BRAINROUTER_HOME = oldHome;
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('fan-out preflight rejects missing trust and duplicate adapters without persisting a run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-preflight-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-preflight-state-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-preflight-bin-'));
  const oldHome = process.env.BRAINROUTER_HOME;
  const oldPath = process.env.PATH;
  process.env.BRAINROUTER_HOME = home;
  process.env.PATH = bin;
  fs.writeFileSync(path.join(bin, 'brainrouter'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'brainrouter'), 0o755);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const ptys = new PtyRegistry({ workspaceRoot: root, spawn: () => new FakePty() });
  const hosted = new HostedAgentManager({ workspaceRoot: root, ptyRegistry: ptys });
  const fanout = new FanoutManager({ workspaceRoot: root, hostedAgents: hosted });
  try {
    assert.throws(
      () => fanout.start({ task: 'Compare', adapterIds: ['brainrouter', 'codex'], sessionKey: 's1' }),
      /Trust isolated worktrees.*Codex CLI/,
    );
    assert.throws(
      () => fanout.start({ task: 'Compare', adapterIds: ['brainrouter', 'brainrouter'], sessionKey: 's1' }),
      /distinct adapters/,
    );
    assert.throws(
      () => fanout.start({ task: 'Compare', adapterIds: ['brainrouter', 'opencode'], trusted: true, sessionKey: 's1' }),
      /Install selected adapters.*OpenCode/,
    );
    assert.deepEqual(listFanoutRuns(root), []);
  } finally {
    fanout.dispose(); hosted.dispose(); ptys.dispose();
    process.env.BRAINROUTER_HOME = oldHome;
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('fan-out startup marks candidates without process-local sessions as failed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-restart-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-restart-state-'));
  const oldHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  const run = createFanoutRun(root, { task: 'Compare', adapterIds: ['brainrouter', 'codex'] });
  for (const candidate of run.candidates) {
    updateFanoutCandidate(root, run.id, candidate.id, {
      status: 'working',
      terminalId: `terminal-${candidate.id}`,
      worktreeRoot: path.join(root, '.worktrees', candidate.id),
    });
  }
  const ptys = new PtyRegistry({ workspaceRoot: root, spawn: () => new FakePty() });
  const hosted = new HostedAgentManager({ workspaceRoot: root, ptyRegistry: ptys });
  const fanout = new FanoutManager({ workspaceRoot: root, hostedAgents: hosted });
  try {
    const reconciled = getFanoutRun(root, run.id)!;
    assert.equal(reconciled.status, 'failed');
    assert.ok(reconciled.candidates.every((candidate) => candidate.status === 'failed'));
    assert.ok(reconciled.candidates.every((candidate) => candidate.error?.includes('Desktop restarted')));
    assert.ok(reconciled.candidates.every((candidate) => candidate.terminalId === undefined));
    assert.ok(reconciled.candidates.every((candidate) => candidate.worktreeRoot));
  } finally {
    fanout.dispose(); hosted.dispose(); ptys.dispose();
    process.env.BRAINROUTER_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
