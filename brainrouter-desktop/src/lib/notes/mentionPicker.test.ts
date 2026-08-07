/**
 * ADR-029 E4/E5 — what `@` writes, and that it can address more than a page.
 *
 * E5 is the row that would be quietly dropped: a mention picker that only
 * offers pages passes every editor test and copies the limitation Part A exists
 * to remove. So the candidate list is asserted across four modes, and the
 * written syntax is asserted to be an ID rather than a title.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineMentions } from '@kinqs/brainrouter-core/notes/editing';
import { applyMentionPick, mentionCandidates, mentionTrigger } from './mentionPicker.js';

test('@ opens at the start of a block and after a space, and not inside an address', () => {
  assert.deepEqual(mentionTrigger('@br', 3), { at: 0, query: 'br', as: 'mention' });
  assert.deepEqual(mentionTrigger('blocked by @BR', 14), { at: 11, query: 'BR', as: 'mention' });
  // Otherwise every email address in a note opens a picker.
  assert.equal(mentionTrigger('mail me@example.test', 20), null);
});

test('[[ opens the page picker, and is checked before the @ inside it', () => {
  assert.deepEqual(mentionTrigger('[[rel', 5), { at: 0, query: 'rel', as: 'page' });
  assert.deepEqual(mentionTrigger('[[@rel', 6), { at: 0, query: '@rel', as: 'page' });
});

test('a picked target is written as an id, never as a title', () => {
  // `[[Some page]]` resolves by title: renaming the page breaks every mention
  // of it, and two pages with one name are the same link.
  const written = applyMentionPick('blocked by @BR', { at: 11, query: 'BR', as: 'mention' }, {
    uri: 'brainrouter://track/work-item/BR-114', label: 'BR-114',
  }, 14);
  assert.equal(written.text, 'blocked by @[BR-114](brainrouter://track/work-item/BR-114)');
  assert.deepEqual(inlineMentions(written.text), ['brainrouter://track/work-item/BR-114']);
  assert.equal(written.caret, written.text.length, 'the caret belongs after what was inserted');
});

test('the page picker writes a reference too, so a renamed page keeps its links', () => {
  const written = applyMentionPick('see [[rel', { at: 4, query: 'rel', as: 'page' }, {
    uri: 'brainrouter://notes/block/blk_9', label: 'Release checklist',
  }, 9);
  assert.equal(written.text, 'see @[Release checklist](brainrouter://notes/block/blk_9)');
});

test('a label with syntax in it is escaped, so a work item called **BR-1** is not bold', () => {
  const written = applyMentionPick('@', { at: 0, query: '', as: 'mention' }, {
    uri: 'brainrouter://track/work-item/BR-1', label: '**BR-1**',
  }, 1);
  assert.match(written.text, /\\\*\\\*BR-1\\\*\\\*/);
});

test('E5: the candidates span the workspace, not only the notes', () => {
  const rows = mentionCandidates({
    pages: [{ id: 'blk_1', title: 'Release checklist' }],
    // E3 — a database is a container a person opens like a page, and it is not
    // in the page list. Left out, the thing a workspace is organised around is
    // the one thing `@` cannot name.
    databases: [{ id: 'blk_7', title: 'Release tracker' }],
    planner: [{ id: 'itm_4', title: 'Release the parser', completed: true }],
    workItems: [{ id: 'wi_9', key: 'BR-114', title: 'Release blocker' }],
    meetings: [{ id: 'mtg_5', title: 'Release review' }],
  }, 'release');

  assert.deepEqual(rows.map((row) => row.mode), ['page', 'database', 'planner', 'work item', 'meeting']);
  assert.deepEqual(rows.map((row) => row.uri), [
    'brainrouter://notes/block/blk_1',
    'brainrouter://notes/block/blk_7',
    'brainrouter://planner/item/itm_4',
    'brainrouter://track/work-item/BR-114',
    'brainrouter://meetings/meeting/mtg_5',
  ]);
  // A3 — the state travels with the resolved label, so a completed task reads
  // as completed in the picker as well as in the chip.
  assert.match(rows[2]!.label, /^✓/);
});

test('candidates rank the way the slash menu does, so the same keys behave the same', () => {
  const rows = mentionCandidates({
    pages: [
      { id: 'a', title: 'Weekly notes' },
      { id: 'b', title: 'Notes on parsing' },
    ],
  }, 'notes');
  assert.deepEqual(rows.map((row) => row.uri), ['brainrouter://notes/block/b', 'brainrouter://notes/block/a']);
});
