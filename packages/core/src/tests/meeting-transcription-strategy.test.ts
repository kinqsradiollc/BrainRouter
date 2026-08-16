/**
 * ADR-035 D10 — strict, endpoint-owned transcription capability selection.
 *
 * Every fact in the v1 streaming contract gets a negative control. Removing a
 * conjunct, restoring an alias, accepting a string boolean, or weakening the
 * latency vocabulary therefore selects streaming in a case that explicitly
 * expects the segmented fallback.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedEndpointUnitPolicy,
  createStreamingTranscriptionCapabilities,
  describeTranscriptionEndpoint,
  isStreamingTranscriptionCapabilities,
  liveTextExpected,
  MEETING_TRANSCRIPTION_LATENCY_MODES,
  SEGMENTED_TRANSCRIPTION_CAPABILITIES,
  selectTranscriptionMode,
  unitPolicyFor,
  type MeetingTranscriptionStream,
  type MeetingTranscriptionCapabilities,
  type MeetingUnitPolicy,
} from '../meetings/index.js';

function completeStreamingDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    segmentedUpload: true,
    streaming: {
      persistent: true,
      partialResults: true,
      serverBoundaries: true,
      coverageCheckpoints: true,
      resumable: true,
      latencyModes: ['low-latency', 'balanced'],
    },
  };
}

test('D10 — the canonical segmented capability document is deeply immutable', () => {
  assert.deepEqual(SEGMENTED_TRANSCRIPTION_CAPABILITIES, {
    schemaVersion: 1,
    segmentedUpload: true,
    streaming: null,
  });
  assert.equal(Object.isFrozen(SEGMENTED_TRANSCRIPTION_CAPABILITIES), true);
  assert.deepEqual(MEETING_TRANSCRIPTION_LATENCY_MODES, ['low-latency', 'balanced', 'high-accuracy']);
  assert.equal(Object.isFrozen(MEETING_TRANSCRIPTION_LATENCY_MODES), true);
});

test('D10 — a complete v1 document normalizes to a frozen streaming contract', () => {
  const advertised = completeStreamingDocument();
  assert.equal(isStreamingTranscriptionCapabilities(advertised), true);

  const normalized = describeTranscriptionEndpoint(advertised);
  assert.deepEqual(normalized, advertised);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.streaming), true);
  assert.equal(Object.isFrozen(normalized.streaming?.latencyModes), true);
  assert.equal(selectTranscriptionMode(normalized), 'streaming');
  assert.equal(liveTextExpected(normalized), true);
});

test('D10 — unknown, legacy, malformed, and partial documents all select segmented', () => {
  const symbolExtra = completeStreamingDocument();
  (symbolExtra as Record<PropertyKey, unknown>)[Symbol('unexpected')] = true;
  const nonEnumerableExtra = completeStreamingDocument();
  Object.defineProperty(nonEnumerableExtra, 'unexpected', { value: true, enumerable: false });
  const nestedSymbolExtra = completeStreamingDocument();
  (nestedSymbolExtra.streaming as Record<PropertyKey, unknown>)[Symbol('unexpected')] = true;
  const fallbacks: unknown[] = [
    undefined,
    null,
    'streaming',
    1,
    [],
    {},
    { schemaVersion: 2, segmentedUpload: true, streaming: completeStreamingDocument().streaming },
    { streaming: true, partialResults: true, serverBoundaries: true },
    { capabilities: ['streaming', 'partial-results', 'semantic-vad'] },
    { ...completeStreamingDocument(), segmentedUpload: 'true' },
    { ...completeStreamingDocument(), unexpected: true },
    symbolExtra,
    nonEnumerableExtra,
    nestedSymbolExtra,
  ];

  for (const advertised of fallbacks) {
    assert.equal(isStreamingTranscriptionCapabilities(advertised), false);
    const normalized = describeTranscriptionEndpoint(advertised);
    assert.equal(normalized, SEGMENTED_TRANSCRIPTION_CAPABILITIES);
    assert.equal(selectTranscriptionMode(normalized), 'segmented');
    assert.equal(liveTextExpected(normalized), false);
  }
});

test('D10 — hostile capability access fails closed without escaping recognition', () => {
  const ownKeysThrow = new Proxy({}, {
    ownKeys(): never {
      throw new Error('hostile ownKeys');
    },
  });
  const streamingGetterThrow = {
    schemaVersion: 1,
    segmentedUpload: true,
    get streaming(): never {
      throw new Error('hostile streaming getter');
    },
  };
  const nestedOwnKeysThrow = {
    schemaVersion: 1,
    segmentedUpload: true,
    streaming: new Proxy({}, {
      ownKeys(): never {
        throw new Error('hostile nested ownKeys');
      },
    }),
  };

  for (const advertised of [ownKeysThrow, streamingGetterThrow, nestedOwnKeysThrow]) {
    assert.doesNotThrow(() => isStreamingTranscriptionCapabilities(advertised));
    assert.equal(isStreamingTranscriptionCapabilities(advertised), false);
    assert.doesNotThrow(() => describeTranscriptionEndpoint(advertised));
    assert.equal(describeTranscriptionEndpoint(advertised), SEGMENTED_TRANSCRIPTION_CAPABILITIES);
  }
});

test('D10 — every top-level v1 field is required with its exact value and shape', () => {
  for (const field of ['schemaVersion', 'segmentedUpload', 'streaming']) {
    const advertised = completeStreamingDocument();
    delete advertised[field];
    assert.equal(
      describeTranscriptionEndpoint(advertised),
      SEGMENTED_TRANSCRIPTION_CAPABILITIES,
      `${field} is required`,
    );
  }

  for (const advertised of [
    { ...completeStreamingDocument(), schemaVersion: '1' },
    { ...completeStreamingDocument(), segmentedUpload: false },
    { ...completeStreamingDocument(), streaming: [] },
    { ...completeStreamingDocument(), streaming: null },
  ]) {
    assert.equal(describeTranscriptionEndpoint(advertised), SEGMENTED_TRANSCRIPTION_CAPABILITIES);
  }
});

test('D10 — every streaming capability is independently mandatory and exactly true', () => {
  const required = [
    'persistent',
    'partialResults',
    'serverBoundaries',
    'coverageCheckpoints',
    'resumable',
  ] as const;

  for (const field of required) {
    const missing = completeStreamingDocument();
    delete (missing.streaming as Record<string, unknown>)[field];
    assert.equal(describeTranscriptionEndpoint(missing), SEGMENTED_TRANSCRIPTION_CAPABILITIES, `${field} is required`);

    const falseValue = completeStreamingDocument();
    (falseValue.streaming as Record<string, unknown>)[field] = false;
    assert.equal(
      describeTranscriptionEndpoint(falseValue),
      SEGMENTED_TRANSCRIPTION_CAPABILITIES,
      `${field} must be true`,
    );

    const stringValue = completeStreamingDocument();
    (stringValue.streaming as Record<string, unknown>)[field] = 'true';
    assert.equal(
      describeTranscriptionEndpoint(stringValue),
      SEGMENTED_TRANSCRIPTION_CAPABILITIES,
      `${field} cannot use a string boolean`,
    );
  }

  const extraNestedField = completeStreamingDocument();
  (extraNestedField.streaming as Record<string, unknown>).acknowledgements = true;
  assert.equal(describeTranscriptionEndpoint(extraNestedField), SEGMENTED_TRANSCRIPTION_CAPABILITIES);
});

test('D10 — latency modes are a non-empty, bounded, duplicate-free literal set', () => {
  const invalidLatencyModes: unknown[] = [
    [],
    ['fast'],
    ['balanced', 'balanced'],
    [true],
    ['low-latency', 'balanced', 'high-accuracy', 'fast'],
  ];
  for (const latencyModes of invalidLatencyModes) {
    const advertised = completeStreamingDocument();
    (advertised.streaming as Record<string, unknown>).latencyModes = latencyModes;
    assert.equal(
      describeTranscriptionEndpoint(advertised),
      SEGMENTED_TRANSCRIPTION_CAPABILITIES,
      JSON.stringify(latencyModes),
    );
  }

  assert.throws(
    () => createStreamingTranscriptionCapabilities([]),
    /one or more distinct supported latency modes/,
  );
  assert.throws(
    () => createStreamingTranscriptionCapabilities(['balanced', 'balanced']),
    /one or more distinct supported latency modes/,
  );
});

test('D10 — the capability builder preserves an endpoint-supported latency subset', () => {
  const capabilities = createStreamingTranscriptionCapabilities(['low-latency', 'high-accuracy']);
  assert.deepEqual(capabilities.streaming.latencyModes, ['low-latency', 'high-accuracy']);
  assert.equal(Object.isFrozen(capabilities.streaming.latencyModes), true);
});

test('D9/D10 — streaming keeps hard ceilings while segmented mode keeps its target', () => {
  const policy: MeetingUnitPolicy = { targetMs: 20_000, maxMs: 45_000, maxBytes: 8_000_000 };
  assert.equal(unitPolicyFor('segmented', policy), policy);
  const bounded = boundedEndpointUnitPolicy(policy);
  assert.deepEqual(bounded, {
    targetMs: 45_000,
    maxMs: 45_000,
    maxBytes: 8_000_000,
  });
  assert.deepEqual(unitPolicyFor('streaming', policy), bounded, 'the chunk ledger owns the ceiling-only policy');

  const segmented: MeetingTranscriptionCapabilities = SEGMENTED_TRANSCRIPTION_CAPABILITIES;
  assert.equal(unitPolicyFor(selectTranscriptionMode(segmented)).targetMs, 20_000);
});

test('D10 — the stream port contract carries bootstrap and structured persisted-chunk fields', async () => {
  const calls: unknown[] = [];
  const stream = {
    initialize(input) {
      calls.push({ operation: 'initialize', mimeType: input.mimeType, bytes: [...input.initializationSegment] });
    },
    send(chunk) {
      calls.push({
        operation: 'send',
        sequence: chunk.sequence,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        audio: [...chunk.audio],
      });
    },
    close() {
      calls.push({ operation: 'close' });
    },
  } satisfies MeetingTranscriptionStream;

  await stream.initialize({ mimeType: 'audio/webm', initializationSegment: Uint8Array.from([1, 2]) });
  await stream.send({ sequence: 3, startMs: 9_000, endMs: 12_000, audio: Uint8Array.from([7, 8]) });
  await stream.close();
  assert.deepEqual(calls, [
    { operation: 'initialize', mimeType: 'audio/webm', bytes: [1, 2] },
    { operation: 'send', sequence: 3, startMs: 9_000, endMs: 12_000, audio: [7, 8] },
    { operation: 'close' },
  ]);
});
