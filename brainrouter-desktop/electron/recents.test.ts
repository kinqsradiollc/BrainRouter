import test from 'node:test';
import assert from 'node:assert/strict';
import { addOpened, noteActivity, reorderWorkspace } from './recents.js';

const A = '/w/a', B = '/w/b', C = '/w/c';

test('opening a project that is already present does NOT reorder it', () => {
  // A is below B; "opening" A must keep A below B (the bug: it jumped to top).
  assert.deepEqual(addOpened([B, A], A), [B, A]);
});

test('opening a NEW project adds it at the bottom (no promotion)', () => {
  assert.deepEqual(addOpened([B, A], C), [B, A, C]);
});

test('opening is idempotent', () => {
  assert.deepEqual(addOpened([A, B], A), [A, B]);
});

test('activity keeps project order fixed', () => {
  assert.deepEqual(noteActivity([B, A, C], C, 10), [B, A, C]);
  assert.deepEqual(noteActivity([B, A], A), [B, A]);
});

test('activity on a brand-new project adds it at the bottom', () => {
  assert.deepEqual(noteActivity([A, B], C), [A, B, C]);
});

test('noteActivity dedupes and caps', () => {
  assert.deepEqual(noteActivity([A, A, B], A, 2), [A, B]);
  assert.equal(noteActivity(['1', '2', '3', '4'], '5', 3).length, 3);
});

test('addOpened never drops the just-opened project when over cap', () => {
  const full = ['1', '2', '3'];
  const out = addOpened(full, A, 3);
  assert.ok(out.includes(A), 'the opened project is present');
  assert.equal(out.length, 3);
  assert.equal(out[out.length - 1], A, 'opened lands at the bottom');
});

test('REGRESSION: opening A then B then viewing A keeps activity order (B above A) — opening A again must not promote it', () => {
  let list: string[] = [];
  list = addOpened(list, A);          // open A
  list = addOpened(list, B);          // open B
  list = noteActivity(list, B, 10);   // B gets activity, but ordering is fixed
  assert.deepEqual(list, [A, B]);
  list = addOpened(list, A);          // merely view/open A again
  assert.deepEqual(list, [A, B], 'viewing A did not move it');
});

test('reorderWorkspace moves a project before the drop target', () => {
  assert.deepEqual(reorderWorkspace([A, B, C], C, A), [C, A, B]);
  assert.deepEqual(reorderWorkspace([A, B, C], A, C), [B, A, C]);
});

test('reorderWorkspace is stable for unknown or same projects', () => {
  assert.deepEqual(reorderWorkspace([A, B], A, A), [A, B]);
  assert.deepEqual(reorderWorkspace([A, B], '/missing', A), [A, B]);
  assert.deepEqual(reorderWorkspace([A, B], A, '/missing'), [A, B]);
});
