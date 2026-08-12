/**
 * ADR-028 I1–I4 — provisioning and identity.
 *
 * Two properties carry it: nothing installs without a click, and an operation
 * that could DISCLOSE stops when the account is wrong while a read never asks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planProvisioning, installPreview, TOOL_REQUIREMENTS,
  type ToolStatus,
} from '../tooling/provisioning.js';
import {
  checkIdentity, isWriteOperation, bindWorkspace, switchCommand,
  type GitHubAccount, type WorkspaceBinding,
} from '../tooling/gitIdentity.js';

const present = (ids: string[]): ToolStatus[] =>
  TOOL_REQUIREMENTS.map((r) => ({ id: r.id, present: ids.includes(r.id) }));

/* ------------------------------------------------------ I1 · provisioning */

test('everything present says ready, and asks nothing', () => {
  assert.deepEqual(planProvisioning(present(['git', 'gh', 'gh-stack'])), { kind: 'ready' });
});

test('a missing optional tool leads with what it UNLOCKS', () => {
  // "gh-stack is not installed" is a fact about your machine; "stacked pull
  // requests are unavailable" is a fact about what you can do, and only the
  // second tells you whether to care.
  const plan = planProvisioning(present(['git', 'gh']), { declined: new Set(), autoInstall: 'off' });
  assert.equal(plan.kind, 'offer');
  assert.match((plan as { message: string }).message, /[Ss]tacked pull requests/);
});

test('a DECLINED offer is never repeated', () => {
  // Asking again next launch is how a prompt becomes noise, and then the one
  // that matters is dismissed reflexively.
  const plan = planProvisioning(present(['git', 'gh']), { declined: new Set(['gh-stack']) });
  assert.equal(plan.kind, 'ready');
});

test('a missing ESSENTIAL tool blocks — but still does not auto-install', () => {
  const plan = planProvisioning(present(['gh', 'gh-stack']));
  assert.equal(plan.kind, 'blocked');
  assert.match((plan as { message: string }).message, /Git/);
});

test('the install command is shown IN FULL before it runs', () => {
  // A one-click install whose command is hidden is asking for trust it has not
  // earned. Someone who would rather run it themselves must be able to.
  const preview = installPreview(TOOL_REQUIREMENTS.find((r) => r.id === 'gh-stack')!);
  assert.match(preview, /gh extension install github\/gh-stack/);
  assert.match(preview, /run it yourself/);
  assert.match(preview, /nothing here happens without your click/);
});

/* --------------------------------------------------------- I3/I4 · identity */

const acct = (login: string, active = true): GitHubAccount => ({ login, host: 'github.com', active });
const bound = (login: string): WorkspaceBinding => ({
  workspaceRoot: '/ws', expectedLogin: login, host: 'github.com', boundAt: '2026-08-04T00:00:00.000Z',
});

test('READS never ask — that is what keeps the guard meaningful', () => {
  // An identity check on every read makes the guard something people learn to
  // click through, which is exactly how it fails on the push that mattered.
  for (const op of ['read_pr', 'read_checks', 'list_stack'] as const) {
    assert.equal(isWriteOperation(op), false);
    assert.deepEqual(
      checkIdentity({ operation: op, active: acct('personal'), binding: bound('work') }),
      { kind: 'ok' },
    );
  }
});

test('every operation that can DISCLOSE is a write', () => {
  for (const op of ['push', 'create_pr', 'merge', 'comment'] as const) {
    assert.equal(isWriteOperation(op), true, `${op} can be attributed to a person`);
  }
});

test('the first push BINDS rather than interrogating', () => {
  const v = checkIdentity({ operation: 'push', active: acct('work'), binding: null });
  assert.equal(v.kind, 'bind');
  assert.equal((v as { login: string }).login, 'work');
});

test('a mismatch STOPS and names BOTH accounts', () => {
  // "Wrong account" makes you go and look. Naming them lets you decide from
  // the message.
  const v = checkIdentity({ operation: 'push', active: acct('personal'), binding: bound('work') });
  assert.equal(v.kind, 'mismatch');
  const m = (v as { message: string }).message;
  assert.match(m, /work/);
  assert.match(m, /personal/);
  // A question, not an error — people do change which account owns a project.
  assert.match(m, /\?$/);
  assert.doesNotMatch(m, /error|denied|forbidden/i);
});

test('a matching account proceeds silently', () => {
  assert.deepEqual(
    checkIdentity({ operation: 'push', active: acct('work'), binding: bound('work') }),
    { kind: 'ok' },
  );
});

test('a different HOST is a mismatch even with the same login', () => {
  // The same username on github.com and an enterprise instance are different
  // people as far as disclosure is concerned.
  const enterprise: GitHubAccount = { login: 'work', host: 'ghe.corp', active: true };
  const v = checkIdentity({ operation: 'push', active: enterprise, binding: bound('work') });
  assert.equal(v.kind, 'mismatch');
});

test('signed out is its own state, with the command to fix it', () => {
  const v = checkIdentity({ operation: 'push', active: null, binding: bound('work') });
  assert.equal(v.kind, 'signed_out');
  assert.match((v as { message: string }).message, /gh auth login/);
});

test('switching uses gh, not a second credential store', () => {
  // A separate store would drift from the one git and gh actually use, and the
  // drift would surface as a push that used an account the UI called inactive.
  assert.equal(
    switchCommand({ login: 'work', host: 'github.com' }),
    'gh auth switch --hostname github.com --user work',
  );
});

test('the mismatch names both accounts AND the command that switches', () => {
  // I3's "question, both one click" UI was never built, so this sentence is
  // what a person actually meets. `describeAccounts` annotated rows for the
  // picker that would have shown it and was retired 2026-08-12 with no caller;
  // `switchCommand` had none either, which is why the message said "switch
  // account" without saying how.
  const v = checkIdentity({
    operation: 'push', active: acct('personal', true), binding: bound('work'),
  });
  assert.equal(v.kind, 'mismatch');
  const message = (v as { message: string }).message;
  assert.match(message, /pushed as work/);
  assert.match(message, /signed in as personal/);
  assert.match(message, /gh auth switch --hostname github\.com --user work/);
});

test('binding records the account and when', () => {
  const b = bindWorkspace('/ws', acct('work'), '2026-08-04T12:00:00.000Z');
  assert.equal(b.expectedLogin, 'work');
  assert.equal(b.boundAt, '2026-08-04T12:00:00.000Z');
});

/* -------------------------------- I1 · auto-install, scoped by blast radius */

test('a gh EXTENSION installs itself; a system package never does', () => {
  // Not about trusting the command — about blast radius. Something that only
  // touches gh's extension directory is undone by deleting a folder;
  // `brew install` and `xcode-select` change the system and need sudo.
  const byId = new Map(TOOL_REQUIREMENTS.map((r) => [r.id, r]));
  assert.equal(byId.get('gh-stack')!.autoInstallable, true);
  assert.equal(byId.get('gh')!.autoInstallable, false);
  assert.equal(byId.get('git')!.autoInstallable, false);
});

test('by default a missing extension is INSTALLED, not merely offered', () => {
  // The whole point: stacked PRs shipped and sat unused because gh-stack was
  // absent, and a correct-but-silent capability check is still a feature
  // nobody gets.
  const plan = planProvisioning(present(['git', 'gh']));
  assert.equal(plan.kind, 'auto_install');
  assert.deepEqual((plan as { install: { id: string }[] }).install.map((r) => r.id), ['gh-stack']);
});

test('auto-install SAYS what it is doing and how to stop it', () => {
  // Silent is the part that would be wrong, not automatic.
  const plan = planProvisioning(present(['git', 'gh']));
  const msg = (plan as { message: string }).message;
  assert.match(msg, /Installing/);
  assert.match(msg, /turned off in settings/);
});

test('turning it off returns to detect-and-offer', () => {
  const plan = planProvisioning(present(['git', 'gh']), { declined: new Set(), autoInstall: 'off' });
  assert.equal(plan.kind, 'offer');
});

test('a system package is still only OFFERED, even with auto-install on', () => {
  const plan = planProvisioning(present(['git']), { declined: new Set(), autoInstall: 'safe' });
  // gh is not auto-installable, so it lands in `offer` alongside the auto one.
  const ids = [
    ...((plan as { install?: { id: string }[] }).install ?? []),
    ...((plan as { offer?: { id: string }[] }).offer ?? []),
  ].map((r) => r.id);
  assert.ok(ids.includes('gh'));
  assert.equal(
    ((plan as { install?: { id: string }[] }).install ?? []).some((r) => r.id === 'gh'),
    false,
    'gh needs a package manager — never automatic',
  );
});

test('a DECLINED tool is not auto-installed either', () => {
  // Declining is a decision about the tool, not about the prompt.
  const plan = planProvisioning(present(['git', 'gh']), { declined: new Set(['gh-stack']) });
  assert.equal(plan.kind, 'ready');
});
