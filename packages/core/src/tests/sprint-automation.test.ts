import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';
import { setGoal } from '../goal/store/goalStore.js';
import { createRequirement, getRequirement } from '../requirement/requirementStore.js';
import { updatePlan } from '../task/taskStore.js';
import {
  createSprint,
  createWorkItem,
  getWorkItem,
  listSprints,
  setSprintState,
  transitionWorkItem,
} from '../track/trackStore.js';
import { reconcileSessionSprints } from '../track/sprintAutomation.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('sprint automation: threshold creates one future sprint and assigns current-session items', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:sprint-create';
    const ids = [1, 2, 3].map((index) =>
      createWorkItem(workspace, { title: `Ready ${index}`, sessionKey, requirementId: 'req_ready' }),
    );

    const actions = reconcileSessionSprints(workspace, { sessionKey, minItems: 3, respectCapacity: true, propose: false });
    const [sprint] = listSprints(workspace);
    assert.equal(sprint.state, 'future');
    assert.equal(actions.filter((action) => action.kind === 'sprint-created').length, 1);
    assert.equal(actions.filter((action) => action.kind === 'work-item-assigned').length, 3);
    assert.ok(ids.every((item) => getWorkItem(workspace, item.id)?.sprintId === sprint.id));
  });
});

test('sprint automation: an existing active sprint is extended instead of creating another', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:sprint-extend';
    const active = createSprint(workspace, { name: 'Current sprint' });
    setSprintState(workspace, active.id, 'active');
    createWorkItem(workspace, { title: 'Ready A', sessionKey, requirementId: 'req_extend' });
    createWorkItem(workspace, { title: 'Ready B', sessionKey, requirementId: 'req_extend' });
    createWorkItem(workspace, { title: 'Ready C', sessionKey, requirementId: 'req_extend' });

    reconcileSessionSprints(workspace, { sessionKey, minItems: 3, respectCapacity: true, propose: false });
    assert.equal(listSprints(workspace).length, 1);
    assert.equal(listSprints(workspace)[0].state, 'active');
    assert.equal(listSprints(workspace)[0].id, active.id);
  });
});

test('sprint automation: respects active capacity and does not pull another session into the sprint', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:capacity';
    const active = createSprint(workspace, { name: 'Capacity sprint', capacity: 3 });
    setSprintState(workspace, active.id, 'active');
    createWorkItem(workspace, { title: 'Current A', sessionKey, requirementId: 'req_capacity', storyPoints: 2 });
    createWorkItem(workspace, { title: 'Current B', sessionKey, requirementId: 'req_capacity', storyPoints: 2 });
    const otherSession = createWorkItem(workspace, { title: 'Other session', sessionKey: 'session:other', requirementId: 'req_other', storyPoints: 1 });

    const actions = reconcileSessionSprints(workspace, { sessionKey, minItems: 1, respectCapacity: true, propose: false });
    assert.equal(actions.filter((action) => action.kind === 'work-item-assigned').length, 1);
    assert.equal(getWorkItem(workspace, otherSession.id)?.sprintId, undefined);
  });
});

test('sprint automation: an all-done active sprint is completed with persisted velocity', () => {
  withTempWorkspace((workspace) => {
    const sprint = createSprint(workspace, { name: 'Velocity sprint' });
    setSprintState(workspace, sprint.id, 'active');
    const first = createWorkItem(workspace, { title: 'One', sprintId: sprint.id, storyPoints: 3 });
    const second = createWorkItem(workspace, { title: 'Two', sprintId: sprint.id, storyPoints: 5 });
    transitionWorkItem(workspace, first.id, 'done');
    transitionWorkItem(workspace, second.id, 'done');

    const actions = reconcileSessionSprints(workspace, { sessionKey: 'session:unrelated', minItems: 3, respectCapacity: true, propose: false });
    const completed = listSprints(workspace).find((candidate) => candidate.id === sprint.id)!;
    assert.equal(completed.state, 'completed');
    assert.equal(completed.velocity, 8);
    assert.deepEqual(actions, [{ kind: 'sprint-completed', sprintId: sprint.id, sprintName: 'Velocity sprint', velocity: 8 }]);
  });
});

test('sprint automation: propose mode (default) SUGGESTS but never mutates the store', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:propose';
    for (const i of [1, 2, 3]) createWorkItem(workspace, { title: `Ready ${i}`, sessionKey, requirementId: 'req_p' });
    // default propose:true — suggest a sprint, create nothing.
    const actions = reconcileSessionSprints(workspace, { sessionKey, minItems: 3, respectCapacity: true });
    assert.deepEqual(actions, [{ kind: 'sprint-suggested', count: 3 }]);
    assert.equal(listSprints(workspace).length, 0, 'propose mode must not create a sprint');

    // an all-done active sprint suggests completion, does not complete it.
    const sprint = createSprint(workspace, { name: 'S' });
    setSprintState(workspace, sprint.id, 'active');
    const w = createWorkItem(workspace, { title: 'X', sprintId: sprint.id });
    transitionWorkItem(workspace, w.id, 'done');
    const a2 = reconcileSessionSprints(workspace, { sessionKey: 'other', minItems: 3, respectCapacity: true });
    assert.ok(a2.some((x) => x.kind === 'sprint-complete-suggested'));
    assert.equal(listSprints(workspace).find((s) => s.id === sprint.id)?.state, 'active', 'must NOT auto-complete');
  });
});

function response(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ message }],
    usage: { prompt_tokens: 8, completion_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function automationOverride(sync: boolean, sprints: boolean) {
  return {
    nextActionPlanner: 'off' as const,
    automation: {
      enabled: true,
      requirements: { enabled: false, autoCreateThreshold: 0.7, lowActThreshold: 0.4, autopilot: false },
      sync: { enabled: sync },
      sprints: { enabled: sprints, minItems: 3, respectCapacity: true, autopilot: sprints },
    },
  };
}

test('sprint guard: a normal tool turn creates and captures the sprint cascade once', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'session:sprint-guard';
    for (let index = 0; index < 3; index += 1) {
      createWorkItem(workspace, { title: `Ready ${index}`, sessionKey, requirementId: 'req_sprint' });
    }
    const originalFetch = globalThis.fetch;
    const captured: Array<Record<string, unknown>> = [];
    let llmCalls = 0;
    setCliKnobOverride(automationOverride(false, true));
    globalThis.fetch = (async () => {
      llmCalls += 1;
      return llmCalls === 1
        ? response({ content: '', tool_calls: [{ id: 'list', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] })
        : response({ content: 'Sprint queued.' });
    }) as any;
    const mcp: any = {
      listTools: async () => ({ tools: [{ name: 'memory_capture_turn' }] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'memory_capture_turn') captured.push(args);
        return { content: [{ text: JSON.stringify({ recordId: `mem_sprint_${captured.length}` }) }] };
      },
      close: async () => {},
    };
    try {
      const agent = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, sessionKey, silent: false,
      });
      await agent.runTurn('inspect current work', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(llmCalls, 2, 'sprint automation is deterministic and must not re-prompt');
      assert.equal(listSprints(workspace).length, 1);
      const actions = captured
        .map((call) => (call.messages as Array<{ content: string }> | undefined)?.[1]?.content)
        .flatMap((content) => {
          try { return [JSON.parse(content ?? '')]; } catch { return []; }
        })
        .filter((event) => event?.provenance?.reason === 'sprint-automation');
      assert.equal(actions.length, 4, 'sprint creation and each assignment are captured');
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});

test('goal completion automation: completes the plan-anchored requirement once', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'session:goal-complete';
    const requirement = createRequirement(workspace, { title: 'Ship tracing', status: 'in-progress', sessionKey });
    updatePlan(workspace, {
      requirementId: requirement.id,
      plan: [{ step: 'Ship tracing', status: 'completed' }],
    }, sessionKey);
    setGoal(workspace, 'Ship tracing', sessionKey);
    const originalFetch = globalThis.fetch;
    const captured: Array<Record<string, unknown>> = [];
    let llmCalls = 0;
    setCliKnobOverride(automationOverride(false, false));
    globalThis.fetch = (async () => {
      llmCalls += 1;
      return llmCalls === 1
        ? response({ content: '', tool_calls: [{ id: 'complete', type: 'function', function: { name: 'goal_complete', arguments: JSON.stringify({ proof: 'Tracing shipped and verified.' }) } }] })
        : response({ content: 'Tracing shipped.' });
    }) as any;
    const mcp: any = {
      listTools: async () => ({ tools: [{ name: 'memory_capture_turn' }] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'memory_capture_turn') captured.push(args);
        return { content: [{ text: JSON.stringify({ recordId: `mem_goal_${captured.length}` }) }] };
      },
      close: async () => {},
    };
    try {
      const agent = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, sessionKey, silent: false,
      });
      await agent.runTurn('finish the goal', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(llmCalls, 2);
      assert.equal(getRequirement(workspace, requirement.id)?.status, 'done');
      assert.equal(getRequirement(workspace, requirement.id)?.linkedMemoryIds.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});
