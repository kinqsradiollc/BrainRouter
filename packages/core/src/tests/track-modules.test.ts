import test from 'node:test';
import assert from 'node:assert/strict';
import { isModule, isModuleStatus, isWorkItemLinkType } from '@kinqs/brainrouter-types';
import {
  ensureProject,
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  listWorkItems,
  createModule,
  listModules,
  getModule,
  updateModule,
  setModuleArchived,
  deleteModule,
} from '../track/trackStore.js';
import { withTempWorkspace } from './_helpers.js';

test('modules: create, list, lookup by name, status update', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const m = createModule(ws, { name: 'Recall pipeline', lead: 'ann' });
    assert.ok(isModule(m));
    assert.equal(m.status, 'planned'); // default
    assert.equal(getModule(ws, 'recall pipeline')?.id, m.id); // case-insensitive name lookup
    assert.equal(listModules(ws).length, 1);

    const updated = updateModule(ws, 'Recall pipeline', { status: 'in-progress' })!;
    assert.equal(updated.status, 'in-progress');
    assert.ok(isModuleStatus('paused') && !isModuleStatus('shipped'));
  });
});

test('modules: assign items, filter by module, delete clears the link', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const m = createModule(ws, { name: 'Search' });
    const a = createWorkItem(ws, { title: 'A', moduleId: m.id });
    const b = createWorkItem(ws, { title: 'B' });
    updateWorkItem(ws, b.key, { moduleId: m.id });
    createWorkItem(ws, { title: 'C' }); // unassigned

    assert.equal(listWorkItems(ws, { moduleId: m.id }).length, 2);
    assert.equal(getWorkItem(ws, a.key)!.moduleId, m.id);

    // deleting the module unassigns every item that referenced it
    assert.equal(deleteModule(ws, 'Search'), true);
    assert.equal(getWorkItem(ws, a.key)!.moduleId, undefined);
    assert.equal(getWorkItem(ws, b.key)!.moduleId, undefined);
    assert.equal(listModules(ws).length, 0);
  });
});

test('modules: archived modules drop out of the default list', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const m = createModule(ws, { name: 'Legacy' });
    createModule(ws, { name: 'Active' });
    setModuleArchived(ws, m.id, true);
    assert.equal(listModules(ws).length, 1);
    assert.equal(listModules(ws, { includeArchived: true }).length, 2);
    setModuleArchived(ws, m.id, false);
    assert.equal(listModules(ws).length, 2);
  });
});

test('relations: the extended link types are recognized', () => {
  for (const t of ['start-before', 'start-after', 'finish-before', 'finish-after', 'implements', 'implemented-by']) {
    assert.ok(isWorkItemLinkType(t), `${t} should be a valid link type`);
  }
  assert.ok(!isWorkItemLinkType('supersedes'));
});
