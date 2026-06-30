import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSprint,
  createWorkItem,
  getWorkItem,
  listSprints,
  setSprintState,
  transitionWorkItem,
  updateWorkItem,
} from '../track/trackStore.js';
import { makeAgent, withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('sprint store: only one sprint may be active', () => {
  withTempWorkspace((workspace) => {
    const first = createSprint(workspace, { name: 'Sprint 1' });
    const second = createSprint(workspace, { name: 'Sprint 2' });

    assert.equal(setSprintState(workspace, first.id, 'active')!.state, 'active');
    assert.throws(
      () => setSprintState(workspace, second.id, 'active'),
      /already active/i,
    );
    assert.equal(listSprints(workspace).find((sprint) => sprint.id === second.id)!.state, 'future');
  });
});

test('track_update: assigns work to a sprint and batch-transitions only matching items', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent = makeAgent(workspace);
    const invoke = (args: Record<string, unknown>) => (agent as any).executeLocalTool('track_update', args) as Promise<string>;
    const sprint = createSprint(workspace, { name: 'Sprint 1' });
    const first = createWorkItem(workspace, { title: 'First task', type: 'task' });
    const second = createWorkItem(workspace, { title: 'Second task', type: 'task' });
    const bug = createWorkItem(workspace, { title: 'Unrelated bug', type: 'bug' });

    const assigned = await invoke({
      action: 'assign-sprint', key: first.key, sprintId: sprint.id,
    });
    assert.match(assigned, new RegExp(`${first.key}.*${sprint.name}`, 'i'));
    assert.equal(getWorkItem(workspace, first.key)!.sprintId, sprint.id);

    const transitioned = await invoke({
      action: 'batch-transition', query: 'type = task', toStatus: 'in-progress',
    });
    assert.match(transitioned, /transitioned 2/i);
    assert.equal(getWorkItem(workspace, first.key)!.status, 'in-progress');
    assert.equal(getWorkItem(workspace, second.key)!.status, 'in-progress');
    assert.equal(getWorkItem(workspace, bug.key)!.status, 'backlog');

    const invalid = await invoke({
      action: 'batch-transition', query: 'not-a-real-field = value', toStatus: 'done',
    });
    assert.match(invalid, /bad query/i);
    assert.equal(getWorkItem(workspace, first.key)!.status, 'in-progress');
  });
});

test('track sprint tools: start, complete, and query lifecycle with persisted velocity', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent = makeAgent(workspace);
    const update = (args: Record<string, unknown>) => (agent as any).executeLocalTool('track_update', args) as Promise<string>;
    const query = (args: Record<string, unknown>) => (agent as any).executeLocalTool('track_query', args) as Promise<string>;
    const created = await update({ action: 'sprint-create', name: 'Sprint 1' });
    assert.match(created, /created.*sprint 1/i);
    const sprint = listSprints(workspace)[0];
    const first = createWorkItem(workspace, { title: 'Five points' });
    const second = createWorkItem(workspace, { title: 'Three points' });
    const undone = createWorkItem(workspace, { title: 'Not done' });
    updateWorkItem(workspace, first.key, { storyPoints: 5 });
    updateWorkItem(workspace, second.key, { storyPoints: 3 });
    transitionWorkItem(workspace, first.key, 'done');
    transitionWorkItem(workspace, second.key, 'done');
    await update({ action: 'assign-sprint', key: first.key, sprintId: sprint.id });
    await update({ action: 'assign-sprint', key: second.key, sprintId: sprint.id });
    await update({ action: 'assign-sprint', key: undone.key, sprintId: sprint.id });

    const started = await update({
      action: 'sprint-start', sprintId: sprint.id, capacity: 12,
    });
    assert.match(started, /started.*sprint 1/i);
    const active = listSprints(workspace).find((candidate) => candidate.id === sprint.id)!;
    assert.equal(active.state, 'active');
    assert.equal(active.capacity, 12);
    assert.ok(active.startDate);

    const completed = await update({
      action: 'sprint-complete', sprintId: sprint.id,
    });
    assert.match(completed, /completed.*velocity.*8/i);
    const persisted = listSprints(workspace).find((candidate) => candidate.id === sprint.id)! as typeof active & { velocity?: number };
    assert.equal(persisted.state, 'completed');
    assert.equal(persisted.velocity, 8);

    const allSprints = JSON.parse(await query({ action: 'sprints' }));
    assert.equal(allSprints[0].id, sprint.id);
    const detail = JSON.parse(await query({ action: 'sprint-detail', sprintId: sprint.id }));
    assert.equal(detail.sprint.id, sprint.id);
    assert.equal(detail.items.length, 3);
    const velocity = JSON.parse(await query({ action: 'velocity', sprintId: sprint.id }));
    assert.deepEqual(velocity, { sprintId: sprint.id, velocity: 8 });
  });
});
