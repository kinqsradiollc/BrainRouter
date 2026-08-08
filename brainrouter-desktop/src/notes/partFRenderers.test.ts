/**
 * ADR-029 F1 — every kind the slash menu offers is drawn as that kind.
 *
 * This is the defect Part F is named for, written as a test so it cannot come
 * back: `Toggle`, `Callout`, `Image`, `Bookmark` and `Table` were all in the
 * catalog and every one of them inserted a block that rendered as a plain line
 * of text. The command existed, the kind was stored, the merge was correct — and
 * choosing "Image" gave you an empty paragraph.
 *
 * So the assertion is not "the component compiles". It is ADR-028 E1's rule
 * applied to what the UI advertises: for every entry in the catalog, name the
 * place that DRAWS it. A kind that reaches nothing but the shared text editor,
 * with no marker, no frame and no styling of its own, fails here — which is
 * exactly the state five of them were shipped in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SLASH_CATALOG } from '@kinqs/brainrouter-core/notes/editing';
import { rendersOwnSurface } from '../lib/notes/notesView.js';

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

const blockRow = source('./BlockRow.tsx');
const notesMode = source('./NotesMode.tsx');
// Part F's rules ship with the Notes chunk rather than with the app's initial
// stylesheet — see the file's own header. `theme.css` still owns the styling
// that the shared editor gets by kind.
const theme = source('../theme.css');
const partFStyles = source('../styles/surfaces/notesBlocks.css');

/**
 * Where each offered kind is drawn, and what proves it.
 *
 * Every row names a real thing in a real file. "The model supports it" is not
 * built (§5), and neither is "the component exists" — the evidence has to be the
 * route a person's click actually takes.
 */
const DRAWN_BY: Record<string, { by: string; evidence: RegExp; where: string }> = {
  paragraph: { by: 'the shared editor', evidence: /<BlockEditor/, where: 'BlockRow.tsx' },
  heading: { by: 'a CSS size rule on the editor', evidence: /\.notes-text-heading/, where: 'theme.css' },
  quote: { by: 'a CSS rule on the editor', evidence: /\.notes-text-quote/, where: 'theme.css' },
  code: { by: 'a CSS rule on the editor', evidence: /\.notes-text-code/, where: 'theme.css' },
  bullet: { by: 'a gutter marker', evidence: /notes-marker/, where: 'BlockRow.tsx' },
  numbered: { by: "core's ordinal in a gutter marker", evidence: /block\.ordinal/, where: 'BlockRow.tsx' },
  todo: { by: 'a checkbox', evidence: /type="checkbox"/, where: 'BlockRow.tsx' },
  divider: { by: 'a rule', evidence: /notes-divider/, where: 'BlockRow.tsx' },
  toggle: { by: 'a disclosure triangle that folds its children', evidence: /<ToggleTwisty/, where: 'BlockRow.tsx' },
  callout: { by: 'an icon and a tinted panel', evidence: /<CalloutFrame/, where: 'BlockRow.tsx' },
  image: { by: 'the image surface', evidence: /<ImageBlock/, where: 'BlockRow.tsx' },
  bookmark: { by: 'the bookmark card', evidence: /<BookmarkBlock/, where: 'BlockRow.tsx' },
  table: { by: 'the grid', evidence: /<TableBlock/, where: 'BlockRow.tsx' },
  embed: { by: 'the live resolved target', evidence: /<EmbedBlock/, where: 'BlockRow.tsx' },
  // F3's "one block, many places, one truth". This row is the one that was
  // missing: the entry was in the catalog, `syncedBlock.ts` knew what a mirror
  // was, and the row fell through to the prose editor — F1's defect committed on
  // the kind Part F itself added.
  synced: { by: 'the mirrored source’s own rows', evidence: /<SyncedBlock/, where: 'BlockRow.tsx' },
  page: { by: 'a sub-page row', evidence: /<SubPageRow/, where: 'NotesMode.tsx' },
  database: { by: 'the database surface', evidence: /<DatabaseBlock/, where: 'NotesMode.tsx' },
};

const FILES: Record<string, string> = {
  'BlockRow.tsx': blockRow,
  'NotesMode.tsx': notesMode,
  'theme.css': theme,
};

test('F1 — every kind the slash menu offers has a renderer that draws it', () => {
  for (const command of SLASH_CATALOG) {
    const drawn = DRAWN_BY[command.kind];
    assert.ok(
      drawn,
      `"${command.label}" inserts a ${command.kind} block and nothing in this test claims to draw one. `
      + 'A menu entry whose block has no renderer is the F1 defect.',
    );
    const file = FILES[drawn.where]!;
    assert.match(
      file, drawn.evidence,
      `"${command.label}" is drawn by ${drawn.by} in ${drawn.where}, and that is no longer there.`,
    );
  }
});

test('F1 — the five that regressed are routed to their own component, not to the text editor', () => {
  // Named individually rather than left to the loop above, because these are the
  // exact five §F1 records as having been offered and inert. A future edit that
  // deletes one route would otherwise only fail a generic assertion.
  for (const [kind, component] of [
    ['toggle', 'ToggleTwisty'],
    ['callout', 'CalloutFrame'],
    ['image', 'ImageBlock'],
    ['bookmark', 'BookmarkBlock'],
    ['table', 'TableBlock'],
  ] as const) {
    assert.match(blockRow, new RegExp(`import \\{[^}]*${component}[^}]*\\} from`), `${kind} lost its renderer import`);
    assert.match(blockRow, new RegExp(`<${component}`), `${kind}'s renderer is imported but never rendered`);
  }
});

test('a block whose text is an ADDRESS never gets a prose editor over it', () => {
  // The kinds whose `text` is a location rather than a sentence. An editor
  // over one would offer marks, a slash menu and a split to a value that has no
  // use for any of them — and `holdsProse` in core already refuses to merge a
  // paragraph into one, so the two answers agree by construction.
  for (const kind of ['image', 'bookmark', 'embed', 'table', 'synced']) {
    assert.equal(rendersOwnSurface(kind), true);
  }
  // Named on its own because it is the one that regressed: a `synced` block's
  // text is a `brainrouter://` address, and leaving it off this list is exactly
  // what put a contenteditable over a URI.
  assert.equal(rendersOwnSurface('synced'), true);
  assert.match(blockRow, /rendersOwnSurface\(block\.kind\)/);
  // ...and the caret skips them, or an arrow key would land nowhere.
  assert.match(notesMode, /!rendersOwnSurface\(candidate\.kind\)/);
});

test('the fold, the table and the search are applied where the page is built', () => {
  // The page must not build its body from a shortened list, which is the shape
  // the "a folded parent lost my text" bug takes.
  assert.match(notesMode, /bodyRows\(body, matchIds\)/);
  assert.match(notesMode, /import \{ bodyRows \} from '\.\.\/lib\/notes\/blockVisibility\.js'/);
});

test('the callout reuses the page header\'s icon picker rather than forking one', () => {
  const shells = source('./BlockShells.tsx');
  const header = source('./PageHeader.tsx');
  const picker = source('./IconPicker.tsx');
  for (const file of [shells, header]) {
    assert.match(file, /from '\.\/IconPicker\.js'/);
  }
  // The palette itself still comes from the one place that defines it, so the
  // two call sites cannot offer different glyphs for the same field.
  assert.match(picker, /PAGE_ICON_CHOICES/);
  assert.doesNotMatch(shells, /PAGE_ICON_CHOICES/, 'a second palette in the callout would be the fork this avoids');
});

test('F3 — a synced block reaches a resolver and an export reaches a writer', () => {
  // The renderer is only half of it: F1's rule is that the entry is REAL where a
  // person meets it, and a mirror that never asked the host what it shows would
  // draw an empty frame. Both routes are named end to end so a later edit that
  // deletes one fails here rather than in somebody's page.
  const container = source('./NotesModeContainer.tsx');
  assert.match(container, /'notes-synced-read'/, 'the mirror has no host route');
  assert.match(container, /'notes-export'/, 'the export has no host route');
  assert.match(source('./SyncedBlock.tsx'), /ops\.readSynced\(blockId\)/);
  // The mirrored row's editor is bound to the SOURCE's id — that is the whole
  // of "editing either place edits the one block", and binding it to the
  // mirror's id would silently make it a copy.
  assert.match(source('./SyncedBlock.tsx'), /blockId=\{row\.id\}/);
  assert.match(source('./PageHeader.tsx'), /ops\.exportPage\(view\.pageId!, choice\.format\)/);
});

test('the new surfaces are styled, so none of them renders as an unstyled block', () => {
  for (const rule of [
    '.notes-callout', '.notes-twisty', '.notes-image-frame', '.notes-bookmark-card',
    '.notes-grid', '.notes-embed-card', '.notes-synced', '.notes-synced-row',
  ]) {
    assert.ok(partFStyles.includes(rule), `${rule} has no styling, so its block renders unframed`);
  }
  // Monochrome: Part F introduces no colour of its own. Every value it adds is
  // one of the existing tokens.
  assert.doesNotMatch(
    partFStyles, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/,
    'Part F must not add a colour — the design language is a border, a tint and a weight',
  );
});

test('Part F pays for itself: its styles ship with the Notes chunk, not with the app', () => {
  // The initial stylesheet is budgeted, and Parts A–E had left 875 bytes under
  // that budget. Importing these rules from anywhere eagerly would put ~7KB back
  // into the app's first paint for a mode most sessions never open.
  const container = source('./NotesModeContainer.tsx');
  assert.match(container, /import '\.\.\/styles\/surfaces\/notesBlocks\.css'/);
  assert.doesNotMatch(theme, /notesBlocks\.css/, 'the shared sheet must not pull the lazy one back in');
  const mainContent = source('../App/layout/MainContent.tsx');
  assert.match(mainContent, /lazy\(\(\)[\s\S]{0,160}NotesModeContainer/, 'the chunk carrying these styles stopped being lazy');
});
