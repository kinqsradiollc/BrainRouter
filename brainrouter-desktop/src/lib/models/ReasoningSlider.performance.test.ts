import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../../components/ReasoningSlider.tsx', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');

function functionBody(name: string): string {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} should exist`);
  const nextHandler = source.indexOf('\n  const on', start + 1);
  const renderStart = source.indexOf('\n  const frac =', start + 1);
  const endCandidates = [nextHandler, renderStart].filter((idx) => idx > start);
  assert.ok(endCandidates.length > 0, `${name} should have a clear boundary`);
  return source.slice(start, Math.min(...endCandidates));
}

test('ReasoningSlider caches layout reads outside pointermove', () => {
  const layoutReads = source.match(/getBoundingClientRect/g) ?? [];
  assert.equal(layoutReads.length, 1, 'drag should read the rail rect once');
  assert.match(functionBody('onPointerDown'), /getBoundingClientRect/);
  assert.doesNotMatch(functionBody('onPointerMove'), /getBoundingClientRect/);
});

test('ReasoningSlider batches drag state through requestAnimationFrame', () => {
  const pointerMove = functionBody('onPointerMove');
  assert.match(pointerMove, /requestAnimationFrame\(flushPointerFrame\)/);
  assert.doesNotMatch(pointerMove, /setPreviewIdx/);
  assert.match(functionBody('flushPointerFrame'), /setPreviewIdx/);
});

test('ReasoningSlider keeps sweep animation compositor-friendly', () => {
  assert.doesNotMatch(source, /RSL_KEYFRAMES/);
  assert.doesNotMatch(source, /background-position/);
  assert.match(source, /willChange: sweepOn \? 'transform, opacity' : 'auto'/);

  assert.match(theme, /@keyframes rsl-sweep/);
  const sweepStart = theme.indexOf('@keyframes rsl-sweep');
  const nextKeyframe = theme.indexOf('@keyframes', sweepStart + 1);
  const sweepBlock = theme.slice(sweepStart, nextKeyframe > sweepStart ? nextKeyframe : undefined);
  assert.match(sweepBlock, /transform:/);
  assert.doesNotMatch(sweepBlock, /background-position/);
  assert.match(theme, /prefers-reduced-motion: reduce/);
});

test('ReasoningSlider keeps the top tier animated at rest (sweep not gated to dragging)', () => {
  // The "maxed reasoning" signature must play ALWAYS at the top stop, not only
  // while the knob is held — so the sweep gate is independent of isDragging.
  assert.match(source, /const sweepOn = isTop && motion;/);
  // ...and the dotted shimmer must also be a slide-feedback cue (shown while dragging).
  assert.match(source, /const twinkleVisible = isDragging \|\| isTop;/);
});
