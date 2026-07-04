/**
 * MC-A6 — workspace archive-on-dispose + resume-from-archive, against a REAL
 * tmp git repo fixture: a dirty worktree runtime's dispose writes
 * patch + tarball + manifest under the runtime archives root, the tarball
 * size cap is respected (oversize → patch only + note), `resumeFromArchive`
 * round-trips the dirty work into a fresh worktree at the archived base
 * commit, and `pruneArchives` keeps the newest N. No live Agent/LLM/MCP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createWorktreeRuntime,
  archiveWorkspace,
  listArchives,
  pruneArchives,
  resumeFromArchive,
  runtimeArchivesRoot,
  type RuntimeArchiveManifest,
} from '../runtime/index.js';
import { setCliKnobOverride } from '../config/config.js';
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
  fs.writeFileSync(path.join(ws, 'stable.txt'), 'untouched\n');
  git(ws, 'add', '.');
  git(ws, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test.invalid', 'commit', '-q', '-m', 'seed');
}

/** Hermetic knob values for the archive suite (defaults unless overridden). */
function pinRuntimeKnobs(overrides: Partial<{
  archiveOnDispose: boolean; archiveMaxMB: number; archiveKeep: number;
}> = {}): void {
  setCliKnobOverride({
    runtime: {
      backend: 'process',
      maxLive: 0,
      archiveOnDispose: true,
      archiveMaxMB: 64,
      archiveKeep: 20,
      ...overrides,
    },
  } as any);
}

function tarEntries(tarPath: string): string[] {
  const res = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(res.status, 0, `tar -tzf failed: ${res.stderr}`);
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

test('MC-A6 dispose writes patch + tarball + manifest under the archives root', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    pinRuntimeKnobs();
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await rt.start({ workspaceRoot: ws, sessionKey: 'session:archive-test' });
    const wt = rt.worktreeRoot!;
    const baseCommit = git(ws, 'rev-parse', 'HEAD').trim();

    // Dirty the tree the way an agent run would: edit tracked + add untracked.
    fs.writeFileSync(path.join(wt, 'fixture.txt'), 'edited by the runtime\n');
    fs.writeFileSync(path.join(wt, 'new-work.txt'), 'net-new file\n');

    await rt.dispose();
    assert.ok(!fs.existsSync(wt), 'worktree removed from disk');

    const dir = path.join(runtimeArchivesRoot(), rt.id);
    const patchPath = path.join(dir, 'changes.patch');
    const tarPath = path.join(dir, 'files.tar.gz');
    const manifestPath = path.join(dir, 'manifest.json');
    assert.ok(fs.existsSync(patchPath), 'git-delta patch archived');
    assert.ok(fs.existsSync(tarPath), 'changed-files tarball archived');
    assert.ok(fs.existsSync(manifestPath), 'manifest archived');

    const patch = fs.readFileSync(patchPath, 'utf8');
    assert.match(patch, /new-work\.txt/);
    assert.match(patch, /edited by the runtime/);

    // Tarball packs the changed set ONLY — never the whole repo.
    const entries = tarEntries(tarPath);
    assert.ok(entries.some((e) => e.endsWith('fixture.txt')));
    assert.ok(entries.some((e) => e.endsWith('new-work.txt')));
    assert.ok(!entries.some((e) => e.endsWith('stable.txt')), 'unchanged files stay out of the tarball');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RuntimeArchiveManifest;
    assert.equal(manifest.id, rt.id);
    assert.equal(manifest.workspaceRoot, ws);
    assert.equal(manifest.baseCommit, baseCommit);
    assert.equal(manifest.branch, 'HEAD'); // detached worktree
    assert.equal(manifest.status, 'archived');
    assert.equal(manifest.changedFiles, 2);
    assert.equal(manifest.patchFile, 'changes.patch');
    assert.equal(manifest.filesTar, 'files.tar.gz');
    assert.equal(manifest.sessionKey, 'session:archive-test');
    assert.ok(manifest.bytes > 0, 'manifest records the on-disk payload size');
    assert.ok(manifest.createdAt);

    // listArchives surfaces it.
    assert.deepEqual(listArchives().map((m) => m.id), [rt.id]);
  });
});

test('MC-A6 dispose skips archiving when cli.runtime.archiveOnDispose is off', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    pinRuntimeKnobs({ archiveOnDispose: false });
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await rt.start({ workspaceRoot: ws, sessionKey: 'session:no-archive' });
    fs.writeFileSync(path.join(rt.worktreeRoot!, 'wip.txt'), 'dirty\n');
    await rt.dispose();
    assert.ok(!fs.existsSync(path.join(runtimeArchivesRoot(), rt.id)), 'no archive dir when opted out');
  });
});

test('MC-A6 clean tree archives nothing (no empty archives on disk)', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    pinRuntimeKnobs();
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await rt.start({ workspaceRoot: ws, sessionKey: 'session:clean' });
    await rt.dispose(); // never dirtied
    assert.ok(!fs.existsSync(path.join(runtimeArchivesRoot(), rt.id)));
    assert.equal(archiveWorkspace({ id: 'direct-clean', workspaceRoot: ws, treeRoot: ws }), null);
    assert.equal(listArchives().length, 0);
  });
});

test('MC-A6 size cap: oversize payload skips the tarball, keeps the patch, notes it', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    pinRuntimeKnobs();
    fs.writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(200) + '\n');
    const manifest = archiveWorkspace({
      id: 'cap-test',
      workspaceRoot: ws,
      treeRoot: ws,
      maxBytes: 16, // way under the payload
    });
    assert.ok(manifest, 'archive still produced');
    assert.equal(manifest!.status, 'oversize');
    assert.equal(manifest!.filesTar, null, 'tarball skipped');
    assert.match(manifest!.note ?? '', /tarball skipped/);
    const dir = path.join(runtimeArchivesRoot(), 'cap-test');
    assert.ok(fs.existsSync(path.join(dir, 'changes.patch')), 'patch still captured');
    assert.ok(!fs.existsSync(path.join(dir, 'files.tar.gz')));
  });
});

test('MC-A6 resumeFromArchive round-trips dirty work into a fresh worktree at baseCommit', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    pinRuntimeKnobs();
    const rt = createWorktreeRuntime({ executeTurn: async () => 'ok' });
    await rt.start({ workspaceRoot: ws, sessionKey: 'session:roundtrip' });
    const wt = rt.worktreeRoot!;
    fs.writeFileSync(path.join(wt, 'fixture.txt'), 'edited then archived\n');
    fs.writeFileSync(path.join(wt, 'new-work.txt'), 'net-new file\n');
    await rt.dispose();
    assert.ok(!fs.existsSync(wt), 'original worktree is gone');

    const resumed = resumeFromArchive(rt.id);
    const revived = resumed.worktreeRoot;
    assert.ok(fs.existsSync(revived), 'a fresh worktree exists');
    assert.notEqual(fs.realpathSync(revived), fs.realpathSync(ws), 'resume never lands on the parent tree');
    // Checked out at the archived base commit…
    assert.equal(git(revived, 'rev-parse', 'HEAD').trim(), resumed.manifest.baseCommit);
    // …with the archived work restored on top.
    assert.equal(fs.readFileSync(path.join(revived, 'fixture.txt'), 'utf8'), 'edited then archived\n');
    assert.equal(fs.readFileSync(path.join(revived, 'new-work.txt'), 'utf8'), 'net-new file\n');
    assert.equal(fs.readFileSync(path.join(revived, 'stable.txt'), 'utf8'), 'untouched\n');
    assert.equal(resumed.patchApplied, true);
    assert.equal(resumed.filesRestored, true);

    // The returned spec is ready to hand a runtime executor.
    assert.equal(resumed.spec.workspaceRoot, revived);
    assert.equal(resumed.spec.launchCwd, revived);
    assert.equal(resumed.spec.sessionKey, 'session:roundtrip');

    // Unknown ids fail loudly.
    assert.throws(() => resumeFromArchive('rt_missing0'), /no archive 'rt_missing0'/);
  });
});

test('MC-A6 pruneArchives keeps the newest N and honors maxAgeDays', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    initRepoFixture(ws);
    pinRuntimeKnobs();
    fs.writeFileSync(path.join(ws, 'dirty.txt'), 'keeps the tree dirty\n');
    const mk = (id: string, iso: string) => {
      const m = archiveWorkspace({ id, workspaceRoot: ws, treeRoot: ws, now: () => iso });
      assert.ok(m, `archive ${id} produced`);
    };
    mk('arch-old', '2026-01-01T00:00:00.000Z');
    mk('arch-mid', '2026-01-02T00:00:00.000Z');
    mk('arch-new', '2026-01-03T00:00:00.000Z');

    assert.deepEqual(listArchives().map((m) => m.id), ['arch-new', 'arch-mid', 'arch-old'], 'newest first');

    // Count-based prune: keep the newest 2.
    assert.deepEqual(pruneArchives({ keepN: 2 }), ['arch-old']);
    assert.deepEqual(listArchives().map((m) => m.id), ['arch-new', 'arch-mid']);
    assert.ok(!fs.existsSync(path.join(runtimeArchivesRoot(), 'arch-old')));

    // Age-based prune (keepN 0 = no count limit): everything older than 10 days goes.
    const removed = pruneArchives({
      keepN: 0,
      maxAgeDays: 10,
      now: () => Date.parse('2026-01-13T00:00:00.000Z'),
    });
    assert.deepEqual(removed.sort(), ['arch-mid']);
    assert.deepEqual(listArchives().map((m) => m.id), ['arch-new']);

    // Default keepN comes from the knob.
    pinRuntimeKnobs({ archiveKeep: 0 });
    assert.deepEqual(pruneArchives(), [], 'archiveKeep 0 = no count-based pruning');
  });
});
