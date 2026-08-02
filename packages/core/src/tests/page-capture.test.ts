/**
 * ADR-027 D10 (P7-2 remainder, P7-3) — table survival, readiness, tab lifecycle.
 *
 * All three failures here are silent. A flattened table reads as a paragraph of
 * numbers the model will happily reason over and get wrong. A spinner captured
 * early is stored as an artifact and cited later as though it were the page. A
 * leaked tab holds a live renderer until the browser is unusable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tableToMarkdown,
  assessReadiness,
  planTabLifecycle,
  type ExtractedTable,
  type ReadinessSignals,
  type OpenTab,
} from '../browser/pageCapture.js';

const ready = (over: Partial<ReadinessSignals> = {}): ReadinessSignals => ({
  documentComplete: true, visibleTextLength: 5_000, pendingRequests: 0, elapsedMs: 500, ...over,
});

const tab = (id: string, over: Partial<OpenTab> = {}): OpenTab =>
  ({ id, purpose: 'read', taskComplete: true, openedAtMs: 0, ...over });

test('a table becomes valid markdown rather than prose', () => {
  // D10 calls this the most common defect: flattened, it reads as a paragraph
  // of numbers rather than as damaged data.
  const table: ExtractedTable = { header: ['Model', 'Cost'], rows: [['a', '1'], ['b', '2']] };
  assert.equal(tableToMarkdown(table), [
    '| Model | Cost |',
    '| --- | --- |',
    '| a | 1 |',
    '| b | 2 |',
  ].join('\n'));
});

test('a ragged row is padded, never dropped', () => {
  // Real HTML tables omit trailing cells constantly. Dropping the row loses
  // data; dropping the table loses more. An empty cell is honest — the reader
  // sees a gap rather than a silently shifted column.
  const markdown = tableToMarkdown({ header: ['A', 'B', 'C'], rows: [['1'], ['1', '2', '3']] });
  assert.match(markdown, /\| 1 \|  \|  \|/);
  assert.match(markdown, /\| 1 \| 2 \| 3 \|/);
});

test('a row wider than the header widens the table', () => {
  const markdown = tableToMarkdown({ header: ['A'], rows: [['1', '2']] });
  const [header, divider] = markdown.split('\n');
  assert.equal(header, '| A |  |');
  assert.equal(divider, '| --- | --- |');
});

test('a headerless table still produces valid markdown', () => {
  const markdown = tableToMarkdown({ header: [], rows: [['a', 'b']] });
  assert.match(markdown, /^\|  \|  \|\n\| --- \| --- \|/, 'empty header, no invented labels');
});

test('pipes and newlines in cells cannot break the row structure', () => {
  // A raw pipe splits the row; a newline ends it entirely. Either corrupts
  // every row after it.
  const markdown = tableToMarkdown({ header: ['A'], rows: [['x | y'], ['line1\nline2']] });
  assert.match(markdown, /x \\\| y/);
  assert.match(markdown, /line1<br>line2/);
  assert.equal(markdown.split('\n').length, 4, 'header, divider, two rows — no extras');
});

test('an empty table renders nothing rather than an empty shell', () => {
  assert.equal(tableToMarkdown({ header: [], rows: [] }), '');
});

test('a fully loaded page is ready', () => {
  assert.deepEqual(assessReadiness(ready()), { ready: true });
});

test('a still-loading document is retried, not captured', () => {
  const verdict = assessReadiness(ready({ documentComplete: false }));
  assert.equal(verdict.ready, false);
  assert.equal((verdict as { retry: boolean }).retry, true);
});

test('outstanding requests defer the capture', () => {
  const verdict = assessReadiness(ready({ pendingRequests: 3 }));
  assert.equal(verdict.ready, false);
  assert.match((verdict as { reason: string }).reason, /3 request\(s\) still outstanding/);
});

test('complete but nearly empty is the client-rendered case, and retries', () => {
  // The shell arrived and the content has not. Capturing here stores an empty
  // article under a real title.
  const verdict = assessReadiness(ready({ visibleTextLength: 20 }));
  assert.equal(verdict.ready, false);
  assert.equal((verdict as { retry: boolean }).retry, true);
  assert.match((verdict as { reason: string }).reason, /nearly empty/);
});

test('a consent wall is NOT retried — waiting does not dismiss it', () => {
  // Capturing it would store a cookie banner under the article's title.
  const verdict = assessReadiness(ready({ consentWallPresent: true }));
  assert.equal(verdict.ready, false);
  assert.equal((verdict as { retry: boolean }).retry, false);
});

test('a timeout reports rather than capturing a fragment', () => {
  // An artifact from a timed-out load is a fragment that gets cited as a whole.
  const verdict = assessReadiness(ready({ elapsedMs: 99_000, visibleTextLength: 10 }));
  assert.equal(verdict.ready, false);
  assert.equal((verdict as { retry: boolean }).retry, false);
  assert.match((verdict as { reason: string }).reason, /did not become readable/);
});

test('a finished read tab is closed immediately', () => {
  const plan = planTabLifecycle([tab('t1')], { nowMs: 1_000 });
  assert.deepEqual(plan.close, ['t1']);
});

test('a tab whose task is still running is never closed', () => {
  // Closing it destroys work the agent is mid-way through.
  const plan = planTabLifecycle([tab('t1', { taskComplete: false, openedAtMs: 0 })], { nowMs: 10 ** 9 });
  assert.deepEqual(plan.close, []);
  assert.match(plan.keep[0]!.reason, /still running/);
});

test('the visible research tab is never auto-closed', () => {
  // The user is watching it; closing mid-session loses the navigation history
  // they were following.
  const plan = planTabLifecycle([tab('r', { purpose: 'research' })], { nowMs: 10 ** 9 });
  assert.deepEqual(plan.close, []);
  assert.match(plan.keep[0]!.reason, /research tab/i);
});

test('age only decides among tabs that already finished', () => {
  const plan = planTabLifecycle([
    tab('fresh', { purpose: 'task', openedAtMs: 0 }),
    tab('stale', { purpose: 'task', openedAtMs: 0 }),
  ], { nowMs: 60_000, maxIdleMs: 120_000 });
  assert.deepEqual(plan.close, [], 'both finished but neither is idle yet');
  assert.equal(plan.keep.length, 2);

  const later = planTabLifecycle([tab('stale', { purpose: 'task', openedAtMs: 0 })], {
    nowMs: 600_000, maxIdleMs: 120_000,
  });
  assert.deepEqual(later.close, ['stale']);
});

test('every tab is either closed or kept with a reason', () => {
  const tabs = [
    tab('a'), tab('b', { purpose: 'research' }),
    tab('c', { taskComplete: false }), tab('d', { purpose: 'task' }),
  ];
  const plan = planTabLifecycle(tabs, { nowMs: 1_000 });
  assert.deepEqual(
    [...plan.close, ...plan.keep.map((k) => k.id)].sort(),
    ['a', 'b', 'c', 'd'],
  );
  for (const kept of plan.keep) assert.ok(kept.reason.length > 0);
});
