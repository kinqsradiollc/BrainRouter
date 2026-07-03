/**
 * CC-SAFETY (B-safety) — classify-all-shell + recent-denials + glob var expansion.
 *
 *   B1 — `classifyShellCommand` routes a shell command through the safety
 *        classifier (destructive guard + dangerous heuristic + strict whitelist).
 *   B2 — `recordDenial` / `listRecentDenials` capture + surface denials.
 *   B3 — `~` / `$HOME` / `$WORKSPACE` expand in permission-rule globs so
 *        `read_file(~/.ssh/**)` / `read_file($HOME/.env)` match the abs path.
 *
 * Pure over the exec primitives — no live provider, no config file. The one
 * persistence test uses a temp HOME-scoped workspace state dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { classifyShellCommand } from '../exec/policy/shellClassifier.js';
import { evaluatePermissionRules, expandPathVars, ruleMatches } from '../exec/policy/permissionRules.js';
import {
  recordDenial,
  listRecentDenials,
  recordDenialInMemory,
  getInMemoryDenials,
  _clearInMemoryDenials,
  MAX_RECENT_DENIALS,
} from '../exec/runtime/recentDenials.js';
import { resolveCliKnobs } from '../config/config.js';

const cfg = (cli: Record<string, unknown>) => ({ activeServer: '', servers: {}, cli } as any);

// ---------------------------------------------------------------------------
// B1 — classify-all-shell
// ---------------------------------------------------------------------------

test('B1 autoClassifyShell knob: default off, on/strict honored, garbage → off', () => {
  assert.equal(resolveCliKnobs(cfg({})).autoClassifyShell, 'off');
  assert.equal(resolveCliKnobs(cfg({ autoClassifyShell: 'on' })).autoClassifyShell, 'on');
  assert.equal(resolveCliKnobs(cfg({ autoClassifyShell: 'strict' })).autoClassifyShell, 'strict');
  assert.equal(resolveCliKnobs(cfg({ autoClassifyShell: 'bogus' })).autoClassifyShell, 'off');
  // enforceWhenSilent defaults true, honored when set false.
  assert.equal(resolveCliKnobs(cfg({})).autoClassifyShellEnforceWhenSilent, true);
  assert.equal(resolveCliKnobs(cfg({ autoClassifyShellEnforceWhenSilent: false })).autoClassifyShellEnforceWhenSilent, false);
});

test('B1 classifier: off is inert — every command allowed', () => {
  const r = classifyShellCommand('rm -rf /', { mode: 'off', silent: true });
  assert.equal(r.decision, 'allow');
});

test('B1 classifier: on-mode routes a dangerous command → deny (silent) / ask (attended, relaxed)', () => {
  // A dangerous shell command (rm -rf) is caught by the classifier.
  const silent = classifyShellCommand('rm -rf ./build', { mode: 'on', silent: true });
  assert.equal(silent.decision, 'deny'); // silent can't answer → fail closed
  assert.equal(silent.rule, 'dangerous');
  assert.ok(/destructive/i.test(silent.reason));

  // Attended + enforcement relaxed → advisory ask (not a hard deny).
  const attended = classifyShellCommand('rm -rf ./build', { mode: 'on', silent: false, enforceWhenSilent: false });
  assert.equal(attended.decision, 'ask');

  // Attended but enforcement ON (default) → deny.
  const enforced = classifyShellCommand('rm -rf ./build', { mode: 'on', silent: false });
  assert.equal(enforced.decision, 'deny');
});

test('B1 classifier: on-mode passes a plain safe command through', () => {
  const r = classifyShellCommand('ls -la', { mode: 'on', silent: true });
  assert.equal(r.decision, 'allow');
  assert.equal(r.rule, 'allowed');
});

test('B1 classifier: on-mode surfaces a destructive-guard block (git reset --hard, no intent)', () => {
  const r = classifyShellCommand('git reset --hard', { mode: 'on', silent: true, destructiveContext: { userIntent: 'fix the bug' } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'destructive');
  // With explicit discard intent, the destructive guard no longer blocks — but
  // `git reset --hard` is still on the dangerous-command floor, so the classifier
  // downgrades the tag to 'dangerous' (a silent session still fails closed).
  const withIntent = classifyShellCommand('git reset --hard', { mode: 'on', silent: true, destructiveContext: { userIntent: 'discard my changes' } });
  assert.equal(withIntent.rule, 'dangerous');
  // A genuinely safe command with intent context is allowed.
  const ok = classifyShellCommand('git log --oneline', { mode: 'on', silent: true, destructiveContext: { userIntent: 'discard my changes' } });
  assert.equal(ok.decision, 'allow');
});

test('B1 classifier: strict denies everything not whitelisted, allows a whitelisted prefix', () => {
  const denied = classifyShellCommand('echo hi', { mode: 'strict', silent: true, allowlist: ['git status'] });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.rule, 'not-whitelisted');

  const allowed = classifyShellCommand('git status --short', { mode: 'strict', silent: true, allowlist: ['git status'] });
  assert.equal(allowed.decision, 'allow');

  // strict with an empty allowlist denies everything (nothing is whitelisted).
  const empty = classifyShellCommand('ls', { mode: 'strict', silent: true, allowlist: [] });
  assert.equal(empty.decision, 'deny');
});

// ---------------------------------------------------------------------------
// B2 — recent-denials capture
// ---------------------------------------------------------------------------

test('B2 in-memory ring: records newest-last + bounded to MAX', () => {
  const key = `t-${Math.random()}`;
  _clearInMemoryDenials(key);
  for (let i = 0; i < MAX_RECENT_DENIALS + 10; i++) {
    recordDenialInMemory(key, 'run_command', `reason ${i}`, 1000 + i);
  }
  const ring = getInMemoryDenials(key);
  assert.equal(ring.length, MAX_RECENT_DENIALS); // capped
  assert.equal(ring[ring.length - 1].reason, `reason ${MAX_RECENT_DENIALS + 9}`); // newest kept
  assert.equal(ring[0].reason, `reason 10`); // oldest evicted
  _clearInMemoryDenials(key);
});

test('B2 normalize: trims + caps tool/reason, defaults blanks', () => {
  const key = `t-${Math.random()}`;
  _clearInMemoryDenials(key);
  const e = recordDenialInMemory(key, '', '   spaced\n\nreason  ', 42);
  assert.equal(e.tool, 'unknown');
  assert.equal(e.reason, 'spaced reason');
  assert.equal(e.ts, 42);
  assert.ok(recordDenialInMemory(key, 'x'.repeat(500), 'y'.repeat(9999)).reason.length <= 400);
  _clearInMemoryDenials(key);
});

test('B2 persist + list: recordDenial writes to session state; listRecentDenials returns newest-first', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-denials-'));
  const prevHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  const key = `sess-${Math.random()}`;
  _clearInMemoryDenials(key);
  try {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ws-'));
    recordDenial(ws, key, 'run_command', 'denied: rm -rf', 1000);
    recordDenial(ws, key, 'write_file', 'denied: outside workspace', 2000);
    const list = listRecentDenials(ws, key, 20);
    assert.equal(list.length, 2);
    assert.equal(list[0].tool, 'write_file', 'newest first'); // ts 2000 > 1000
    assert.equal(list[1].tool, 'run_command');
    // A fresh in-memory ring (simulating a restart) still sees the persisted entries.
    _clearInMemoryDenials(key);
    const afterRestart = listRecentDenials(ws, key, 20);
    assert.equal(afterRestart.length, 2, 'persisted denials survive an in-memory reset');
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = prevHome;
    _clearInMemoryDenials(key);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B3 — glob rule variable expansion (~ / $HOME / $WORKSPACE)
// ---------------------------------------------------------------------------

test('B3 expandPathVars: ~, $HOME, ${HOME}, $WORKSPACE expand; unrelated globs untouched', () => {
  const vars = { home: '/Users/me', workspace: '/repo' };
  assert.equal(expandPathVars('~/.ssh/**', vars), '/Users/me/.ssh/**');
  assert.equal(expandPathVars('~', vars), '/Users/me');
  assert.equal(expandPathVars('$HOME/.env', vars), '/Users/me/.env');
  assert.equal(expandPathVars('${HOME}/.aws/*', vars), '/Users/me/.aws/*');
  assert.equal(expandPathVars('$WORKSPACE/dist/**', vars), '/repo/dist/**');
  // A mid-string ~ is literal; a bare glob has nothing to expand.
  assert.equal(expandPathVars('a/~/b', vars), 'a/~/b');
  assert.equal(expandPathVars('*', vars), '*');
});

test('B3 deny rule with ~ matches the resolved absolute home path', () => {
  const vars = { home: '/Users/me', workspace: '/repo' };
  const rules = { deny: ['read_file(~/.ssh/**)'] };
  // A read_file whose primary arg is the expanded abs path is denied.
  assert.equal(
    evaluatePermissionRules(rules, 'read_file', '/Users/me/.ssh/id_rsa', vars),
    'deny',
  );
  // An unrelated path is not denied by that rule.
  assert.equal(
    evaluatePermissionRules(rules, 'read_file', '/repo/src/index.ts', vars),
    null,
  );
});

test('B3 deny rule with $HOME matches; $WORKSPACE deny matches a workspace-relative-expanded path', () => {
  const vars = { home: '/home/alice', workspace: '/srv/app' };
  assert.equal(
    evaluatePermissionRules({ deny: ['read_file($HOME/.env)'] }, 'read_file', '/home/alice/.env', vars),
    'deny',
  );
  assert.equal(
    evaluatePermissionRules({ deny: ['write_file($WORKSPACE/dist/**)'] }, 'write_file', '/srv/app/dist/bundle.js', vars),
    'deny',
  );
  // ruleMatches directly, case-insensitive on the arg.
  assert.equal(ruleMatches('read_file($HOME/.env)', 'read_file', '/HOME/ALICE/.ENV'.replace('/HOME/ALICE', '/home/alice'), vars), true);
});
