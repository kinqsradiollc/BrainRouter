/**
 * ADR-035 D10 — live utterance revisions and durable coverage checkpoints.
 *
 * Upstream finality and host durability are independent facts. Partial/final
 * events change only the ephemeral utterance buffer; a separate coverage event
 * may advance the transcript-committed checkpoint after proving an ordered D9
 * ledger prefix. Hosts must persist the returned transcript state and checkpoint
 * atomically before using that checkpoint as reconnect authority.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_STREAMING_TRANSCRIPT,
  reduceStreamingTranscript,
  validateTranscriptCommittedCheckpoint,
  type MeetingChunk,
  type MeetingStreamingTranscriptEvent,
  type MeetingStreamingTranscriptState,
} from '../meetings/index.js';

function ledger(...sequences: number[]): MeetingChunk[] {
  return sequences.map((sequence) => ({
    sequence,
    byteLength: 100,
    startMs: sequence * 3_000,
    endMs: (sequence + 1) * 3_000,
  }));
}

function partial(utteranceId: string, revision: number, text: string): MeetingStreamingTranscriptEvent {
  return { kind: 'partial', utteranceId, revision, text, startMs: 0, endMs: 3_000 };
}

function final(utteranceId: string, revision: number, text: string): MeetingStreamingTranscriptEvent {
  return { kind: 'final', utteranceId, revision, text, startMs: 0, endMs: 6_000 };
}

function coverage(coveredThroughSequence: number): MeetingStreamingTranscriptEvent {
  return { kind: 'coverage', coveredThroughSequence };
}

test('D10 — a checkpoint advances only through a contiguous persisted ledger prefix', () => {
  assert.deepEqual(validateTranscriptCommittedCheckpoint(null, 2, ledger(0, 1, 2, 3)), {
    kind: 'transcript-committed',
    acknowledgedThroughSequence: 2,
  });
  assert.deepEqual(validateTranscriptCommittedCheckpoint(0, 3, ledger(0, 1, 2, 3)), {
    kind: 'transcript-committed',
    acknowledgedThroughSequence: 3,
  });
});

test('D10 — duplicate, backwards, out-of-ledger, holed, duplicated, and reordered checkpoints are refused', () => {
  const invalid = [
    validateTranscriptCommittedCheckpoint(1, 1, ledger(0, 1, 2)),
    validateTranscriptCommittedCheckpoint(1, 0, ledger(0, 1, 2)),
    validateTranscriptCommittedCheckpoint(1, 3, ledger(0, 1, 2)),
    validateTranscriptCommittedCheckpoint(null, 2, ledger(0, 2)),
    validateTranscriptCommittedCheckpoint(0, 2, ledger(0, 1, 1, 2)),
    validateTranscriptCommittedCheckpoint(null, 2, ledger(1, 0, 2)),
    validateTranscriptCommittedCheckpoint(-1, 0, ledger(0)),
    validateTranscriptCommittedCheckpoint(null, 0.5, ledger(0)),
    validateTranscriptCommittedCheckpoint(Number.MAX_SAFE_INTEGER + 1, 0, ledger(0)),
    validateTranscriptCommittedCheckpoint(null, Number.MAX_SAFE_INTEGER + 1, ledger(0)),
  ];
  assert.deepEqual(invalid, [null, null, null, null, null, null, null, null, null, null]);
});

test('D10 — higher revisions replace one partial by utterance id without settling it', () => {
  const first = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, partial('utt-1', 0, 'Hel'), ledger(0));
  const revised = reduceStreamingTranscript(first, partial('utt-1', 1, 'Hello'), ledger(0));

  assert.equal(revised.utterances.length, 1, 'a revision replaces rather than appends');
  assert.deepEqual(revised.utterances[0], {
    kind: 'partial',
    utteranceId: 'utt-1',
    revision: 1,
    text: 'Hello',
    startMs: 0,
    endMs: 3_000,
    state: 'partial',
  });
  assert.equal(revised.checkpoint, null, 'partials never prove durable coverage');
  assert.equal(first.utterances[0]?.text, 'Hel', 'the reducer does not mutate prior state');
  assert.equal(Object.isFrozen(revised), true);
  assert.equal(Object.isFrozen(revised.utterances), true);
  assert.equal(Object.isFrozen(revised.utterances[0]), true);
});

test('D10 — stale or duplicate partial revisions cannot replace newer live text', () => {
  const current = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, partial('utt-1', 2, 'newest'), ledger(0));
  assert.equal(reduceStreamingTranscript(current, partial('utt-1', 2, 'duplicate'), ledger(0)), current);
  assert.equal(reduceStreamingTranscript(current, partial('utt-1', 1, 'stale'), ledger(0)), current);
  assert.equal(current.utterances[0]?.text, 'newest');
});

test('D10 — a final may settle the latest partial without inventing another revision', () => {
  const live = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, partial('utt-1', 4, 'same words'), ledger(0));
  const settled = reduceStreamingTranscript(live, final('utt-1', 4, 'same words'), ledger(0));

  assert.deepEqual(settled.utterances[0], {
    kind: 'final',
    utteranceId: 'utt-1',
    revision: 4,
    text: 'same words',
    startMs: 0,
    endMs: 6_000,
    state: 'final',
  });
  assert.equal(settled.checkpoint, null, 'upstream finality is not host durability');
});

test('D10 — partial and final events never advance the checkpoint', () => {
  const live = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, partial('utt-1', 0, 'One'), ledger(0));
  const settled = reduceStreamingTranscript(live, final('utt-1', 1, 'One.'), ledger(0));
  const second = reduceStreamingTranscript(settled, final('utt-2', 0, 'Two.'), ledger(0));
  assert.equal(live.checkpoint, null);
  assert.equal(settled.checkpoint, null);
  assert.equal(second.checkpoint, null);
});

test('D10 — a final utterance is immutable to duplicate, stale, and later revisions', () => {
  const settled = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, final('utt-1', 1, 'settled words'), ledger(0));
  const arrivals = [
    final('utt-1', 1, 'duplicate overwrite'),
    partial('utt-1', 0, 'stale overwrite'),
    partial('utt-1', 2, 'late overwrite'),
    final('utt-1', 3, 'later overwrite'),
  ];
  for (const event of arrivals) {
    assert.equal(reduceStreamingTranscript(settled, event, ledger(0)), settled);
  }
  assert.equal(settled.utterances[0]?.text, 'settled words');
});

test('D10 — multiple finals are followed by one independent coverage transition', () => {
  const first = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, final('utt-1', 0, 'One.'), ledger(0));
  const second = reduceStreamingTranscript(first, final('utt-2', 0, 'Two.'), ledger(0));
  assert.equal(second.checkpoint, null);

  const covered = reduceStreamingTranscript(second, coverage(0), ledger(0));
  assert.deepEqual(covered.utterances.map(({ utteranceId, text, state }) => ({ utteranceId, text, state })), [
    { utteranceId: 'utt-1', text: 'One.', state: 'final' },
    { utteranceId: 'utt-2', text: 'Two.', state: 'final' },
  ]);
  assert.deepEqual(covered.checkpoint, {
    kind: 'transcript-committed',
    acknowledgedThroughSequence: 0,
  });
});

test('D10 — coverage waits for an overlapping partial to become final', () => {
  const live = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, partial('utt-1', 0, 'One'), ledger(0));
  assert.equal(reduceStreamingTranscript(live, coverage(0), ledger(0)), live);
  assert.equal(live.checkpoint, null);
  assert.equal(live.utterances[0]?.state, 'partial');

  const finalized = reduceStreamingTranscript(live, final('utt-1', 0, 'One.'), ledger(0));
  const covered = reduceStreamingTranscript(finalized, coverage(0), ledger(0));
  assert.equal(finalized.checkpoint, null);
  assert.equal(covered.utterances[0]?.state, 'final');
  assert.equal(covered.checkpoint?.acknowledgedThroughSequence, 0);
});

test('D10 — a chunk-one partial blocks coverage one until that utterance is final', () => {
  const chunks = ledger(0, 1);
  const chunkOnePartial = { ...partial('utt-1', 0, 'One'), startMs: 3_000, endMs: 6_000 };
  const live = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, chunkOnePartial, chunks);
  assert.equal(reduceStreamingTranscript(live, coverage(1), chunks), live);
  assert.equal(live.checkpoint, null);

  const chunkOneFinal = { ...final('utt-1', 0, 'One.'), startMs: 3_000, endMs: 6_000 };
  const finalized = reduceStreamingTranscript(live, chunkOneFinal, chunks);
  const covered = reduceStreamingTranscript(finalized, coverage(1), chunks);
  assert.equal(covered.utterances[0]?.state, 'final');
  assert.equal(covered.checkpoint?.acknowledgedThroughSequence, 1);
});

test('D10 — silence-only coverage can advance without an utterance', () => {
  const covered = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, coverage(1), ledger(0, 1));
  assert.deepEqual(covered.utterances, []);
  assert.deepEqual(covered.checkpoint, {
    kind: 'transcript-committed',
    acknowledgedThroughSequence: 1,
  });
});

test('D10 — covered silence rejects late text inside its range but permits the exact boundary', () => {
  const covered = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, coverage(0), ledger(0));
  assert.equal(reduceStreamingTranscript(covered, partial('late-partial', 0, 'unsafe'), ledger(0)), covered);
  assert.equal(reduceStreamingTranscript(covered, final('late-final', 0, 'unsafe'), ledger(0)), covered);
  assert.deepEqual(covered.utterances, []);

  const boundaryPartial = { ...partial('next-partial', 0, 'safe'), startMs: 3_000, endMs: 6_000 };
  const boundaryFinal = { ...final('next-final', 0, 'safe'), startMs: 3_000, endMs: 6_000 };
  const withPartial = reduceStreamingTranscript(covered, boundaryPartial, ledger(0));
  const withFinal = reduceStreamingTranscript(withPartial, boundaryFinal, ledger(0));
  assert.deepEqual(withFinal.utterances.map(({ utteranceId, state }) => ({ utteranceId, state })), [
    { utteranceId: 'next-partial', state: 'partial' },
    { utteranceId: 'next-final', state: 'final' },
  ]);
});

test('D10 — checkpoint one rejects text inside chunk one and permits the exact 6000ms boundary', () => {
  const chunks = ledger(0, 1);
  const covered = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, coverage(1), chunks);
  const insidePartial = { ...partial('late-partial', 0, 'unsafe'), startMs: 3_000, endMs: 6_000 };
  const insideFinal = { ...final('late-final', 0, 'unsafe'), startMs: 5_999, endMs: 6_000 };
  assert.equal(reduceStreamingTranscript(covered, insidePartial, chunks), covered);
  assert.equal(reduceStreamingTranscript(covered, insideFinal, chunks), covered);

  const boundary = { ...final('next-final', 0, 'safe'), startMs: 6_000, endMs: 9_000 };
  const accepted = reduceStreamingTranscript(covered, boundary, chunks);
  assert.equal(accepted.utterances[0]?.text, 'safe');
  assert.equal(accepted.utterances[0]?.startMs, 6_000);
});

test('D10 — invalid, duplicate, or backwards coverage cannot move trusted authority', () => {
  const covered = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, coverage(1), ledger(0, 1));
  assert.equal(reduceStreamingTranscript(covered, coverage(1), ledger(0, 1)), covered);
  assert.equal(reduceStreamingTranscript(covered, coverage(0), ledger(0, 1)), covered);
  assert.equal(reduceStreamingTranscript(covered, coverage(2), ledger(0, 2)), covered);
  assert.equal(covered.checkpoint?.acknowledgedThroughSequence, 1);
});

test('D10 — coverage refuses zero-byte, reversed, non-finite, and overlapping D9 ledger values', () => {
  const invalidLedgers: MeetingChunk[][] = [
    [{ sequence: 0, byteLength: 0, startMs: 0, endMs: 3_000 }],
    [{ sequence: 0, byteLength: 100, startMs: 0, endMs: 0 }],
    [{ sequence: 0, byteLength: 100, startMs: 3_000, endMs: 2_000 }],
    [{ sequence: 0, byteLength: 100, startMs: 0, endMs: Number.POSITIVE_INFINITY }],
    [
      { sequence: 0, byteLength: 100, startMs: 0, endMs: 4_000 },
      { sequence: 1, byteLength: 100, startMs: 3_000, endMs: 6_000 },
    ],
  ];
  for (const chunks of invalidLedgers) {
    const through = chunks.length - 1;
    assert.equal(
      reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, coverage(through), chunks),
      EMPTY_STREAMING_TRANSCRIPT,
    );
  }
});

test('D10 — corrupt existing checkpoints cannot authorize coverage', () => {
  const corruptCheckpoints: unknown[] = [
    { kind: 'transcript-committed', acknowledgedThroughSequence: -1 },
    { kind: 'transcript-committed', acknowledgedThroughSequence: 0.5 },
    { kind: 'transcript-committed', acknowledgedThroughSequence: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'bytes-received', acknowledgedThroughSequence: 0 },
    { kind: 'transcript-committed', acknowledgedThroughSequence: 0, extra: true },
  ];
  for (const checkpoint of corruptCheckpoints) {
    const corrupt = { utterances: [], checkpoint } as unknown as MeetingStreamingTranscriptState;
    assert.equal(reduceStreamingTranscript(corrupt, coverage(1), ledger(0, 1)), corrupt);
  }
});

test('D10 — coverage canonicalizes prior authority and leaves the prior persisted state untouched', () => {
  const mutableCheckpoint = { kind: 'transcript-committed', acknowledgedThroughSequence: 0 };
  const persisted = {
    utterances: [],
    checkpoint: mutableCheckpoint,
  } as unknown as MeetingStreamingTranscriptState;

  const next = reduceStreamingTranscript(persisted, coverage(1), ledger(0, 1));
  assert.notEqual(next, persisted);
  assert.deepEqual(persisted.checkpoint, mutableCheckpoint, 'failed persistence may keep using this prior authority');
  assert.deepEqual(next.checkpoint, { kind: 'transcript-committed', acknowledgedThroughSequence: 1 });
  assert.notEqual(next.checkpoint, mutableCheckpoint);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.utterances), true);
  assert.equal(Object.isFrozen(next.checkpoint), true);
});

test('D10 — mutable restored authority is deep-canonicalized before partial and final events', () => {
  const mutableCheckpoint = { kind: 'transcript-committed', acknowledgedThroughSequence: 0 };
  const mutableUtterances: unknown[] = [];
  const restored = {
    utterances: mutableUtterances,
    checkpoint: mutableCheckpoint,
  } as unknown as MeetingStreamingTranscriptState;
  const nextPartial = { ...partial('utt-1', 0, 'next'), startMs: 3_000, endMs: 6_000 };
  const live = reduceStreamingTranscript(restored, nextPartial, ledger(0));

  mutableCheckpoint.acknowledgedThroughSequence = 99;
  mutableUtterances.push({ text: 'poison' });
  assert.equal(live.checkpoint?.acknowledgedThroughSequence, 0);
  assert.equal(live.utterances.length, 1);
  assert.equal(live.utterances[0]?.text, 'next');
  assert.equal(Object.isFrozen(live.checkpoint), true);
  assert.equal(Object.isFrozen(live.utterances[0]), true);

  const nextFinal = { ...final('utt-1', 0, 'next.'), startMs: 3_000, endMs: 6_000 };
  const settled = reduceStreamingTranscript(live, nextFinal, ledger(0));
  assert.equal(settled.utterances[0]?.state, 'final');
  assert.equal(settled.utterances[0]?.text, 'next.');
});

test('D10 — mutable restored final text is copied before coverage can authorize resume', () => {
  const mutableFinal = {
    kind: 'final',
    utteranceId: 'utt-1',
    revision: 0,
    text: 'One.',
    startMs: 0,
    endMs: 3_000,
    state: 'final',
  };
  const restored = { utterances: [mutableFinal], checkpoint: null } as unknown as MeetingStreamingTranscriptState;
  const covered = reduceStreamingTranscript(restored, coverage(0), ledger(0));

  mutableFinal.text = 'mutated after reduction';
  assert.equal(covered.utterances[0]?.text, 'One.');
  assert.equal(covered.checkpoint?.acknowledgedThroughSequence, 0);
  assert.equal(Object.isFrozen(covered.utterances[0]), true);
});

test('D10 — a restored utterance kind/state mismatch cannot authorize coverage', () => {
  const mismatched = {
    utterances: [{
      kind: 'final',
      utteranceId: 'existing',
      revision: 0,
      text: 'Existing.',
      startMs: 0,
      endMs: 3_000,
      state: 'partial',
    }],
    checkpoint: null,
  } as unknown as MeetingStreamingTranscriptState;

  const result = reduceStreamingTranscript(mismatched, coverage(0), ledger(0));
  assert.equal(result, mismatched);
  assert.equal(result.checkpoint, null);
});

test('D10 — malformed restored utterance timing fails closed before an event can act', () => {
  const malformedTimes = [
    { startMs: Number.NaN, endMs: 3_000 },
    { startMs: -1, endMs: 3_000 },
    { startMs: 3_000, endMs: 3_000 },
    { startMs: 3_000, endMs: 2_000 },
    { startMs: 0, endMs: Number.POSITIVE_INFINITY },
  ];
  for (const timing of malformedTimes) {
    const restored = {
      utterances: [{
        kind: 'final',
        utteranceId: 'existing',
        revision: 0,
        text: 'Existing.',
        state: 'final',
        ...timing,
      }],
      checkpoint: null,
    } as unknown as MeetingStreamingTranscriptState;
    assert.equal(reduceStreamingTranscript(restored, final('new', 0, 'unsafe'), ledger(0)), restored);
  }
});

test('D10 — hostile restored state fails closed without throwing or reading through it', () => {
  const ownKeysThrow = new Proxy({}, {
    ownKeys(): never {
      throw new Error('hostile state ownKeys');
    },
  });
  const utterancesGetterThrow = Object.defineProperty({ checkpoint: null }, 'utterances', {
    get(): never {
      throw new Error('hostile utterances getter');
    },
  });
  const hostileEntry = new Proxy({}, {
    ownKeys(): never {
      throw new Error('hostile entry ownKeys');
    },
  });
  const entryState = { utterances: [hostileEntry], checkpoint: null };

  for (const restored of [ownKeysThrow, utterancesGetterThrow, entryState]) {
    assert.doesNotThrow(() => reduceStreamingTranscript(
      restored as unknown as MeetingStreamingTranscriptState,
      final('new', 0, 'unsafe'),
      ledger(0),
    ));
    assert.equal(
      reduceStreamingTranscript(
        restored as unknown as MeetingStreamingTranscriptState,
        final('new', 0, 'unsafe'),
        ledger(0),
      ),
      restored,
    );
  }
});

test('D10 — malformed live and coverage events fail closed without mutating the buffer', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    1,
    'partial',
    { ...partial('', 0, 'empty id') },
    { ...partial('utt-1', -1, 'negative revision') },
    { ...partial('utt-1', 0.5, 'fractional revision') },
    { ...partial('utt-1', Number.MAX_SAFE_INTEGER + 1, 'unsafe revision') },
    { ...partial('utt-1', 0, 'wrong text'), text: 7 },
    { ...partial('utt-1', 0, 'NaN start'), startMs: Number.NaN },
    { ...partial('utt-1', 0, 'negative start'), startMs: -1 },
    { ...partial('utt-1', 0, 'infinite start'), startMs: Number.POSITIVE_INFINITY },
    { ...partial('utt-1', 0, 'NaN end'), endMs: Number.NaN },
    { ...partial('utt-1', 0, 'negative end'), endMs: -1 },
    { ...partial('utt-1', 0, 'infinite end'), endMs: Number.POSITIVE_INFINITY },
    { ...partial('utt-1', 0, 'zero duration'), startMs: 3_000, endMs: 3_000 },
    { ...final('utt-1', 0, 'zero duration'), startMs: 3_000, endMs: 3_000 },
    { ...partial('utt-1', 0, 'backwards time'), startMs: 4_000, endMs: 3_000 },
    { ...partial('utt-1', 0, 'extra ACK'), acknowledgedThroughSequence: 0 },
    { ...final('utt-1', 0, 'extra ACK'), acknowledgedThroughSequence: 0 },
    { kind: 'coverage' },
    { kind: 'coverage', coveredThroughSequence: -1 },
    { kind: 'coverage', coveredThroughSequence: 0.5 },
    { kind: 'coverage', coveredThroughSequence: 0, extra: true },
    { ...partial('utt-1', 0, 'symbol field'), [Symbol('unexpected')]: true },
  ];
  for (const event of malformed) {
    assert.doesNotThrow(() => reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, event, ledger(0)));
    assert.equal(
      reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, event, ledger(0)),
      EMPTY_STREAMING_TRANSCRIPT,
    );
  }
});

test('D10 — hostile event access fails closed and never escapes the reducer', () => {
  const ownKeysThrow = new Proxy({}, {
    get(_target, key): unknown {
      return key === 'kind' ? 'partial' : undefined;
    },
    ownKeys(): never {
      throw new Error('hostile ownKeys');
    },
  });
  const getterThrow = Object.defineProperty({}, 'kind', {
    get(): never {
      throw new Error('hostile getter');
    },
  });

  for (const event of [ownKeysThrow, getterThrow]) {
    assert.doesNotThrow(() => reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, event, ledger(0)));
    assert.equal(reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, event, ledger(0)), EMPTY_STREAMING_TRANSCRIPT);
  }
});

test('D10 — accepted events are reconstructed as canonical deeply frozen entries', () => {
  const event: Record<string, unknown> = {
    kind: 'final',
    utteranceId: 'utt-1',
    revision: 0,
    startMs: 0,
    endMs: 3_000,
  };
  Object.defineProperty(event, 'text', { value: 'canonical text', enumerable: false });

  const state = reduceStreamingTranscript(EMPTY_STREAMING_TRANSCRIPT, event, ledger(0));
  assert.deepEqual(state.utterances[0], {
    kind: 'final',
    utteranceId: 'utt-1',
    revision: 0,
    text: 'canonical text',
    startMs: 0,
    endMs: 3_000,
    state: 'final',
  });
  assert.deepEqual(Reflect.ownKeys(state.utterances[0] ?? {}), [
    'kind',
    'utteranceId',
    'revision',
    'text',
    'startMs',
    'endMs',
    'state',
  ]);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.utterances), true);
  assert.equal(Object.isFrozen(state.utterances[0]), true);
});
