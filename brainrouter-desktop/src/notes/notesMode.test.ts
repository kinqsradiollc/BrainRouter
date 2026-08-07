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
  backlinkNote, canEdit, conflictBanner, conflictLine, indentFor, MAX_VISUAL_DEPTH,
  pendingRefLabel, readOnlyReason, repairNote, sendTargetsFor, visibleBlocks,
  type NoteBlockView,
} from '../lib/notes/notesView.js';

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

function block(over: Partial<NoteBlockView> = {}): NoteBlockView {
  return {
    id: 'blk_1', parentId: null, depth: 0, kind: 'paragraph', text: 'a line',
    checked: false, level: null, hasChildren: false, refs: [], conflicts: [],
    lockedBy: null, title: null, icon: null, cover: null, favourite: false, ...over,
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
    // C2 row 6 — the picker's symbol list. Registered on one surface only, the
    // symbol step is an empty list in the harness and looks like a broken read.
    'code-symbols',
    // E1 — the gestures. The host served these before anything called them;
    // a name missing from the harness is a keystroke that does nothing in the
    // browser and gets debugged as a renderer bug.
    'notes-split', 'notes-merge-back', 'notes-duplicate', 'notes-move-up', 'notes-move-down',
    'notes-indent', 'notes-outdent', 'notes-input-rule', 'notes-slash-menu',
    // E3 — the database verbs. The host served all thirteen before anything
    // called them, and the harness had none: the five views would have rendered
    // "unknown query" in the browser while working in the app, which is the
    // failure this whole test exists to catch.
    'notes-database-read', 'notes-database-create', 'notes-database-list',
    'notes-database-add-row', 'notes-database-set-value', 'notes-database-remove-row',
    'notes-database-add-property', 'notes-database-update-property',
    'notes-database-remove-property', 'notes-database-reorder-properties',
    'notes-database-save-view', 'notes-database-remove-view', 'notes-property-catalog',
  ]) {
    assert.match(host, new RegExp(`'${name}'`), `the electron host has no ${name} handler`);
    assert.match(dev, new RegExp(`'${name}'`), `the dev bridge has no ${name} handler`);
  }
});

/* ------------------------------------------------------ E1: the keyboard */

test('E1: every editing gesture has a caller from a real key press, not only a handler', () => {
  // ADR-029 §5 judges this layer on E1's sentence, and ADR-028 E1 exists to
  // catch exactly this shape of failure: the host served `notes-input-rule` and
  // `notes-slash-menu` for a release while nothing in the renderer called
  // either, so the model supported the gestures and the keyboard did not.
  const editor = source('./BlockEditor.tsx');
  const container = source('./NotesModeContainer.tsx');
  const mode = source('./NotesMode.tsx');

  // The keyboard reaches the judgement…
  assert.match(editor, /blockKeyIntent\(/, 'no key press is interpreted');
  assert.match(editor, /slashTrigger\(/, 'typing "/" opens nothing');
  assert.match(editor, /mentionTrigger\(/, 'typing "@" opens nothing');
  assert.match(editor, /onInputRule\(/, 'the markdown markers are never asked about');
  assert.match(editor, /toggleInlineMark\(/, 'the mark shortcuts transform nothing');

  // …and the judgement reaches core, through the host.
  for (const [op, query] of [
    ['splitBlock', 'notes-split'], ['mergeBack', 'notes-merge-back'],
    ['duplicate', 'notes-duplicate'], ['moveUp', 'notes-move-up'],
    ['indent', 'notes-indent'], ['outdent', 'notes-outdent'],
  ] as const) {
    assert.match(container, new RegExp(`${op}: \\(id.*'${query}'`), `${op} does not call ${query}`);
  }
  assert.match(container, /'notes-input-rule'/, 'the input rules are decided in the renderer');
  assert.match(container, /'notes-slash-menu'/, 'the slash menu is a second list in the renderer');

  // The gesture's OUTCOME moves the caret. A split that works and leaves the
  // caret behind fails the parity test as surely as one that does nothing.
  assert.match(mode, /focusBlock\(outcome\?\.focusId/, 'the caret is not placed after a gesture');
  assert.match(mode, /caretForColumn\(/, 'the arrows do not preserve the column');
});

test('E1: Enter mid-word leaves the head able to recognise its own truncation', () => {
  // The gesture reached core and the store held ["sec", "ond line"], and the
  // head still showed "second line" — permanently, because the truncation is
  // the only change the `text` prop ever makes and it arrives while the block
  // that was split still has focus. One more keystroke in that line pushed the
  // pre-split text back and the tail became a duplicate.
  const editor = source('./BlockEditor.tsx');
  assert.match(editor, /expected: splitExpectation\.current/, 'the head cannot recognise its own split');
  assert.match(
    editor,
    /splitExpectation\.current = draftRef\.current\.slice\(0, caret\)/,
    'nothing records what a cut at the caret leaves behind',
  );
  // BOTH routes, or the gesture repairs itself when typed one way and corrupts
  // the block when typed the other: a keydown this editor prevents never
  // becomes the `insertParagraph` the same file also handles.
  assert.match(editor, /case 'split':\s*\n\s*event\.preventDefault\(\);\s*\n\s*askForSplit\(/, 'the key route does not');
  assert.match(editor, /'insertParagraph'\)[\s\S]{0,120}askForSplit\(selection\.start\)/, 'the input route does not');
});

test('E4: the block editor renders marks, and the textarea that could not is gone', () => {
  const editor = source('./BlockEditor.tsx');
  assert.match(editor, /contentEditable=\{!readOnly\}/, 'the surface cannot render inline marks');
  assert.match(editor, /parseInlineMarks|inlineSegments/, 'nothing parses the marks for rendering');
  assert.doesNotMatch(source('./BlockRow.tsx'), /<textarea/, 'a textarea shows raw markdown');
  // B2 — the lease survives the restructuring: read-only WITH the attribution.
  assert.match(source('./BlockRow.tsx'), /readOnly=\{!editable\}/, 'a leased block became editable');
  assert.match(source('./BlockRow.tsx'), /\{locked \? <div className="notes-locked">/, 'the attribution is gone');
});

test('E4/E5: the handle, the selection and the pickers are wired to something a person can press', () => {
  const row = source('./BlockRow.tsx');
  assert.match(row, /<BlockHandle/, 'no block handle renders');
  assert.match(source('./BlockHandle.tsx'), /draggable/, 'the handle cannot be dragged');
  assert.match(row, /onDragStart=\{\(event\)/, 'a drag from the handle reaches nothing');
  assert.match(source('./NotesMode.tsx'), /blockDropIntent\(/, 'a drag decides nothing');
  assert.match(source('./NotesMode.tsx'), /selectedBlockIds\(/, 'multi-block selection is not applied');
  // E5 — a mention can address a planner item, a work item or a meeting.
  assert.match(source('./NotesModeContainer.tsx'), /mentionCandidates\(sources, query\)/);
  assert.match(source('./NotesModeContainer.tsx'), /'planner-read'[\s\S]{0,400}'track-items'/);
  assert.match(source('./NotesModeContainer.tsx'), /createMeetingsOps\(\)\.list\(\)/, 'a mention cannot address a meeting');
});

test('C2: every cross-mode move is wired to something a person can press', () => {
  // Each row of C2's table, asserted at the surface that owns the gesture.
  const chatRow = source('../chat/MessageRow.tsx');
  assert.match(chatRow, /title="Save to notes"/, 'Chat → Notes has no control');
  assert.match(chatRow, /title="Add to planner"/, 'Chat → Planner has no control');

  const renderHelpers = source('../App/render/renderHelpers.tsx');
  // The button existing is not the same as it being connected: this is the
  // layer where ADR-028's six unreachable definitions were lost.
  assert.match(renderHelpers, /onSaveToNotes=\{capture\('notes', captureToNotes\)\}/);
  assert.match(renderHelpers, /onAddToPlanner=\{capture\('your planner', captureToPlanner\)\}/);
  // …and connected is not the same as ANSWERED: the result used to be
  // discarded, so a refusal created nothing and looked like success.
  assert.match(renderHelpers, /kind: outcome\.ok \? 'status' : 'error'/, 'a failed capture says nothing');

  // The row moved out of `NotesMode` when a block became an editing surface
  // rather than a textarea; the gestures it owns are asserted where they live.
  const blockRow = source('./BlockRow.tsx');
  assert.match(blockRow, /ops\.sendTo\(block\.id, target\)/, 'Notes → Track/Planner has no control');
  assert.match(blockRow, /ops\.linkFile\(block\.id, p, symbol\)/, 'Notes → Code has no control');
  // C2 row 6 names a file OR a symbol; a kind with no writer is unreachable.
  assert.match(blockRow, /ops\.loadSymbols\(p\)/, 'the picker cannot offer a symbol');
  assert.match(source('./NotesModeContainer.tsx'), /codeSymbolUri\(relPath, symbol\)/, 'no symbol reference is ever written');

  const notesContainer = source('./NotesModeContainer.tsx');
  assert.match(notesContainer, /'workspace-create'/, 'the notes menu creates nothing');
  assert.match(notesContainer, /'workspace-link'/, 'the created record is never cited back');

  const planner = source('../planner/PlannerMode.tsx');
  assert.match(planner, /ops\.openNotesPage\(/, 'Planner → Notes has no control');
  assert.match(source('../planner/PlannerModeContainer.tsx'), /openNotesPage: \(itemId, title, notes\)/);
  // A1 — one rendering of a reference, or two surfaces disagree about what a
  // link looks like: the planner used to leave the raw URI in its prose.
  assert.match(planner, /<RefText text=\{n\.notes/, 'the planner renders a reference as plain text');
  assert.match(blockRow, /<RefChip key=\{uri\}/, 'notes stopped using the shared chip');
  assert.match(
    source('../App/layout/MainContent.tsx'),
    /<PlannerModeContainer[^\n]*onOpenRef=\{openWorkspaceRef\}/,
    'a planner chip has nowhere to open to',
  );

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
  const conflicted = (id: string) => block({ id, conflicts: [{ field: 'text', reason: 'concurrent_text' }] });
  assert.equal(conflictBanner([block()]), null);
  assert.match(String(conflictBanner([conflicted('b1')])), /^One block/);
  assert.match(String(conflictBanner([conflicted('b1'), conflicted('b2')])), /^2 blocks/);
});

test('a fenced conflict reads differently from a concurrent one, because the causes differ', () => {
  // B2's second departure from migration 048: a refusal has to say WHICH
  // refusal. "Two people typed at once" asks someone to choose between two
  // intentions; "your device wrote under a lock it no longer held" explains why
  // the sentence on screen is not the one they typed — and without that the app
  // looks like it lost their work rather than like it kept both copies.
  const concurrent = conflictLine({ field: 'text', reason: 'concurrent_text' });
  const stale = conflictLine({ field: 'text', reason: 'fenced_stale_epoch' });

  assert.match(concurrent, /two places at once/);
  assert.match(stale, /reissued/);
  assert.notEqual(concurrent, stale);
  assert.match(conflictLine({ field: 'text', reason: 'fenced_blocked' }), /Another device was editing/);
  assert.match(conflictLine({ field: 'text', reason: 'fenced_lease_expired' }), /had expired/);
});

test('a reason this build does not know still renders a line rather than taking the page down', () => {
  // The renderer cannot import core's union — the notes barrel reaches the
  // filesystem — so a newer server can send a reason this build has never seen.
  assert.match(conflictLine({ field: 'level', reason: 'something_new' }), /“level”/);
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
