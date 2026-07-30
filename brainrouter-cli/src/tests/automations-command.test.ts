/** MC-B3 — `brainrouter automations` gating + listing helpers (pure). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAutomationsInvocation,
  formatAutomationsList,
} from '../runtime/triggers/automationsCommand.js';
import type { AutomationRule } from '@kinqs/brainrouter-core/triggers';

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'build-on-label',
    name: 'Build on label',
    on: 'github.issue.labeled',
    when: "label == 'brainrouter'",
    do: 'build',
    enabled: true,
    instructions: 'Focus on the failing suite first.',
    sourcePath: '/ws/.brainrouter/automations/build-on-label.md',
    ...over,
  };
}

test('automations invocation gate: list needs no id; enable/disable require one; junk rejected', () => {
  assert.equal(validateAutomationsInvocation('list'), null);
  assert.equal(validateAutomationsInvocation('enable', 'build-on-label'), null);
  assert.equal(validateAutomationsInvocation('disable', 'build-on-label'), null);
  assert.match(validateAutomationsInvocation('enable')!, /automations enable <rule-id>/);
  assert.match(validateAutomationsInvocation('disable', '  ')!, /automations disable <rule-id>/);
  assert.match(validateAutomationsInvocation('destroy')!, /Unknown automations action/);
});

test('formatAutomationsList renders state, on/when/do per rule; empty registry shows a starter', () => {
  const out = formatAutomationsList([
    rule(),
    rule({ id: 'review-on-open', on: 'github.pull_request.opened', when: '', do: 'review', enabled: false }),
  ]);
  assert.match(out, /Automation rules \(2\):/);
  assert.match(out, /\[on\] {2}build-on-label {2}on github\.issue\.labeled {2}when label == 'brainrouter' {2}do build/);
  assert.match(out, /\[off\] review-on-open {2}on github\.pull_request\.opened {2}do review/);
  const empty = formatAutomationsList([]);
  assert.match(empty, /No automation rules found/);
  assert.match(empty, /\.brainrouter\/automations\/<id>\.md/);
});
