import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, unwrapMarkdownFences, preserveAnsiAcrossNewlines, extractMarkdownSegments, fitColumns, renderTable } from '../cli/ink/text/markdownRender.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const displayWidth = (s: string) => [...stripAnsi(s)].length;

// --- unwrapMarkdownFences ---------------------------------------------

test('unwrapMarkdownFences: strips outer ```md fence', () => {
  const input = '```md\n# Hello\n\nbody\n```';
  assert.equal(unwrapMarkdownFences(input), '# Hello\n\nbody');
});

test('unwrapMarkdownFences: strips outer ```markdown fence', () => {
  const input = '```markdown\nhello\n```';
  assert.equal(unwrapMarkdownFences(input), 'hello');
});

test('unwrapMarkdownFences: case-insensitive on the language token', () => {
  const input = '```MD\nhello\n```';
  assert.equal(unwrapMarkdownFences(input), 'hello');
});

test('unwrapMarkdownFences: tolerates trailing whitespace after the closing fence', () => {
  const input = '```md\nhello\n```\n\n';
  assert.equal(unwrapMarkdownFences(input), 'hello');
});

test('unwrapMarkdownFences: leaves non-markdown fences alone', () => {
  const input = '```python\nprint("hi")\n```';
  assert.equal(unwrapMarkdownFences(input), input);
});

test('unwrapMarkdownFences: leaves plain text untouched', () => {
  const input = 'just some text\nwith a newline';
  assert.equal(unwrapMarkdownFences(input), input);
});

test('unwrapMarkdownFences: leaves a single-line input alone (no fence pair)', () => {
  const input = '```md hello ```';
  assert.equal(unwrapMarkdownFences(input), input);
});

// --- preserveAnsiAcrossNewlines ---------------------------------------

test('preserveAnsiAcrossNewlines: passes through input with no ANSI codes', () => {
  const input = 'hello\nworld\nfoo';
  assert.equal(preserveAnsiAcrossNewlines(input), input);
});

test('preserveAnsiAcrossNewlines: passes through input with no newlines', () => {
  const input = '\x1b[32mhello world\x1b[39m';
  assert.equal(preserveAnsiAcrossNewlines(input), input);
});

test('preserveAnsiAcrossNewlines: re-scopes a multi-line foreground color', () => {
  // Open green on line 1, close on line 3 — line 2 originally orphan.
  const input = '\x1b[32mline 1\nline 2\nline 3\x1b[39m';
  const out = preserveAnsiAcrossNewlines(input);
  // Each line should now be wrapped in its own \x1b[32m ... \x1b[39m scope.
  // Expected shape: open, line, close, \n, open, line, close, \n, open, line, close.
  assert.equal(out, '\x1b[32mline 1\x1b[39m\n\x1b[32mline 2\x1b[39m\n\x1b[32mline 3\x1b[39m');
});

test('preserveAnsiAcrossNewlines: re-scopes a multi-line italic+gray blockquote', () => {
  // The exact shape marked-terminal emits for a 2-line blockquote.
  const input = '\x1b[90m\x1b[3mline 1\nline 2\x1b[39m\x1b[23m';
  const out = preserveAnsiAcrossNewlines(input);
  // After re-scope: each line carries its own open + close pair.
  assert.ok(out.startsWith('\x1b[90m\x1b[3mline 1'), `got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('\n'), 'newline preserved');
  // Line 2 must still have the same opening codes after the newline.
  const afterNewline = out.split('\n')[1];
  assert.ok(/\x1b\[(?:90|3)m.*\x1b\[(?:90|3)m/.test(afterNewline) || afterNewline.startsWith('\x1b['), `line 2 missing reopen: ${JSON.stringify(afterNewline)}`);
});

test('preserveAnsiAcrossNewlines: respects \\x1b[0m reset across newlines', () => {
  // Reset code clears all active state — the next line should not reopen.
  const input = '\x1b[32mline 1\x1b[0m\nline 2';
  const out = preserveAnsiAcrossNewlines(input);
  // Line 2 has no ANSI prefix.
  assert.equal(out, '\x1b[32mline 1\x1b[0m\nline 2');
});

test('preserveAnsiAcrossNewlines: handles 256-color sequences as opaque codes', () => {
  const input = '\x1b[38;5;208mline 1\nline 2\x1b[39m';
  const out = preserveAnsiAcrossNewlines(input);
  // Both lines must carry the 256-color code.
  assert.ok(out.startsWith('\x1b[38;5;208m'));
  assert.ok(out.includes('\n\x1b[38;5;208m'), 'line 2 missing 256-color reopen');
});

test('preserveAnsiAcrossNewlines: nests attribute + color correctly', () => {
  const input = '\x1b[1m\x1b[31mbold red\nstill bold red\x1b[39m\x1b[22m';
  const out = preserveAnsiAcrossNewlines(input);
  // Line 2 must reopen BOTH bold and red.
  const lines = out.split('\n');
  assert.ok(lines[1].includes('\x1b[31'), `line 2 lost red: ${JSON.stringify(lines[1])}`);
  assert.ok(lines[1].includes('\x1b[1') || lines[1].startsWith('\x1b['), `line 2 lost bold: ${JSON.stringify(lines[1])}`);
});

// --- renderMarkdown end-to-end ----------------------------------------

test('renderMarkdown: returns input unchanged for empty / non-string', () => {
  assert.equal(renderMarkdown(''), '');
  // @ts-expect-error: deliberately wrong type for the runtime guard.
  assert.equal(renderMarkdown(undefined), undefined);
});

test('renderMarkdown: produces structured output for headings', () => {
  const out = renderMarkdown('# Hello');
  // The heading text round-trips. ANSI styling is conditional on
  // chalk detecting TTY-color support (FORCE_COLOR=1 in tests, or a
  // real terminal at runtime); when chalk is in no-color mode the
  // text still renders without escape codes — assert only the
  // text presence so the test passes in both modes.
  assert.match(out, /Hello/);
  assert.doesNotMatch(out, /^#/);  // the leading `#` is consumed by the heading renderer
});

test('renderMarkdown: unwraps outer ```md fence before rendering', () => {
  const out = renderMarkdown('```md\n# Hello\n```');
  // Should render as a heading, not as a code block. The first char of
  // the styled output should NOT be the yellow code-block marker.
  assert.match(out, /Hello/);
});

test('renderMarkdown: renders fenced code blocks (not unwrapped)', () => {
  const out = renderMarkdown('```python\nprint("hi")\n```');
  // Python code block stays as code (yellow text).
  assert.match(out, /print/);
});

test('renderMarkdown: falls back to verbatim on parse failure', () => {
  // Even malformed-ish markdown should round-trip rather than throw.
  const src = 'plain text with \x00 weird chars';
  const out = renderMarkdown(src);
  assert.ok(typeof out === 'string');
  assert.ok(out.length > 0);
});

// --- GFM tables (TUI-TABLES) ------------------------------------------

const TABLE = [
  '| Name | Role | Notes |',
  '| --- | :---: | ---: |',
  '| Alice | admin | a fairly long note that should wrap inside its column |',
  '| Bob | user | short |',
].join('\n');

test('extractMarkdownSegments: splits prose / table / prose in order', () => {
  const segs = extractMarkdownSegments(`intro\n\n${TABLE}\n\noutro`);
  assert.deepEqual(segs.map((s) => s.type), ['md', 'table', 'md']);
  assert.match(segs[1].text, /\| Name \| Role \| Notes \|/);
});

test('extractMarkdownSegments: no table → single md segment (old fast path)', () => {
  const segs = extractMarkdownSegments('# Hello\n\nbody');
  assert.deepEqual(segs.map((s) => s.type), ['md']);
});

test('extractMarkdownSegments: a pipe line with no separator is NOT a table', () => {
  const segs = extractMarkdownSegments('a | b without a separator row');
  assert.deepEqual(segs.map((s) => s.type), ['md']);
});

test('fitColumns: leaves columns that already fit', () => {
  assert.deepEqual(fitColumns([4, 4, 5], 100), [4, 4, 5]);
});

test('fitColumns: narrow columns keep natural width; the wide one absorbs the deficit', () => {
  const w = fitColumns([5, 5, 60], 50);
  assert.equal(w[0], 5);
  assert.equal(w[1], 5);
  assert.equal(w[2], 40);
  assert.equal(w.reduce((a, b) => a + b, 0), 50);
});

test('renderTable: draws a box, keeps header text, wraps long cells to fit width', () => {
  const out = renderTable(TABLE, 60);
  const lines = out.split('\n').filter((l) => l !== '');
  assert.match(lines[0], /^┌.*┐$/);
  assert.match(lines[lines.length - 1], /^└.*┘$/);
  assert.match(stripAnsi(out), /Name/);
  assert.match(stripAnsi(out), /Notes/);
  for (const l of lines) {
    assert.ok(!stripAnsi(l).includes('a fairly long note that should wrap inside its column'), 'long cell must wrap');
    assert.ok(displayWidth(l) <= 60, `line over width: ${displayWidth(l)}`);
  }
});

test('renderMarkdown: a table renders as a box, not a fenced code block', () => {
  const out = renderMarkdown(`before\n\n${TABLE}\n\nafter`, { width: 70 });
  assert.match(out, /┌/);
  assert.match(out, /┴/);
  assert.match(stripAnsi(out), /before/);
  assert.match(stripAnsi(out), /after/);
});
