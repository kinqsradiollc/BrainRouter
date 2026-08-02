/**
 * 0.4.19 — domain breadth in profiles, WITHOUT splitting engineering.
 *
 * Two rules pull against each other and both are owner decisions:
 *
 *  1. There should be a profile for each kind of work someone does — legal,
 *     finance, marketing, and so on — so onboarding is not "pick engineering
 *     and edit everything".
 *  2. Engineering must stay ONE profile. Frontend and backend are task-time
 *     capabilities inside it, not separate profiles, because a task that
 *     crosses them is the normal case rather than the exception.
 *
 * Rule 2 is the one that erodes: adding `frontend` next to `engineering` looks
 * locally reasonable every time it is proposed. The test below is what makes
 * that proposal fail loudly rather than pass review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PROFILES, getWorkspaceProfile } from '../workspace/profiles.js';
import { ORCHESTRATION_PLAN_ALIASES } from '../workspace/profileOrchestrationDefaults.js';

const IDS = WORKSPACE_PROFILES.map((p) => p.id);

test('engineering is ONE profile — no per-specialism split', () => {
  for (const forbidden of ['frontend', 'backend', 'fullstack', 'devops', 'mobile', 'qa', 'sre']) {
    assert.ok(
      !IDS.includes(forbidden as never),
      `"${forbidden}" must not be a profile — it is a capability inside engineering. ` +
      'Splitting forces a lane choice at workspace creation and re-onboarding when a ' +
      'task crosses it, which is most tasks.',
    );
  }
});

test('engineering carries the specialisms as capabilities instead', () => {
  const engineering = getWorkspaceProfile('engineering')!;
  assert.ok(engineering.capabilities.available.includes('frontend'));
  assert.ok(engineering.capabilities.available.includes('backend'));
  assert.ok(engineering.capabilities.recommended.includes('frontend'));
  assert.ok(engineering.capabilities.recommended.includes('backend'));
});

test('the domain profiles a person would actually look for all exist', () => {
  for (const expected of [
    'engineering', 'product-management', 'design', 'research', 'data-science',
    'study', 'education', 'writing', 'marketing', 'sales', 'operations',
    'finance', 'legal', 'people', 'healthcare', 'consulting', 'custom',
  ]) {
    assert.ok(IDS.includes(expected as never), `missing profile "${expected}"`);
  }
});

test('education and study are distinct — teaching is not studying', () => {
  // They differ in who is learning, which changes the whole posture: one
  // designs assessment for others, the other works through material for
  // oneself. Collapsing them would make one of the two behave wrongly.
  const study = getWorkspaceProfile('study')!;
  const education = getWorkspaceProfile('education')!;
  assert.notEqual(study.persona.default, education.persona.default);
  assert.match(education.description, /Teaching/i);
});

test('every profile is complete and internally consistent', () => {
  for (const profile of WORKSPACE_PROFILES) {
    assert.ok(profile.label.trim(), `${profile.id} label`);
    assert.ok(profile.description.trim(), `${profile.id} description`);
    // The deprecated `agents` alias must mirror `persona`, or a v1 client and a
    // v2 client disagree about which persona a workspace uses.
    assert.deepEqual(profile.agents, profile.persona, `${profile.id} agents/persona alias`);
    // `enabled` is the wire-compatible mirror of `recommended`.
    assert.deepEqual(
      profile.capabilities.enabled, profile.capabilities.recommended,
      `${profile.id} capabilities enabled/recommended alias`,
    );
    // Recommended capabilities must be offered by the profile.
    for (const capability of profile.capabilities.recommended) {
      assert.ok(
        profile.capabilities.available.includes(capability),
        `${profile.id} recommends "${capability}" without offering it`,
      );
    }
    if (profile.id !== 'custom') {
      assert.ok(profile.persona.default, `${profile.id} needs a default persona`);
      assert.ok(profile.tools.profiles.length > 0, `${profile.id} needs tool groups`);
      assert.ok(profile.skills.enabled.length > 0, `${profile.id} needs starter skills`);
    }
  }
});

test('profile ids are unique and url-safe', () => {
  assert.equal(new Set(IDS).size, IDS.length, 'duplicate profile id');
  for (const id of IDS) {
    assert.match(id, /^[a-z][a-z0-9-]*$/, `"${id}" is not a safe id`);
  }
});

test('custom stays last, and stays empty', () => {
  // It is the "impose nothing" option; a preset leaking into it defeats that.
  assert.equal(IDS[IDS.length - 1], 'custom');
  const custom = getWorkspaceProfile('custom')!;
  assert.deepEqual(custom.skills.enabled, []);
  assert.deepEqual(custom.tools.profiles, []);
});

test('every plan alias points at a profile that really exists', () => {
  // An alias to a deleted or misspelled profile silently falls through to the
  // TypeScript compatibility path, which is a downgrade nobody would notice.
  for (const [from, to] of Object.entries(ORCHESTRATION_PLAN_ALIASES)) {
    assert.ok(IDS.includes(from as never), `alias source "${from}" is not a profile`);
    assert.ok(IDS.includes(to as never), `alias target "${to}" is not a profile`);
    assert.notEqual(from, to, `"${from}" aliases itself`);
  }
});

test('regulated-adjacent profiles exist and are named plainly', () => {
  // finance / legal / healthcare describe work next to licensed professions.
  // Their personas carry the not-professional-advice framing, because the
  // persona is what reaches the model; a UI disclaimer does not.
  for (const id of ['finance', 'legal', 'healthcare'] as const) {
    const profile = getWorkspaceProfile(id)!;
    assert.match(
      profile.description,
      /not (licensed financial advice|legal advice|medical advice)/i,
      `${id} description must say plainly what it is not`,
    );
  }
});
