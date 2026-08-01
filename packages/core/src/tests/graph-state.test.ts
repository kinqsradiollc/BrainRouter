/**
 * ADR-027 D2 (P3-1) — typed graph state.
 *
 * The property under test is the one a turn loop cannot give you: every channel
 * declares HOW UPDATES MERGE, so parallel fan-in is defined rather than a data
 * race, and a checkpoint is a value rather than a snapshot of something still
 * being mutated underneath it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GraphState,
  GraphStateError,
  lastValue,
  appendAll,
  unionOf,
  sum,
  exclusive,
} from '../graph/graphState.js';

const schema = {
  status: { reducer: lastValue<string>(), initial: 'pending' },
  messages: { reducer: appendAll<string>() },
  filesSeen: { reducer: unionOf<string>() },
  tokens: { reducer: sum() },
};

test('initial values come from the schema; unset channels are undefined', () => {
  const state = GraphState.create(schema);
  assert.equal(state.get('status'), 'pending');
  assert.equal(state.get('messages'), undefined, 'absent until written, not silently empty');
});

test('each channel folds by its own reducer', () => {
  const state = GraphState.create(schema)
    .apply({ status: 'running', messages: ['a'], tokens: 10 })
    .apply({ messages: ['b'], tokens: 5 });

  assert.equal(state.get('status'), 'running');
  assert.deepEqual(state.get('messages'), ['a', 'b'], 'append, not replace');
  assert.equal(state.get('tokens'), 15, 'sum, not replace');
});

test('applying returns a NEW state — a checkpoint is a value, not a live object', () => {
  const first = GraphState.create(schema).apply({ messages: ['a'] });
  const second = first.apply({ messages: ['b'] });
  assert.deepEqual(first.get('messages'), ['a'], 'the earlier state is unchanged');
  assert.deepEqual(second.get('messages'), ['a', 'b']);
  assert.notEqual(first, second);
});

test('fan-in reducers are order-independent in content', () => {
  // This is what makes parallel branches safe. The same updates in either order
  // must produce the same set and the same total.
  const a = { filesSeen: ['x.ts', 'y.ts'], tokens: 3 };
  const b = { filesSeen: ['y.ts', 'z.ts'], tokens: 4 };

  const forward = GraphState.create(schema).applyAll([a, b]);
  const reverse = GraphState.create(schema).applyAll([b, a]);

  assert.deepEqual([...forward.get('filesSeen')!].sort(), ['x.ts', 'y.ts', 'z.ts']);
  assert.deepEqual([...forward.get('filesSeen')!].sort(), [...reverse.get('filesSeen')!].sort());
  assert.equal(forward.get('tokens'), reverse.get('tokens'));
});

test('unionOf de-duplicates while preserving first-seen order', () => {
  const state = GraphState.create(schema)
    .apply({ filesSeen: ['b', 'a'] })
    .apply({ filesSeen: ['a', 'c'] });
  assert.deepEqual(state.get('filesSeen'), ['b', 'a', 'c']);
});

test('lastValue IS order-dependent — and that is the visible signal', () => {
  // Choosing lastValue for a channel two parallel branches write is the bug.
  // It should be legible in the schema, not hidden inside a merge strategy.
  const forward = GraphState.create(schema).applyAll([{ status: 'a' }, { status: 'b' }]);
  const reverse = GraphState.create(schema).applyAll([{ status: 'b' }, { status: 'a' }]);
  assert.notEqual(forward.get('status'), reverse.get('status'));
});

test('an exclusive channel rejects a conflicting second write', () => {
  const owned = { winner: { reducer: exclusive<string>('winner') } };
  const once = GraphState.create(owned).apply({ winner: 'branch-a' });
  assert.equal(once.get('winner'), 'branch-a');
  // Re-writing the same value is a harmless retry; a different one is a bug.
  assert.doesNotThrow(() => once.apply({ winner: 'branch-a' }));
  assert.throws(() => once.apply({ winner: 'branch-b' }), GraphStateError);
});

test('an undefined update value is a no-op, not a wipe', () => {
  const state = GraphState.create(schema)
    .apply({ status: 'running' })
    .apply({ status: undefined as unknown as string });
  assert.equal(state.get('status'), 'running');
});

test('writing an unknown channel throws rather than being dropped', () => {
  assert.throws(
    () => GraphState.create(schema).apply({ nope: 'x' } as never),
    GraphStateError,
  );
});

test('a checkpoint round-trips exactly', () => {
  const before = GraphState.create(schema).apply({ status: 'running', messages: ['a'], tokens: 7 });
  const after = GraphState.restore(schema, before.toCheckpoint());
  assert.equal(after.get('status'), 'running');
  assert.deepEqual(after.get('messages'), ['a']);
  assert.equal(after.get('tokens'), 7);
});

test('a checkpoint from a different graph version is refused, not partially loaded', () => {
  // Dropping unknown channels would resume into a state the graph never
  // actually reached — worse than refusing to resume.
  assert.throws(
    () => GraphState.restore(schema, { status: 'running', retired: 1 }),
    (error: Error) => {
      assert.ok(error instanceof GraphStateError);
      assert.match(error.message, /retired/);
      return true;
    },
  );
});

test('a restored state continues folding normally', () => {
  const restored = GraphState.restore(schema, { messages: ['a'], tokens: 1 });
  const next = restored.apply({ messages: ['b'], tokens: 2 });
  assert.deepEqual(next.get('messages'), ['a', 'b']);
  assert.equal(next.get('tokens'), 3);
});

test('a checkpoint is a copy, not a live view of the state', () => {
  const state = GraphState.create(schema).apply({ messages: ['a'] });
  const checkpoint = state.toCheckpoint();
  (checkpoint.messages as string[]).push('tampered');
  assert.deepEqual(state.get('messages'), ['a'], 'mutating the checkpoint must not reach the state');
});
