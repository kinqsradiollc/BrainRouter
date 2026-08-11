import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NOTE_BLOCK_KINDS } from './index.js';

const source = (name: string): string => readFileSync(
  new URL(`../../src/notes/${name}`, import.meta.url),
  'utf8',
);

test('the shared editor owns keyboard interpretation and returns gesture focus', () => {
  const editor = source('BlockEditor.tsx');
  const mode = source('NotesMode.tsx');

  assert.match(editor, /blockKeyIntent\(/, 'no key press is interpreted');
  assert.match(editor, /slashTrigger\(/, 'typing "/" opens nothing');
  assert.match(editor, /mentionTrigger\(/, 'typing "@" opens nothing');
  assert.match(editor, /onInputRule\(/, 'markdown markers never reach the host');
  assert.match(editor, /toggleInlineMark\(/, 'mark shortcuts transform nothing');
  assert.match(mode, /focusBlock\(outcome\?\.focusId/, 'gesture outcomes do not place the caret');
  assert.match(mode, /caretForColumn\(/, 'vertical navigation loses its visual column');
});

test('unsupported host effects stay optional and remove their controls', () => {
  const capabilities = source('capabilities.ts');
  const mode = source('NotesMode.tsx');
  const handle = source('BlockHandle.tsx');
  const row = source('BlockRow.tsx');

  assert.match(capabilities, /history\?: NotesHistoryCapability/);
  assert.match(capabilities, /images\?: NotesImageCapability/);
  assert.match(capabilities, /export\?: NotesExportCapability/);
  assert.match(mode, /\{history \? \(/, 'history controls render without a history capability');
  assert.match(handle, /action\.id !== 'copy-link' \|\| canCopyLink/);
  assert.match(row, /files\.length > 0 \? \(/, 'file-link control renders without host files');
  assert.match(row, /linkOpen && files\.length > 0/, 'file picker opens without host files');
});

test('shared Notes CSS owns responsive layout and semantic host fallbacks', () => {
  const css = source('notes.css');
  assert.match(css, /\.notes-mode \{[^}]*flex: 1/);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /--br-notes-text/);
  assert.match(css, /--br-color-text-primary/);
});

test('every Core block kind reaches one shared presentation route', () => {
  const editor = source('BlockEditor.tsx');
  const mode = source('NotesMode.tsx');
  const row = source('BlockRow.tsx');
  const tableView = source('tableView.ts');
  const css = source('notes.css');
  const proseEditor = row.includes("block.kind !== 'divider' && !rendersOwnSurface(block.kind)")
    && editor.includes('notes-text-${kind}');

  const presented: Record<(typeof NOTE_BLOCK_KINDS)[number], boolean> = {
    page: mode.includes("block.kind === 'page'") && mode.includes('<SubPageRow'),
    heading: proseEditor && css.includes('.notes-text-heading'),
    paragraph: proseEditor,
    bullet: row.includes("block.kind === 'bullet' || block.kind === 'numbered'"),
    numbered: row.includes("block.kind === 'bullet' || block.kind === 'numbered'"),
    todo: row.includes("block.kind === 'todo'"),
    toggle: row.includes("block.kind === 'toggle'") && row.includes('<ToggleTwisty'),
    quote: proseEditor && css.includes('.notes-text-quote'),
    callout: row.includes("block.kind === 'callout'") && row.includes('<CalloutFrame'),
    code: proseEditor && css.includes('.notes-text-code'),
    image: row.includes("block.kind === 'image'") && row.includes('<ImageBlock'),
    bookmark: row.includes("block.kind === 'bookmark'") && row.includes('<BookmarkBlock'),
    table: row.includes("block.kind === 'table'") && row.includes('<TableBlock'),
    'table-row': tableView.includes("block.kind === 'table-row'"),
    embed: row.includes("block.kind === 'embed'") && row.includes('<EmbedBlock'),
    synced: row.includes("block.kind === 'synced'") && row.includes('<SyncedBlock'),
    divider: row.includes("block.kind === 'divider'") && row.includes('<hr className="notes-divider"'),
    database: mode.includes("block.kind === 'database'") && mode.includes('<DatabaseBlock'),
  };

  for (const kind of NOTE_BLOCK_KINDS) {
    assert.equal(presented[kind], true, `${kind} has no shared Notes presentation route`);
  }
});
