/**
 * ADR-028 G6 — mode shells must FILL `.workrow`, not size to content.
 *
 * The bug this pins: `.workrow` is a flex ROW, and a mode child without
 * `flex` sizes to its content — so the planner rendered in a column about half
 * the window wide with the rest dead black, and Meetings did the same.
 *
 * It survived review because `height: 100%` made it look deliberate, and it
 * survived MY verification because I checked the calendar in a standalone
 * harness where it filled the viewport. A harness proves a component RENDERS.
 * It cannot prove the component FITS where it actually lives.
 *
 * So this asserts the CSS contract rather than a screenshot: every mode shell
 * declares `flex` and `min-width: 0`, which is what makes it fill a flex row
 * and shrink below its content instead of forcing the row wider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const NOTES_CSS = '../../packages/ui/src/notes/notes.css';

/** Every shell mounted directly inside `.workrow`, and the file declaring it. */
const MODE_SHELLS: ReadonlyArray<readonly [string, string]> = [
  ['.br-planner', '../../packages/ui/src/planner/planner.css'],
  ['.mv-shell', 'components/meetings/meetings.css'],
  // ADR-029 — Notes. Its shell is a flex ROW rather than a column, which makes
  // the rule matter twice: see the inner-column test below.
  ['.notes-mode', NOTES_CSS],
];

/**
 * Shells that are THEMSELVES a flex row, and the column inside them that has to
 * take the remaining width.
 *
 * The bug above, one level in. Notes puts a fixed-width sidebar beside the
 * page, so the page column is a flex child of a row for exactly the same
 * reason `.planner-mode` is — and without `flex: 1` it sizes to the longest
 * line on the page while the sidebar is pushed off the left edge, which looks
 * like a layout that broke rather than one that was never told to fill.
 */
const INNER_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ['.notes-mode', '.notes-page', NOTES_CSS],
];

function ruleFor(css: string, selector: string): string {
  // The first declaration block for this exact selector.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no rule found for ${selector}`);
  return m![1]!;
}

test('every mode shell declares flex — without it, it sizes to content', () => {
  for (const [selector, file] of MODE_SHELLS) {
    const rule = ruleFor(read(file), selector);
    assert.match(
      rule,
      /flex\s*:\s*1/,
      `${selector} must set flex:1 or it will leave half the window empty inside .workrow`,
    );
  }
});

test('every mode shell declares min-width: 0 — without it, it cannot shrink', () => {
  // A flex child defaults to min-width:auto, so wide content (a seven-day
  // calendar grid) forces the row wider than the window instead of scrolling
  // inside it.
  for (const [selector, file] of MODE_SHELLS) {
    const rule = ruleFor(read(file), selector);
    assert.match(rule, /min-width\s*:\s*0/, `${selector} must set min-width: 0`);
  }
});

test('.workrow is still a flex row — the premise these rules depend on', () => {
  // If this ever becomes a column, `flex: 1` on the children means something
  // different and these tests stop protecting anything.
  const rule = ruleFor(read('theme.css'), '.workrow');
  assert.match(rule, /display\s*:\s*flex/);
  assert.doesNotMatch(rule, /flex-direction\s*:\s*column/);
});

test('the asynchronous tooling notice stays above, not beside, the active mode', () => {
  // The notice resolves after startup. As a direct sibling of MainContent in
  // `.app` (a flex row), it consumed a horizontal column and pushed Planner
  // completely outside the viewport only after the visual gate had loaded.
  const app = read('App.tsx');
  assert.match(
    app,
    /<div className="app-main-stack">[\s\S]*<ToolingNotice\s*\/>[\s\S]*<MainContent/,
    'ToolingNotice and MainContent must remain in the shared vertical stack',
  );
  const stack = ruleFor(read('theme.css'), '.app-main-stack');
  assert.match(stack, /display\s*:\s*flex/);
  assert.match(stack, /flex-direction\s*:\s*column/);
  assert.match(stack, /flex\s*:\s*1/);
  assert.match(stack, /min-width\s*:\s*0/);
});

test('a shell that is itself a flex row gives its content column the same rules', () => {
  for (const [shell, column, file] of INNER_COLUMNS) {
    const css = read(file);
    const shellRule = ruleFor(css, shell);
    // The premise: if this shell ever becomes a column, `flex: 1` on the child
    // means something different and the assertion below stops protecting it.
    assert.match(shellRule, /flex-direction\s*:\s*row/, `${shell} is no longer a row`);

    const columnRule = ruleFor(css, column);
    assert.match(columnRule, /flex\s*:\s*1/, `${column} must set flex:1 or it sizes to its content`);
    assert.match(columnRule, /min-width\s*:\s*0/, `${column} must set min-width: 0 or a long line widens the row`);
  }
});

test('the notes sidebar is a fixed rail, not a flex child that fights the page', () => {
  // `flex: none` is what keeps the tree from shrinking to nothing when a page
  // holds a long unbroken line — the failure is that the sidebar's titles
  // collapse to ellipses one at a time as you type.
  const rule = ruleFor(read(NOTES_CSS), '.notes-sidebar');
  assert.match(rule, /flex\s*:\s*none/);
  assert.match(rule, /width\s*:/);
});

test('the shared planner list views keep a reading column', () => {
  // A text input spanning 1600px is unusable — you lose the start of the line
  // looking at the end of it. The calendar is deliberately exempt.
  const rule = ruleFor(read('../../packages/ui/src/planner/planner.css'), '.br-planner-scroll');
  assert.match(rule, /max-width/);
});

test('interactive planner source chips keep the compact 24px hit target', () => {
  const rule = ruleFor(read('../../packages/ui/src/planner/planner.css'), '.br-planner-source');
  assert.match(rule, /min-height\s*:\s*24px/);
});

test('a mode header reserves room for the floating control cluster above it', () => {
  // `.topbar-right` is position:absolute at z-66, so it sits ON TOP of whatever
  // header the current mode draws. A header whose right-aligned content runs to
  // the window edge therefore puts that content underneath the buttons — which
  // is what the planner's status line did, and what the notes header inherited
  // by copying its shape. Measured live: `.notes-sync` spanned x1125-1264 with
  // "Export session" at 1206 and "Settings" at 1238 directly over it.
  //
  // Asserted as a CSS contract for the same reason as the rules above: a
  // screenshot in a harness has no floating cluster to collide with, so the
  // collision is invisible exactly where it would be checked.
  const theme = read('theme.css');
  assert.match(theme, /--topbar-right-clearance\s*:/, 'the clearance is no longer declared once');
  for (const [header, file] of [
    ['.br-planner-header', '../../packages/ui/src/planner/planner.css'],
    ['.notes-head', NOTES_CSS],
  ] as const) {
    assert.match(
      ruleFor(read(file), header),
      /padding-right\s*:\s*calc\([^;]*--topbar-right-clearance/,
      `${header} does not reserve room, so its right-hand content renders under the toolbar`,
    );
  }
});
