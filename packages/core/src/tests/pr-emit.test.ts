import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep all worktree FS side effects out of the real ~/.brainrouter.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'br-premit-home-'));
process.env.BRAINROUTER_HOME = TMP_HOME;

const {
  emitPrFromPatch,
  prBranchName,
  derivePrTitle,
  derivePrBody,
  parsePrUrl,
  isGhAvailable,
} = await import('../git/prEmit.js');
type CmdRunner = import('../git/prEmit.js').CmdRunner;

interface Call { cmd: string; args: string[] }
type Handler = (cmd: string, args: string[]) => { ok?: boolean; stdout?: string; stderr?: string } | void;
function makeRunner(handler: Handler, calls: Call[] = []): CmdRunner {
  return (cmd, args) => {
    calls.push({ cmd, args });
    const r = handler(cmd, args) ?? {};
    return { ok: r.ok ?? true, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

function writePatch(body = 'diff --git a/x b/x\n+change\n'): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'br-premit-')), 'build.patch');
  fs.writeFileSync(p, body);
  return p;
}

/** The happy-path command handler: gh present, GitHub origin, on `main`, PR opened. */
function happyHandler(prUrl = 'https://github.com/owner/repo/pull/7'): Handler {
  return (cmd, args) => {
    if (cmd === 'gh' && args[0] === '--version') return { ok: true, stdout: 'gh version 2.0' };
    if (cmd === 'git' && args[0] === 'remote') return { ok: true, stdout: 'git@github.com:owner/repo.git' };
    if (cmd === 'git' && args[0] === 'branch') return { ok: true, stdout: 'main\n' };
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') return { ok: true, stdout: `${prUrl}\n` };
    return { ok: true };
  };
}

// --- pure helpers ----------------------------------------------------------

test('prBranchName is deterministic, git-safe, and slug-sanitized', () => {
  const a = prBranchName('Build Feature X!', 'PATCH CONTENT');
  const b = prBranchName('Build Feature X!', 'PATCH CONTENT');
  assert.equal(a, b, 'same slug + same patch → same branch (idempotent PR updates)');
  assert.match(a, /^honk\/build-feature-x-[0-9a-f]{8}$/);
  assert.notEqual(a, prBranchName('Build Feature X!', 'DIFFERENT PATCH'), 'different work → different branch');
});

test('derivePrTitle uses the first meaningful line, else falls back, and caps length', () => {
  assert.equal(derivePrTitle('s', '# Add the new login flow\nbody'), 'Add the new login flow');
  assert.equal(derivePrTitle('my-slug', ''), 'Build: my-slug', 'empty implement output → fallback');
  assert.equal(derivePrTitle('my-slug', 'short'), 'Build: my-slug', 'too-short first line → fallback');
  assert.ok(derivePrTitle('s', 'x'.repeat(120)).length <= 72, 'capped at 72');
});

test('derivePrBody includes verify status, file count, review excerpt, and the no-merge note', () => {
  const body = derivePrBody({ slug: 'feat-1', verifyGreen: true, changedFiles: 3, reviewOutput: 'LGTM, no blockers' });
  assert.match(body, /feat-1/);
  assert.match(body, /Verify: ✅ green/);
  assert.match(body, /Files changed: 3/);
  assert.match(body, /LGTM, no blockers/);
  assert.match(body, /not merged into the working tree/);
  assert.match(derivePrBody({ slug: 's', verifyGreen: false, changedFiles: 0 }), /Verify: ⚠️ not green/);
});

test('parsePrUrl extracts the URL + number, and is empty when absent', () => {
  assert.deepEqual(parsePrUrl('Opened: https://github.com/o/r/pull/42\n'), { url: 'https://github.com/o/r/pull/42', number: 42 });
  assert.deepEqual(parsePrUrl('no url here'), {});
});

test('isGhAvailable reflects the gh --version exit', () => {
  assert.equal(isGhAvailable(makeRunner(() => ({ ok: true }))), true);
  assert.equal(isGhAvailable(makeRunner(() => ({ ok: false }))), false);
});

// --- emitPrFromPatch: declines (skips) ------------------------------------

test('emitPrFromPatch skips when the patch file is missing', () => {
  const res = emitPrFromPatch(
    { sourceRoot: '/repo', patchPath: '/does/not/exist.patch', slug: 's', title: 't', body: 'b' },
    makeRunner(() => ({})),
  );
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'no-patch');
});

test('emitPrFromPatch skips (no-gh) when the GitHub CLI is absent', () => {
  const res = emitPrFromPatch(
    { sourceRoot: '/repo', patchPath: writePatch(), slug: 's', title: 't', body: 'b' },
    makeRunner((cmd, args) => (cmd === 'gh' && args[0] === '--version' ? { ok: false } : { ok: true })),
  );
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'no-gh');
});

test('emitPrFromPatch skips (no-remote) when origin is not a GitHub remote', () => {
  const res = emitPrFromPatch(
    { sourceRoot: '/repo', patchPath: writePatch(), slug: 's', title: 't', body: 'b' },
    makeRunner((cmd, args) => {
      if (cmd === 'gh' && args[0] === '--version') return { ok: true };
      if (cmd === 'git' && args[0] === 'remote') return { ok: true, stdout: 'https://gitlab.com/o/r.git' };
      return { ok: true };
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'no-remote');
});

// --- emitPrFromPatch: happy path + injection safety ------------------------

test('emitPrFromPatch opens a PR and returns its url/number/branch on success', () => {
  const calls: Call[] = [];
  const res = emitPrFromPatch(
    { sourceRoot: '/repo', patchPath: writePatch(), slug: 'feat-1', title: 'Add login', body: 'desc' },
    makeRunner(happyHandler(), calls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.pushed, true);
  assert.equal(res.prUrl, 'https://github.com/owner/repo/pull/7');
  assert.equal(res.prNumber, 7);
  assert.match(res.branch ?? '', /^honk\/feat-1-[0-9a-f]{8}$/);

  // Injection-safety: title/body/branch flow as SEPARATE argv items (never a shell string).
  const create = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(create, 'gh pr create was invoked');
  assert.ok(create!.args.includes('--title') && create!.args.includes('Add login'));
  assert.ok(create!.args.includes('--base') && create!.args.includes('main'));
  assert.ok(create!.args.includes('--head') && create!.args.includes(res.branch!));

  // It worked in an isolated worktree, never the user's checkout.
  assert.ok(calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add'));
  assert.ok(calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove'), 'worktree cleaned up');
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout'), 'never switches the user branch');
});

test('emitPrFromPatch honors an explicit base branch override', () => {
  const calls: Call[] = [];
  emitPrFromPatch(
    { sourceRoot: '/repo', patchPath: writePatch(), slug: 's', title: 't', body: 'b', baseBranch: 'develop' },
    makeRunner(happyHandler(), calls),
  );
  const create = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(create!.args.includes('develop') && !create!.args.includes('main'));
});

// --- emitPrFromPatch: failure modes ---------------------------------------

test('emitPrFromPatch reports a push failure (pushed:false) and cleans up', () => {
  const calls: Call[] = [];
  const res = emitPrFromPatch(
    { sourceRoot: '/repo', patchPath: writePatch(), slug: 's', title: 't', body: 'b' },
    makeRunner((cmd, args) => {
      const base = happyHandler()(cmd, args) ?? {};
      if (cmd === 'git' && args[0] === 'push') return { ok: false, stderr: 'auth required' };
      return base;
    }, calls),
  );
  assert.equal(res.ok, false);
  assert.equal(res.pushed, false);
  assert.match(res.error ?? '', /push failed/);
  assert.ok(calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove'));
});

test('emitPrFromPatch reports a gh-create failure but notes the branch was pushed', () => {
  const res = emitPrFromPatch(
    { sourceRoot: '/repo', patchPath: writePatch(), slug: 's', title: 't', body: 'b' },
    makeRunner((cmd, args) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') return { ok: false, stderr: 'pr already exists' };
      return happyHandler()(cmd, args) ?? {};
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.pushed, true);
  assert.match(res.error ?? '', /gh pr create failed/);
});

test('emitPrFromPatch reports a failed patch apply without pushing', () => {
  const calls: Call[] = [];
  const res = emitPrFromPatch(
    { sourceRoot: '/repo', patchPath: writePatch(), slug: 's', title: 't', body: 'b' },
    makeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'apply') return { ok: false, stderr: 'patch does not apply' };
      return happyHandler()(cmd, args) ?? {};
    }, calls),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /git apply failed/);
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'push'), 'never pushes a failed apply');
});
