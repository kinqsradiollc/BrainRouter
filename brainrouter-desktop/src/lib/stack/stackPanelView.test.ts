/**
 * ADR-028 A8 — the stack panel's judgements.
 *
 * The properties that matter are about what the panel REFUSES to say: it never
 * reports a blocker the person cannot act on first, never offers a control that
 * would fail, and never renders a verdict where a count would do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layerStatus, highestMergeable, mergeButtonLabel, showsAction, unavailableNotice, stackSummary,
  isSafeBranchName, partitionBranches,
  type StackLayerView,
} from './stackPanelView.js';

const layer = (over: Partial<StackLayerView> & { number: number; position: number }): StackLayerView => ({
  title: `Layer ${over.position}`, branch: `feat/l${over.position}`,
  merged: false, checksPassed: true, checksPending: false, approved: true,
  changesRequested: false, inMergeQueue: false, needsSync: false, ...over,
});

const CAPABLE = { capable: true, halted: false };

test('a ready bottom layer has no blocker', () => {
  const l = layer({ number: 1, position: 1 });
  assert.deepEqual(layerStatus(l, [l]), { readiness: 'ready', blocker: null });
});

test('the blocker reported is the one you can act on FIRST', () => {
  // A layer both unapproved AND stuck behind an unmerged layer reports the
  // layer below: getting it approved changes nothing until that one lands.
  const layers = [layer({ number: 1, position: 1 }), layer({ number: 2, position: 2, approved: false })];
  const s = layerStatus(layers[1]!, layers);
  assert.equal(s.readiness, 'blocked_below');
  assert.match(s.blocker!, /#1/);
  assert.match(s.blocker!, /bottom-up/);
});

test('every blocker NAMES the cause — never "not ready"', () => {
  const cases: Array<[Partial<StackLayerView>, RegExp]> = [
    [{ changesRequested: true }, /requesting changes/],
    [{ needsSync: true }, /needs a sync/],
    [{ checksPassed: false, checksPending: true }, /still running/],
    [{ checksPassed: false }, /have not passed/],
    [{ approved: false }, /Not approved/],
    [{ inMergeQueue: true }, /merge queue/],
  ];
  for (const [over, expected] of cases) {
    const l = layer({ number: 1, position: 1, ...over });
    assert.match(layerStatus(l, [l]).blocker!, expected);
  }
});

test('a merged layer is merged, whatever else is true of it', () => {
  const l = layer({ number: 1, position: 1, merged: true, checksPassed: false });
  assert.equal(layerStatus(l, [l]).readiness, 'merged');
});

test('the HIGHEST mergeable layer is reported, not merely the next one', () => {
  // `gh stack merge` lands everything beneath, so the useful answer is how far
  // a single merge could reach.
  const layers = [
    layer({ number: 1, position: 1 }),
    layer({ number: 2, position: 2 }),
    layer({ number: 3, position: 3, approved: false }),
  ];
  assert.equal(highestMergeable(layers)!.number, 2);
});

test('a blocked bottom layer means nothing is mergeable', () => {
  const layers = [
    layer({ number: 1, position: 1, checksPassed: false }),
    layer({ number: 2, position: 2 }),
  ];
  assert.equal(highestMergeable(layers), null);
});

test('already-merged layers are skipped when finding the highest', () => {
  const layers = [
    layer({ number: 1, position: 1, merged: true }),
    layer({ number: 2, position: 2 }),
  ];
  assert.equal(highestMergeable(layers)!.number, 2);
});

test('the merge button names every pull request that would land', () => {
  // "Merge #12" has not told the truth about landing four.
  const layers = [
    layer({ number: 9, position: 1 }),
    layer({ number: 11, position: 2 }),
    layer({ number: 12, position: 3 }),
  ];
  const label = mergeButtonLabel(layers[2]!, layers);
  assert.match(label, /3 layers/);
  assert.match(label, /#9, #11, #12/);
  assert.equal(mergeButtonLabel(layers[0]!, layers), 'Merge #9');
});

test('controls are HIDDEN when the feature is unavailable, not disabled', () => {
  // A greyed-out button invites a hover looking for an explanation a tooltip is
  // a poor place to give.
  const missing = { capable: false, halted: false, reason: 'gh-stack is not installed.' };
  for (const action of ['view', 'sync', 'merge', 'add', 'submit'] as const) {
    assert.equal(showsAction(action, missing), false);
  }
  assert.match(unavailableNotice(missing)!, /not installed/);
});

test('while halted, READ controls remain — you must see the stack that is stuck', () => {
  const halted = { capable: true, halted: true, reason: 'A rebase conflict stopped the sync.' };
  assert.equal(showsAction('view', halted), true);
  assert.equal(showsAction('merge', halted), false);
  assert.equal(showsAction('sync', halted), false);
  assert.match(unavailableNotice(halted)!, /Resolve it in the terminal/);
});

test('everything is offered when the stack is usable and clean', () => {
  for (const action of ['view', 'sync', 'merge', 'add', 'submit'] as const) {
    assert.equal(showsAction(action, CAPABLE), true);
  }
  assert.equal(unavailableNotice(CAPABLE), null);
});

test('the header is COUNTS, not a verdict', () => {
  // "3 of 5 merged" is a fact someone can act on; "stack healthy" is a claim
  // that will eventually be wrong.
  const layers = [
    layer({ number: 1, position: 1, merged: true }),
    layer({ number: 2, position: 2, checksPassed: false }),
    layer({ number: 3, position: 3 }),
  ];
  const text = stackSummary(layers);
  assert.match(text, /1 of 3 merged/);
  assert.match(text, /1 blocked/);
  assert.doesNotMatch(text, /healthy|good|fine|ok/i);
  assert.equal(stackSummary([]), 'No stack on this branch.');
});

/* ---------------------------------------- untrusted branch names (CWE-88) */

test('a branch name shaped like an OPTION is refused', () => {
  // Branch names come from GitHub, so a collaborator picks them. `--upload-pack`
  // is read by git as an option, not as the ref it pretends to be — and the
  // character class alone would pass it, which is why the hyphen check exists.
  for (const bad of ['--upload-pack=touch /tmp/x', '-f', '-c', '', 'a..b', 'x.lock', 'has space']) {
    assert.equal(isSafeBranchName(bad), false, `${bad} must be refused`);
  }
});

test('ordinary branch names pass', () => {
  for (const good of ['feat/api', 'release/0.4.20', 'main', 'fix_1']) {
    assert.equal(isSafeBranchName(good), true, `${good} must be allowed`);
  }
});

test('the partition keeps safe and refused separate so the UI can explain', () => {
  // Silently dropping one would sync a partial stack while reporting success.
  const { safe, refused } = partitionBranches([
    layer({ number: 1, position: 1, branch: 'feat/ok' }),
    layer({ number: 2, position: 2, branch: '--exec=whoami' }),
  ]);
  assert.deepEqual(safe.map((l) => l.number), [1]);
  assert.deepEqual(refused.map((l) => l.number), [2]);
});
