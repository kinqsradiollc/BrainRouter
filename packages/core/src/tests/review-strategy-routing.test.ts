/**
 * ADR-028 — the review strategies are actually reachable by delegation.
 *
 * Both review strategies reuse the stock `reviewer` role and the
 * `code-review-and-quality` skill on purpose: a new role id would be absent
 * from every already-written `.brainrouter/workspace.json`, its required stage
 * would be dropped, and the strategy would silently never fire — the primary
 * agent would answer in prose that reads like a review. These tests assert the
 * resolved OUTCOME, never prompt text.
 *
 * They cover the CHAT path only — a person asking for a review in their own
 * words. The dedicated `/review` commands and the desktop Review panel assemble
 * a whole review workflow themselves and must NOT be routed; the last test here
 * shows what happens when they are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bundledOrchestrationProfileReferences,
  findBundledOrchestrationProfile,
} from '../orchestration/profiles/orchestrationProfileCatalog.js';
import {
  resolveWorkspaceOrchestrationPlan,
  type WorkspaceOrchestrationResolutionInput,
} from '../orchestration/profiles/orchestrationProfileResolver.js';
import { detectOrchestrationTaskSignals } from '../orchestration/profiles/taskSignals.js';
import { buildWorkingTreeReviewPrompt } from '../review/workingTreeReview.js';
import { getWorkspaceProfile } from '../workspace/profiles.js';

function resolutionInput(task: string): WorkspaceOrchestrationResolutionInput {
  const definition = findBundledOrchestrationProfile('engineering');
  const preset = getWorkspaceProfile('engineering');
  const references = bundledOrchestrationProfileReferences();
  assert.ok(definition);
  assert.ok(preset);
  return {
    definition,
    manifest: {
      profile: 'engineering',
      orchestration: structuredClone(preset.orchestration),
    },
    taskSignalIds: detectOrchestrationTaskSignals(task),
    roleCatalog: references.roles,
    installedSkillIds: references.skillIds,
    workspaceSkillIds: new Set(preset.skills.enabled),
    delegationPolicy: 'auto',
    runtimeLimits: { maxConcurrentChildren: 3, providerAvailableSlots: 2 },
  };
}

test('a security review resolves the security strategy, a code review does not', () => {
  const security = 'Run a security review on this diff.';
  const signals = detectOrchestrationTaskSignals(security);
  assert.ok(signals.has('security-review'));
  assert.ok(signals.has('review'), 'the generic signal still fires; strategy order breaks the tie');

  assert.equal(
    resolveWorkspaceOrchestrationPlan(resolutionInput(security)).strategyId,
    'security-review-only',
  );
  assert.equal(
    resolveWorkspaceOrchestrationPlan(resolutionInput('Code review this diff.')).strategyId,
    'review-only',
  );
});

test('both review strategies name a role and a skill a stock engineering workspace can run', () => {
  const plan = findBundledOrchestrationProfile('engineering');
  const preset = getWorkspaceProfile('engineering');
  assert.ok(plan);
  assert.ok(preset);
  const roles = new Set(preset.orchestration.availableRoles);
  const skills = new Set(preset.skills.enabled);

  for (const strategyId of ['security-review-only', 'review-only']) {
    const strategy = plan.strategies.find((candidate) => candidate.id === strategyId);
    assert.ok(strategy, `${strategyId} is missing from the bundled plan`);
    for (const stage of strategy.stages) {
      if (stage.executor.kind === 'role') {
        assert.ok(
          roles.has(stage.executor.roleId),
          `${strategyId}/${stage.id} needs role ${stage.executor.roleId}, which the preset does not grant`,
        );
      }
      for (const skillId of stage.skillIds) {
        assert.ok(
          skills.has(skillId),
          `${strategyId}/${stage.id} needs skill ${skillId}, which the preset does not enable`,
        );
      }
    }
  }
});

test('the security strategy is what distinguishes the two — its stage objective, not its role', () => {
  const plan = findBundledOrchestrationProfile('engineering');
  const security = plan?.strategies.find((strategy) => strategy.id === 'security-review-only');
  const code = plan?.strategies.find((strategy) => strategy.id === 'review-only');
  const securityStage = security?.stages.find((stage) => stage.executor.kind === 'role');
  const codeStage = code?.stages.find((stage) => stage.executor.kind === 'role');
  assert.equal(
    securityStage?.executor.kind === 'role' && securityStage.executor.roleId,
    codeStage?.executor.kind === 'role' && codeStage.executor.roleId,
  );
  assert.match(securityStage?.objective ?? '', /vulnerabilit/i);
  assert.doesNotMatch(codeStage?.objective ?? '', /vulnerabilit/i);
});

test('an already-assembled review workflow routes to delivery, which is why its callers must not be routed', () => {
  const task = buildWorkingTreeReviewPrompt({
    diff: 'diff --git a/src/auth.ts b/src/auth.ts\n@@ -3,6 +3,7 @@\n+  if (!token) return null;\n',
  });
  const signals = detectOrchestrationTaskSignals(task);
  assert.ok(
    signals.has('bug-fix'),
    'the review contract tells the model to hunt bugs, so the router reads the prompt as one',
  );
  assert.equal(
    resolveWorkspaceOrchestrationPlan(resolutionInput(task)).strategyId,
    'delivery',
    'signal detection reads the whole task, so a finished review workflow is planned as inspect → implement → verify',
  );
});
