import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureProject,
  createWorkItem,
  transitionWorkItem,
  updateWorkItem,
  getWorkItem,
  createAutomation,
  listAutomations,
  updateAutomation,
  deleteAutomation,
} from '../track/trackStore.js';
import { withTempWorkspace } from './_helpers.js';

test('automation: a "created" rule with a condition sets a field', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    createAutomation(ws, { name: 'Bugs are high', trigger: 'created', condition: 'type = bug', actions: [{ type: 'set-priority', value: 'high' }] });
    const bug = createWorkItem(ws, { title: 'Crash', type: 'bug' });
    assert.equal(bug.priority, 'high'); // automation applied before return
    const story = createWorkItem(ws, { title: 'Feature', type: 'story' });
    assert.equal(story.priority, 'medium'); // condition didn't match
  });
});

test('automation: a "transitioned" rule comments; only fires on transition', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    createAutomation(ws, { name: 'Note done', trigger: 'transitioned', condition: 'status = done', actions: [{ type: 'comment', value: 'auto-resolved' }] });
    const w = createWorkItem(ws, { title: 'X' });
    assert.equal(w.comments.length, 0);
    const moved = transitionWorkItem(ws, w.key, 'in-progress')!;
    assert.equal(moved.comments.length, 0); // condition status=done not met
    const done = transitionWorkItem(ws, w.key, 'done')!;
    assert.equal(done.comments.length, 1);
    assert.equal(done.comments[0].author, 'automation');
  });
});

test('automation: actions apply directly and do NOT loop', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    // An "updated" rule that adds a label — its own write must not re-trigger.
    createAutomation(ws, { name: 'Tag touched', trigger: 'updated', actions: [{ type: 'add-label', value: 'touched' }] });
    const w = createWorkItem(ws, { title: 'Y' });
    const updated = updateWorkItem(ws, w.key, { assignee: 'ann' })!;
    assert.deepEqual(updated.labels, ['touched']); // applied exactly once, no infinite loop
    const activityAuto = updated.activity.filter((a) => a.field === 'automation');
    assert.equal(activityAuto.length, 1);
  });
});

test('automation: disabled rules do not fire; CRUD round-trips', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const rule = createAutomation(ws, { name: 'Off', trigger: 'created', actions: [{ type: 'add-label', value: 'x' }] });
    assert.equal(listAutomations(ws).length, 1);
    updateAutomation(ws, rule.id, { enabled: false });
    const w = createWorkItem(ws, { title: 'Z' });
    assert.deepEqual(w.labels, []); // disabled → no effect
    assert.equal(deleteAutomation(ws, rule.id), true);
    assert.equal(listAutomations(ws).length, 0);
  });
});
