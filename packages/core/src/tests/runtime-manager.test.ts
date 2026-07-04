/**
 * MC-A4 — runtime manager: LRU parking under the `maxLive` cap, resume
 * re-attach (in-process handle, worktree by path, process re-host), boot
 * reconcile of records a dead process left live-ish, and `listRuntimes()`.
 * No live Agent/LLM/MCP — turn execution stays injected; the worktree
 * end-to-end case uses a real tmp git repo like the backend suite does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RuntimeManager,
  createRuntimeManager,
  reconcileRuntimeRecords,
  createRuntimeRecord,
  updateRuntimeRecord,
  readRuntimeRecord,
} from '../runtime/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

const echoTurn = async (turn: { prompt: string }) => `echo:${turn.prompt}`;

/** Liveness stub: only OUR pid counts as alive (everything stale is "dead"). */
const onlySelfAlive = (pid: number | null | undefined) => pid === process.pid;

function makeManager(ws: string, maxLive: number): RuntimeManager {
  return new RuntimeManager({ workspaceRoot: ws, executeTurn: echoTurn, maxLive, isAlive: onlySelfAlive });
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

/** Turn the temp workspace into a real git repo with one commit. */
function initRepoFixture(ws: string): void {
  git(ws, 'init', '-q');
  fs.writeFileSync(path.join(ws, 'fixture.txt'), 'seed content\n');
  git(ws, 'add', '.');
  git(ws, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test.invalid', 'commit', '-q', '-m', 'seed');
}

// ---------------------------------------------------------------------------
// LRU parking under the cap
// ---------------------------------------------------------------------------

test('MC-A4 LRU: starting over the cap parks the least-recently-used live instance', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const mgr = makeManager(ws, 2);
    const a = await mgr.start({ sessionKey: 's:a', kind: 'process' });
    const b = await mgr.start({ sessionKey: 's:b', kind: 'process' });
    assert.equal(mgr.liveCount(), 2);

    // Touch A — B becomes the LRU.
    assert.equal((await mgr.exec(a.id, { prompt: 'hi' })).output, 'echo:hi');

    const c = await mgr.start({ sessionKey: 's:c', kind: 'process' });
    assert.equal(mgr.liveCount(), 2, 'cap holds');
    assert.equal(b.status(), 'parked', 'LRU instance was parked, not the touched one');
    assert.equal(readRuntimeRecord(ws, b.id)?.status, 'parked', 'park is durable');
    assert.equal(a.status(), 'ready');
    assert.equal(c.status(), 'ready');

    // A parked instance is no longer exec-able through the manager.
    await assert.rejects(() => mgr.exec(b.id, { prompt: 'x' }), /not live/);
  });
});

test('MC-A4 LRU: resume re-attaches the parked instance and re-parks another to stay under the cap', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const mgr = makeManager(ws, 2);
    const a = await mgr.start({ sessionKey: 's:a', kind: 'process' });
    const b = await mgr.start({ sessionKey: 's:b', kind: 'process' });
    await mgr.exec(a.id, { prompt: 'touch a' });
    const c = await mgr.start({ sessionKey: 's:c', kind: 'process' }); // parks B

    // Resuming B must evict the current LRU (A — touched before C started).
    const revived = await mgr.resume(b.id);
    assert.equal(revived.id, b.id, 'the SAME in-process handle resumes');
    assert.equal(revived, b);
    assert.equal(mgr.liveCount(), 2);
    assert.equal(a.status(), 'parked', 'LRU live instance was re-parked to make room');
    assert.equal(b.status(), 'ready');
    assert.equal(c.status(), 'ready');
    assert.equal((await mgr.exec(b.id, { prompt: 'back' })).output, 'echo:back');

    // Resume of an already-live instance is idempotent (no parking churn).
    assert.equal(await mgr.resume(c.id), c);
    assert.equal(mgr.liveCount(), 2);
    assert.equal(b.status(), 'ready');
  });
});

test('MC-A4 maxLive=0: uncapped — never parks anything', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const mgr = makeManager(ws, 0);
    const started = [];
    for (let i = 0; i < 5; i++) {
      started.push(await mgr.start({ sessionKey: `s:${i}`, kind: 'process' }));
    }
    assert.equal(mgr.liveCount(), 5);
    for (const rt of started) assert.equal(rt.status(), 'ready');
  });
});

test('MC-A4 cap full of mid-turn instances: start fails loudly instead of yanking a running turn', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mgr = new RuntimeManager({
      workspaceRoot: ws,
      executeTurn: async () => { await gate; return 'done'; },
      maxLive: 1,
      isAlive: onlySelfAlive,
    });
    const a = await mgr.start({ sessionKey: 's:a', kind: 'process' });
    const inFlight = mgr.exec(a.id, { prompt: 'long turn' });
    await assert.rejects(
      () => mgr.start({ sessionKey: 's:b', kind: 'process' }),
      /mid-turn/,
    );
    release();
    assert.equal((await inFlight).output, 'done');
  });
});

// ---------------------------------------------------------------------------
// Boot reconcile
// ---------------------------------------------------------------------------

test('MC-A4 boot reconcile: dead-running → parked; missing worktree → error; live pids untouched', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    // A `process` record whose owner died mid-run.
    const deadProc = createRuntimeRecord(ws, { backend: 'process', sessionKey: 's:dead', status: 'running', pid: 41 });
    // A `worktree` record whose owner died but whose tree is still on disk.
    const treeDir = path.join(ws, 'still-here');
    fs.mkdirSync(treeDir, { recursive: true });
    const deadTree = createRuntimeRecord(ws, { backend: 'worktree', sessionKey: 's:tree', status: 'running', pid: 42 });
    updateRuntimeRecord(ws, deadTree.id, { worktree: { sourceRoot: ws, worktreeRoot: treeDir } });
    // A `worktree` record whose tree vanished with its owner.
    const goneTree = createRuntimeRecord(ws, { backend: 'worktree', sessionKey: 's:gone', status: 'running', pid: 43 });
    updateRuntimeRecord(ws, goneTree.id, { worktree: { sourceRoot: ws, worktreeRoot: path.join(ws, 'vanished') } });
    // A record still owned by a LIVE process — reconcile must not touch it.
    const alive = createRuntimeRecord(ws, { backend: 'process', sessionKey: 's:alive', status: 'running', pid: process.pid });
    // Terminal records are never reconciled.
    const done = createRuntimeRecord(ws, { backend: 'process', sessionKey: 's:done', status: 'disposed', pid: 44 });

    const result = reconcileRuntimeRecords(ws, onlySelfAlive);
    assert.deepEqual([...result.parked].sort(), [deadProc.id, deadTree.id].sort());
    assert.deepEqual(result.errored, [goneTree.id]);

    assert.equal(readRuntimeRecord(ws, deadProc.id)?.status, 'parked');
    assert.equal(readRuntimeRecord(ws, deadProc.id)?.pid, null, 'parked records are unowned');
    assert.equal(readRuntimeRecord(ws, deadTree.id)?.status, 'parked');
    assert.equal(readRuntimeRecord(ws, goneTree.id)?.status, 'error');
    assert.equal(readRuntimeRecord(ws, alive.id)?.status, 'running', 'live owner untouched');
    assert.equal(readRuntimeRecord(ws, alive.id)?.pid, process.pid);
    assert.equal(readRuntimeRecord(ws, done.id)?.status, 'disposed');
  });
});

test('MC-A4 boot reconcile: dead worktree record WITHOUT a persisted ref → error', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const orphan = createRuntimeRecord(ws, { backend: 'worktree', sessionKey: 's:orphan', status: 'starting', pid: 45 });
    const result = reconcileRuntimeRecords(ws, onlySelfAlive);
    assert.deepEqual(result.errored, [orphan.id]);
    assert.equal(readRuntimeRecord(ws, orphan.id)?.status, 'error');
  });
});

test('MC-A4 createRuntimeManager: runs boot reconcile before serving', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const stale = createRuntimeRecord(ws, { backend: 'process', sessionKey: 's:stale', status: 'running', pid: 46 });
    const { manager, reconciled } = createRuntimeManager({
      workspaceRoot: ws,
      executeTurn: echoTurn,
      maxLive: 0,
      isAlive: onlySelfAlive,
    });
    assert.deepEqual(reconciled, { parked: [stale.id], errored: [] });
    // ...and the reconciled record is immediately resumable through the manager.
    const revived = await manager.resume(stale.id);
    assert.equal(revived.id, stale.id);
    assert.equal(revived.status(), 'ready');
    assert.equal(readRuntimeRecord(ws, stale.id)?.pid, process.pid, 'resume claims ownership');
    assert.equal((await manager.exec(stale.id, { prompt: 'again' })).output, 'echo:again');
  });
});

// ---------------------------------------------------------------------------
// Cross-process resume + listRuntimes
// ---------------------------------------------------------------------------

test('MC-A4 resume: a durable-parked process record re-hosts in a FRESH manager', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const first = makeManager(ws, 0);
    const rt = await first.start({ sessionKey: 's:host', kind: 'process' });
    await first.pause(rt.id);
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'parked');

    // A fresh manager (fresh process in real life) holds no in-process handle.
    const second = makeManager(ws, 0);
    const revived = await second.resume(rt.id);
    assert.equal(revived.id, rt.id, 're-hosted under the SAME durable id');
    assert.equal(revived.status(), 'ready');
    assert.equal((await second.exec(rt.id, { prompt: 'rehosted' })).output, 'echo:rehosted');

    // Guards: unknown id / non-parked records refuse to resume.
    await assert.rejects(() => second.resume('rt_missing0'), /no runtime record/);
    await second.dispose(rt.id);
    // (MC-A3 widened the message: containers suspend as 'paused', not 'parked'.)
    await assert.rejects(() => second.resume(rt.id), /only parked\/paused runtimes resume/);
  });
});

test('MC-A4 resume: a durable-parked worktree record re-attaches by path in a FRESH manager', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const first = makeManager(ws, 0);
    const rt = await first.start({ sessionKey: 's:wt', kind: 'worktree' });
    const wt = readRuntimeRecord(ws, rt.id)?.worktree?.worktreeRoot;
    assert.ok(wt && fs.existsSync(wt), 'worktree provisioned');
    fs.writeFileSync(path.join(wt!, 'wip.txt'), 'parked work\n');
    await first.pause(rt.id);
    assert.ok(fs.existsSync(wt!), 'worktree stays on disk while parked');

    const seen: string[] = [];
    const second = new RuntimeManager({
      workspaceRoot: ws,
      executeTurn: async (_turn, spec) => { seen.push(spec.workspaceRoot); return 'revived'; },
      maxLive: 0,
      isAlive: onlySelfAlive,
    });
    const revived = await second.resume(rt.id);
    assert.equal(revived.id, rt.id);
    assert.equal((await second.exec(rt.id, { prompt: 'go' })).output, 'revived');
    assert.deepEqual(seen, [wt], 'revived executor runs inside the SAME worktree');
    assert.equal(fs.readFileSync(path.join(wt!, 'wip.txt'), 'utf8'), 'parked work\n');

    await second.dispose(rt.id);
    assert.ok(!fs.existsSync(wt!), 'dispose removes the tree');
  });
});

test('MC-A4 dispose: a durable-parked worktree record is torn down without resuming first', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const first = makeManager(ws, 0);
    const rt = await first.start({ sessionKey: 's:wt2', kind: 'worktree' });
    const wt = readRuntimeRecord(ws, rt.id)?.worktree?.worktreeRoot;
    await first.pause(rt.id);

    const second = makeManager(ws, 0);
    await second.dispose(rt.id);
    assert.ok(!fs.existsSync(wt!), 'parked tree removed via re-attach + dispose');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'disposed');
  });
});

test('MC-A4 listRuntimes: durable records + in-process liveness for CLI/desktop surfaces', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const mgr = makeManager(ws, 0);
    const a = await mgr.start({ sessionKey: 's:a', kind: 'process' });
    const b = await mgr.start({ sessionKey: 's:b', kind: 'process' });
    await mgr.pause(b.id);
    // A record owned by another (dead) process — visible but not live here.
    const foreign = createRuntimeRecord(ws, { backend: 'process', sessionKey: 's:foreign', status: 'parked', pid: null });

    const listed = mgr.listRuntimes();
    const byId = new Map(listed.map((r) => [r.id, r]));
    assert.equal(listed.length, 3);
    assert.equal(byId.get(a.id)?.live, true);
    assert.equal(byId.get(a.id)?.status, 'ready');
    assert.equal(byId.get(b.id)?.live, false, 'parked instances are not live');
    assert.equal(byId.get(b.id)?.status, 'parked');
    assert.equal(byId.get(foreign.id)?.live, false);
    assert.equal(byId.get(foreign.id)?.sessionKey, 's:foreign');
  });
});
