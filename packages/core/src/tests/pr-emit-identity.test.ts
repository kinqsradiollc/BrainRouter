/**
 * ADR-028 I3 — the build-loop push consults the workspace's account binding.
 *
 * I3 says *any* push, create or merge compares the active account against what
 * the workspace expects. It shipped enforced on exactly one path — the Track
 * create-PR button, which a human presses — while the build loop, which is the
 * path an AGENT takes, ran `git push` with no check at all. A work branch pushed
 * from a personal account is a disclosure whichever of the two did it.
 *
 * Kept in its own file rather than added to `pr-emit.test.ts` because these
 * cases need a per-test `BRAINROUTER_HOME`: the binding is real state on disk,
 * and a shared home would let one case's first-push binding decide the next.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'br-premit-identity-'));
process.env.BRAINROUTER_HOME = TMP_HOME;

const { emitPrFromPatch, checkPushIdentity } = await import('../git/prEmit.js');
type CmdRunner = import('../git/prEmit.js').CmdRunner;

interface Call { cmd: string; args: string[] }

/** A fresh home per case, so one test's binding cannot decide another's. */
function withHome<T>(fn: (home: string) => T): T {
  const previous = process.env.BRAINROUTER_HOME;
  const home = fs.mkdtempSync(path.join(TMP_HOME, 'home-'));
  process.env.BRAINROUTER_HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.BRAINROUTER_HOME = previous;
  }
}

function bindingsPath(home: string): string {
  return path.join(fs.realpathSync(home), 'git-bindings.json');
}

function writeBinding(home: string, workspaceRoot: string, expectedLogin: string): void {
  fs.writeFileSync(
    bindingsPath(home),
    JSON.stringify({
      [workspaceRoot]: {
        workspaceRoot, expectedLogin, host: 'github.com', boundAt: '2026-08-01T00:00:00.000Z',
      },
    }),
  );
}

/** `gh auth status --active` output for a signed-in account. */
function authStatus(login: string, host = 'github.com'): string {
  return `${host}\n  ✓ Logged in to ${host} account ${login} (keyring)\n`;
}

function runnerFor(
  authStdout: { ok: boolean; stdout: string },
  calls: Call[] = [],
): CmdRunner {
  return (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'gh' && args[0] === 'auth') return { ...authStdout, stderr: '' };
    if (cmd === 'gh' && args[0] === '--version') return { ok: true, stdout: 'gh version 2.90.0', stderr: '' };
    if (cmd === 'git' && args[0] === 'remote') return { ok: true, stdout: 'git@github.com:owner/repo.git', stderr: '' };
    if (cmd === 'git' && args[0] === 'branch') return { ok: true, stdout: 'main\n', stderr: '' };
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return { ok: true, stdout: 'https://github.com/owner/repo/pull/9\n', stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
}

function writePatch(): string {
  const dir = fs.mkdtempSync(path.join(TMP_HOME, 'patch-'));
  const file = path.join(dir, 'build.patch');
  fs.writeFileSync(file, 'diff --git a/x b/x\n+change\n');
  return file;
}

const baseInput = {
  sourceRoot: '/repo', slug: 'feat-1', runToken: 'r1', title: 'Add login', body: 'desc',
};

test('a bound workspace refuses to push as a different account, and names both', () => {
  withHome((home) => {
    writeBinding(home, '/repo', 'work-acct');
    const calls: Call[] = [];
    const result = emitPrFromPatch(
      { ...baseInput, patchPath: writePatch() },
      runnerFor({ ok: true, stdout: authStatus('personal') }, calls),
    );

    assert.equal(result.ok, false);
    assert.equal(result.skipped, 'identity');
    assert.equal(result.pushed, false);
    assert.match(result.error!, /work-acct/);
    assert.match(result.error!, /personal/);
    // The disclosure is what this prevents, so the push must not have happened.
    assert.equal(
      calls.some((c) => c.cmd === 'git' && c.args[0] === 'push'),
      false,
      'the branch was pushed anyway — the guard reported without stopping anything',
    );
    assert.equal(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'create'), false);
  });
});

test('the first push BINDS instead of interrogating, then proceeds', () => {
  withHome((home) => {
    const calls: Call[] = [];
    const result = emitPrFromPatch(
      { ...baseInput, patchPath: writePatch() },
      runnerFor({ ok: true, stdout: authStatus('work-acct') }, calls),
    );

    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    const stored = JSON.parse(fs.readFileSync(bindingsPath(home), 'utf8'));
    assert.equal(stored['/repo'].expectedLogin, 'work-acct');
    assert.equal(stored['/repo'].host, 'github.com');
  });
});

test('a bound workspace refuses when the active account cannot be read', () => {
  // There is an expectation and no way to verify it. Pushing anyway would be
  // this ADR's own defect: acting as though a state had been established.
  withHome((home) => {
    writeBinding(home, '/repo', 'work-acct');
    const calls: Call[] = [];
    const result = emitPrFromPatch(
      { ...baseInput, patchPath: writePatch() },
      runnerFor({ ok: false, stdout: '' }, calls),
    );
    assert.equal(result.skipped, 'identity');
    assert.equal(calls.some((c) => c.cmd === 'git' && c.args[0] === 'push'), false);
  });
});

test('an UNBOUND workspace with no readable account still pushes', () => {
  // No binding means no expectation to contradict. Refusing here would break
  // every emit on a box that authenticates by token rather than a named login,
  // which is how a guard gets switched off.
  withHome(() => {
    const result = emitPrFromPatch(
      { ...baseInput, patchPath: writePatch() },
      runnerFor({ ok: false, stdout: '' }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
  });
});

test('checkPushIdentity reads the account fresh on every call', () => {
  // A cached identity check is a wrong one: `gh auth switch` between two pushes
  // must be visible to the second.
  withHome((home) => {
    writeBinding(home, '/repo', 'work-acct');
    let login = 'work-acct';
    const run: CmdRunner = () => ({ ok: true, stdout: authStatus(login), stderr: '' });
    assert.equal(checkPushIdentity('/repo', run).declineReason, null);
    login = 'personal';
    assert.match(checkPushIdentity('/repo', run).declineReason!, /work-acct/);
  });
});
