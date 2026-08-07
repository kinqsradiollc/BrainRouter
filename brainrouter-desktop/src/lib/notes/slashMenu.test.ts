/**
 * ADR-029 E1 — `/` opens the menu, and does not open it the rest of the time.
 *
 * The second half is the one that decides whether people keep the feature: a
 * command menu that appears inside `and/or`, a date, or every pasted path is a
 * menu you learn to type around. So the trigger is pinned against the text
 * people actually write, not only against the happy case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSlashTrigger, slashPlan, slashTrigger, type SlashCommandDto } from './slashMenu.js';

const command = (over: Partial<SlashCommandDto> & { kind: string }): SlashCommandDto =>
  ({ id: over.id ?? over.kind, label: over.label ?? over.kind, hint: '', ...over });

test('a slash at the start of a block opens the menu and filters as you type', () => {
  assert.deepEqual(slashTrigger('/', 1), { at: 0, query: '' });
  assert.deepEqual(slashTrigger('/head', 5), { at: 0, query: 'head' });
});

test('a slash after a space opens it too, because that is where a command is typed', () => {
  assert.deepEqual(slashTrigger('some words /tod', 15), { at: 11, query: 'tod' });
});

test('a slash inside a word is a slash', () => {
  // `and/or`, `4/8`, and every path anyone pastes.
  assert.equal(slashTrigger('and/or', 6), null);
  assert.equal(slashTrigger('see src/lib/notes', 17), null);
  assert.equal(slashTrigger('4/8 and 5/9', 11), null);
});

test('a space after the slash ends it, and a long run is not a command', () => {
  assert.equal(slashTrigger('/heading one', 12), null);
  assert.equal(slashTrigger(`/${'x'.repeat(40)}`, 41), null);
});

test('picking consumes the marker; closing the menu leaves it as typed text', () => {
  // Escape does not call this at all — the person may have been typing a
  // fraction, and eating their `/` would be the editor taking a character away.
  const cleared = clearSlashTrigger('write /head here', { at: 6, query: 'head' });
  assert.equal(cleared.text, 'write  here');
  assert.equal(cleared.caret, 6);
});

test('a prose command converts the block and keeps the words', () => {
  assert.deepEqual(
    slashPlan(command({ kind: 'heading', level: 2 }), 'the section title'),
    { action: 'set-kind', kind: 'heading', level: 2 },
  );
  assert.deepEqual(slashPlan(command({ kind: 'todo' }), ''), { action: 'set-kind', kind: 'todo' });
});

test('a command with no prose arrives as a new block rather than deleting the line', () => {
  // Converting a written line into a divider would delete the sentence the
  // command was typed at the end of.
  assert.deepEqual(
    slashPlan(command({ kind: 'divider' }), 'already written'),
    { action: 'create-after', kind: 'divider' },
  );
  assert.deepEqual(slashPlan(command({ kind: 'divider' }), '   '), { action: 'set-kind', kind: 'divider' });
});

test('a page is created and opened rather than typed into here', () => {
  assert.deepEqual(slashPlan(command({ kind: 'page' }), ''), { action: 'create-page' });
});
