import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveWorkflowGraph,
  loadWorkflowGraph,
  listWorkflowGraphs,
  deleteWorkflowGraph,
} from '../workflow/graphStore.js';
import type { WorkflowGraph } from '../workflow/graph.js';
import { withTempWorkspace } from './_helpers.js';

const graph = (name: string): WorkflowGraph => ({
  name,
  nodes: [{ id: 't', type: 'trigger' }, { id: 'o', type: 'output', data: { template: 'hi' } }],
  edges: [{ id: 'e', source: 't', target: 'o' }],
  vars: { topic: 'x' },
});

test('graphStore: save → list → load → delete', () => {
  withTempWorkspace((ws) => {
    assert.deepEqual(listWorkflowGraphs(ws), []);

    const meta = saveWorkflowGraph(ws, graph('My Flow'));
    assert.equal(meta.id, 'My_Flow'); // filename-sanitized
    assert.equal(meta.name, 'My Flow');
    assert.ok(meta.updatedAt);

    const list = listWorkflowGraphs(ws);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'My_Flow');

    const loaded = loadWorkflowGraph(ws, 'My_Flow')!;
    assert.equal(loaded.name, 'My Flow');
    assert.equal(loaded.nodes.length, 2);
    assert.deepEqual(loaded.vars, { topic: 'x' });

    assert.equal(deleteWorkflowGraph(ws, 'My_Flow'), true);
    assert.equal(deleteWorkflowGraph(ws, 'My_Flow'), false); // already gone
    assert.deepEqual(listWorkflowGraphs(ws), []);
    assert.equal(loadWorkflowGraph(ws, 'My_Flow'), null);
  });
});

test('graphStore: ids are sanitized (no traversal) and list is newest-first', () => {
  withTempWorkspace((ws) => {
    saveWorkflowGraph(ws, { ...graph('a'), id: '../escape/../../etc' });
    const list = listWorkflowGraphs(ws);
    assert.equal(list.length, 1);
    assert.ok(!list[0].id.includes('/') && !list[0].id.includes('.'), 'id is filesystem-safe');

    const g2 = saveWorkflowGraph(ws, graph('second'));
    const all = listWorkflowGraphs(ws);
    assert.equal(all.length, 2);
    assert.ok(all.map((a) => a.id).includes(g2.id), 'second graph is listed');
  });
});
