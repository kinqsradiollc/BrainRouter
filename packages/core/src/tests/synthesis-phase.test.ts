import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReviewFindings, synthesizePhase } from '../orchestration/workflow/synthesis.js';
import type { SynthChild } from '../orchestration/workflow/synthesis.js';

const child = (id: string, finalOutput: string, role = 'reviewer'): SynthChild => ({ id, role, status: 'completed', finalOutput });

// ── extractReviewFindings ────────────────────────────────────────────────────

test('WF-SYNTH extractReviewFindings parses a fenced ```json findings block', () => {
  const text = 'Some prose.\n```json\n[{"file":"a.ts","line":10,"severity":"high","confidence":90,"summary":"SQLi"}]\n```';
  const f = extractReviewFindings(text);
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'a.ts');
  assert.equal(f[0].confidence, 90);
});

test('WF-SYNTH extractReviewFindings parses a bare array and a {findings:[]} object', () => {
  assert.equal(extractReviewFindings('[{"file":"a","summary":"x"}]').length, 1);
  assert.equal(extractReviewFindings('{"findings":[{"file":"a","summary":"x"}]}').length, 1);
});

test('WF-SYNTH extractReviewFindings returns [] for prose-only output (no inventing)', () => {
  assert.deepEqual(extractReviewFindings('Looks clean, nothing to report.'), []);
  assert.deepEqual(extractReviewFindings(undefined), []);
});

test('WF-SYNTH extractReviewFindings drops items without file+summary, defaults confidence', () => {
  const f = extractReviewFindings('[{"file":"a","summary":"ok"},{"line":3},{"summary":"no file"}]');
  assert.equal(f.length, 1); // only the one with both file + summary
  assert.equal(f[0].confidence, 50); // defaulted
});

// ── synthesizePhase ──────────────────────────────────────────────────────────

test('WF-SYNTH synthesizePhase none → concatenated raw outputs', () => {
  const po = synthesizePhase([child('a', 'OUT1'), child('b', 'OUT2')], 'none');
  assert.equal(po.mode, 'none');
  assert.equal(po.text, 'OUT1\n\n---\n\nOUT2');
  assert.equal(po.rollup, undefined);
  assert.equal(po.review, undefined);
});

test('WF-SYNTH synthesizePhase role-rollup → rollup digest', () => {
  const po = synthesizePhase([child('a', 'finding', 'reviewer')], 'role-rollup');
  assert.equal(po.mode, 'role-rollup');
  assert.ok(po.rollup);
  assert.equal(po.rollup!.total, 1);
  assert.match(po.text, /reviewer/);
});

test('WF-SYNTH synthesizePhase review-merge → dedupes findings across reviewers', () => {
  const c1 = child('r1', '```json\n[{"file":"a.ts","line":10,"severity":"high","confidence":90,"summary":"SQLi"}]\n```');
  const c2 = child('r2', '[{"file":"a.ts","line":10,"severity":"high","confidence":80,"summary":"SQLi"}]');
  const po = synthesizePhase([c1, c2], 'review-merge');
  assert.equal(po.mode, 'review-merge');
  assert.ok(po.review, 'review present');
  assert.equal(po.review!.kept.length, 1); // same finding from 2 reviewers → 1
  assert.equal(po.review!.kept[0].confidence, 90); // max wins
  assert.match(po.text, /SQLi/);
});

test('WF-SYNTH synthesizePhase review-merge with NO findings → falls back to role-rollup', () => {
  const po = synthesizePhase([child('r1', 'all clean, nothing to flag')], 'review-merge');
  assert.equal(po.mode, 'review-merge');
  assert.equal(po.review, undefined); // no findings → no merge
  assert.ok(po.rollup, 'fell back to a role rollup');
});
