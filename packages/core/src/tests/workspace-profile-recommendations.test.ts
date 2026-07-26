/**
 * B3 profile-serving recommendations remain catalog-bounded and advisory.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectWorkspaceProfilePlugins,
  recommendWorkspaceProfileServing,
  WORKSPACE_PROFILES,
} from '../workspace/index.js';

const PERSONAS = ['engineer', 'researcher', 'data-scientist', 'tutor', 'writer'];
const STARTER_SKILLS = [...new Set(
  WORKSPACE_PROFILES.flatMap((profile) => profile.skills.enabled),
)];

test('B3 recommends the research pack, persona, and starter skills from live catalogs', () => {
  const recommendation = recommendWorkspaceProfileServing('research', {
    profilePlugins: inspectWorkspaceProfilePlugins(),
    personaIds: PERSONAS,
    skillIds: STARTER_SKILLS,
  });

  assert.ok(recommendation);
  assert.equal(recommendation.complete, true);
  assert.equal(recommendation.advisory, true);
  assert.equal(recommendation.authorizationEffect, 'none');
  assert.deepEqual(recommendation.agents, {
    default: 'researcher',
    enabled: ['researcher'],
  });
  assert.deepEqual(recommendation.skillPacks.map((pack) => ({
    id: pack.id,
    source: pack.source,
    skillIds: pack.skillIds,
  })), [{
    id: 'research',
    source: 'profile-plugin',
    skillIds: ['evidence-research-skill', 'source-synthesis-skill'],
  }]);
  assert.deepEqual(recommendation.starterSkillIds, ['planning-skill', 'handover-skill']);
  assert.deepEqual(recommendation.unavailable, []);
});

test('B3 keeps engineering as one persona and recommends frontend and backend capabilities', () => {
  const recommendation = recommendWorkspaceProfileServing('engineering', {
    profilePlugins: inspectWorkspaceProfilePlugins(),
    personaIds: PERSONAS,
    skillIds: STARTER_SKILLS,
  });

  assert.ok(recommendation);
  assert.deepEqual(recommendation.agents, {
    default: 'engineer',
    enabled: ['engineer'],
  });
  assert.deepEqual(recommendation.skillPacks, [{
    id: 'engineering',
    source: 'bundled',
    skillIds: [],
  }]);
  assert.deepEqual(recommendation.capabilities.map((capability) => capability.id), ['frontend', 'backend']);
  assert.equal(JSON.stringify(recommendation).includes('frontend-builder'), false);
});

test('B3 filters unavailable packs, personas, and skills without turning preference into policy', () => {
  const catalog = inspectWorkspaceProfilePlugins();
  const recommendation = recommendWorkspaceProfileServing('research', {
    profilePlugins: {
      available: catalog.available.filter((plugin) => plugin.id !== 'research'),
      unavailable: [{
        ...catalog.available.find((plugin) => plugin.id === 'research')!,
        reason: 'fixture package is absent',
      }],
    },
    personaIds: [],
    skillIds: ['planning-skill'],
  });

  assert.ok(recommendation);
  assert.equal(recommendation.complete, false);
  assert.equal(recommendation.authorizationEffect, 'none');
  assert.deepEqual(recommendation.agents, { default: '', enabled: [] });
  assert.deepEqual(recommendation.skillPacks, []);
  assert.deepEqual(recommendation.starterSkillIds, ['planning-skill']);
  assert.deepEqual(recommendation.unavailable, [
    { kind: 'skill-pack', id: 'research', reason: 'fixture package is absent' },
    { kind: 'persona', id: 'researcher', reason: 'persona is unavailable' },
    { kind: 'skill', id: 'handover-skill', reason: 'starter skill is unavailable' },
  ]);
});

test('B3 custom stays a valid empty recommendation and unknown profiles fail closed', () => {
  const availability = {
    profilePlugins: inspectWorkspaceProfilePlugins(),
    personaIds: [],
    skillIds: [],
  };
  const custom = recommendWorkspaceProfileServing('custom', availability);

  assert.ok(custom);
  assert.equal(custom.complete, true);
  assert.deepEqual(custom.agents, { default: '', enabled: [] });
  assert.deepEqual(custom.skillPacks, []);
  assert.deepEqual(custom.capabilities, []);
  assert.deepEqual(custom.starterSkillIds, []);
  assert.equal(recommendWorkspaceProfileServing('administrator', availability), undefined);
});
