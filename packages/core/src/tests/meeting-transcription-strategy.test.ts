/**
 * ADR-035 D10 — endpoint capability chooses the transcription strategy.
 *
 * The parser fails closed one fact at a time, and the selector fails closed on
 * the whole contract. A held connection is not the D10 strategy unless it also
 * emits partial text and owns utterance boundaries; otherwise the 20-second
 * segmented policy remains the honest behavior. Tests assert every normalized
 * value and the resulting mode/policy/live-text claims so deleting any one
 * capability check turns a guard red.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeTranscriptionEndpoint,
  liveTextExpected,
  SEGMENTED_ENDPOINT,
  selectTranscriptionMode,
  unitPolicyFor,
  type MeetingUnitPolicy,
} from '../meetings/index.js';

test('D10 — an absent or unrecognised capability document selects the segmented fallback', () => {
  for (const advertised of [undefined, null, 'streaming', 1, {}, { capabilities: ['partial_results'] }]) {
    const endpoint = describeTranscriptionEndpoint(advertised);
    assert.deepEqual(endpoint, SEGMENTED_ENDPOINT);
    assert.equal(selectTranscriptionMode(endpoint), 'segmented');
    assert.equal(liveTextExpected(endpoint), false);
  }
});

test('D10 — streaming alone stays segmented with the 20-second policy and no live-text promise', () => {
  const endpoint = describeTranscriptionEndpoint({ streaming: true });
  assert.deepEqual(endpoint, {
    streaming: true,
    partialResults: false,
    serverBoundaries: false,
  });
  const mode = selectTranscriptionMode(endpoint);
  assert.equal(mode, 'segmented');
  assert.equal(unitPolicyFor(mode).targetMs, 20_000);
  assert.equal(liveTextExpected(endpoint), false, 'a final-only stream cannot promise text mid-sentence');
});

test('D10 — explicit capability flags enable live text and endpoint-selected boundaries', () => {
  const endpoint = describeTranscriptionEndpoint({
    capabilities: ['streaming', 'partial-results', 'semantic-vad'],
  });
  assert.deepEqual(endpoint, {
    streaming: true,
    partialResults: true,
    serverBoundaries: true,
  });
  assert.equal(selectTranscriptionMode(endpoint), 'streaming');
  assert.equal(liveTextExpected(endpoint), true);
});

test('D10 — explicit false values outrank a capability list', () => {
  const endpoint = describeTranscriptionEndpoint({
    streaming: true,
    partialResults: false,
    serverBoundaries: false,
    capabilities: ['partial_results', 'server_boundaries'],
  });
  assert.deepEqual(endpoint, {
    streaming: true,
    partialResults: false,
    serverBoundaries: false,
  });
  assert.equal(selectTranscriptionMode(endpoint), 'segmented');
  assert.equal(liveTextExpected(endpoint), false);
});

test('D10 — each capability is independently required by the streaming strategy', () => {
  const missingStreaming = { streaming: false, partialResults: true, serverBoundaries: true };
  const missingPartials = { streaming: true, partialResults: false, serverBoundaries: true };
  const missingBoundaries = { streaming: true, partialResults: true, serverBoundaries: false };

  for (const endpoint of [missingStreaming, missingPartials, missingBoundaries]) {
    assert.equal(selectTranscriptionMode(endpoint), 'segmented');
    assert.equal(liveTextExpected(endpoint), false);
    assert.equal(unitPolicyFor(selectTranscriptionMode(endpoint)).targetMs, 20_000);
  }
});

test('D10 — unambiguous string booleans are normalized without treating other strings as truthy', () => {
  assert.deepEqual(
    describeTranscriptionEndpoint({ streaming: 'true', interim_results: 'true', server_vad: 'true' }),
    { streaming: true, partialResults: true, serverBoundaries: true },
  );
  assert.deepEqual(describeTranscriptionEndpoint({ streaming: 'maybe', partialResults: 'true' }), SEGMENTED_ENDPOINT);
});

test('D9/D10 — streaming keeps hard unit ceilings while segmented mode keeps its target', () => {
  const policy: MeetingUnitPolicy = { targetMs: 20_000, maxMs: 45_000, maxBytes: 8_000_000 };
  assert.equal(unitPolicyFor('segmented', policy), policy);
  assert.deepEqual(unitPolicyFor('streaming', policy), {
    targetMs: 45_000,
    maxMs: 45_000,
    maxBytes: 8_000_000,
  });
});
