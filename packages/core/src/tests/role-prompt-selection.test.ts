import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findById,
  loadRegistry,
  type AgentDefinition,
} from '../orchestration/agents/agentRegistry.js';
import {
  DOMAIN_NEUTRAL_ROLE_PROMPTS,
  type ActiveProfilePromptContext,
  type DomainNeutralRoleId,
} from '../orchestration/roles/rolePromptSelection.js';
import { resolveRole } from '../orchestration/roles/roles.js';
import { findBundledOrchestrationProfile } from '../orchestration/profiles/orchestrationProfileCatalog.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AGENTS_DIR = path.join(PACKAGE_ROOT, 'agents');
const ROLE_IDS = [
  'explorer',
  'architect',
  'worker',
  'reviewer',
  'verifier',
] as const satisfies readonly DomainNeutralRoleId[];
const ACTIVE_ENGINEERING: ActiveProfilePromptContext = {
  activation: 'active',
  orchestrationProfileId: 'engineering',
  strategyId: 'delivery',
};
const LEGACY_PROMPT_HASHES: Record<DomainNeutralRoleId, string> = {
  explorer: 'fc4a4fd243c394305d707fa31ace1801eb3972b682070b4a6fbed78c28143f7c',
  architect: '98f2bfb2c6aa820d4e1b7b41e23dccdad12f50e3b2a030e5786f2f068dc1d97e',
  worker: '7fb851275f8611e06d5864c1bd92a4a20a235756fab12bf5645942748fdd1f08',
  // ADR-028 — the reviewer's "verify before you flag" paragraph is no longer
  // written here; it comes from `review/reviewGrounding.ts`, which every
  // reviewing surface shares. This pin therefore moves whenever that one rule
  // deliberately changes, and MUST NOT be re-pinned to silence an accidental
  // edit to the rest of the role prompt.
  reviewer: 'ca96860377c453f02e33af7f6f1c23f7659b6645a168f7c2706c819d5d19a757',
  verifier: '85a8f003b27fa32f98af4ce2974afbc43d561974281763b6d3f3e25b280902a1',
};

function physicalDefinition(roleId: DomainNeutralRoleId): AgentDefinition {
  return JSON.parse(
    fs.readFileSync(path.join(AGENTS_DIR, `${roleId}.json`), 'utf8'),
  ) as AgentDefinition;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function executionPolicy(definition: AgentDefinition): Omit<
  AgentDefinition,
  'prompt' | 'whenToUse'
> {
  const { prompt: _prompt, whenToUse: _whenToUse, ...policy } = definition;
  return policy;
}

test('P23-4 bundled reusable role JSON is domain-neutral', () => {
  const domainTerms = /\b(code|codebase|file|repository|shell|test|typecheck|memory_\w+|recordId)\b/i;
  for (const roleId of ROLE_IDS) {
    const definition = physicalDefinition(roleId);
    assert.equal(definition.prompt, DOMAIN_NEUTRAL_ROLE_PROMPTS[roleId].prompt);
    assert.equal(definition.whenToUse, DOMAIN_NEUTRAL_ROLE_PROMPTS[roleId].description);
    assert.doesNotMatch(definition.prompt, domainTerms, `${roleId} prompt leaked a domain workflow`);
    assert.doesNotMatch(definition.whenToUse, domainTerms, `${roleId} description leaked a domain workflow`);
  }
});

test('P23-4 compatibility execution preserves the exact bundled Engineering prompts', () => {
  for (const roleId of ROLE_IDS) {
    const compatibility = findById(roleId);
    const active = findById(roleId, undefined, ACTIVE_ENGINEERING);
    assert.ok(compatibility);
    assert.ok(active);
    assert.equal(hash(compatibility.def.prompt), LEGACY_PROMPT_HASHES[roleId]);
    assert.equal(active.def.prompt, physicalDefinition(roleId).prompt);
    assert.deepEqual(executionPolicy(active.def), executionPolicy(compatibility.def));
  }
});

test('P23-4 preview or malformed profile context cannot activate neutral prompts', () => {
  const preview = {
    activation: 'preview',
    orchestrationProfileId: 'engineering',
    strategyId: 'delivery',
  } as unknown as ActiveProfilePromptContext;
  const malformed = {
    activation: 'active',
    orchestrationProfileId: '../engineering',
    strategyId: 'delivery',
  } as ActiveProfilePromptContext;

  assert.equal(
    hash(findById('worker', undefined, preview)!.def.prompt),
    LEGACY_PROMPT_HASHES.worker,
  );
  assert.equal(
    hash(findById('worker', undefined, malformed)!.def.prompt),
    LEGACY_PROMPT_HASHES.worker,
  );
});

test('P23-4 active profile selection reuses the same neutral role posture across domains', () => {
  const contexts: ActiveProfilePromptContext[] = [
    ACTIVE_ENGINEERING,
    { activation: 'active', orchestrationProfileId: 'research', strategyId: 'investigate' },
    { activation: 'active', orchestrationProfileId: 'study', strategyId: 'guided-session' },
  ];
  for (const roleId of ROLE_IDS) {
    const prompts = contexts.map((context) =>
      findById(roleId, undefined, context)!.def.prompt);
    assert.equal(new Set(prompts).size, 1, `${roleId} changed posture between profiles`);
  }
});

test('P23-4 direct-role compatibility remains Engineering-oriented until activation', () => {
  assert.match(resolveRole('worker').promptOverlay, /implement a single bounded task/i);
  assert.match(resolveRole('reviewer').promptOverlay, /code review|review changes/i);
  assert.equal(
    resolveRole('worker', ACTIVE_ENGINEERING).promptOverlay,
    DOMAIN_NEUTRAL_ROLE_PROMPTS.worker.prompt,
  );
  assert.equal(
    resolveRole('reviewer', ACTIVE_ENGINEERING).promptOverlay,
    DOMAIN_NEUTRAL_ROLE_PROMPTS.reviewer.prompt,
  );
});

test('P23-4 Engineering workflow choices live in the Engineering plan', () => {
  const plan = findBundledOrchestrationProfile('engineering');
  assert.ok(plan);
  const delivery = plan.strategies.find((strategy) => strategy.id === 'delivery');
  assert.ok(delivery);
  const implement = delivery.stages.find((stage) => stage.id === 'implement');
  const review = delivery.stages.find((stage) => stage.id === 'review');
  const verify = delivery.stages.find((stage) => stage.id === 'verify');

  assert.match(implement?.objective ?? '', /implement|requirement/i);
  assert.deepEqual(implement?.skillIds, ['incremental-skill', 'testing-skill']);
  assert.match(review?.objective ?? '', /repository policy|security boundaries/i);
  assert.deepEqual(review?.skillIds, ['code-review-and-quality']);
  assert.match(verify?.objective ?? '', /automated|runtime checks/i);
  assert.deepEqual(verify?.skillIds, ['verify-loop']);
});

test('P23-4 registry policy and output contracts do not vary by prompt source', () => {
  const compatibility = new Map(loadRegistry().map((entry) => [entry.def.id, entry.def]));
  const active = loadRegistry(undefined, ACTIVE_ENGINEERING);
  for (const entry of active) {
    assert.deepEqual(
      executionPolicy(entry.def),
      executionPolicy(compatibility.get(entry.def.id)!),
      `${entry.def.id} execution policy changed with prompt source`,
    );
  }
});
