/**
 * ADR-035 D10 — the framing rules, asserted against the BYTES rather than
 * against the fact that something was sent.
 *
 * The gateway parses every frame here with an exact key set, an exact header
 * layout and a big-endian range (`audio-streaming-protocol.ts`). Each of those
 * is a rule this host can break silently: a little-endian range, an extra
 * property, a header a byte short — all of them still "send a frame", and all of
 * them close the connection at the far end for a reason no local test would see.
 * So these assertions decode what was produced instead of counting calls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMeetingStreamClose,
  encodeMeetingStreamAttach,
  encodeMeetingStreamAudio,
  encodeMeetingStreamInitialization,
  meetingStreamUrl,
  parseMeetingStreamMessage,
  preferredLatencyMode,
  MEETING_STREAM_FINISH_FRAME,
} from './meetingStreamProtocol.js';

test('an audio frame is the exact header the gateway parses, big-endian and in order', () => {
  const audio = Uint8Array.from([9, 8, 7]);
  const frame = encodeMeetingStreamAudio({ sequence: 258, startMs: 3_000, endMs: 6_000, audio });

  // Decoded the way `parseGatewayAudioBinaryFrame` decodes it: kind, u32
  // sequence, u64 start, u64 end, then the audio. Reading it back this way is
  // what makes an endianness or offset mistake fail here rather than at a
  // deployment's first live meeting.
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  assert.equal(frame[0], 0x02);
  assert.equal(view.getUint32(1, false), 258);
  assert.equal(view.getBigUint64(5, false), 3_000n);
  assert.equal(view.getBigUint64(13, false), 6_000n);
  assert.deepEqual([...frame.subarray(21)], [9, 8, 7]);
  assert.equal(frame.byteLength, 24);
});

test('a chunk with no audio or a reversed range is refused before it reaches the wire', () => {
  const audio = Uint8Array.from([1]);
  assert.throws(() => encodeMeetingStreamAudio({ sequence: 0, startMs: 0, endMs: 0, audio }));
  assert.throws(() => encodeMeetingStreamAudio({ sequence: 0, startMs: 10, endMs: 5, audio }));
  assert.throws(() => encodeMeetingStreamAudio({ sequence: -1, startMs: 0, endMs: 5, audio }));
  assert.throws(() => encodeMeetingStreamAudio({ sequence: 0, startMs: 0, endMs: 5, audio: new Uint8Array(0) }));
});

test('the attach frame carries exactly the gateway keys — an extra one fails the whole frame closed', () => {
  const attach = JSON.parse(encodeMeetingStreamAttach({
    bearer: 'br_test',
    requestedOrgId: 'org_1',
    sessionId: 'cap_1',
    mimeType: 'audio/webm;codecs=opus',
    language: null,
    latencyMode: 'low-latency',
    resumeFromSequence: null,
  })) as Record<string, unknown>;

  assert.deepEqual(Object.keys(attach).sort(), [
    'bearer', 'language', 'latencyMode', 'mimeType', 'requestedOrgId', 'resumeFromSequence', 'sessionId', 'type',
  ]);
  assert.equal(attach.type, 'attach');
  // Written out in full rather than spread conditionally: the gateway reads a
  // missing `language` and a null one identically, and an absent key here would
  // be one more shape for that reader to be lenient about.
  assert.equal(attach.language, null);
  assert.equal(attach.resumeFromSequence, null);
});

test('the finish frame is the single-key control frame the gateway accepts', () => {
  assert.deepEqual(JSON.parse(MEETING_STREAM_FINISH_FRAME), { type: 'finish' });
  assert.equal(Object.keys(JSON.parse(MEETING_STREAM_FINISH_FRAME) as object).length, 1);
});

test('the initialization frame is explicit even when it is empty', () => {
  assert.deepEqual([...encodeMeetingStreamInitialization(new Uint8Array(0))], [0x01]);
  assert.deepEqual([...encodeMeetingStreamInitialization(Uint8Array.from([4, 5]))], [0x01, 4, 5]);
});

test('a bearer never gets a ws:// URL to another machine', () => {
  // The attach frame carries the account key, so this is the same rule
  // `meetingsBridge.ts` applies to the batch POST. A remote plain-http endpoint
  // has no stream URL at all, which is what makes the host degrade instead.
  assert.equal(meetingStreamUrl('http://api.example.com'), null);
  assert.equal(meetingStreamUrl('ftp://api.example.com'), null);
  assert.equal(meetingStreamUrl('not a url'), null);
  assert.equal(
    meetingStreamUrl('https://api.example.com'),
    'wss://api.example.com/v1/audio/transcriptions/stream',
  );
  assert.equal(
    meetingStreamUrl('http://127.0.0.1:3748/'),
    'ws://127.0.0.1:3748/v1/audio/transcriptions/stream',
  );
  assert.equal(
    meetingStreamUrl('https://api.example.com/gateway'),
    'wss://api.example.com/gateway/v1/audio/transcriptions/stream',
  );
});

test('4422 is a verdict on the audio and everything unknown is a verdict on the endpoint', () => {
  // D7's whole distinction, spelled in close codes. Reading 4422 as an outage
  // would reconnect for ever over bytes that will never decode; reading an
  // unknown code as bad audio would throw away a live path that was working.
  assert.equal(classifyMeetingStreamClose(4422), 'audio');
  assert.equal(classifyMeetingStreamClose(1011), 'endpoint');
  assert.equal(classifyMeetingStreamClose(1013), 'endpoint');
  assert.equal(classifyMeetingStreamClose(4401), 'refused');
  assert.equal(classifyMeetingStreamClose(1008), 'refused');
  assert.equal(classifyMeetingStreamClose(1000), 'finished');
  assert.equal(classifyMeetingStreamClose(4999), 'endpoint');
});

test('the lowest advertised latency mode is the one asked for', () => {
  assert.equal(preferredLatencyMode(['high-accuracy', 'balanced', 'low-latency']), 'low-latency');
  assert.equal(preferredLatencyMode(['high-accuracy', 'balanced']), 'balanced');
  assert.equal(preferredLatencyMode(['high-accuracy']), 'high-accuracy');
  assert.equal(preferredLatencyMode([]), null);
});

test('only the three server messages parse, and a malformed attached is not one', () => {
  assert.deepEqual(
    parseMeetingStreamMessage(JSON.stringify({
      type: 'attached', sessionId: 'cap_1', generation: 'g1', acceptedResumeFromSequence: 4, latencyMode: 'balanced',
    })),
    { type: 'attached', sessionId: 'cap_1', generation: 'g1', acceptedResumeFromSequence: 4, latencyMode: 'balanced' },
  );
  assert.deepEqual(
    parseMeetingStreamMessage(JSON.stringify({ type: 'transcript.event', event: { kind: 'coverage' } })),
    { type: 'transcript.event', event: { kind: 'coverage' } },
  );
  assert.deepEqual(parseMeetingStreamMessage(JSON.stringify({ type: 'finished' })), { type: 'finished' });
  assert.equal(parseMeetingStreamMessage('not json'), null);
  assert.equal(parseMeetingStreamMessage(JSON.stringify({ type: 'attached', sessionId: 'cap_1' })), null);
  assert.equal(
    parseMeetingStreamMessage(JSON.stringify({
      type: 'attached', sessionId: 'cap_1', generation: 'g1', acceptedResumeFromSequence: -1, latencyMode: 'balanced',
    })),
    null,
  );
});
