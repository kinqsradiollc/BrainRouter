import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateEntryHeight,
  estimateTextHeight,
  packVisibleScrollback,
  type ScrollbackEntry,
} from '../cli/ink/ChatApp.js';

// --- height estimation (the overlap bug was an UNDER-estimate) --------------

test('estimateTextHeight: counts wrapped rows, not just newlines', () => {
  assert.equal(estimateTextHeight('', 80), 0);
  assert.equal(estimateTextHeight('short', 80), 1);
  // a 400-char single line wraps to ceil(400/40) rows
  assert.equal(estimateTextHeight('x'.repeat(400), 40), Math.ceil(400 / 40));
});

test('estimateEntryHeight: assistant body wrapping is accounted (no undershoot)', () => {
  const longLine = 'x'.repeat(400);
  const wide = estimateEntryHeight({ id: 1, kind: 'assistant', text: longLine } as ScrollbackEntry, 200);
  const narrow = estimateEntryHeight({ id: 2, kind: 'assistant', text: longLine } as ScrollbackEntry, 40);
  assert.ok(narrow > wide, `narrower terminal must wrap to more rows (narrow=${narrow}, wide=${wide})`);
  // body width ≈ cols-2 → ~ceil(400/38) ≈ 11 rows; must not undershoot the raw "1 line".
  assert.ok(narrow >= 10, `estimate ${narrow} must cover the wrapped height`);
});

test('estimateEntryHeight: markdown list spacing is counted (not raw newline count)', () => {
  const md = '- one\n- two\n- three';
  const h = estimateEntryHeight({ id: 1, kind: 'assistant', text: md } as ScrollbackEntry, 80);
  assert.ok(h >= 4, `rendered list estimate ${h} should cover the bullets + margin`);
});

// --- packing (must NEVER exceed the budget → never overflow the frame) ------

interface FakeEntry { id: number; h: number; }
const mk = (heights: number[]): FakeEntry[] => heights.map((h, i) => ({ id: i, h }));
const est = (e: FakeEntry) => e.h;

test('packVisibleScrollback: FILLS the budget newest-first (crossing entry kept; box clips it)', () => {
  const r = packVisibleScrollback(mk([5, 5, 5, 5, 5]), { budget: 12, scrollOffset: 0, estimateHeight: est });
  const total = r.entries.reduce((n, e) => n + e.h, 0);
  // Must FILL the pane (no blank space below the budget) — the crossing entry is
  // included and clipped, so total reaches/exceeds the budget rather than bailing
  // out under it (which left responses off-screen with the rest blank).
  assert.ok(total >= 12, `packed total ${total} must FILL the budget (>=12)`);
  assert.ok(r.entries.length >= 1);
  assert.equal(r.entries[r.entries.length - 1].id, 4, 'newest entry is always included');
  assert.equal(r.hiddenAbove, 5 - r.entries.length);
  assert.equal(r.hiddenBelow, 0);
});

test('packVisibleScrollback: a lone oversized newest entry is still shown (box clips it)', () => {
  const r = packVisibleScrollback(mk([100]), { budget: 10, scrollOffset: 0, estimateHeight: est });
  assert.equal(r.entries.length, 1);
  assert.equal(r.hiddenAbove, 0);
});

test('packVisibleScrollback: scrollOffset slides the window toward older history', () => {
  const r = packVisibleScrollback(mk([3, 3, 3, 3, 3, 3]), { budget: 6, scrollOffset: 2, estimateHeight: est });
  assert.equal(r.hiddenBelow, 2, 'two newest entries scrolled past');
  assert.equal(r.entries[r.entries.length - 1].id, 3);
  assert.ok(r.entries.reduce((n, e) => n + e.h, 0) <= 6);
});

test('packVisibleScrollback: empty input → empty window', () => {
  assert.deepEqual(
    packVisibleScrollback([], { budget: 10, scrollOffset: 0, estimateHeight: est }),
    { entries: [], hiddenAbove: 0, hiddenBelow: 0 },
  );
});
