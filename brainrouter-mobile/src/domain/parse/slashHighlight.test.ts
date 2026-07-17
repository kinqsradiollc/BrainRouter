import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizedCommandToken } from './slashHighlight.js';
import type { DeskCommand } from '../commands/commands.js';

const cmd = (base: string): DeskCommand => ({ cmd: base, base, desc: '', category: 'test', wire: { kind: 'cli-only' } as never });
const COMMANDS: DeskCommand[] = [cmd('/goal'), cmd('/config'), cmd('/export-chat')];
// Stand-in for the popup's prefix matches; the function only reads `.length`.
const matches = (n: number): DeskCommand[] => COMMANDS.slice(0, n);

test('no highlight when the draft is not a slash command', () => {
  assert.equal(recognizedCommandToken('hello world', false, [], COMMANDS), null);
  assert.equal(recognizedCommandToken('', false, [], COMMANDS), null);
});

test('while typing the token, highlights only when the popup has a prefix match', () => {
  // slashActive + matches → the partial token lights up
  assert.equal(recognizedCommandToken('/go', true, matches(1), COMMANDS), '/go');
  // slashActive but zero matches (unknown command) → no highlight
  assert.equal(recognizedCommandToken('/zzz', true, [], COMMANDS), null);
  // popup dismissed (slashActive false) → no highlight even with matches
  assert.equal(recognizedCommandToken('/go', false, matches(1), COMMANDS), null);
});

test('with an argument, highlights only the EXACT command token', () => {
  assert.equal(recognizedCommandToken('/goal do a comparison', false, [], COMMANDS), '/goal');
  assert.equal(recognizedCommandToken('/export-chat md ~/out', false, [], COMMANDS), '/export-chat');
  // a leading slash that is NOT a real command (e.g. dictation) stays plain
  assert.equal(recognizedCommandToken('/notes to self', false, [], COMMANDS), null);
});

test('command match is case-insensitive', () => {
  assert.equal(recognizedCommandToken('/GOAL ship it', false, [], COMMANDS), '/GOAL');
});
