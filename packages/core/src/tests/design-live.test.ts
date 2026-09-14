/**
 * ADR-056 D-B5 — the browser-driven half of live variants: the brief the
 * `/design live` turn starts from names the picked element, the count, the
 * source hint when there is one, and the one job (locate in source, wrap
 * through the tool, never by hand); the descriptor and scan normalisers bound
 * what the browser reports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liveVariantPrompt, normalizeLiveTarget, parseLiveScan, clampVariantCount, describeLiveTarget, LIVE_VARIANT_LIMITS, type LiveVariantTarget,
} from '../design/index.js';

const TARGET: LiveVariantTarget = {
  selector: 'main > header > h1.hero',
  tag: 'h1',
  text: 'Ship faster',
  classes: ['hero', 'hero--display'],
  elementId: 'headline',
  outerHtml: '<h1 class="hero hero--display" id="headline">Ship faster</h1>',
  hint: { file: 'src/pages/Landing.tsx', line: 42, framework: 'react' },
};

test('B5 liveVariantPrompt names the element, count, hint, and the tool-only rule; bounded', () => {
  const p = liveVariantPrompt({ target: TARGET, action: 'bolder', count: 3 });
  assert.match(p, /3 bolder variant\(s\)/);
  assert.match(p, /h1\.hero\.hero--display#headline/);
  assert.match(p, /“Ship faster”/);
  assert.match(p, /Source hint: src\/pages\/Landing\.tsx:42 \(react\) — start there\./);
  assert.match(p, /design_variants \{op:"wrap", file, start, end, variants:\[…3…\], action:"bolder"\}/);
  assert.match(p, /never write the display:contents wrapper by hand/);
  assert.match(p, /Print the session id/);
  assert.match(p, /never wrap the wrong node/);
  assert.ok(p.length <= LIVE_VARIANT_LIMITS.promptChars);
});

test('B5 the prompt degrades honestly with no hint, sanitises the action, and clamps the count', () => {
  const noHint = liveVariantPrompt({ target: { ...TARGET, hint: undefined }, action: 'make it POP!! <script>', count: 99 });
  assert.match(noHint, /No source hint from the framework — search the workspace/);
  assert.match(noHint, /6 make it POP script variant\(s\)/); // clamped to max, punctuation stripped ('<script>' → ' script')
  assert.doesNotMatch(noHint, /<script>/);
  const tiny = liveVariantPrompt({ target: TARGET, action: '', count: 0 });
  assert.match(tiny, /asked for 1 variant\(s\) of it/); // count floored to min; the generic 'variant' action is not doubled
  assert.equal(clampVariantCount(4), 4);
  assert.equal(clampVariantCount(-2), LIVE_VARIANT_LIMITS.minCount);
  assert.equal(clampVariantCount('x'), 3);
});

test('B5 normalizeLiveTarget bounds strings, filters classes, keeps a valid hint, and rejects a tagless element', () => {
  const n = normalizeLiveTarget({
    tag: 'BUTTON', selector: 'x'.repeat(500), text: 'y'.repeat(500), classes: ['a', '', '  ', 'b', ...Array(20).fill('c')],
    elementId: 'go', outerHtml: 'z'.repeat(5_000), hint: { file: 'src/App.tsx', line: '17', framework: 'vue', extra: 'ignored' },
  });
  assert.ok(n);
  assert.equal(n!.tag, 'button');
  assert.equal(n!.selector.length, LIVE_VARIANT_LIMITS.selectorChars);
  assert.equal(n!.text.length, LIVE_VARIANT_LIMITS.textChars);
  assert.equal(n!.outerHtml.length, LIVE_VARIANT_LIMITS.outerHtmlChars);
  assert.equal(n!.classes.length, LIVE_VARIANT_LIMITS.classes);
  assert.ok(!n!.classes.includes(''));
  assert.deepEqual(n!.hint, { file: 'src/App.tsx', line: 17, framework: 'vue' });
  assert.equal(normalizeLiveTarget({ selector: 'div' }), null);
  assert.equal(normalizeLiveTarget(null), null);
  // A hint with no usable field is dropped entirely.
  assert.equal(normalizeLiveTarget({ tag: 'p', hint: { note: 'hi' } })!.hint, undefined);
  assert.equal(describeLiveTarget({ tag: 'a', classes: [], elementId: undefined }), 'a');
});

test('B5 parseLiveScan keeps valid wrappers, clamps active into range, and drops junk', () => {
  const scan = parseLiveScan([
    { id: 'hero-20260905-abcd', action: 'bolder', count: 4, active: 2 },
    { id: 'over', action: 'quieter', count: 3, active: 9 },       // active clamped to count-1
    { id: 'Bad Id!', action: 'x', count: 2, active: 0 },          // rejected: not a slug
    { id: 'empty', action: 'x', count: 0, active: 0 },            // rejected: no children
    { id: 'noaction', count: 2, active: 1 },                       // action defaulted
    'nonsense',
  ]);
  assert.deepEqual(scan, [
    { id: 'hero-20260905-abcd', action: 'bolder', count: 4, active: 2 },
    { id: 'over', action: 'quieter', count: 3, active: 2 },
    { id: 'noaction', action: 'variant', count: 2, active: 1 },
  ]);
  assert.deepEqual(parseLiveScan({ wrappers: [{ id: 'wrapped-1234', action: 'a', count: 2, active: 0 }] }), [{ id: 'wrapped-1234', action: 'a', count: 2, active: 0 }]);
  assert.deepEqual(parseLiveScan(undefined), []);
});
