import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureProject,
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  listWorkItems,
  listLabels,
  upsertLabel,
  getLabel,
  deleteLabel,
  setWorkItemArchived,
} from '../track/trackStore.js';
import { withTempWorkspace } from './_helpers.js';

test('multi-assignee: assignees is the source of truth; assignee mirrors the first', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const a = createWorkItem(ws, { title: 'Pair work', assignees: ['ann', 'bob', 'ann'] });
    assert.deepEqual(a.assignees, ['ann', 'bob']); // deduped
    assert.equal(a.assignee, 'ann'); // mirror

    // legacy single-assignee input folds into assignees
    const b = createWorkItem(ws, { title: 'Solo', assignee: 'cara' });
    assert.deepEqual(b.assignees, ['cara']);
    assert.equal(b.assignee, 'cara');

    // updating assignees re-syncs the mirror + logs activity
    const updated = updateWorkItem(ws, a.key, { assignees: ['bob'] })!;
    assert.deepEqual(updated.assignees, ['bob']);
    assert.equal(updated.assignee, 'bob');
    assert.ok(updated.activity.some((e) => e.field === 'assignees'));

    // a legacy assignee patch also updates assignees
    const legacy = updateWorkItem(ws, b.key, { assignee: 'dan' })!;
    assert.deepEqual(legacy.assignees, ['dan']);
  });
});

test('multi-assignee: list filter matches membership', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    createWorkItem(ws, { title: 'X', assignees: ['ann', 'bob'] });
    createWorkItem(ws, { title: 'Y', assignees: ['bob'] });
    createWorkItem(ws, { title: 'Z', assignees: ['cara'] });
    assert.equal(listWorkItems(ws, { assignee: 'bob' }).length, 2);
    assert.equal(listWorkItems(ws, { assignee: 'ann' }).length, 1);
  });
});

test('labels: created items auto-register into the project registry with a color', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    createWorkItem(ws, { title: 'Tagged', labels: ['memory', 'cli'] });
    const labels = listLabels(ws);
    assert.deepEqual(labels.map((l) => l.name).sort(), ['cli', 'memory']);
    assert.ok(labels.every((l) => /^#[0-9a-f]{6}$/i.test(l.color)));
    // a second item reusing a label does not duplicate the registry entry
    createWorkItem(ws, { title: 'Tagged 2', labels: ['memory'] });
    assert.equal(listLabels(ws).filter((l) => l.name === 'memory').length, 1);
  });
});

test('labels: upsert sets a custom color; delete strips the label from items', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const item = createWorkItem(ws, { title: 'Bug', labels: ['urgent'] });
    const lbl = upsertLabel(ws, { name: 'urgent', color: '#ff0000', description: 'drop everything' });
    assert.equal(lbl.color, '#ff0000');
    assert.equal(getLabel(ws, 'urgent')?.description, 'drop everything');
    assert.equal(getLabel(ws, lbl.id)?.name, 'urgent'); // lookup by id too

    assert.equal(deleteLabel(ws, 'urgent'), true);
    assert.equal(getLabel(ws, 'urgent'), undefined);
    assert.deepEqual(getWorkItem(ws, item.key)!.labels, []); // stripped from the item
    assert.equal(deleteLabel(ws, 'urgent'), false); // already gone
  });
});

test('archive: archived items drop out of the default list but persist', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const a = createWorkItem(ws, { title: 'Keep' });
    const b = createWorkItem(ws, { title: 'Shelve' });
    setWorkItemArchived(ws, b.key, true);
    assert.equal(listWorkItems(ws).length, 1); // archived excluded by default
    assert.equal(listWorkItems(ws, { includeArchived: true }).length, 2);
    assert.ok(getWorkItem(ws, b.key)!.archivedAt); // still present, just flagged
    // restore
    setWorkItemArchived(ws, b.key, false);
    assert.equal(listWorkItems(ws).length, 2);
    assert.equal(getWorkItem(ws, a.key)!.archivedAt, undefined);
  });
});
