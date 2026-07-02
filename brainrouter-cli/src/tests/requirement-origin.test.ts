import test from 'node:test';
import assert from 'node:assert/strict';
import { originLabel, originTag } from '../cli/commands/requirement/index.js';

test('requirement origin labels distinguish automatic records without cluttering manual lists', () => {
  assert.equal(originLabel({ origin: 'auto' }), 'auto');
  assert.equal(originLabel({}), 'manual');
  assert.match(originTag({ origin: 'auto' }), /auto/);
  assert.equal(originTag({}), '');
});
