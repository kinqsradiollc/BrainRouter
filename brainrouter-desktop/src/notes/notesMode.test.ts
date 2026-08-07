/**
 * ADR-029 — the Notes mode, and the claim that a person can actually get to it.
 *
 * ADR-028's whole lesson was that a surface can exist, compile, pass tests and
 * be unreachable. A mode is reachable only when FOUR separate things are true,
 * and three of them fail silently:
 *
 *   - the `WorkspaceMode` union has the member (a type error otherwise — loud),
 *   - the `MODES` table has a row, or no button renders,
 *   - `MainContent`'s mode chain has a branch, or the final `else` renders Chat
 *     and the mode looks like it "did not switch",
 *   - `theme.css` gives the surface `flex: 1`, or it renders in a narrow column
 *     with the rest of the window dead black — the defect the planner shipped.
 *
 * The host half has the same shape: a query registered in one handler map and
 * not the other compiles and answers "unknown query" on the surface that lacks
 * it, which is how the planner ended up blank in the browser harness.
 *
 * The view-model tests below are behaviour; these are reachability, and they
 * are asserted at the source because the components are hook-heavy and cannot
 * be rendered outside React here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  backlinkNote, canEdit, conflictBanner, indentFor, MAX_VISUAL_DEPTH, pendingRefLabel,
  readOnlyReason, repairNote, sendTargetsFor, visibleBlocks, type NoteBlockView,
} from '../lib/notes/notesView.js';

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

function block(over: Partial<NoteBlockView> = {}): NoteBlockView {
  return {
    id: 'blk_1', parentId: null, depth: 0, kind: 'paragraph', text: 'a line',
    checked: false, level: null, hasChildren: false, refs: [], conflictFields: [],
    lockedBy: null, ...over,
  };
}

/* ------------------------------------------------------------ reachability */

test('the Notes mode is reachable: the union, the button, the branch and the width all exist', () => {
  const activityBar = source('../components/layout/ActivityBar.tsx');
  assert.match(activityBar, /WorkspaceMode = .*'notes'/, 'the mode is not in the WorkspaceMode union');
  // The buttons map over MODES, not over the union, so a union member with no
  // row here compiles and renders no button at all.
  assert.match(activityBar, /\['notes', 'note', 'Notes'\]/, 'no MODES row, so no button renders');

  const mainContent = source('../App/layout/MainContent.tsx');
  assert.match(mainContent, /mode === 'notes' \?/, 'no branch — the mode chain would fall through to Chat');
  assert.match(mainContent, /<NotesModeContainer/, 'the branch renders something other than the mode');

  const css = source('../theme.css');
  // `.workrow` is a flex ROW: without `flex: 1` the surface sizes to its
  // content and renders about half the window wide.
  assert.match(css, /\.notes-mode \{[^}]*flex: 1/, 'the surface has no flex rule and will render narrow');

  const icons = source('../icons.tsx');
  assert.match(icons, /^\s*note:/m, 'the MODES row names an icon that does not exist, so the button is blank');
});

test('both handler maps answer for Notes — a query in only one is unreachable on the other surface', () => {
  const host = source('../../electron/host/queries.ts');
  const dev = source('../devBridge/queries.ts');
  for (const name of [
    'notes-read', 'notes-create', 'notes-update', 'notes-delete', 'notes-move', 'notes-sync',
    'notes-begin-edit', 'notes-keep-edit', 'notes-end-edit', 'notes-resolve',
    'workspace-create', 'workspace-link', 'workspace-describe', 'workspace-resolve',
  ]) {
    assert.match(host, new RegExp(`'${name}'`), `the electron host has no ${name} handler`);
    assert.match(dev, new RegExp(`'${name}'`), `the dev bridge has no ${name} handler`);
  }
});

test('C2: every cross-mode move is wired to something a person can press', () => {
  // Each row of C2's table, asserted at the surface that owns the gesture.
  const chatRow = source('../chat/MessageRow.tsx');
  assert.match(chatRow, /title="Save to notes"/, 'Chat → Notes has no control');
  assert.match(chatRow, /title="Add to planner"/, 'Chat → Planner has no control');

  const renderHelpers = source('../App/render/renderHelpers.tsx');
  // The button existing is not the same as it being connected: this is the
  // layer where ADR-028's six unreachable definitions were lost.
  assert.match(renderHelpers, /onSaveToNotes=\{\(text\) => void captureToNotes\(/);
  assert.match(renderHelpers, /onAddToPlanner=\{\(text\) => void captureToPlanner\(/);

  const notesMode = source('./NotesMode.tsx');
  assert.match(notesMode, /ops\.sendTo\(block\.id, target\)/, 'Notes → Track/Planner has no control');
  assert.match(notesMode, /ops\.linkFile\(block\.id, p\)/, 'Notes → Code has no control');

  const notesContainer = source('./NotesModeContainer.tsx');
  assert.match(notesContainer, /'workspace-create'/, 'the notes menu creates nothing');
  assert.match(notesContainer, /'workspace-link'/, 'the created record is never cited back');

  const planner = source('../planner/PlannerMode.tsx');
  assert.match(planner, /ops\.openNotesPage\(/, 'Planner → Notes has no control');
  assert.match(source('../planner/PlannerModeContainer.tsx'), /openNotesPage: \(itemId, title, notes\)/);

  const meetings = source('../components/meetings/MeetingsView.tsx');
  assert.match(meetings, /captureToPlanner\(action\.title/, 'Meetings → Planner has no control');
  assert.match(meetings, /summaryToNotes\(\)/, 'Meetings → Notes has no control');

  const review = source('../panels/review/ReviewPanel.tsx');
  assert.match(review, /findingToNote\(f\)/, 'Code → Notes has no control');
});

/* -------------------------------------------------------------- behaviour */

test('a block another device is editing is read-only WITH the attribution, not silently disabled', () => {
  const locked = block({ lockedBy: 'Being edited on another device' });
  assert.equal(canEdit(locked), false);
  // The reason is what makes the lock information rather than a fault.
  assert.equal(readOnlyReason(locked), 'Being edited on another device');
  assert.equal(canEdit(block()), true);
});

test('a divider refuses text rather than accepting it and discarding it', () => {
  assert.equal(canEdit(block({ kind: 'divider' })), false);
  assert.match(String(readOnlyReason(block({ kind: 'divider' }))), /holds no text/);
});

test('conflicts get a banner because they are the one state that cannot resolve itself', () => {
  assert.equal(conflictBanner([block()]), null);
  assert.match(String(conflictBanner([block({ conflictFields: ['text'] })])), /^One block/);
  assert.match(
    String(conflictBanner([block({ conflictFields: ['text'] }), block({ id: 'b2', conflictFields: ['kind'] })])),
    /^2 blocks/,
  );
});

test('an empty line offers no cross-mode move — a work item called "" is one someone has to delete', () => {
  assert.deepEqual(sendTargetsFor(block({ text: '   ' })), []);
  assert.equal(sendTargetsFor(block({ text: 'ship the parser' })).length, 2);
});

test('indentation saturates, so deep nesting stops eating the width the text needs', () => {
  assert.equal(indentFor(0), 0);
  assert.equal(indentFor(3), 54);
  assert.equal(indentFor(MAX_VISUAL_DEPTH + 40), indentFor(MAX_VISUAL_DEPTH));
});

test('a repaired block says why it moved, rather than looking like someone dragged it', () => {
  assert.match(repairNote({ blockId: 'b', reason: 'deleted_parent', claimedParentId: 'p' }), /was deleted/);
  assert.match(repairNote({ blockId: 'b', reason: 'missing_parent', claimedParentId: 'p' }), /has not arrived/);
  assert.match(repairNote({ blockId: 'b', reason: 'cycle', claimedParentId: 'p' }), /nested inside itself/);
});

test('a reference with no resolved label yet shows the address, not nothing', () => {
  // A3 makes the label a resolve rather than a stored copy, so there is a
  // moment with no label; a chip that renders empty and then pops into
  // existence reads as a glitch.
  assert.equal(pendingRefLabel('brainrouter://planner/item/itm_4f2a'), 'planner/item/itm_4f2a');
  assert.ok(pendingRefLabel(`brainrouter://code/file/${'a'.repeat(80)}.ts`).endsWith('…'));
});

test('an empty search shows everything; a search with no hits shows nothing', () => {
  const blocks = [block({ id: 'b1' }), block({ id: 'b2' })];
  // Collapsing "not searched" into "no matches" would make an empty search look
  // like an empty document, which is the wrong thing to conclude about it.
  assert.deepEqual(visibleBlocks(blocks, null).map((b) => b.id), ['b1', 'b2']);
  assert.deepEqual(visibleBlocks(blocks, new Set()).map((b) => b.id), []);
  assert.deepEqual(visibleBlocks(blocks, new Set(['b2'])).map((b) => b.id), ['b2']);
});

test('A2: "what links here" is a count with no entry at zero, so a block with no links says nothing', () => {
  assert.equal(backlinkNote(0), null);
  assert.equal(backlinkNote(-1), null);
  assert.equal(backlinkNote(1), '1 block links here');
  assert.equal(backlinkNote(4), '4 blocks link here');
});
