/**
 * MC-A2 — the `worktree` runtime backend against a REAL tmp git repo fixture:
 * start provisions an actual git worktree (via the shared child-isolation
 * machinery), exec hands the executor a spec whose cwd is inside the
 * worktree, dispose captures a recovery patch when dirty then removes the
 * tree, pause parks it in place, and resume re-attaches by path (same
 * instance and via `attachWorktreeRuntime` on a fresh one). No live
 * Agent/LLM/MCP — turn execution stays injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createWorktreeRuntime,
  attachWorktreeRuntime,
  resolveRuntime,
  availableRuntimeBackends,
  readRuntimeRecord,
  type RuntimeSpec,
} from '../runtime/index.js';
import { worktreePatchFile } from '../worktree/worktreeIsolation.js';
import { withTempWorkspaceAsync } from './_helpers.js';

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

function makeSpec(workspaceRoot: string): RuntimeSpec {
  return { workspaceRoot, sessionKey: 'session:worktree-test' };
}

test('MC-A2 start provisions a real git worktree; exec runs with cwd inside it', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const specsSeen: RuntimeSpec[] = [];
    const rt = createWorktreeRuntime({
      executeTurn: async (turn, spec) => {
        specsSeen.push(spec);
        return `ran:${turn.prompt}`;
      },
    });
    assert.equal(rt.kind, 'worktree');

    await rt.start(makeSpec(ws));
    assert.equal(rt.status(), 'ready');

    const wt = rt.worktreeRoot;
    assert.ok(wt, 'worktree path is exposed after start');
    assert.ok(fs.existsSync(wt!), 'worktree exists on disk');
    assert.notEqual(fs.realpathSync(wt!), fs.realpathSync(ws), 'worktree is NOT the parent tree');
    // It is a real checkout of the repo (linked worktree .git file + HEAD content).
    assert.ok(fs.existsSync(path.join(wt!, '.git')));
    assert.equal(fs.readFileSync(path.join(wt!, 'fixture.txt'), 'utf8'), 'seed content\n');

    // The durable record carries where the runtime lives (re-attach by path).
    const record = readRuntimeRecord(ws, rt.id);
    assert.equal(record?.backend, 'worktree');
    assert.equal(record?.status, 'ready');
    assert.equal(record?.worktree?.worktreeRoot, wt);
    assert.ok(record?.worktree?.sourceRoot);

    // exec: the executor sees the ISOLATED workspace, not the parent.
    const out = await rt.exec({ prompt: 'hello' });
    assert.equal(out.output, 'ran:hello');
    assert.equal(specsSeen.length, 1);
    assert.equal(specsSeen[0].workspaceRoot, wt);
    assert.equal(specsSeen[0].launchCwd, wt);
    assert.equal(specsSeen[0].sessionKey, 'session:worktree-test');
    assert.equal(rt.status(), 'ready');

    await rt.dispose();
  });
});

test('MC-A2 dispose removes the worktree and leaves a recovery patch when dirty', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await rt.start(makeSpec(ws));
    const wt = rt.worktreeRoot!;

    // Dirty the worktree the way an agent run would: edit + add a file.
    fs.writeFileSync(path.join(wt, 'fixture.txt'), 'edited by the runtime\n');
    fs.writeFileSync(path.join(wt, 'new-work.txt'), 'net-new file\n');

    await rt.dispose();
    assert.equal(rt.status(), 'disposed');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'disposed');
    assert.ok(!fs.existsSync(wt), 'worktree removed from disk');

    // The recovery patch survives the teardown, at the existing patch path.
    const patch = worktreePatchFile(ws, rt.id);
    assert.ok(fs.existsSync(patch), `recovery patch expected at ${patch}`);
    const body = fs.readFileSync(patch, 'utf8');
    assert.match(body, /new-work\.txt/);
    assert.match(body, /edited by the runtime/);

    await rt.dispose(); // idempotent
    assert.equal(rt.status(), 'disposed');
  });
});

test('MC-A2 dispose on a clean worktree removes it without writing a patch', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await rt.start(makeSpec(ws));
    const wt = rt.worktreeRoot!;
    await rt.dispose();
    assert.ok(!fs.existsSync(wt), 'worktree removed');
    assert.ok(!fs.existsSync(worktreePatchFile(ws, rt.id)), 'no patch for a clean tree');
  });
});

test('MC-A2 pause parks the runtime and leaves the worktree intact; resume re-attaches', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await rt.start(makeSpec(ws));
    const wt = rt.worktreeRoot!;
    // Park with in-flight work sitting in the tree.
    fs.writeFileSync(path.join(wt, 'wip.txt'), 'half-done\n');

    await rt.pause();
    assert.equal(rt.status(), 'parked');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'parked', 'park is durable');
    assert.ok(fs.existsSync(wt), 'worktree stays ON DISK while parked');
    assert.equal(fs.readFileSync(path.join(wt, 'wip.txt'), 'utf8'), 'half-done\n');
    await rt.pause(); // idempotent
    assert.equal(rt.status(), 'parked');
    await assert.rejects(() => rt.exec({ prompt: 'nope' }), /cannot exec while 'parked'/);

    await rt.resume();
    assert.equal(rt.status(), 'ready');
    const out = await rt.exec({ prompt: 'after resume' });
    assert.equal(out.output, 'ok');
    // The in-flight work survived the park/resume round-trip untouched.
    assert.equal(fs.readFileSync(path.join(wt, 'wip.txt'), 'utf8'), 'half-done\n');
    await rt.dispose();
  });
});

test('MC-A2 attachWorktreeRuntime re-attaches a parked instance by path', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const first = createWorktreeRuntime({ executeTurn: async () => 'first' });
    await first.start(makeSpec(ws));
    const wt = first.worktreeRoot!;
    fs.writeFileSync(path.join(wt, 'wip.txt'), 'parked work\n');
    await first.pause();

    // A fresh instance (fresh process in real life) re-attaches from the record.
    const seen: string[] = [];
    const revived = attachWorktreeRuntime({
      executeTurn: async (_turn, spec) => {
        seen.push(spec.workspaceRoot);
        return 'revived';
      },
      workspaceRoot: ws,
      id: first.id,
    });
    assert.equal(revived.id, first.id);
    assert.equal(revived.status(), 'parked');
    assert.equal(revived.worktreeRoot, wt);

    await revived.resume();
    assert.equal(revived.status(), 'ready');
    assert.equal((await revived.exec({ prompt: 'go' })).output, 'revived');
    assert.deepEqual(seen, [wt], 'revived executor runs inside the SAME worktree');
    assert.equal(fs.readFileSync(path.join(wt, 'wip.txt'), 'utf8'), 'parked work\n');

    // Dispose from the revived handle: patch captured, tree removed.
    await revived.dispose();
    assert.ok(!fs.existsSync(wt));
    assert.ok(fs.existsSync(worktreePatchFile(ws, first.id)));

    // Guards: unknown id / non-parked records refuse to attach.
    assert.throws(() => attachWorktreeRuntime({ executeTurn: async () => '', workspaceRoot: ws, id: 'rt_missing0' }), /no runtime record/);
    assert.throws(() => attachWorktreeRuntime({ executeTurn: async () => '', workspaceRoot: ws, id: first.id }), /only parked runtimes re-attach/);
  });
});

test('MC-A2 status reflects worktree existence on disk', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await rt.start(makeSpec(ws));
    await rt.pause();
    const wt = rt.worktreeRoot!;

    // The worktree vanishes out from under the parked runtime (external rm,
    // orphan GC, sibling prune) — status tells the truth instead of 'parked'.
    fs.rmSync(wt, { recursive: true, force: true });
    assert.equal(rt.status(), 'error');
    await assert.rejects(() => rt.resume(), /worktree missing/);
    await rt.dispose(); // teardown still safe with the tree already gone
    assert.equal(rt.status(), 'disposed');
  });
});

test('MC-A2 start fails closed outside a git repo (never runs non-isolated)', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    // No git init — the workspace is a plain directory.
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await assert.rejects(() => rt.start(makeSpec(ws)), /not inside a git repository/);
    assert.equal(rt.status(), 'error');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'error');
    await rt.dispose(); // dispose still allowed from error
  });
});

test('MC-A2 lifecycle guards: exec/pause before start, double start', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await assert.rejects(() => rt.exec({ prompt: 'x' }), /not started/);
    await assert.rejects(() => rt.pause(), /not started/);
    await rt.start(makeSpec(ws));
    await assert.rejects(() => rt.start(makeSpec(ws)), /already started/);
    await rt.dispose();
  });
});

test('MC-A2 registry: worktree backend is registered and resolvable', () => {
  assert.ok(availableRuntimeBackends().includes('worktree'));
  assert.equal(resolveRuntime({ executeTurn: async () => 'ok' }, 'worktree').kind, 'worktree');
});
