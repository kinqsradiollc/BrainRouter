import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffManifests } from './diff.js';
import type { UiMap } from '../types.js';

const mk = (els: Array<[string, 'button' | 'input', 'tap' | 'type']>): UiMap => ({
  version: 1,
  generatedAt: 'x',
  screens: [
    {
      id: 'login',
      title: 'Login',
      platform: 'web',
      route: '/login',
      elements: els.map(([id, type, action]) => ({ id, testID: id, type, action })),
    },
  ],
});

test('diff reports added, removed, and changed elements', () => {
  const prev = mk([
    ['a', 'button', 'tap'],
    ['b', 'input', 'type'],
  ]);
  const next = mk([
    ['a', 'input', 'type'], // changed type+action
    ['c', 'button', 'tap'], // added
  ]); // b removed
  const d = diffManifests(prev, next);
  assert.deepEqual(d.addedElements, ['login:c']);
  assert.deepEqual(d.removedElements, ['login:b']);
  assert.deepEqual(d.changedElements, ['login:a']);
});

test('diff detects added/removed screens against an undefined prior', () => {
  const next = mk([['a', 'button', 'tap']]);
  const d = diffManifests(undefined, next);
  assert.deepEqual(d.addedScreens, ['login']);
  assert.deepEqual(d.addedElements, ['login:a']);
  assert.deepEqual(d.removedScreens, []);
});
