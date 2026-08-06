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

/** Every shell mounted directly inside `.workrow`, and the file declaring it. */
const MODE_SHELLS: ReadonlyArray<readonly [string, string]> = [
  ['.planner-mode', 'theme.css'],
  ['.mv-shell', 'components/meetings/meetings.css'],
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

test('the planner list views keep a reading column', () => {
  // A text input spanning 1600px is unusable — you lose the start of the line
  // looking at the end of it. The calendar is deliberately exempt.
  const rule = ruleFor(read('theme.css'), '.planner-body');
  assert.match(rule, /max-width/);
});
