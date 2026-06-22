import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDestructiveCommand, extractIacTarget } from '../exec/destructiveCommandGuard.js';

// WS5 — block destructive git/IaC commands unless the user explicitly asked.

test('WS5: discard-work commands are BLOCKED without discard intent', () => {
  for (const cmd of ['git reset --hard', 'git reset --hard HEAD~2', 'git checkout -- .', 'git checkout -- src/app.ts', 'git clean -fd', 'git clean -xdf', 'git stash drop', 'git stash clear']) {
    const v = evaluateDestructiveCommand(cmd, { userIntent: 'fix the failing test' });
    assert.equal(v.decision, 'block', `should block: ${cmd}`);
    assert.equal(v.rule, 'discard-work');
  }
});

test('WS5: discard-work is ALLOWED when the user asked to discard', () => {
  assert.equal(evaluateDestructiveCommand('git reset --hard', { userIntent: 'discard my changes and start over' }).decision, 'allow');
  assert.equal(evaluateDestructiveCommand('git clean -fd', { userIntent: 'wipe the untracked files' }).decision, 'allow');
  assert.equal(evaluateDestructiveCommand('git checkout -- .', { userIntent: 'revert all local changes' }).decision, 'allow');
  assert.equal(evaluateDestructiveCommand('git stash drop', { userIntent: 'throw away that stash' }).decision, 'allow');
});

test('WS5: a destructive segment in a compound command is caught per-segment', () => {
  const v = evaluateDestructiveCommand('npm run build && git reset --hard', { userIntent: 'build the project' });
  assert.equal(v.decision, 'block');
  assert.equal(v.rule, 'discard-work');
});

test('WS5: git commit --amend is BLOCKED unless HEAD was authored by the agent this session', () => {
  const ctx = { userIntent: 'amend the commit', headSha: 'abc123', agentAuthoredCommits: new Set<string>() };
  assert.equal(evaluateDestructiveCommand('git commit --amend --no-edit', ctx).decision, 'block');
  assert.equal(evaluateDestructiveCommand('git commit --amend --no-edit', ctx).rule, 'amend-foreign');
  // Allowed once the agent authored HEAD this session.
  const mine = { ...ctx, agentAuthoredCommits: new Set(['abc123']) };
  assert.equal(evaluateDestructiveCommand('git commit --amend --no-edit', mine).decision, 'allow');
});

test('WS5: IaC destroy is BLOCKED unless the user named that specific stack', () => {
  assert.equal(evaluateDestructiveCommand('terraform destroy', { userIntent: 'clean up' }).decision, 'block');
  assert.equal(evaluateDestructiveCommand('pulumi destroy --stack prod', { userIntent: 'tear something down' }).decision, 'block', 'destroy verb but no specific stack named');
  // Named the stack + a destroy verb → allowed.
  assert.equal(evaluateDestructiveCommand('pulumi destroy --stack prod', { userIntent: 'destroy the prod stack' }).decision, 'allow');
  assert.equal(evaluateDestructiveCommand('cdk destroy MyStack', { userIntent: 'tear down MyStack please' }).decision, 'allow');
});

test('WS5: benign commands always pass', () => {
  for (const cmd of ['git status', 'git commit -m "feat: x"', 'git checkout -b feature', 'git stash', 'npm test', 'terraform plan', 'pulumi preview', 'git reset HEAD~1']) {
    assert.equal(evaluateDestructiveCommand(cmd, { userIntent: 'do work' }).decision, 'allow', `should allow: ${cmd}`);
  }
});

test('WS5: extractIacTarget pulls the stack/target', () => {
  assert.equal(extractIacTarget('pulumi destroy --stack prod'), 'prod');
  assert.equal(extractIacTarget('pulumi destroy -s staging'), 'staging');
  assert.equal(extractIacTarget('cdk destroy MyAppStack'), 'MyAppStack');
  assert.equal(extractIacTarget('terraform destroy -target=module.db'), 'module.db');
});
