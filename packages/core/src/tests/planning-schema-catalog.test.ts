import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPlanningSchemaCatalog,
  resolvePlanningSchema,
} from '../workspace/planningSchemas/catalog.js';
import { resolvePlanningSchemaActivation } from '../workspace/planningSchemas/activation.js';
import type { WorkspaceProfileId } from '../workspace/profiles.js';

const EXPECTED_DEFAULTS: ReadonlyArray<readonly [WorkspaceProfileId, string]> = [
  ['engineering', 'engineering-delivery'],
  ['research', 'research-evidence'],
  ['data-science', 'data-science-experiment'],
  ['study', 'study-learning'],
  ['writing', 'writing-editorial'],
  ['custom', 'custom-deliverable'],
];

test('bundled planning schema catalog resolves one validated default per profile', () => {
  const catalog = loadPlanningSchemaCatalog();
  assert.equal(catalog.length, 6);
  for (const [profileId, schemaId] of EXPECTED_DEFAULTS) {
    const resolution = resolvePlanningSchema({ profileId, catalog });
    assert.equal(resolution.schema.id, schemaId);
    assert.equal(resolution.source, 'profile-default');
    assert.ok(resolution.schema.sections.some((section) => section.required));
    assert.ok(resolution.schema.gates.length > 0);
  }
});

test('custom workspaces may select a known catalog schema but cannot invent one', () => {
  const catalog = loadPlanningSchemaCatalog();
  const selected = resolvePlanningSchema({
    profileId: 'custom',
    selectedSchemaId: 'research-evidence',
    catalog,
  });
  assert.equal(selected.schema.id, 'research-evidence');
  assert.equal(selected.source, 'workspace-selection');

  const rejected = resolvePlanningSchema({
    profileId: 'custom',
    selectedSchemaId: 'invented-schema',
    catalog,
  });
  assert.equal(rejected.schema.id, 'custom-deliverable');
  assert.equal(rejected.source, 'safe-fallback');
  assert.match(rejected.diagnostic ?? '', /unavailable for profile/);

  const incompatible = resolvePlanningSchema({
    profileId: 'engineering',
    selectedSchemaId: 'research-evidence',
    catalog,
  });
  assert.equal(incompatible.schema.id, 'engineering-delivery');
  assert.equal(incompatible.source, 'safe-fallback');
});

test('activation requires profile planning skills and engineering decision policy only when triggered', () => {
  const catalog = loadPlanningSchemaCatalog();
  const research = resolvePlanningSchemaActivation({
    profileId: 'research',
    prompt: 'Plan a deep research project with several deliverables.',
    activeGoal: false,
    catalog,
  });
  assert.deepEqual(
    research.requiredSkills.map((skill) => skill.id),
    ['planning-skill', 'research-question-skill'],
  );

  const routineEngineering = resolvePlanningSchemaActivation({
    profileId: 'engineering',
    prompt: 'Rename this local variable.',
    activeGoal: false,
    catalog,
  });
  assert.deepEqual(routineEngineering.requiredSkills, []);

  const architecturalEngineering = resolvePlanningSchemaActivation({
    profileId: 'engineering',
    prompt: 'Plan a cross-surface public API and database schema migration.',
    activeGoal: false,
    catalog,
  });
  assert.deepEqual(
    architecturalEngineering.requiredSkills.map((skill) => skill.id),
    ['planning-skill', 'adr-skill'],
  );
  assert.deepEqual(
    architecturalEngineering.decisionTriggerIds,
    ['public-contract', 'persistence-model', 'cross-surface'],
  );
});
