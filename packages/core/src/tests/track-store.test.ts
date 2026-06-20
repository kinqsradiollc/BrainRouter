import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkItem, isTrackProject } from '@kinqs/brainrouter-types';
import {
  ensureProject,
  getProject,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  transitionWorkItem,
  addComment,
  linkWorkItem,
  deleteWorkItem,
  createSprint,
  listSprints,
  setSprintState,
  createBoard,
  listBoards,
  boardView,
} from '../track/trackStore.js';
import { withTempWorkspace } from './_helpers.js';

test('ensureProject: creates a valid project + default board, idempotent', () => {
  withTempWorkspace((ws) => {
    const p = ensureProject(ws, { name: 'BrainRouter', key: 'br' });
    assert.ok(isTrackProject(p));
    assert.equal(p.key, 'BR'); // uppercased
    assert.equal(p.keyCounter, 1);
    assert.ok(p.workflowStates.length >= 3 && p.issueTypes.length >= 4);
    assert.equal(ensureProject(ws).id, p.id); // same project on second call
    assert.equal(listBoards(ws).length, 1); // default board created once
  });
});

test('createWorkItem: mints sequential keys, resolves category, seeds activity', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const a = createWorkItem(ws, { title: 'First', type: 'story', actor: 'agent' });
    const b = createWorkItem(ws, { title: 'Second', type: 'bug', priority: 'high' });
    assert.ok(isWorkItem(a) && isWorkItem(b));
    assert.equal(a.key, 'BR-1');
    assert.equal(b.key, 'BR-2');
    assert.equal(a.statusCategory, 'todo'); // default first state → todo
    assert.equal(a.activity[0].field, 'created');
    assert.equal(a.activity[0].actor, 'agent');
    assert.equal(b.priority, 'high');
    assert.equal(getProject(ws)!.keyCounter, 3);
  });
});

test('getWorkItem: by id and by human key', () => {
  withTempWorkspace((ws) => {
    const a = createWorkItem(ws, { title: 'X' });
    assert.equal(getWorkItem(ws, a.id)?.id, a.id);
    assert.equal(getWorkItem(ws, a.key)?.id, a.id);
    assert.equal(getWorkItem(ws, 'nope'), undefined);
  });
});

test('updateWorkItem + transition: status change recomputes category + logs activity', () => {
  withTempWorkspace((ws) => {
    const a = createWorkItem(ws, { title: 'Move me' });
    const moved = transitionWorkItem(ws, a.key, 'in-review', 'agent')!;
    assert.equal(moved.status, 'in-review');
    assert.equal(moved.statusCategory, 'in-progress');
    const statusEntry = moved.activity.find((e) => e.field === 'status');
    assert.ok(statusEntry && statusEntry.to === 'in-review' && statusEntry.actor === 'agent');
    const done = transitionWorkItem(ws, a.key, 'done')!;
    assert.equal(done.statusCategory, 'done');
    // invalid transition throws
    assert.throws(() => transitionWorkItem(ws, a.key, 'nonsense'), /Unknown workflow state/);
  });
});

test('listWorkItems: filters by type, category, assignee, and text', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    createWorkItem(ws, { title: 'Build board', type: 'story', assignee: 'ann' });
    const bug = createWorkItem(ws, { title: 'Fix crash', type: 'bug', assignee: 'bob' });
    transitionWorkItem(ws, bug.key, 'done');
    assert.equal(listWorkItems(ws, { type: 'bug' }).length, 1);
    assert.equal(listWorkItems(ws, { statusCategory: 'done' }).length, 1);
    assert.equal(listWorkItems(ws, { assignee: 'ann' }).length, 1);
    assert.equal(listWorkItems(ws, { text: 'crash' }).length, 1);
    assert.equal(listWorkItems(ws, { text: 'BR-' }).length, 2); // key match
  });
});

test('comments + links: append + dedup provenance', () => {
  withTempWorkspace((ws) => {
    const a = createWorkItem(ws, { title: 'Linkable' });
    addComment(ws, a.key, 'ann', 'looks good');
    const linked = linkWorkItem(ws, a.key, {
      codeLinks: [{ kind: 'branch', ref: 'feat/x' }, { kind: 'branch', ref: 'feat/x' }],
      linkedMemoryIds: ['mem_1', 'mem_1', 'mem_2'],
    })!;
    assert.equal(linked.comments.length, 1);
    assert.equal(linked.codeLinks.length, 1); // deduped
    assert.deepEqual(linked.linkedMemoryIds, ['mem_1', 'mem_2']);
  });
});

test('deleteWorkItem: removes the item', () => {
  withTempWorkspace((ws) => {
    const a = createWorkItem(ws, { title: 'Temp' });
    assert.equal(deleteWorkItem(ws, a.key), true);
    assert.equal(getWorkItem(ws, a.key), undefined);
    assert.equal(deleteWorkItem(ws, a.key), false);
  });
});

test('sprints + board view: state transitions + column grouping', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const sp = createSprint(ws, { name: 'Sprint 1', goal: 'ship Track' });
    assert.equal(sp.state, 'future');
    assert.equal(setSprintState(ws, sp.id, 'active')!.state, 'active');
    assert.equal(listSprints(ws).length, 1);

    const todo = createWorkItem(ws, { title: 'Todo item' });
    const doing = createWorkItem(ws, { title: 'Doing item' });
    transitionWorkItem(ws, doing.key, 'in-progress');
    const board = createBoard(ws, { name: 'Sprint board', type: 'scrum' });
    const view = boardView(ws, board.id);
    const todoCol = view.find((c) => c.column === 'To Do');
    const doingCol = view.find((c) => c.column === 'In Progress');
    assert.ok(todoCol!.items.some((w) => w.id === todo.id));
    assert.ok(doingCol!.items.some((w) => w.id === doing.id));
  });
});
