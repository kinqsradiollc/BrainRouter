/**
 * ADR-040 A40-10 — Desktop Runs.
 *
 * These pin the claims the panel is allowed to make. A row that implies it has
 * an execution map behind it when only a summary was retained sends someone
 * clicking for detail that never existed; a reconnecting panel that reports an
 * error throws away a last-good answer that was perfectly true.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionNotice, rowDetailLabel, statusTone, type RunsRow, type RunsDetail } from './RunsPanel.js';
import type { RunsListRow, RunDetailView } from '@kinqs/brainrouter-core/orchestration/runs';

// ADR-040 A40-10 — compile-time drift guard: the panel's row/detail types ARE
// Core's projection types, not a parallel copy. These assignments only compile
// while that holds, so re-localizing the shapes (or Core changing them) fails
// the typecheck instead of letting the two hosts quietly disagree.
const _rowIsCore: RunsListRow = {} as RunsRow;
const _coreIsRow: RunsRow = {} as RunsListRow;
const _detailIsCore: RunDetailView = {} as RunsDetail;
const _coreIsDetail: RunsDetail = {} as RunDetailView;
void _rowIsCore; void _coreIsRow; void _detailIsCore; void _coreIsDetail;

test('a live panel shows no notice at all', () => {
  assert.equal(connectionNotice('live'), null);
});

test('reconnecting says it is showing the last answer, and does NOT claim failure', () => {
  // "stale" and "error" are different facts. Collapsing them means a brief
  // reconnect reads as a broken subsystem.
  const stale = connectionNotice('stale');
  assert.match(stale ?? '', /reconnecting/i);
  assert.doesNotMatch(stale ?? '', /unavailable/i);
});

test('an error says nothing below is current, rather than showing stale rows as fact', () => {
  assert.match(connectionNotice('error') ?? '', /nothing below is current/i);
});

test('a summary-only row does not imply an execution map', () => {
  assert.equal(rowDetailLabel({ detail: 'summary-only' }), 'Summary only');
  assert.equal(rowDetailLabel({ detail: 'projected' }), 'Execution map');
});

test('status tone distinguishes interrupted from failed', () => {
  // An interrupted run is not a failed one — it is a run nobody finished, and
  // colouring them alike hides the difference between a bug and a crash.
  assert.equal(statusTone('succeeded'), 'ok');
  assert.equal(statusTone('failed'), 'bad');
  assert.equal(statusTone('interrupted'), 'warn');
  assert.equal(statusTone('cancelled'), 'warn');
  assert.equal(statusTone('running'), 'muted');
});

test('the panel is registered so it can actually be opened', async () => {
  // ADR-034's rule, applied to this ADR's own work: a panel that exists but is
  // unreachable is not shipped.
  const { PANEL_DEFS } = await import('../panelCatalog.js');
  const runs = PANEL_DEFS.find((p) => p.id === 'runs');
  assert.ok(runs, 'runs must be in the panel catalog');
  assert.equal(runs!.title, 'Runs');
});
