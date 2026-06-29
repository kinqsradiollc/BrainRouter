import test from 'node:test';
import assert from 'node:assert/strict';
import { indexPrsByBranch, prStatusFor, prStatusLabel } from './prStatus.js';

const rows = [
  { number: 1, state: 'OPEN', headRefName: 'feat/a', isDraft: false, mergeable: 'MERGEABLE' },
  { number: 2, state: 'OPEN', headRefName: 'feat/draft', isDraft: true },
  { number: 3, state: 'OPEN', headRefName: 'feat/conflict', mergeable: 'CONFLICTING' },
  { number: 4, state: 'MERGED', headRefName: 'feat/merged' },
  { number: 5, state: 'CLOSED', headRefName: 'feat/closed' },
];

test('prStatusFor: maps every state', () => {
  const by = indexPrsByBranch(rows);
  assert.equal(prStatusFor('feat/a', by)?.status, 'open');
  assert.equal(prStatusFor('feat/draft', by)?.status, 'draft');
  assert.equal(prStatusFor('feat/conflict', by)?.status, 'conflict');
  assert.equal(prStatusFor('feat/merged', by)?.status, 'merged');
  assert.equal(prStatusFor('feat/closed', by)?.status, 'closed');
});

test('prStatusFor: null when no branch or no matching PR', () => {
  const by = indexPrsByBranch(rows);
  assert.equal(prStatusFor(null, by), null);
  assert.equal(prStatusFor(undefined, by), null);
  assert.equal(prStatusFor('feat/none', by), null);
});

test('indexPrsByBranch: prefers the OPEN PR when a branch has both', () => {
  const by = indexPrsByBranch([
    { number: 9, state: 'CLOSED', headRefName: 'feat/x' },
    { number: 10, state: 'OPEN', headRefName: 'feat/x', isDraft: false, mergeable: 'MERGEABLE' },
  ]);
  assert.equal(prStatusFor('feat/x', by)?.pr.number, 10);
  assert.equal(prStatusFor('feat/x', by)?.status, 'open');
});

test('prStatusLabel: covers all', () => {
  assert.equal(prStatusLabel('open'), 'Open');
  assert.equal(prStatusLabel('conflict'), 'Conflict');
  assert.equal(prStatusLabel('merged'), 'Merged');
});
