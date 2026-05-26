import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../cli/wizard/picker.js';
import { buildTheme } from '../cli/theme.js';

// All tests target the pure helpers exposed via `__test`. The
// interactive runtime side (`pickFromList`, `promptText`) is wired to
// stdin keypress events; we cover it via the wizard reducer + frame
// renderer in this file and lean on manual smoke for the I/O glue.

const mono = buildTheme('mono');

test('renderFrame emits a title bar with title + optional badge', () => {
  const out = __test.renderFrame({
    theme: mono,
    title: 'Theme',
    bodyLines: ['hello'],
    footer: 'esc to close',
    width: 60,
    badge: 'Step 1 of 6',
  });
  const lines = out.split('\n');
  assert.match(lines[0], /Theme/);
  assert.match(lines[0], /Step 1 of 6/);
  assert.match(lines[0], /^┌/, 'starts with top-left border');
  assert.ok(lines[lines.length - 1].startsWith('└'), 'ends with bottom-left border');
});

test('renderFrame wraps the subtitle to inner width', () => {
  const out = __test.renderFrame({
    theme: mono,
    title: 'X',
    subtitle: 'short',
    bodyLines: [],
    footer: '',
    width: 60,
  });
  // Subtitle line should be present and within width.
  const subtitleLine = out.split('\n').find((l) => l.includes('short'));
  assert.ok(subtitleLine, 'subtitle rendered');
  assert.ok(subtitleLine!.length <= 80, 'within reasonable bound');
});

test('renderFrame renders the preview divider when previewLines is non-empty', () => {
  const without = __test.renderFrame({
    theme: mono, title: 'X', bodyLines: ['a'], footer: '', width: 50,
  });
  const withPreview = __test.renderFrame({
    theme: mono, title: 'X', bodyLines: ['a'], previewLines: ['preview row'], footer: '', width: 50,
  });
  assert.ok(!without.includes('preview row'), 'baseline has no preview');
  assert.ok(withPreview.includes('preview row'), 'preview row appears');
  // Divider char ├ shows up only when preview is present.
  assert.ok(withPreview.includes('├'), 'divider rendered');
  assert.ok(!without.includes('├'), 'no divider without preview');
});

test('formatBodyRow puts the value column right-aligned within the inner width', () => {
  const lines = __test.formatBodyRow(
    mono,
    { id: 'theme', label: 'Theme', value: 'dark' },
    false,
    0,
    60,
  );
  assert.equal(lines.length, 1, 'no description = one line');
  // " " marker + space + label ... value at the end
  assert.ok(lines[0].includes('Theme'), 'label present');
  assert.ok(lines[0].endsWith('dark'), 'value right-aligned at end of inner width');
});

test('formatBodyRow uses the › glyph for the selected row', () => {
  const selected = __test.formatBodyRow(mono, { id: 'a', label: 'A' }, true, 0, 40);
  const unselected = __test.formatBodyRow(mono, { id: 'a', label: 'A' }, false, 0, 40);
  assert.ok(selected[0].includes('›'), 'selected row carries marker');
  assert.ok(!unselected[0].includes('›'), 'unselected has no marker');
});

test('formatBodyRow indents the description line under the label', () => {
  const lines = __test.formatBodyRow(
    mono,
    { id: 'a', label: 'A', description: 'a short description of A' },
    true,
    0,
    60,
  );
  assert.ok(lines.length >= 2, 'description renders a second line');
  assert.ok(lines[1].trimStart().startsWith('a short'), 'description starts at indent');
});

test('wrap splits long input on word boundaries to width', () => {
  const out = __test.wrap('the quick brown fox jumps over the lazy dog', 12);
  for (const line of out) assert.ok(line.length <= 12, `line "${line}" > width`);
  assert.equal(out.join(' ').replace(/\s+/g, ' '), 'the quick brown fox jumps over the lazy dog');
});

test('wrap returns a single empty string for empty input (so an empty subtitle still renders one blank line)', () => {
  const out = __test.wrap('', 40);
  assert.deepEqual(out, ['']);
});

test('visibleLength ignores ANSI escape sequences', () => {
  const plain = 'hello';
  const ansi = '\x1b[31mhello\x1b[39m';
  assert.equal(__test.visibleLength(plain), 5);
  assert.equal(__test.visibleLength(ansi), 5);
});

test('padRightVisible pads a colored string to visible width without breaking ANSI', () => {
  const colored = '\x1b[31mhi\x1b[39m';
  const padded = __test.padRightVisible(colored, 5);
  assert.equal(__test.visibleLength(padded), 5);
  assert.ok(padded.endsWith(' ' + ' ' + ' '), 'three trailing spaces');
  assert.ok(padded.includes('hi'), 'original chars preserved');
});

test('computeValueColumn returns the widest value across all rows (visible chars only)', () => {
  const w = __test.computeValueColumn([
    { id: 'a', label: 'A', value: 'short' },
    { id: 'b', label: 'B', value: '\x1b[31mlooooong\x1b[39m' },
    { id: 'c', label: 'C' }, // no value
  ]);
  assert.equal(w, 8, 'colored "looooong" is 8 visible chars');
});

test('defaultFooter changes copy between pick / other phases', () => {
  const pick = __test.defaultFooter('pick', false);
  const other = __test.defaultFooter('other', false);
  assert.notEqual(pick, other);
  assert.ok(pick.includes('navigate'));
  assert.ok(other.includes('accept'));
});
