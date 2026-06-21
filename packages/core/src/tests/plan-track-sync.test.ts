import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';
import { createRequirement, getRequirement } from '../requirement/requirementStore.js';
import { planItemId, syncRequirementPlanTrack } from '../requirement/planTrackSync.js';
import { readPlan, updatePlan } from '../task/taskStore.js';
import { listWorkItems } from '../track/trackStore.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('plan/Track sync: a ready requirement seeds one plan and deduplicated work items', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:sync';
    const requirement = createRequirement(workspace, {
      title: 'Add gateway rate limiting',
      status: 'ready',
      sessionKey,
      acceptanceCriteria: ['Reject requests above the configured limit.', 'Cover the limit with a test.'],
    });

    const first = syncRequirementPlanTrack(workspace, sessionKey);
    const plan = readPlan(workspace, sessionKey);
    const items = listWorkItems(workspace);
    assert.equal(getRequirement(workspace, requirement.id)?.status, 'in-progress');
    assert.equal(plan.requirementId, requirement.id);
    assert.equal(plan.items.length, 2);
    assert.equal(items.length, 2);
    assert.equal(first.actions.filter((action) => action.kind === 'plan-seeded').length, 1);
    assert.equal(first.actions.filter((action) => action.kind === 'work-item-created').length, 2);
    assert.ok(plan.items.every((item, index) =>
      items.some((workItem) => workItem.taskIds.includes(planItemId(requirement.id, item, index))),
    ));

    const second = syncRequirementPlanTrack(workspace, sessionKey);
    assert.deepEqual(second.actions, []);
    assert.equal(listWorkItems(workspace).length, 2, 're-running must not duplicate Track items');
  });
});

test('plan/Track sync: a completed plan item transitions its linked item to done', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:completed';
    const requirement = createRequirement(workspace, {
      title: 'Verify rate limiting',
      status: 'ready',
      sessionKey,
      acceptanceCriteria: ['Rate limits are enforced.'],
    });
    syncRequirementPlanTrack(workspace, sessionKey);
    updatePlan(workspace, { plan: [{ step: 'Rate limits are enforced.', status: 'completed' }] }, sessionKey);

    const result = syncRequirementPlanTrack(workspace, sessionKey);
    const item = listWorkItems(workspace).find((candidate) => candidate.requirementId === requirement.id)!;
    assert.equal(item.statusCategory, 'done');
    assert.equal(result.actions.filter((action) => action.kind === 'work-item-completed').length, 1);
  });
});

test('plan/Track sync: a ready requirement without criteria remains untouched', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:no-criteria';
    const requirement = createRequirement(workspace, {
      title: 'Incomplete requirement',
      status: 'ready',
      sessionKey,
    });

    assert.deepEqual(syncRequirementPlanTrack(workspace, sessionKey).actions, []);
    assert.equal(getRequirement(workspace, requirement.id)?.status, 'ready');
    assert.equal(readPlan(workspace, sessionKey).items.length, 0);
    assert.equal(listWorkItems(workspace).length, 0);
  });
});

function response(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ message }],
    usage: { prompt_tokens: 8, completion_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('plan/Track sync guard: one enabled turn creates and captures the cascade once', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'session:guard';
    const requirement = createRequirement(workspace, {
      title: 'Add request tracing',
      status: 'ready',
      sessionKey,
      acceptanceCriteria: ['Requests include a trace id.'],
    });
    const originalFetch = globalThis.fetch;
    const statuses: string[] = [];
    const captured: Array<Record<string, unknown>> = [];
    let llmCalls = 0;
    setCliKnobOverride({
      nextActionPlanner: 'off',
      automation: {
        enabled: true,
        requirements: { enabled: false, autoCreateThreshold: 0.7, lowActThreshold: 0.4 },
        sync: { enabled: true },
        sprints: { enabled: false, minItems: 3, respectCapacity: true },
      },
    });
    globalThis.fetch = (async () => {
      llmCalls += 1;
      return llmCalls === 1
        ? response({
          content: '',
          tool_calls: [{ id: 'call_list', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
        })
        : response({ content: 'Tracing requirements are ready.' });
    }) as any;
    const mcp: any = {
      listTools: async () => ({ tools: [{ name: 'memory_capture_turn' }] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'memory_capture_turn') captured.push(args);
        return { content: [{ text: JSON.stringify({ recordId: `mem_sync_${captured.length}` }) }] };
      },
      close: async () => {},
    };
    try {
      const agent = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, sessionKey, silent: false,
      });
      await agent.runTurn('inspect the workspace', {
        onStatusUpdate: (status) => statuses.push(status), onToolStart: () => {}, onToolEnd: () => {},
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(llmCalls, 2, 'the deterministic guard must not re-prompt the model');
      assert.equal(statuses.filter((status) => /Requirement .* Plan .* Track/i.test(status)).length, 1, 'guard budget is one pass per turn');
      assert.equal(listWorkItems(workspace).filter((item) => item.requirementId === requirement.id).length, 1);
      const automationEvents = captured
        .map((call) => (call.messages as Array<{ content: string }> | undefined)?.[1]?.content)
        .flatMap((content) => {
          try { return [JSON.parse(content ?? '')]; } catch { return []; }
        })
        .filter((event) => event?.provenance?.reason === 'plan-track-sync');
      assert.equal(automationEvents.length, 2, 'plan and work-item auto-actions are captured separately');
      assert.equal(getRequirement(workspace, requirement.id)?.linkedMemoryIds.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});
