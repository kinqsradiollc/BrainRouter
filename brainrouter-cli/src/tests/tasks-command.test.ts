/** MC-B6 — `brainrouter tasks suggest` gating + rendering helpers (pure). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTasksInvocation,
  formatSuggestedTasksList,
  pickSuggestedPrompt,
} from '../runtime/triggers/tasksCommand.js';
import type { SuggestedTask, SuggestedTasksResult } from '@kinqs/brainrouter-core/triggers';

function task(over: Partial<SuggestedTask> = {}): SuggestedTask {
  return {
    kind: 'failing-checks',
    title: 'PR #12 ("Add the frobnicator") has failing checks: CI',
    repo: 'acme/widgets',
    number: 12,
    url: 'https://github.com/acme/widgets/pull/12',
    suggestedPrompt: 'Fix the failing checks on PR #12 in acme/widgets ("Add the frobnicator"): CI. Check out the PR branch, reproduce each failure locally, fix it, and push the fixes to the same branch.',
    ...over,
  };
}

function result(tasks: SuggestedTask[], warnings: string[] = []): SuggestedTasksResult {
  return { repo: 'acme/widgets', tasks, warnings };
}

test('tasks invocation gate: suggest passes, junk actions and junk --pick are rejected', () => {
  assert.equal(validateTasksInvocation('suggest'), null);
  assert.equal(validateTasksInvocation('suggest', '2'), null);
  assert.match(validateTasksInvocation('destroy')!, /Unknown tasks action/);
  assert.match(validateTasksInvocation('suggest', '0')!, /--pick <n>/);
  assert.match(validateTasksInvocation('suggest', 'nope')!, /--pick <n>/);
});

test('formatSuggestedTasksList renders numbered kinds + prompts, the run hand-off hint, and warnings', () => {
  const out = formatSuggestedTasksList(result(
    [
      task(),
      task({ kind: 'labeled-issue', number: 7, title: 'Issue #7 ("Fix timer") is labeled "good first issue"', url: '', suggestedPrompt: 'Work on issue #7 in acme/widgets ("Fix timer"). Implement it on a fresh branch and open a pull request that references the issue.' }),
    ],
    ['issues labeled "brainrouter": HTTP 403'],
  ));
  assert.match(out, /Suggested tasks in acme\/widgets \(2\):/);
  assert.match(out, /1\. \[checks\] PR #12 .*failing checks: CI {2}https:\/\/github\.com\/acme\/widgets\/pull\/12/);
  assert.match(out, /prompt: Fix the failing checks on PR #12/);
  assert.match(out, /2\. \[issue\] Issue #7/);
  assert.match(out, /brainrouter run "\$\(brainrouter tasks suggest --pick <n>\)"/);
  assert.match(out, /warning: issues labeled "brainrouter": HTTP 403/);
});

test('formatSuggestedTasksList on an empty scan explains there is nothing actionable', () => {
  const out = formatSuggestedTasksList(result([]));
  assert.match(out, /No suggested tasks — nothing actionable found in acme\/widgets\./);
});

test('pickSuggestedPrompt returns the 1-based prompt, null out of range', () => {
  const r = result([task(), task({ kind: 'merge-conflict', suggestedPrompt: 'Resolve the merge conflicts on PR #12 in acme/widgets.' })]);
  assert.match(pickSuggestedPrompt(r, 1)!, /^Fix the failing checks/);
  assert.match(pickSuggestedPrompt(r, 2)!, /^Resolve the merge conflicts/);
  assert.equal(pickSuggestedPrompt(r, 3), null);
  assert.equal(pickSuggestedPrompt(result([]), 1), null);
});
