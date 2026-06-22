import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNoteCommand } from '../runtime/exec/bangCommand.js';

test('parseNoteCommand: non-# input falls through', () => {
  assert.deepEqual(parseNoteCommand('hello'), { isNote: false, note: '' });
  assert.deepEqual(parseNoteCommand('/help'), { isNote: false, note: '' });
  assert.deepEqual(parseNoteCommand('! ls'), { isNote: false, note: '' });
});

test('parseNoteCommand: bare # → empty note (usage)', () => {
  assert.deepEqual(parseNoteCommand('#'), { isNote: true, note: '' });
  assert.deepEqual(parseNoteCommand('#   '), { isNote: true, note: '' });
});

test('parseNoteCommand: extracts + trims the note', () => {
  assert.deepEqual(parseNoteCommand('# deploys happen Fridays only '), { isNote: true, note: 'deploys happen Fridays only' });
  assert.deepEqual(parseNoteCommand('#no space'), { isNote: true, note: 'no space' });
});
