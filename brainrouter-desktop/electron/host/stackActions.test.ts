/**
 * ADR-027 D13 — desktop host implementations for the `stack.*` control actions.
 *
 * These were declarations with no host until now. The cases below are the ones
 * where an agent-driven action could do something the caller did not ask for,
 * or state something untrue about what can merge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readStack,
  describeStackAction,
  adviseStackingAction,
  createStackLayerAction,
  type StackActionDeps,
  type GhJson,
} from './stackActions.js';

const THREE = {
  trunk: 'main',
  pull_requests: [
    { number: 1, head: { ref: 'a' }, base: { ref: 'main' }, mergeable_state: 'clean' },
    { number: 2, head: { ref: 'b' }, base: { ref: 'a' }, mergeable_state: 'unknown' },
    { number: 3, head: { ref: 'c' }, base: { ref: 'b' }, mergeable_state: 'clean' },
  ],
};

function deps(over: Partial<StackActionDeps> & { gh?: GhJson } = {}): StackActionDeps {
  return {
    ghJson: over.gh ?? ((async () => ({ data: THREE })) as unknown as GhJson),
    repo: over.repo ?? (() => 'o/r'),
    workingTreeGroups: over.workingTreeGroups ?? (async () => ({
      totalChangedLines: 40,
      groups: [{ label: 'x', files: ['a.ts'], changedLines: 40 }],
    })),
  };
}

test('a workspace with no GitHub repository is refused, not guessed at', async () => {
  const result = await readStack(deps({ repo: () => null }), 1);
  assert.equal(result.stack, null);
  assert.match(result.reason!, /no GitHub repository/);
});

test('a non-number pull request is refused before any network call', async () => {
  let called = false;
  const gh = (async () => { called = true; return { data: THREE }; }) as unknown as GhJson;
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const result = await readStack(deps({ gh }), bad);
    assert.equal(result.stack, null, `for ${bad}`);
  }
  assert.equal(called, false, 'no request should be made for an invalid number');
});

test('a gh error degrades to no stack rather than throwing', async () => {
  const gh: GhJson = async () => ({ error: 'gh: not found' });
  const result = await readStack(deps({ gh }), 1);
  assert.equal(result.stack, null);
  assert.match(result.reason!, /not found/);
});

test('a malformed layer refuses the whole chain', async () => {
  // An unverified chain must not be used to state merge order.
  const gh: GhJson = async () => ({ data: { trunk: 'main', pull_requests: [null] } }) as never;
  const result = await readStack(deps({ gh }), 1);
  assert.equal(result.stack, null);
  assert.match(result.reason!, /was not an object/);
});

test('describe reports the blocker one floor down, not on this layer', async () => {
  // #2 is `unknown` so not ready; #3 is ready but cannot jump the queue.
  const result = await describeStackAction(deps(), { pullNumber: 3 });
  assert.equal(result.stacked, true);
  assert.match(result.text, /waiting on #2/);
  assert.match(result.text, /not on anything in #3 itself/);
  assert.equal(result.mergeable, 1, 'only the bottom layer can merge right now');
});

test('describe on an unstacked pull request says so plainly', async () => {
  const gh: GhJson = async () => ({ data: { trunk: 'main', pull_requests: [] } }) as never;
  const result = await describeStackAction(deps({ gh }), { pullNumber: 1 });
  assert.equal(result.stacked, false);
  assert.match(result.text, /not part of a stack/);
});

test('advice passes the working tree through and can say no', async () => {
  const small = await adviseStackingAction(deps());
  assert.equal(small.shouldStack, false);

  const big = await adviseStackingAction(deps({
    workingTreeGroups: async () => ({
      totalChangedLines: 700,
      groups: [
        { label: 'schema', files: ['m.sql'], changedLines: 200 },
        { label: 'api', files: ['r.ts'], changedLines: 500 },
      ],
    }),
  }));
  assert.equal(big.shouldStack, true);
  assert.deepEqual(big.layers.map((l) => l.label), ['schema', 'api']);
});

test('adding a layer targets the branch of the pull request it stacks on', async () => {
  // The whole point of a stack: the new layer's base is the layer below's HEAD,
  // not the trunk. Getting this wrong silently produces an ordinary PR.
  const calls: string[][] = [];
  const gh: GhJson = async (args) => {
    calls.push(args);
    if (args[1]?.includes('/pulls/7')) return { data: { head: { ref: 'feature-below' } } } as never;
    return { data: { html_url: 'https://github.com/o/r/pull/8' } } as never;
  };
  const result = await createStackLayerAction(deps({ gh }), {
    onPullNumber: 7, head: 'feature-above', title: 'Layer 2',
  });
  assert.equal(result.created, true);
  assert.equal(result.url, 'https://github.com/o/r/pull/8');
  const create = calls[1]!;
  assert.ok(create.includes('base=feature-below'), 'base must be the branch below, not the trunk');
  assert.ok(create.includes('head=feature-above'));
});

test('a layer is not created when the branch below cannot be resolved', async () => {
  // Falling back to an ordinary pull request would do something adjacent to
  // what was asked, which is how an agent action stops being trustworthy.
  const calls: string[][] = [];
  const gh: GhJson = async (args) => { calls.push(args); return { error: 'not found' }; };
  const result = await createStackLayerAction(deps({ gh }), {
    onPullNumber: 7, head: 'x', title: 'y',
  });
  assert.equal(result.created, false);
  assert.match(result.reason!, /could not resolve the head branch/);
  assert.equal(calls.length, 1, 'it must not attempt the create');
});

test('a missing branch or title is refused before any call', async () => {
  let called = false;
  const gh: GhJson = async () => { called = true; return { data: {} } as never; };
  for (const args of [{ onPullNumber: 7, head: '', title: 'y' }, { onPullNumber: 7, head: 'x', title: '  ' }]) {
    const result = await createStackLayerAction(deps({ gh }), args);
    assert.equal(result.created, false);
  }
  assert.equal(called, false);
});
