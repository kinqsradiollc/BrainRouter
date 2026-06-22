import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateEntryHeight,
  estimateTextHeight,
  packVisibleLines,
  type ScrollbackEntry,
} from '../cli/ink/ChatApp.js';

// --- height estimation (the overlap bug was an UNDER-estimate) --------------

test('estimateTextHeight: counts wrapped rows, not just newlines', () => {
  assert.equal(estimateTextHeight('', 80), 0);
  assert.equal(estimateTextHeight('short', 80), 1);
  assert.equal(estimateTextHeight('x'.repeat(400), 40), Math.ceil(400 / 40));
});

test('estimateEntryHeight: assistant body wrapping is accounted (no undershoot)', () => {
  const longLine = 'x'.repeat(400);
  const wide = estimateEntryHeight({ id: 1, kind: 'assistant', text: longLine } as ScrollbackEntry, 200);
  const narrow = estimateEntryHeight({ id: 2, kind: 'assistant', text: longLine } as ScrollbackEntry, 40);
  assert.ok(narrow > wide, `narrower terminal must wrap to more rows (narrow=${narrow}, wide=${wide})`);
  assert.ok(narrow >= 10, `estimate ${narrow} must cover the wrapped height`);
});

test('estimateEntryHeight: markdown list spacing is counted (not raw newline count)', () => {
  const md = '- one\n- two\n- three';
  const h = estimateEntryHeight({ id: 1, kind: 'assistant', text: md } as ScrollbackEntry, 80);
  assert.ok(h >= 4, `rendered list estimate ${h} should cover the bullets + margin`);
});

// --- CC-P1.1 line-level packing ----------------------------------------------

interface FakeEntry { id: number; h: number; }
const mk = (heights: number[]): FakeEntry[] => heights.map((h, i) => ({ id: i, h }));
const est = (e: FakeEntry) => e.h;
const visibleRows = <T,>(r: { slices: Array<{ height: number; clipTop: number; clipBottom: number; entry: T }> }) =>
  r.slices.reduce((n, s) => n + (s.height - s.clipTop - s.clipBottom), 0);

test('packVisibleLines: fills exactly the budget, clipping the topmost entry', () => {
  const r = packVisibleLines(mk([5, 5, 5]), { budget: 12, lineOffset: 0, estimateHeight: est });
  assert.equal(visibleRows(r), 12);
  assert.equal(r.totalLines, 15);
  assert.equal(r.hiddenLinesAbove, 3);
  assert.equal(r.hiddenLinesBelow, 0);
  // Top slice shows only its bottom 2 rows (5+5 below it leave 2 of budget).
  assert.equal(r.slices[0].clipTop, 3);
  assert.equal(r.slices[0].clipBottom, 0);
  assert.equal(r.slices[r.slices.length - 1].clipTop, 0);
});

test('packVisibleLines: lineOffset slides by single lines (mid-entry clipBottom)', () => {
  const r = packVisibleLines(mk([5, 5, 5]), { budget: 12, lineOffset: 2, estimateHeight: est });
  // 2 lines scrolled below the window — the bottom entry loses its last 2 rows.
  assert.equal(r.hiddenLinesBelow, 2);
  assert.equal(r.slices[r.slices.length - 1].clipBottom, 2);
  assert.equal(visibleRows(r), 12);
  assert.equal(r.hiddenLinesAbove, 1);
});

test('packVisibleLines: offset is clamped to the top (g key can pass Infinity)', () => {
  const r = packVisibleLines(mk([5, 5, 5]), { budget: 12, lineOffset: 1e9, estimateHeight: est });
  assert.equal(r.hiddenLinesAbove, 0, 'window is at the very top');
  assert.equal(r.hiddenLinesBelow, 3, 'offset clamped to totalLines - budget');
  assert.equal(r.slices[0].clipTop, 0);
  assert.equal(visibleRows(r), 12);
});

test('packVisibleLines: an entry taller than the viewport is windowed inside itself', () => {
  const r = packVisibleLines(mk([40]), { budget: 10, lineOffset: 5, estimateHeight: est });
  assert.equal(r.slices.length, 1);
  assert.equal(r.slices[0].clipBottom, 5);
  assert.equal(r.slices[0].clipTop, 25);
  assert.equal(visibleRows(r), 10);
});

test('packVisibleLines: content shorter than the budget shows fully, no clips', () => {
  const r = packVisibleLines(mk([2, 3]), { budget: 12, lineOffset: 0, estimateHeight: est });
  assert.equal(r.slices.length, 2);
  assert.ok(r.slices.every((s) => s.clipTop === 0 && s.clipBottom === 0));
  assert.equal(r.hiddenLinesAbove, 0);
  assert.equal(r.hiddenLinesBelow, 0);
});

test('packVisibleLines: empty input → empty window', () => {
  assert.deepEqual(
    packVisibleLines([], { budget: 10, lineOffset: 0, estimateHeight: est }),
    { slices: [], hiddenLinesAbove: 0, hiddenLinesBelow: 0, totalLines: 0 },
  );
});

test('estimateEntryHeight: verbose mode uncaps tool previews (CC-P1.3)', () => {
  const preview = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const entry = { id: 1, kind: 'tool', header: 'Read(x)', ok: true, preview } as ScrollbackEntry;
  const capped = estimateEntryHeight(entry, 80);
  const verbose = estimateEntryHeight(entry, 80, true);
  assert.equal(capped, 1 + 8 + 1 + 1); // header + 8 lines + hidden notice + margin
  assert.equal(verbose, 1 + 30 + 1);   // header + all lines + margin
});
