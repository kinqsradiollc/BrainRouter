import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNotebookEdit } from '../agent/fs/notebookEdit.js';

function nb(): string {
  return JSON.stringify({
    cells: [
      { cell_type: 'code', metadata: {}, execution_count: 3, outputs: [{ x: 1 }], source: ['print(1)\n'] },
      { cell_type: 'markdown', metadata: {}, source: ['# title\n'] },
    ],
    metadata: { kernelspec: { name: 'python3' } },
    nbformat: 4,
    nbformat_minor: 5,
  });
}

test('replace overwrites a cell source and preserves notebook metadata', () => {
  const { content, cells } = applyNotebookEdit(nb(), { editMode: 'replace', cellIndex: 0, source: 'print(42)\nprint(43)' });
  const out = JSON.parse(content);
  assert.equal(cells, 2);
  assert.deepEqual(out.cells[0].source, ['print(42)\n', 'print(43)']);
  assert.equal(out.cells[0].cell_type, 'code'); // unchanged
  assert.equal(out.nbformat, 4);
  assert.deepEqual(out.metadata.kernelspec, { name: 'python3' });
});

test('replace can change the cell type and normalizes code fields', () => {
  const out = JSON.parse(applyNotebookEdit(nb(), { editMode: 'replace', cellIndex: 1, cellType: 'code', source: 'x=1' }).content);
  assert.equal(out.cells[1].cell_type, 'code');
  assert.deepEqual(out.cells[1].outputs, []);
  assert.equal(out.cells[1].execution_count, null);
});

// ADR-051 D2 — a code cell's outputs describe its OLD source; a replace clears them.
test('replace of a code cell clears its now-stale outputs and execution_count', () => {
  const out = JSON.parse(applyNotebookEdit(nb(), { editMode: 'replace', cellIndex: 0, source: 'print(42)' }).content);
  assert.equal(out.cells[0].cell_type, 'code');
  assert.deepEqual(out.cells[0].outputs, [], 'stale outputs cleared'); // was [{ x: 1 }]
  assert.equal(out.cells[0].execution_count, null, 'execution_count reset'); // was 3
});

test('replace turning a code cell into markdown sheds outputs and execution_count', () => {
  const out = JSON.parse(applyNotebookEdit(nb(), { editMode: 'replace', cellIndex: 0, cellType: 'markdown', source: '# note' }).content);
  assert.equal(out.cells[0].cell_type, 'markdown');
  assert.ok(!('outputs' in out.cells[0]), 'markdown cells have no outputs field');
  assert.ok(!('execution_count' in out.cells[0]), 'markdown cells have no execution_count field');
});

test('insert adds a cell at the index and shifts the rest', () => {
  const out = JSON.parse(applyNotebookEdit(nb(), { editMode: 'insert', cellIndex: 1, cellType: 'markdown', source: '## new' }).content);
  assert.equal(out.cells.length, 3);
  assert.equal(out.cells[1].cell_type, 'markdown');
  assert.deepEqual(out.cells[1].source, ['## new']);
  assert.deepEqual(out.cells[2].source, ['# title\n']); // shifted down
});

test('insert with no index appends; defaults to a code cell', () => {
  const out = JSON.parse(applyNotebookEdit(nb(), { editMode: 'insert', source: 'y=2' }).content);
  assert.equal(out.cells.length, 3);
  assert.equal(out.cells[2].cell_type, 'code');
});

test('delete removes the cell', () => {
  const out = JSON.parse(applyNotebookEdit(nb(), { editMode: 'delete', cellIndex: 0 }).content);
  assert.equal(out.cells.length, 1);
  assert.equal(out.cells[0].cell_type, 'markdown');
});

test('out-of-range index and bad JSON throw', () => {
  assert.throws(() => applyNotebookEdit(nb(), { editMode: 'replace', cellIndex: 9, source: 'x' }), /out of range/);
  assert.throws(() => applyNotebookEdit(nb(), { editMode: 'delete', cellIndex: -1 }), /out of range/);
  assert.throws(() => applyNotebookEdit('not json', { editMode: 'replace', cellIndex: 0, source: 'x' }), /not valid JSON/);
  assert.throws(() => applyNotebookEdit('{"foo":1}', { editMode: 'replace', cellIndex: 0, source: 'x' }), /no "cells"/);
});
