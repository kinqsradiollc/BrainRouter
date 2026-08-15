/**
 * Can the agent actually REACH the orchestration it is told to use?
 *
 * Every assertion here exists because a definition compiled, was tested, and
 * nothing could call it. `spawn_agents` was instructed by four prompt surfaces
 * while being filtered out of the advertised tool list; `route_task`'s top tier
 * was one child, so the escalation ladder the prompt mandates terminated below
 * the fan-out it demanded. A passing unit test on either piece proved nothing
 * about whether the model could get there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { localToolSpecsFromExecutors } from '../tool/registry/executors.js';
import { routeTask } from '../orchestration/delegation/router.js';
import { buildTemplatePlan, WORKFLOW_TEMPLATES } from '../workflow/template/workflowTemplates.js';
import { describeProfileStageTool } from '../agent/runtime/profileStageRuntime.js';
import {
  createRunWorkflowGraphTool,
  createRunWorkflowTool,
  createSpawnAgentsTool,
  createTaskAgentTool,
  createRouteTaskTool,
} from '../orchestration/agents/agentTools.js';
import { buildFanOutHint, detectBreadthIntent } from '../prompt/planning/breadthHint.js';
import {
  fanOutGuardMessage,
  undifferentiatedFanOutGuardMessage,
} from '../agent/runtime/turnGuardMessages.js';
import { shouldRunFanOutDifferentiationGuard } from '../agent/guards/fanOutFollowThroughGuard.js';
import { adversarialLens, investigationLenses, reviewLenses } from '../orchestration/lenses.js';
import {
  bundledOrchestrationProfileReferences,
  findBundledOrchestrationProfile,
} from '../orchestration/profiles/orchestrationProfileCatalog.js';
import { resolveWorkspaceOrchestrationPlan } from '../orchestration/profiles/orchestrationProfileResolver.js';
import { getWorkspaceProfile } from '../workspace/profiles.js';
import { resolveWorkspaceToolSelection, workspaceToolAllowed } from '../workspace/toolProfiles.js';
import { extensionToolOwner } from '../extension/registry.js';
import { registryEntry } from '../tool/registry/registry.js';

/**
 * A context argument is required, not optional decoration: `localToolSpecsFromExecutors`
 * short-circuits its availability filter when called with none, so a bare call
 * reports tools the model never actually sees. The real turn always passes one
 * (runTurn.impl.ts), so the assertions below must too.
 */
const registryAdvertised = () => new Set(
  localToolSpecsFromExecutors({ rootAgent: true, activeOrchestrationPlan: false })
    .map((spec) => spec.name),
);

/**
 * The registry list is only half of what the real turn applies. A managed
 * workspace runs `workspaceAllowsLocalTool` over it as well
 * (runTurn.impl.ts:252,394), and the FIRST version of this file asserted only
 * against the registry — which is why guidance naming `run_workflow` passed
 * green here while the tool was denied on a v3 workspace that had enabled
 * active-turn orchestration and not workflow launch. Assert through the same
 * filter, on a manifest shaped like a real onboarded engineering repo.
 */
const ORCHESTRATION_WORKSPACE = {
  version: 3,
  profile: 'engineering',
  capabilities: { enabled: ['frontend', 'backend'], disabled: [] },
  tools: {
    mode: 'explicit-catalog',
    enabled: [],
    profiles: ['coding', 'shell', 'browser', 'artifacts', 'planning-session', 'orchestration'],
    deny: [],
  },
} as never;

const advertised = () => {
  const selection = resolveWorkspaceToolSelection({ manifest: ORCHESTRATION_WORKSPACE });
  return new Set(
    [...registryAdvertised()].filter((name) => {
      const canonical = registryEntry(name)?.name ?? name;
      return workspaceToolAllowed(selection, {
        toolId: canonical,
        extensionId: extensionToolOwner(canonical)?.extension,
      });
    }),
  );
};

test('spawn_agents is advertised, because four prompt surfaces instruct the model to call it', () => {
  assert.equal(advertised().has('spawn_agents'), true);
});

test('spawn_agent stays hidden, because task_agent and delegate_agent already cover one child', () => {
  assert.equal(advertised().has('spawn_agent'), false);
});

test('every tool the runtime NAMES in an injected message is a tool the model can emit', () => {
  // The regression that let spawn_agents rot was string literals in guidance
  // drifting away from the registry. Assert against the live advertised list,
  // never against a hard-coded expectation — and through the workspace policy,
  // because the registry alone said `run_workflow` was fine while a v3 catalog
  // workspace denied it.
  const surfaces = [
    buildFanOutHint('audit everything', detectBreadthIntent('audit everything')),
    fanOutGuardMessage(),
    undifferentiatedFanOutGuardMessage(['same', 'same', 'same']),
    createSpawnAgentsTool().description,
    createRouteTaskTool().description,
  ].join('\n');

  const names = advertised();
  // Only check names the runtime could plausibly own: backticked identifiers
  // that look like tool ids. Prose words are not tool names.
  const mentioned = [...surfaces.matchAll(/`([a-z][a-z0-9_]{4,})`/g)].map((m) => m[1]!);
  // `_thread` is in this list because leaving it out is how the same defect
  // survived one tier up: `route_task` named `spawn_worker_thread`, which the
  // background-workers group gates, and the filter simply did not look.
  const orchestrationish = mentioned.filter((name) => /_(agent|agents|task|workflow|graph|thread)$/.test(name));
  assert.ok(orchestrationish.length > 0, 'precondition: the surfaces name orchestration tools at all');
  for (const name of new Set(orchestrationish)) {
    assert.equal(names.has(name), true, `injected guidance names \`${name}\`, which is not in the advertised tool list`);
  }
});

test('the low-level workflow target stays catalogued for exact host-authorized dispatch', () => {
  // Authorization is enforced at the runtime chokepoint, not by deleting the
  // stable tool id from profiles. Existing catalogs and low-level APIs remain
  // readable while model-facing guidance points at explicit host commands.
  assert.equal(advertised().has('run_workflow'), true);
});

test('route_task never recommends a model tool this turn cannot emit', async () => {
  // The workspace-policy list is what the turn hands the model. A tier whose
  // tool is missing from it must yield to the next one, not be recommended
  // anyway — the router's answer is acted on, not read.
  const withoutWorkflow = await routeTask({
    task: 'Implement the retry backoff, then run the tests and review the diff.',
    skipMemory: true,
    availableTools: new Set(['spawn_agents', 'read_file', 'run_command']),
  });
  assert.equal(withoutWorkflow.tier, 'workflow');
  assert.equal(withoutWorkflow.recommendedTool, null);
  assert.match(withoutWorkflow.reason, /`\/build <task>`/);
  assert.doesNotMatch(withoutWorkflow.reason, /hand .* to `run_workflow`/i);

  const withoutWorkers = await routeTask({
    task: 'Watch the deploy in the background until it finishes and tell me how it went.',
    skipMemory: true,
    availableTools: new Set(['spawn_agents', 'run_workflow']),
  });
  assert.notEqual(withoutWorkers.tier, 'spawn-worker');
  assert.notEqual(withoutWorkers.recommendedTool, 'spawn_worker_thread');

  // Same prompts, full surface: the tiers are still reachable, so the gate
  // demotes on denial rather than always.
  const worker = await routeTask({
    task: 'Watch the deploy in the background until it finishes and tell me how it went.',
    skipMemory: true,
  });
  assert.equal(worker.tier, 'spawn-worker');
});

test('route_task can recommend a fan-out, so the ladder does not terminate at one child', async () => {
  const result = await routeTask({
    task: 'Audit every workspace test setup across the whole repository and tell me which are weakest.',
    skipMemory: true,
  });
  assert.equal(result.tier, 'fan-out');
  assert.equal(result.recommendedTool, 'spawn_agents');
});

test('route_task recommends a workflow for a phase chain, and names the template to pass', async () => {
  const result = await routeTask({
    task: 'Implement the retry backoff, then run the tests and review the diff.',
    skipMemory: true,
  });
  assert.equal(result.tier, 'workflow');
  assert.equal(result.recommendedTool, null);
  assert.match(result.reason, /`\/build <task>`/);
  assert.match(result.reason, /cannot authorize or start/);
});

test('route_task routes a multi-target comparison to the compare workflow, not N hand-managed children', async () => {
  const result = await routeTask({ task: 'Compare pgvector vs sqlite-vec for our recall path.', skipMemory: true });
  assert.equal(result.tier, 'workflow');
  assert.equal(result.recommendedTool, null);
  assert.match(result.reason, /`\/workflow run compare \[jsonArgs\]`/);
});

test('workflow tool specs state exact host authority and current Desktop availability', () => {
  const phase = createRunWorkflowTool().description;
  assert.match(phase, /unexpired, single-use execution intent/);
  assert.match(phase, /exact workspace, session, user, turn, tool, and normalized arguments/);
  assert.match(phase, /active goal, planner\/router recommendation.*does not create that authority/);
  assert.match(phase, /`\/build <task>`/);
  assert.match(phase, /`\/workflow run <template> \[jsonArgs\]`/);
  assert.match(phase, /Desktop production launch is unavailable/);

  const graph = createRunWorkflowGraphTool().description;
  assert.match(graph, /unexpired, single-use execution intent/);
  assert.match(graph, /Production graph launch remains unavailable/);
  assert.match(graph, /Desktop Test run is preview-only/);
});

test('an explicit "do it yourself" still demotes below fan-out, because the veto outranks breadth', async () => {
  const result = await routeTask({
    task: 'Audit every workspace test setup across the whole repository yourself, no fan-out.',
    skipMemory: true,
  });
  assert.notEqual(result.tier, 'fan-out');
  assert.notEqual(result.tier, 'workflow');
  assert.notEqual(result.recommendedTool, 'spawn_agents');
});

test('a weak local model is steered off the multi-child tiers, which it coordinates worst', async () => {
  const task = 'Audit every workspace test setup across the whole repository.';
  assert.equal((await routeTask({ task, skipMemory: true })).tier, 'fan-out');

  const local = await routeTask({ task, skipMemory: true, localModel: true });
  assert.equal(local.tier, 'spawn-inline');
  assert.match(local.reason, /local-model: bounded inline task/);
  // A demoted tier still names a runnable child; dropping it to null would leave
  // the model with a tier and no way to act on it.
  assert.match(String(local.recommendedTool), /^delegate_/);
});

test('the investigate template fans out distinct lenses and ends on one adversary that consumes the synthesis', () => {
  assert.ok(WORKFLOW_TEMPLATES.includes('investigate' as never));
  const { plan, errors } = buildTemplatePlan('investigate', { question: 'why is recall slow?' });
  assert.deepEqual(errors, []);
  assert.ok(plan);

  const inspect = plan!.phases.find((phase) => phase.id === 'inspect');
  const lenses = inspect?.fanOut?.over ?? [];
  assert.ok(lenses.length >= 3, 'an investigation worth fanning out has ≥3 angles');
  assert.equal(new Set(lenses).size, lenses.length, 'the angles must be distinct, or it is one question N times');

  const challenge = plan!.phases.filter((phase) => phase.id === 'challenge');
  assert.equal(challenge.length, 1, 'exactly one adversary — a second would just be another opinion');
  assert.deepEqual(challenge[0]?.inputFrom, ['synthesize'], 'the adversary attacks the SYNTHESIS, not the raw findings');
  assert.match(challenge[0]?.agents?.[0]?.prompt ?? '', /falsify/);
});

test('investigate refuses a single lens, because one angle is not an investigation', () => {
  const { plan, errors } = buildTemplatePlan('investigate', { question: 'why?', lenses: ['only one'] });
  assert.equal(plan, null);
  assert.match(errors.join(' '), /≥2 distinct angles/);
});

test('the profile-stage description renders fanOut, because the delegated-stage guard conditions on it', () => {
  const described = describeProfileStageTool('BASE', {
    workspaceProfileId: 'engineering',
    planProfileId: 'engineering',
    orchestrationProfileId: 'engineering',
    strategyId: 'delivery',
    selectionSource: 'deterministic',
    matchedSignalIds: [],
    stages: [{
      id: 'inspect',
      executor: { kind: 'role', roleId: 'explorer' },
      after: [],
      objective: 'Map the surfaces.',
      skillIds: ['planning-skill'],
      fanOut: { min: 1, max: 3 },
      optional: false,
      requiresApproval: false,
    }],
    skippedStages: [],
    effectiveParallel: 4,
    diagnostics: [],
  });
  assert.match(described, /fan-out: 1-3 children on DISTINCT angles/);
});

test('the parent can ask a child to think harder, on both spawn paths', () => {
  const taskAgent = createTaskAgentTool().inputSchema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(taskAgent.effort?.enum, ['low', 'medium', 'high', 'xhigh']);

  const entry = (createSpawnAgentsTool().inputSchema.properties.agents as {
    items: { properties: Record<string, { enum?: string[] }> };
  }).items.properties;
  assert.deepEqual(entry.effort?.enum, ['low', 'medium', 'high', 'xhigh']);
});

test('spawn_agents states the four conditions that make a fan-out worth its cost', () => {
  const description = createSpawnAgentsTool().description;
  assert.match(description, /DISTINCT named lens/);
  assert.ok(description.includes(reviewLenses()[0]!), 'names the concrete review lenses, not just "distinct"');
  assert.ok(description.includes(investigationLenses()[0]!));
  assert.ok(description.includes(adversarialLens()));
  assert.match(description, /ownership/);
  assert.match(description, /You synthesize/);
});

test('three children sharing one angle trips the differentiation guard, two do not', () => {
  const base = {
    fanOutHinted: true,
    guardFired: 0,
    maxGuardFires: 1,
    interactiveTopLevel: true,
    internalSession: false,
  };
  assert.equal(shouldRunFanOutDifferentiationGuard({ ...base, childLabels: ['audit', 'audit', 'audit'] }), true);
  assert.equal(shouldRunFanOutDifferentiationGuard({ ...base, childLabels: [undefined, undefined, undefined] }), true);
  // A genuine split-by-target of two is not the failure this names.
  assert.equal(shouldRunFanOutDifferentiationGuard({ ...base, childLabels: ['audit', 'audit'] }), false);
  assert.equal(
    shouldRunFanOutDifferentiationGuard({ ...base, childLabels: ['correctness', 'security', 'regressions'] }),
    false,
  );
  // The guard is a fan-out follow-up; without the hint it must stay silent.
  assert.equal(
    shouldRunFanOutDifferentiationGuard({ ...base, fanOutHinted: false, childLabels: ['a', 'a', 'a'] }),
    false,
  );
});

test('the engineering adversary stage is optional, so a missing reviewer loses a stage and not the strategy', () => {
  const plan = findBundledOrchestrationProfile('engineering');
  assert.ok(plan);
  const withChallenge = plan!.strategies.filter((strategy) =>
    strategy.stages.some((stage) => stage.id === 'challenge'));
  assert.deepEqual(withChallenge.map((strategy) => strategy.id), ['investigate', 'delivery']);
  for (const strategy of withChallenge) {
    const challenge = strategy.stages.find((stage) => stage.id === 'challenge')!;
    assert.equal(challenge.optional, true, `${strategy.id}/challenge must be optional`);
  }
});

/**
 * `optional: true` is only half the guarantee. The adversary was inserted into
 * the middle of both strategies — `deliver` waits on `challenge`, and so does
 * `investigate`'s `synthesize`. If dropping an unavailable optional stage left
 * that edge behind, the terminal stage would wait forever on a lifecycle record
 * that was never compiled: a plan claiming a state it can never reach.
 */
function resolveEngineering(signals: string[], dropRole?: string) {
  const references = bundledOrchestrationProfileReferences();
  const roles = new Map(references.roles);
  if (dropRole) roles.delete(dropRole);
  return resolveWorkspaceOrchestrationPlan({
    definition: findBundledOrchestrationProfile('engineering'),
    manifest: {
      profile: 'engineering',
      orchestration: structuredClone(getWorkspaceProfile('engineering')!.orchestration),
    },
    taskSignalIds: new Set(signals),
    roleCatalog: roles,
    installedSkillIds: references.skillIds,
    workspaceSkillIds: references.skillIds,
    delegationPolicy: 'auto',
    runtimeLimits: { maxConcurrentChildren: 4, providerAvailableSlots: 4 },
  });
}

test('dropping the unavailable adversary also drops the edge pointing at it, so the terminal stage is still reachable', () => {
  for (const [signals, terminalId] of [
    [['implementation', 'bug-fix'], 'deliver'],
    [['investigation'], 'synthesize'],
  ] as const) {
    const withReviewer = resolveEngineering([...signals]);
    assert.ok(
      withReviewer.stages.some((stage) => stage.id === 'challenge'),
      'precondition: the adversary is compiled in when the reviewer role exists',
    );
    assert.ok(withReviewer.stages.find((stage) => stage.id === terminalId)?.after.includes('challenge'));

    const without = resolveEngineering([...signals], 'reviewer');
    // The strategy must survive: losing the adversary must not demote the whole
    // run to the `direct` fallback.
    assert.equal(without.strategyId, withReviewer.strategyId);
    assert.equal(without.stages.some((stage) => stage.id === 'challenge'), false);

    const stageIds = without.stages.map((stage) => stage.id);
    const terminal = without.stages.find((stage) => stage.id === terminalId);
    assert.ok(terminal, `${terminalId} must survive the adversary being unavailable`);
    assert.deepEqual(
      terminal!.after.filter((id) => !stageIds.includes(id)),
      [],
      `${terminalId} must not wait on a stage that was never compiled`,
    );
  }
});

test('inspect stages may fan out past one child, but never require more than one', () => {
  const plan = findBundledOrchestrationProfile('engineering');
  for (const strategyId of ['investigate', 'delivery']) {
    const inspect = plan!.strategies
      .find((strategy) => strategy.id === strategyId)!
      .stages.find((stage) => stage.id === 'inspect')!;
    assert.equal(inspect.fanOut?.max, 3);
    // min > 1 makes the stage unavailable below that much parallelism, which
    // silently drops the whole strategy to the `direct` fallback. The ceiling is
    // what buys breadth; the floor would only buy outages.
    assert.equal(inspect.fanOut?.min, 1);
  }
});
