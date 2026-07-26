/**
 * P23-1 contract tests for bounded orchestration-profile JSON.
 *
 * These tests pin the trust boundary before bundled plans or runtime activation
 * exist: nested field strictness, reference integrity, graph/limit checks, and
 * no-follow file containment must all fail closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ORCHESTRATION_PROFILE_MAX_BYTES,
  listOrchestrationProfileDefinitionFiles,
  parseOrchestrationProfileDefinition,
  readOrchestrationProfileDefinitionFile,
  type OrchestrationProfileReferenceCatalog,
} from '../orchestration/profiles/orchestrationProfileDefinitionFile.js';

const REFERENCES: OrchestrationProfileReferenceCatalog = {
  roleIds: new Set(['explorer', 'worker', 'reviewer', 'fleet']),
  skillIds: new Set(['planning-skill', 'testing-skill', 'verify-loop']),
  signalIds: new Set(['small-scope', 'implementation']),
  outputContractIds: new Set(['findings', 'worker']),
};

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'orchestration-profile',
    id: 'engineering',
    displayName: 'Engineering orchestration',
    defaultMode: 'adaptive',
    rolePolicy: {
      availableRoles: ['explorer', 'worker', 'reviewer'],
      disabledRoles: ['fleet'],
    },
    limits: {
      maxParallel: 4,
      maxStages: 6,
      maxChildrenPerStage: 3,
      maxTotalChildren: 8,
      maxDepth: 2,
      maxRetries: 1,
    },
    strategies: [
      {
        id: 'direct',
        description: 'Complete a small task on the primary agent.',
        activation: { signals: ['small-scope'], explicitOnly: false },
        stages: [
          {
            id: 'complete',
            executor: { kind: 'primary' },
            after: [],
            objective: 'Complete the bounded task directly.',
            skillIds: [],
            optional: false,
          },
        ],
      },
      {
        id: 'delivery',
        description: 'Inspect and implement a bounded change.',
        activation: { signals: ['implementation'], explicitOnly: false },
        stages: [
          {
            id: 'inspect',
            executor: { kind: 'role', roleId: 'explorer' },
            after: [],
            objective: 'Map the affected surfaces and constraints.',
            skillIds: ['planning-skill'],
            fanOut: { min: 1, max: 2 },
            optional: true,
            expectedOutput: {
              contractId: 'findings',
              requiredSections: ['scope', 'evidence'],
            },
          },
          {
            id: 'implement',
            executor: { kind: 'role', roleId: 'worker' },
            after: ['inspect'],
            objective: 'Implement the reviewed requirement.',
            skillIds: ['testing-skill'],
            fanOut: { min: 1, max: 1 },
            optional: false,
            expectedOutput: {
              contractId: 'worker',
              requiredSections: ['changes', 'verification'],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function parse(value: Record<string, unknown> = definition()) {
  return parseOrchestrationProfileDefinition(
    JSON.stringify(value),
    'engineering',
    REFERENCES,
  );
}

function withDirectory(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-orchestration-profile-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeDefinition(root: string, id = 'engineering'): string {
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, `${id}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify(definition({ id, displayName: `${id} orchestration` })),
    'utf8',
  );
  return filePath;
}

test('P23-1 parses a bounded orchestration profile with typed stage executors', () => {
  const parsed = parse();

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.kind, 'orchestration-profile');
  assert.equal(parsed.defaultMode, 'adaptive');
  assert.deepEqual(parsed.rolePolicy, {
    availableRoles: ['explorer', 'worker', 'reviewer'],
    disabledRoles: ['fleet'],
  });
  assert.deepEqual(parsed.strategies[0]?.stages[0]?.executor, { kind: 'primary' });
  assert.deepEqual(parsed.strategies[1]?.stages[0]?.executor, {
    kind: 'role',
    roleId: 'explorer',
  });
});

test('P23-1 rejects authority fields and unknown nested fields', () => {
  assert.throws(
    () => parse(definition({ model: 'provider-model' })),
    /definition contains unknown fields: model/,
  );

  const value = definition();
  (value.rolePolicy as Record<string, unknown>).tools = ['run_command'];
  assert.throws(() => parse(value), /rolePolicy contains unknown fields: tools/);

  const nested = definition();
  const strategy = (nested.strategies as Array<Record<string, unknown>>)[0]!;
  const stage = (strategy.stages as Array<Record<string, unknown>>)[0]!;
  (stage.executor as Record<string, unknown>).access = 'shell';
  assert.throws(() => parse(nested), /executor contains unknown fields: access/);
});

test('P23-1 rejects duplicate strategy and stage ids', () => {
  const duplicateStrategy = definition();
  const strategies = duplicateStrategy.strategies as Array<Record<string, unknown>>;
  strategies.push(structuredClone(strategies[0]!));
  assert.throws(() => parse(duplicateStrategy), /strategy ids contains duplicate ids: direct/);

  const duplicateStage = definition();
  const delivery = (duplicateStage.strategies as Array<Record<string, unknown>>)[1]!;
  const stages = delivery.stages as Array<Record<string, unknown>>;
  stages.push(structuredClone(stages[0]!));
  assert.throws(() => parse(duplicateStage), /stage ids contains duplicate ids: inspect/);
});

test('P23-1 rejects missing dependencies and cyclic stage graphs', () => {
  const missing = definition();
  const missingDelivery = (missing.strategies as Array<Record<string, unknown>>)[1]!;
  const missingStages = missingDelivery.stages as Array<Record<string, unknown>>;
  missingStages[1]!.after = ['unknown-stage'];
  assert.throws(() => parse(missing), /references unknown dependency unknown-stage/);

  const cyclic = definition();
  const cyclicDelivery = (cyclic.strategies as Array<Record<string, unknown>>)[1]!;
  const cyclicStages = cyclicDelivery.stages as Array<Record<string, unknown>>;
  cyclicStages[0]!.after = ['implement'];
  assert.throws(() => parse(cyclic), /stage graph must be acyclic/);
});

test('P23-1 rejects unknown role, skill, signal, and output-contract references', () => {
  const unknownRole = definition();
  (unknownRole.rolePolicy as Record<string, unknown>).availableRoles = ['explorer', 'invented'];
  assert.throws(() => parse(unknownRole), /rolePolicy.availableRoles contains unknown references: invented/);

  const unknownSkill = definition();
  const unknownSkillStrategy = (unknownSkill.strategies as Array<Record<string, unknown>>)[0]!;
  const unknownSkillStage = (unknownSkillStrategy.stages as Array<Record<string, unknown>>)[0]!;
  unknownSkillStage.skillIds = ['invented-skill'];
  assert.throws(() => parse(unknownSkill), /skillIds contains unknown references: invented-skill/);

  const unknownSignal = definition();
  const unknownSignalStrategy = (unknownSignal.strategies as Array<Record<string, unknown>>)[0]!;
  (unknownSignalStrategy.activation as Record<string, unknown>).signals = ['invented-signal'];
  assert.throws(() => parse(unknownSignal), /activation.signals contains unknown references: invented-signal/);

  const unknownContract = definition();
  const contractStrategy = (unknownContract.strategies as Array<Record<string, unknown>>)[1]!;
  const contractStage = (contractStrategy.stages as Array<Record<string, unknown>>)[0]!;
  (contractStage.expectedOutput as Record<string, unknown>).contractId = 'invented-contract';
  assert.throws(
    () => parse(unknownContract),
    /expectedOutput.contractId contains unknown references: invented-contract/,
  );
});

test('P23-1 rejects fan-out and aggregate child counts beyond plan limits', () => {
  const primaryFanOut = definition();
  const primaryStrategy = (primaryFanOut.strategies as Array<Record<string, unknown>>)[0]!;
  const primaryStage = (primaryStrategy.stages as Array<Record<string, unknown>>)[0]!;
  primaryStage.fanOut = { min: 1, max: 1 };
  assert.throws(() => parse(primaryFanOut), /primary executor cannot fan out/);

  const oversizedFanOut = definition();
  const fanOutStrategy = (oversizedFanOut.strategies as Array<Record<string, unknown>>)[1]!;
  const fanOutStage = (fanOutStrategy.stages as Array<Record<string, unknown>>)[0]!;
  fanOutStage.fanOut = { min: 1, max: 4 };
  assert.throws(() => parse(oversizedFanOut), /fanOut.max must be an integer between 1 and 3/);

  const aggregate = definition();
  (aggregate.limits as Record<string, unknown>).maxTotalChildren = 2;
  assert.throws(() => parse(aggregate), /can create 3 children, exceeding limits.maxTotalChildren 2/);
});

test('P23-1 rejects malformed, oversized, mismatched, and secret-bearing definitions', () => {
  assert.throws(
    () => parseOrchestrationProfileDefinition('{ nope', 'engineering', REFERENCES),
    /not valid JSON/,
  );
  assert.throws(
    () => parseOrchestrationProfileDefinition(
      ' '.repeat(ORCHESTRATION_PROFILE_MAX_BYTES + 1),
      'engineering',
      REFERENCES,
    ),
    /must be 1-/,
  );
  assert.throws(
    () => parseOrchestrationProfileDefinition(
      JSON.stringify(definition({ id: 'research' })),
      'engineering',
      REFERENCES,
    ),
    /id must match its filename/,
  );
  assert.throws(
    () => parse(definition({
      displayName: 'Use token=super-secret-value for this profile.',
    })),
    /secret material/,
  );
});

test('P23-1 file discovery and reads reject links and containment escapes', () => {
  withDirectory((root) => {
    const profilesRoot = path.join(root, 'orchestration-profiles');
    const outsideRoot = path.join(root, 'outside');
    const valid = writeDefinition(profilesRoot);
    const outside = writeDefinition(outsideRoot, 'research');
    fs.symlinkSync(outside, path.join(profilesRoot, 'research.json'));

    assert.deepEqual(
      listOrchestrationProfileDefinitionFiles(profilesRoot, root),
      [valid],
    );
    assert.throws(
      () => readOrchestrationProfileDefinitionFile(
        path.join(profilesRoot, 'research.json'),
        REFERENCES,
        profilesRoot,
        root,
      ),
      /symbolic links|readable regular UTF-8/,
    );
    assert.throws(
      () => readOrchestrationProfileDefinitionFile(
        outside,
        REFERENCES,
        profilesRoot,
        profilesRoot,
      ),
      /escaped its declared orchestration-profiles directory/,
    );
  });
});
