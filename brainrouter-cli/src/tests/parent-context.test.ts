import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildParentExecutionContextSnapshot,
  formatSnapshotForHuman,
  type ParentExecutionContextSnapshot,
} from '../orchestration/parentContext.js';

/**
 * MAS-P2-M3 — ParentExecutionContextSnapshot tests.
 *
 * The snapshot is the typed contract the parent hands every child it
 * spawns. Tests cover three responsibilities:
 *
 *   1. The builder is forgiving — partial inputs produce partial
 *      snapshots without crashing.
 *   2. Excerpts (plan, briefing) are truncated to predictable bounds
 *      so a 50k-line plan can't blow up the snapshot.
 *   3. The renderer formats every field with a sane fallback (`—`)
 *      when absent, so `/agents show <id>` is always readable.
 */

const REQUIRED_INPUTS = {
  parentSessionKey: 'parent-sk',
  childSessionKey: 'parent-sk:child:abc',
  parentAgentId: 'explorer',
  accessMode: 'read' as const,
};

test('builder: minimal required inputs produce a valid snapshot', () => {
  const snap = buildParentExecutionContextSnapshot(REQUIRED_INPUTS);
  assert.equal(snap.parentSessionKey, 'parent-sk');
  assert.equal(snap.childSessionKey, 'parent-sk:child:abc');
  assert.equal(snap.parentAgentId, 'explorer');
  assert.equal(snap.accessMode, 'read');
  // Optional fields stay undefined, not null.
  assert.equal(snap.goal, undefined);
  assert.equal(snap.planExcerpt, undefined);
  assert.equal(snap.briefingExcerpt, undefined);
});

test('builder: planText > 600 chars is truncated with an ellipsis', () => {
  const planText = 'step '.repeat(200); // 1000 chars
  const snap = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    planText,
  });
  assert.ok(snap.planExcerpt);
  assert.ok(snap.planExcerpt!.length <= 600);
  assert.ok(snap.planExcerpt!.endsWith('…'));
});

test('builder: briefingBlock > 500 chars is truncated with an ellipsis', () => {
  const briefing = 'word '.repeat(200); // 1000 chars
  const snap = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    briefingBlock: briefing,
  });
  assert.ok(snap.briefingExcerpt);
  assert.ok(snap.briefingExcerpt!.length <= 500);
  assert.ok(snap.briefingExcerpt!.endsWith('…'));
});

test('builder: recalledRecordIds are deduped and capped at 50', () => {
  const ids = Array.from({ length: 80 }, (_, i) => `rec-${i % 60}`); // 80 entries, 60 unique
  const snap = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    recalledRecordIds: ids,
  });
  assert.ok(snap.recalledRecordIds);
  assert.ok(snap.recalledRecordIds!.length <= 50);
  assert.equal(new Set(snap.recalledRecordIds!).size, snap.recalledRecordIds!.length);
});

test('builder: workspaceInstructions are hashed (not embedded) so the snapshot stays small', () => {
  const instructions = 'A '.repeat(5000); // 10k chars
  const snap = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    workspaceInstructions: instructions,
  });
  assert.ok(snap.workspaceInstructionsHash);
  // 16-char prefix of a sha-256 hex digest.
  assert.equal(snap.workspaceInstructionsHash!.length, 16);
  assert.match(snap.workspaceInstructionsHash!, /^[0-9a-f]{16}$/);
});

test('builder: workspaceInstructionsHash differs when the source text differs', () => {
  const a = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    workspaceInstructions: 'version A',
  });
  const b = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    workspaceInstructions: 'version B',
  });
  assert.notEqual(a.workspaceInstructionsHash, b.workspaceInstructionsHash);
});

test('builder: empty / null goal is normalised to absent (no goal field)', () => {
  const empty = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    goal: { text: '', status: 'active' },
  });
  assert.equal(empty.goal, undefined);

  const real = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    goal: { text: 'ship landing page', status: 'active' },
  });
  assert.deepEqual(real.goal, { text: 'ship landing page', status: 'active' });
});

test('builder: visibleTools are capped at 80', () => {
  const tools = Array.from({ length: 120 }, (_, i) => `tool_${i}`);
  const snap = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    visibleTools: tools,
  });
  assert.equal(snap.visibleTools!.length, 80);
});

test('builder: ownership null vs omitted are distinguished', () => {
  const nullish = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    ownership: null,
  });
  // null is preserved when explicitly passed.
  assert.equal(nullish.ownership, null);

  const omitted = buildParentExecutionContextSnapshot({ ...REQUIRED_INPUTS });
  assert.equal(omitted.ownership, undefined);
});

test('renderer: every field renders, absent ones show as `—`', () => {
  const snap: ParentExecutionContextSnapshot = {
    parentSessionKey: 'parent-sk',
    childSessionKey: 'parent-sk:child:1',
    parentAgentId: 'reviewer',
    accessMode: 'shell',
    executionMode: 'fast',
    reviewPolicy: 'proceed',
  };
  const rendered = formatSnapshotForHuman(snap);
  assert.match(rendered, /parentSessionKey/);
  assert.match(rendered, /parent-sk/);
  assert.match(rendered, /accessMode\s+shell/);
  assert.match(rendered, /executionMode\s+fast/);
  // Absent optional field renders as the em-dash placeholder.
  assert.match(rendered, /goal\s+—/);
  assert.match(rendered, /planExcerpt\s+—/);
});

test('renderer: planExcerpt + briefingExcerpt are reported by char count, not embedded', () => {
  const snap = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    planText: 'a plan with some content here',
    briefingBlock: 'a memory briefing block',
  });
  const rendered = formatSnapshotForHuman(snap);
  assert.match(rendered, /planExcerpt\s+\d+ chars/);
  assert.match(rendered, /briefingExcerpt\s+\d+ chars/);
  // The body itself is NOT in the human view — the JSON envelope on
  // the child's transcript is the authoritative copy.
  assert.doesNotMatch(rendered, /a plan with some content here/);
});

test('renderer: recalledRecordIds show count + first 3 ids', () => {
  const snap = buildParentExecutionContextSnapshot({
    ...REQUIRED_INPUTS,
    recalledRecordIds: ['rec-1', 'rec-2', 'rec-3', 'rec-4', 'rec-5'],
  });
  const rendered = formatSnapshotForHuman(snap);
  assert.match(rendered, /5 ids: rec-1, rec-2, rec-3…/);
});
