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

test('createStackLayerAction is GONE, not merely unused — ADR-028 A2', async () => {
  // It reported created:true for a pull request that was never registered as a
  // stack. Removed rather than deprecated: a tool that reports success for work
  // it did not do is worse than a missing tool, because the human stops
  // checking. This test exists so it cannot quietly return.
  const mod = await import('./stackActions.js') as Record<string, unknown>;
  for (const gone of ['createStackLayerAction', 'addStackLayer', 'createLayer']) {
    assert.equal(mod[gone], undefined, `${gone} must not exist until A2's replacement lands`);
  }
});
