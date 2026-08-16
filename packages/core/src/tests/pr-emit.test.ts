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
  parseChangeRequestUrl,
  isGhAvailable,
  isSafeRef,
  redactSecrets,
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
const baseInput = { sourceRoot: '/repo', slug: 'feat-1', runToken: 'r1', title: 'Add login', body: 'desc' };

// --- pure helpers ----------------------------------------------------------

test('prBranchName is git-safe, slug+token sanitized, and UNIQUE per run token', () => {
  const a = prBranchName('Build Feature X!', 'PATCH', 'abc123');
  assert.equal(a, prBranchName('Build Feature X!', 'PATCH', 'abc123'), 'same inputs → same branch');
  assert.match(a, /^honk\/build-feature-x-[0-9a-f]{6}-abc123$/);
  assert.notEqual(a, prBranchName('Build Feature X!', 'PATCH', 'def456'), 'different run token → different branch (no reuse)');
  assert.notEqual(a, prBranchName('Build Feature X!', 'OTHER', 'abc123'), 'different patch → different branch');
});

test('isSafeRef accepts plain branch names and rejects flag/metachar/ref-format hazards', () => {
  for (const ok of ['main', 'develop', 'release/0.4.16', 'honk/x-ab12cd-r1']) assert.equal(isSafeRef(ok), true, ok);
  for (const bad of ['', '-main', '--upload-pack=x', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'feat\\x', 'a@{0}', '/x', 'x/']) {
    assert.equal(isSafeRef(bad), false, bad);
  }
});

test('redactSecrets masks token shapes and key assignments', () => {
  assert.match(redactSecrets('key sk-abcd1234efgh5678'), /«redacted»/);
  assert.match(redactSecrets('br_abcdef123456 here'), /«redacted»/);
  assert.match(redactSecrets('ghp_0123456789abcdef0123456789abcdef'), /«redacted»/);
  assert.match(redactSecrets('OPENAI_API_KEY=sk-zzzzzzzzzzzz'), /«redacted»/);
  assert.doesNotMatch(redactSecrets('just normal text, no secrets'), /«redacted»/);
});

test('derivePrTitle redacts secrets and falls back / caps', () => {
  assert.equal(derivePrTitle('s', '# Add the new login flow\nbody'), 'Add the new login flow');
  assert.equal(derivePrTitle('my-slug', ''), 'Build: my-slug');
  assert.equal(derivePrTitle('my-slug', 'short'), 'Build: my-slug');
  assert.match(derivePrTitle('s', 'token=sk-abcdef123456 leaked here in the first line'), /«redacted»/);
  assert.ok(derivePrTitle('s', 'x'.repeat(120)).length <= 72);
});

test('derivePrBody reports status/files and redacts the review excerpt', () => {
  const body = derivePrBody({ slug: 'feat-1', verifyGreen: true, changedFiles: 3, reviewOutput: 'LGTM. fyi OPENAI_API_KEY=sk-abcdef123456' });
  assert.match(body, /Verify: ✅ green/);
  assert.match(body, /Files changed: 3/);
  assert.match(body, /«redacted»/);
  assert.doesNotMatch(body, /sk-abcdef123456/);
  assert.match(derivePrBody({ slug: 's', verifyGreen: false, changedFiles: 0 }), /Verify: ⚠️ not green/);
});

test('parsePrUrl extracts the URL + number, and is empty when absent', () => {
  assert.deepEqual(parsePrUrl('Opened: https://github.com/o/r/pull/42\n'), { url: 'https://github.com/o/r/pull/42', number: 42 });
  assert.deepEqual(parsePrUrl('no url here'), {});
});

test('parseChangeRequestUrl also extracts a GitLab merge-request URL', () => {
  assert.deepEqual(parseChangeRequestUrl('https://gitlab.com/o/r/-/merge_requests/19\n'), { url: 'https://gitlab.com/o/r/-/merge_requests/19', number: 19 });
});

test('isGhAvailable reflects the gh --version exit', () => {
  assert.equal(isGhAvailable(makeRunner(() => ({ ok: true }))), true);
  assert.equal(isGhAvailable(makeRunner(() => ({ ok: false }))), false);
});

// --- emitPrFromPatch: declines (skips) ------------------------------------

test('emitPrFromPatch skips when the patch file is missing', () => {
  const res = emitPrFromPatch({ ...baseInput, patchPath: '/does/not/exist.patch' }, makeRunner(() => ({})));
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'no-patch');
});

test('emitPrFromPatch skips (no-gh) when the GitHub CLI is absent', () => {
  const res = emitPrFromPatch(
    { ...baseInput, patchPath: writePatch() },
    makeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') return { ok: true, stdout: 'git@github.com:owner/repo.git' };
      return cmd === 'gh' && args[0] === '--version' ? { ok: false } : { ok: true };
    }),
  );
  assert.equal(res.skipped, 'no-gh');
});

test('emitPrFromPatch skips (no-remote) when origin is not a recognized forge remote', () => {
  const res = emitPrFromPatch(
    { ...baseInput, patchPath: writePatch() },
    makeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') return { ok: true, stdout: 'https://example.com/o/r.git' };
      return { ok: true };
    }),
  );
  assert.equal(res.skipped, 'no-remote');
});

test('emitPrFromPatch rejects an unsafe (flag-shaped) base branch as base-unknown', () => {
  const res = emitPrFromPatch(
    { ...baseInput, patchPath: writePatch(), baseBranch: '--upload-pack=evil' },
    makeRunner(happyHandler()),
  );
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'base-unknown');
});

// --- emitPrFromPatch: happy path + injection safety + draft -----------------

test('emitPrFromPatch opens a DRAFT PR on a unique branch and returns its url/number', () => {
  const calls: Call[] = [];
  const res = emitPrFromPatch({ ...baseInput, patchPath: writePatch() }, makeRunner(happyHandler(), calls));
  assert.equal(res.ok, true);
  assert.equal(res.pushed, true);
  assert.equal(res.prUrl, 'https://github.com/owner/repo/pull/7');
  assert.equal(res.prNumber, 7);
  assert.match(res.branch ?? '', /^honk\/feat-1-[0-9a-f]{6}-r1$/);

  const create = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(create, 'gh pr create was invoked');
  // argv items (injection-safe) + draft by default + correct base/head
  assert.ok(create!.args.includes('--title') && create!.args.includes('Add login'));
  assert.ok(create!.args.includes('--base') && create!.args.includes('main'));
  assert.ok(create!.args.includes('--head') && create!.args.includes(res.branch!));
  assert.ok(create!.args.includes('--draft'), 'PR opens as a draft by default');

  // unique branch off base, isolated worktree, cleaned up, user branch never switched
  assert.ok(calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add' && c.args.includes('-b')));
  assert.ok(calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove'));
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout'));
  // NEVER a reuse `git worktree add <wt> <branch>` (no -b) — that was the tree-mutation bug
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add' && !c.args.includes('-b')));
});

test('ADR-028 A7 — the build-loop emit opens ONE pull request and never a stack', () => {
  // The emit lays down one squashed patch on one throwaway branch, so there is
  // no second layer for a stack to hold. It states that route rather than
  // asking a router for an answer it could not carry out: a `gh stack submit`
  // here would register one pull request while calling it a chain.
  const calls: Call[] = [];
  const res = emitPrFromPatch({ ...baseInput, patchPath: writePatch() }, makeRunner(happyHandler(), calls));
  assert.equal(res.ok, true);
  assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[0] === 'stack'), 'no gh stack subcommand runs');
  assert.ok(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'));
  // One branch pushed, so one pull request. Two pushes would mean layers.
  assert.equal(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'push').length, 1);
});

test('emitPrFromPatch can open a ready (non-draft) PR when draft:false', () => {
  const calls: Call[] = [];
  emitPrFromPatch({ ...baseInput, patchPath: writePatch(), draft: false }, makeRunner(happyHandler(), calls));
  const create = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(!create!.args.includes('--draft'));
});

test('emitPrFromPatch honors an explicit (safe) base branch override', () => {
  const calls: Call[] = [];
  emitPrFromPatch({ ...baseInput, patchPath: writePatch(), baseBranch: 'develop' }, makeRunner(happyHandler(), calls));
  const create = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(create!.args.includes('develop') && !create!.args.includes('main'));
});

test('emitPrFromPatch opens a GitLab draft merge request through glab', () => {
  const calls: Call[] = [];
  const res = emitPrFromPatch(
    { ...baseInput, patchPath: writePatch() },
    makeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') return { ok: true, stdout: 'git@gitlab.com:owner/repo.git' };
      if (cmd === 'git' && args[0] === 'branch') return { ok: true, stdout: 'main\n' };
      if (cmd === 'glab' && args[0] === '--version') return { ok: true, stdout: 'glab 1.0' };
      if (cmd === 'glab' && args[0] === 'mr' && args[1] === 'create') return { ok: true, stdout: 'https://gitlab.com/owner/repo/-/merge_requests/9\n' };
      return { ok: true };
    }, calls),
  );
  assert.equal(res.ok, true);
  assert.equal(res.forge, 'gitlab');
  assert.equal(res.prNumber, 9);
  const create = calls.find((call) => call.cmd === 'glab' && call.args[0] === 'mr' && call.args[1] === 'create');
  assert.ok(create?.args.includes('--draft'));
  assert.ok(create?.args.includes('--source-branch'));
  assert.ok(!calls.some((call) => call.cmd === 'gh'), 'GitLab delivery never probes or invokes gh');
});

// --- emitPrFromPatch: failure modes ---------------------------------------

test('emitPrFromPatch reports a push failure (pushed:false) and cleans up', () => {
  const calls: Call[] = [];
  const res = emitPrFromPatch(
    { ...baseInput, patchPath: writePatch() },
    makeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'push') return { ok: false, stderr: 'auth required' };
      return happyHandler()(cmd, args) ?? {};
    }, calls),
  );
  assert.equal(res.ok, false);
  assert.equal(res.pushed, false);
  assert.match(res.error ?? '', /push failed/);
  assert.ok(calls.some((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove'));
});

test('emitPrFromPatch reports a forge create failure but notes the branch was pushed', () => {
  const res = emitPrFromPatch(
    { ...baseInput, patchPath: writePatch() },
    makeRunner((cmd, args) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') return { ok: false, stderr: 'pr already exists' };
      return happyHandler()(cmd, args) ?? {};
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.pushed, true);
  assert.match(res.error ?? '', /gh change-request create failed/);
});

test('emitPrFromPatch reports a failed patch apply without pushing', () => {
  const calls: Call[] = [];
  const res = emitPrFromPatch(
    { ...baseInput, patchPath: writePatch() },
    makeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'apply') return { ok: false, stderr: 'patch does not apply' };
      return happyHandler()(cmd, args) ?? {};
    }, calls),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /git apply failed/);
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'push'));
});

test('emitPrFromPatch redacts secrets that leak into git stderr', () => {
  const res = emitPrFromPatch(
    { ...baseInput, patchPath: writePatch() },
    makeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'push') return { ok: false, stderr: 'remote rejected: token sk-abcdef123456 invalid' };
      return happyHandler()(cmd, args) ?? {};
    }),
  );
  assert.match(res.error ?? '', /«redacted»/);
  assert.doesNotMatch(res.error ?? '', /sk-abcdef123456/);
});
