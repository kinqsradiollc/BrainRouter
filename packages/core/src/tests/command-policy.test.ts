import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCommandPolicy, splitCommandSegments, segmentHead } from '../exec/commandPolicy.js';
import { resolveRunCommandApproval } from '../exec/dangerousCommand.js';

test('CODEX-EXEC-POLICY splitCommandSegments splits on &&, ||, |, ;, newlines', () => {
  assert.deepEqual(splitCommandSegments('a && b || c | d ; e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(splitCommandSegments('  git status  '), ['git status']);
  assert.deepEqual(splitCommandSegments(''), []);
});

test('CODEX-EXEC-POLICY segmentHead skips env-assignments and strips paths', () => {
  assert.equal(segmentHead('ls -la'), 'ls');
  assert.equal(segmentHead('FOO=bar BAZ=1 npm test'), 'npm');
  assert.equal(segmentHead('/usr/bin/grep foo'), 'grep');
  assert.equal(segmentHead('./scripts/run.sh'), 'run.sh');
});

test('CODEX-EXEC-POLICY classifies read-only built-ins as safe, mutators as unknown/dangerous', () => {
  assert.equal(evaluateCommandPolicy('ls -la').segments[0].classification, 'safe');
  assert.equal(evaluateCommandPolicy('git status -s').segments[0].classification, 'safe');
  assert.equal(evaluateCommandPolicy('grep -r foo src').segments[0].classification, 'safe');
  // git write subcommand is NOT in the safe read set.
  assert.equal(evaluateCommandPolicy('git push origin main').segments[0].classification, 'unknown');
  // npm runs arbitrary scripts → never "safe".
  assert.equal(evaluateCommandPolicy('npm test').segments[0].classification, 'unknown');
  // dangerous floor.
  assert.equal(evaluateCommandPolicy('rm -rf /tmp/x').segments[0].classification, 'dangerous');
  // a read-only head with an output redirect is a write → not safe.
  assert.equal(evaluateCommandPolicy('echo hi > file.txt').segments[0].classification, 'unknown');
  // command substitution can't be reasoned about → not safe.
  assert.equal(evaluateCommandPolicy('cat $(find . -name x)').segments[0].classification, 'unknown');
});

test('CODEX-EXEC-POLICY allowlist matches on a word boundary, every segment must match', () => {
  const allow = ['git status', 'npm test'];
  const ok = evaluateCommandPolicy('git status && npm test', allow);
  assert.equal(ok.allAllowlisted, true);
  // `git status-hack` must NOT match the `git status` prefix.
  assert.equal(evaluateCommandPolicy('git status-hack', allow).allAllowlisted, false);
  // a non-allowlisted segment defeats allAllowlisted.
  assert.equal(evaluateCommandPolicy('git status && rm -rf x', allow).allAllowlisted, false);
  assert.equal(evaluateCommandPolicy('git status && rm -rf x', allow).anyDangerous, true);
});

test('CODEX-EXEC-POLICY allowlisted commands auto-approve in any mode; dangerous never does', () => {
  const allow = ['git status', 'npm run build'];
  // Planning mode, no goal — normally `ask`, but allowlisted → auto-approve.
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'git status', { silent: false, allowlist: allow }),
    'auto-approve',
  );
  // A dangerous segment is never auto-approved even if part is allowlisted.
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'git status && sudo rm -rf /', { silent: false, allowlist: allow }),
    'ask',
  );
  // Silent child: allowlisted safe → auto-approve; dangerous → deny-silent.
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'npm run build', { silent: true, allowlist: allow }),
    'auto-approve',
  );
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'rm -rf /', { silent: true, allowlist: allow }),
    'deny-silent',
  );
});

test('CODEX-EXEC-POLICY empty allowlist leaves approval behavior unchanged', () => {
  // No allowlist → the historical mode gating still governs (ls asks in planning).
  assert.equal(resolveRunCommandApproval({ executionMode: 'planning' }, 'ls -la', { silent: false }), 'ask');
  assert.equal(resolveRunCommandApproval({ executionMode: 'planning' }, 'ls -la', { silent: false, allowlist: [] }), 'ask');
  assert.equal(resolveRunCommandApproval({ executionMode: 'fast' }, 'ls -la', { silent: false }), 'auto-approve');
});
