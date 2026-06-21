import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_ROLES, buildRolePrompt, PRIOR_WORK_PREAMBLE } from '../orchestration/roles.js';

// MAS-NOREDUN — every role prompt must carry the "build on prior work, don't
// re-derive" directive so a fan-out child reads deltas, not the whole tree.

test('buildRolePrompt injects the anti-redundancy preamble for every role', () => {
  for (const role of Object.values(BUILT_IN_ROLES)) {
    const prompt = buildRolePrompt(role, 'BASE', 'do the task');
    assert.ok(prompt.includes(PRIOR_WORK_PREAMBLE), `${role.name} prompt must include PRIOR_WORK_PREAMBLE`);
    assert.match(prompt, /do NOT re-derive/i, `${role.name} prompt must tell the agent not to re-derive`);
    // basePrompt still present, overlay still present.
    assert.ok(prompt.includes('BASE'));
    assert.ok(prompt.includes(role.promptOverlay));
  }
});

test('memory-first opening is conditional, not mandatory (skip when handed context)', () => {
  // The read-mapping roles must no longer say "(mandatory)" — they should skip
  // the memory pass when the parent already handed them a plan/diff/findings.
  for (const name of ['explorer', 'architect', 'reviewer', 'verifier']) {
    const overlay = BUILT_IN_ROLES[name].promptOverlay;
    assert.doesNotMatch(overlay, /Memory-first opening \(mandatory\)/, `${name} must not force the memory pass`);
    assert.match(overlay, /SKIP if you were handed/i, `${name} must allow skipping the memory pass`);
  }
});
