/**
 * ADR-027 D13 — stacked pull requests.
 *
 * The failures worth testing are the ones that would make the review gate say
 * something FALSE about a layer: a green verdict on something that cannot
 * merge, a red one whose only cause is a floor below, or one issue reported
 * five times because it is visible from five layers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStack,
  evaluateStackMerge,
  highestMergeableLayer,
  attributeFindingsToLayers,
  adviseStacking,
  describeStack,
  displayRef,
  REVIEWABLE_LAYER_LINES,
  StackError,
  type PullRequestStack,
} from '../review/stackedPr.js';

function stack(over: Partial<PullRequestStack> = {}): PullRequestStack {
  return {
    trunk: 'main',
    layers: [
      { number: 1, head: 'a', base: 'main', ready: true },
      { number: 2, head: 'b', base: 'a', ready: true },
      { number: 3, head: 'c', base: 'b', ready: true },
    ],
    ...over,
  };
}

test('a well-formed chain validates', () => {
  assert.doesNotThrow(() => validateStack(stack()));
  assert.doesNotThrow(() => validateStack({ trunk: 'main', layers: [] }));
});

test('a layer targeting somewhere other than the layer below is rejected', () => {
  // Treating a non-chain as a chain would report merge order wrongly.
  assert.throws(
    () => validateStack(stack({
      layers: [
        { number: 1, head: 'a', base: 'main', ready: true },
        { number: 2, head: 'b', base: 'main', ready: true },
      ],
    })),
    (e: StackError) => e.code === 'not_linear',
  );
});

test('a bottom layer that does not target the trunk is rejected', () => {
  assert.throws(
    () => validateStack({ trunk: 'main', layers: [{ number: 1, head: 'a', base: 'develop', ready: true }] }),
    (e: StackError) => e.code === 'wrong_trunk',
  );
});

test('duplicates and self-targeting are rejected', () => {
  assert.throws(
    () => validateStack({ trunk: 'main', layers: [
      { number: 1, head: 'a', base: 'main', ready: true },
      { number: 1, head: 'b', base: 'a', ready: true },
    ] }),
    (e: StackError) => e.code === 'duplicate_layer',
  );
  assert.throws(
    () => validateStack({ trunk: 'main', layers: [{ number: 1, head: 'a', base: 'a', ready: true }] }),
    (e: StackError) => e.code === 'cycle',
  );
});

test('a merged layer above an unmerged one is rejected as impossible', () => {
  // Stacks merge bottom-up, so this ordering cannot have occurred; it means the
  // caller assembled the layers wrongly, and every later answer would be wrong.
  assert.throws(
    () => validateStack(stack({
      layers: [
        { number: 1, head: 'a', base: 'main', ready: true, merged: false },
        { number: 2, head: 'b', base: 'a', ready: true, merged: true },
      ],
    })),
    (e: StackError) => e.code === 'merged_above_unmerged',
  );
});

test('merging a layer lands every ready layer beneath it', () => {
  const verdicts = evaluateStackMerge(stack());
  assert.deepEqual(verdicts.map((v) => v.mergeable), [true, true, true]);
  assert.deepEqual(verdicts[2]!.landsWith, [1, 2, 3]);
  assert.deepEqual(verdicts[0]!.landsWith, [1]);
});

test('a layer blocked by its OWN checks is distinguished from one blocked below', () => {
  // This distinction is the whole point. Collapsing them is what makes a stack
  // feel like it is fighting you: you fix a layer, nothing changes, and nothing
  // ever says the reason is one floor down.
  const verdicts = evaluateStackMerge(stack({
    layers: [
      { number: 1, head: 'a', base: 'main', ready: true },
      { number: 2, head: 'b', base: 'a', ready: false },
      { number: 3, head: 'c', base: 'b', ready: true },
    ],
  }));
  assert.equal(verdicts[0]!.mergeable, true);
  assert.deepEqual(verdicts[1]!.reason, { kind: 'own_checks' });
  assert.deepEqual(verdicts[2]!.reason, { kind: 'blocked_below', by: 2 });
  assert.equal(verdicts[2]!.mergeable, false, 'a ready top layer still cannot jump the queue');
});

test('the highest mergeable layer is the one to click', () => {
  assert.equal(highestMergeableLayer(stack())!.number, 3);
  const partial = stack({
    layers: [
      { number: 1, head: 'a', base: 'main', ready: true },
      { number: 2, head: 'b', base: 'a', ready: false },
      { number: 3, head: 'c', base: 'b', ready: true },
    ],
  });
  assert.equal(highestMergeableLayer(partial)!.number, 1);
});

test('nothing is mergeable when the bottom layer is not ready', () => {
  const blocked = stack({
    layers: [
      { number: 1, head: 'a', base: 'main', ready: false },
      { number: 2, head: 'b', base: 'a', ready: true },
    ],
  });
  assert.equal(highestMergeableLayer(blocked), null);
});

test('an already-merged bottom does not block the layers above it', () => {
  const partial = stack({
    layers: [
      { number: 1, head: 'a', base: 'main', ready: true, merged: true },
      { number: 2, head: 'b', base: 'a', ready: true },
    ],
  });
  const verdicts = evaluateStackMerge(partial);
  assert.deepEqual(verdicts[0]!.reason, { kind: 'already_merged' });
  assert.equal(verdicts[1]!.mergeable, true);
});

test('a finding is attributed to the LOWEST layer it appears in', () => {
  // A lower layer's issue is visible from every layer above. Reporting it on
  // each would turn one problem into three dismissals — notification fatigue
  // manufactured by our own tooling.
  const attributed = attributeFindingsToLayers({
    stack: stack(),
    observed: new Map([
      [1, ['fp-a']],
      [2, ['fp-a', 'fp-b']],
      [3, ['fp-a', 'fp-b', 'fp-c']],
    ]),
  });
  assert.deepEqual(attributed.get(1), ['fp-a']);
  assert.deepEqual(attributed.get(2), ['fp-b']);
  assert.deepEqual(attributed.get(3), ['fp-c']);
});

test('a layer with no new findings reports an empty list, not absence', () => {
  const attributed = attributeFindingsToLayers({
    stack: stack(),
    observed: new Map([[1, ['fp-a']], [2, ['fp-a']], [3, []]]),
  });
  assert.deepEqual(attributed.get(2), []);
  assert.deepEqual(attributed.get(3), []);
});

test('a small change is not told to stack', () => {
  const advice = adviseStacking({
    totalChangedLines: 120,
    groups: [{ label: 'x', files: ['a.ts'], changedLines: 120 }],
  });
  assert.equal(advice.shouldStack, false);
  assert.match(advice.reason, new RegExp(String(REVIEWABLE_LAYER_LINES)));
});

test('a large but INDIVISIBLE change is not told to stack either', () => {
  // Splitting one unit of work produces layers that cannot be reviewed or
  // merged independently — worse than one honest large PR. A tool that insists
  // otherwise gets ignored, and then it advises nothing at all.
  const advice = adviseStacking({
    totalChangedLines: 900,
    groups: [{ label: 'mechanical rename', files: ['a.ts', 'b.ts'], changedLines: 900 }],
  });
  assert.equal(advice.shouldStack, false);
  assert.match(advice.reason, /single unit of work/);
  assert.deepEqual(advice.suggestedLayers, []);
});

test('a large separable change is stacked along its existing seams', () => {
  const advice = adviseStacking({
    totalChangedLines: 640,
    groups: [
      { label: 'schema', files: ['migrations/1.sql'], changedLines: 90 },
      { label: 'store', files: ['store.ts'], changedLines: 250 },
      { label: 'api', files: ['routes.ts'], changedLines: 300 },
    ],
  });
  assert.equal(advice.shouldStack, true);
  assert.deepEqual(advice.suggestedLayers.map((l) => l.label), ['schema', 'store', 'api']);
});

test('the description names the blocking layer rather than just failing', () => {
  const text = describeStack(stack({
    layers: [
      { number: 1, head: 'a', base: 'main', ready: true, merged: true },
      { number: 2, head: 'b', base: 'a', ready: false },
      { number: 3, head: 'c', base: 'b', ready: true },
    ],
  }));
  assert.match(text, /#1 a — merged/);
  assert.match(text, /#2 b — not ready/);
  assert.match(text, /#3 c — waiting on #2/);
});

test('branch names are rendered inert in the review comment', () => {
  // Refs come from the forge API, which this pipeline treats as untrusted
  // everywhere else. Relying on git's ref rules and GitHub's Markdown
  // sanitizer would be depending on someone else's invariants to protect the
  // bot's highest-trust output — the comment that sits beside real findings.
  const text = describeStack({
    trunk: 'main`x`',
    layers: [{ number: 1, head: 'feat/**bold**<img src=x>', base: 'main`x`', ready: true }],
  });
  for (const metachar of ['`', '*', '<', '>', '[', ']', '|', '\\']) {
    assert.ok(!text.includes(metachar), `"${metachar}" must not survive into the comment`);
  }
  assert.match(text, /feat\/boldimg src=x/);
});

test('a ref cannot close the fenced block it is rendered inside', () => {
  // A newline is what a fence-escape needs. Git forbids it in refs, but that
  // is git's guarantee, not ours.
  const text = describeStack({
    trunk: 'main',
    layers: [{ number: 1, head: 'a\n```\n# spoofed heading', base: 'main', ready: true }],
  });
  assert.ok(!text.includes('```'));
  assert.equal(text.split('\n').length, 2, 'the layer stays on one line');
});

test('ordinary branch names are left readable', () => {
  // Sanitising must not mangle the common case into unreadability.
  assert.equal(displayRef('feat/adr027-stacked-prs'), 'feat/adr027-stacked-prs');
  assert.equal(displayRef('release/0.4.19'), 'release/0.4.19');
  assert.equal(displayRef('fix/bug-123'), 'fix/bug-123');
});

test('bidirectional overrides cannot reorder the rendered stack line', () => {
  // Trojan Source (CVE-2021-42574) in the one comment a reader is most
  // inclined to believe. Git forbids ASCII controls in refs but these are
  // Unicode format characters, so they pass ref validation.
  for (const attack of ['‮', '‭', '⁦', '⁩', '‪']) {
    assert.ok(!displayRef(`feat/a${attack}kcatta`).includes(attack), `U+${attack.codePointAt(0)!.toString(16)}`);
  }
});

test('invisible characters are stripped, since two refs must not look identical', () => {
  assert.equal(displayRef('feat/a​b'), 'feat/ab');
  assert.equal(displayRef('feat/a­b'), 'feat/ab');
  assert.equal(displayRef('﻿feat/a'), 'feat/a');
});
