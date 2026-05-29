import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBangCommand } from '../runtime/bangCommand.js';

test('PARITY-B1 parseBangCommand: non-bang input falls through', () => {
  assert.deepEqual(parseBangCommand('hello world'), { isBang: false, command: '' });
  assert.deepEqual(parseBangCommand('/status'), { isBang: false, command: '' });
  assert.deepEqual(parseBangCommand('what is !important'), { isBang: false, command: '' });
});

test('PARITY-B1 parseBangCommand: extracts + trims the command', () => {
  assert.deepEqual(parseBangCommand('!git status'), { isBang: true, command: 'git status' });
  assert.deepEqual(parseBangCommand('! git status'), { isBang: true, command: 'git status' });
  assert.deepEqual(parseBangCommand('!   ls -la   '), { isBang: true, command: 'ls -la' });
});

test('PARITY-B1 parseBangCommand: bare bang is a bang with empty command (caller shows usage)', () => {
  assert.deepEqual(parseBangCommand('!'), { isBang: true, command: '' });
  assert.deepEqual(parseBangCommand('!   '), { isBang: true, command: '' });
});
