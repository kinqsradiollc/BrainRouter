/**
 * ADR-035 D10 — the handshake, in the order the gateway requires it.
 *
 * The gateway closes 1002 on the second frame it sees before attach resolves,
 * and refuses audio that arrives before the container bootstrap. Both are
 * ordering rules, so these tests assert the SEQUENCE of what reached the socket
 * — which is the only thing that can tell a connection that works from one that
 * sends the same frames in the wrong order.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { connectMeetingStream, type MeetingStreamSocketListeners } from './meetingStreamConnection.js';
import type { MeetingStreamAttachInput } from './meetingStreamProtocol.js';

const ATTACH: MeetingStreamAttachInput = {
  bearer: 'br_test',
  requestedOrgId: 'org_1',
  sessionId: 'cap_1',
  mimeType: 'audio/webm',
  language: null,
  latencyMode: 'low-latency',
  resumeFromSequence: null,
};

interface FakeSocket {
  readonly sent: Array<string | Uint8Array>;
  listeners: MeetingStreamSocketListeners;
  closed: boolean;
}

function harness(): { socket: FakeSocket; factory: (url: string, listeners: MeetingStreamSocketListeners) => { send(data: string | Uint8Array): void; close(): void } } {
  const socket: FakeSocket = { sent: [], listeners: null as unknown as MeetingStreamSocketListeners, closed: false };
  return {
    socket,
    factory: (_url, listeners) => {
      socket.listeners = listeners;
      return {
        send: (data) => { socket.sent.push(data); },
        close: () => { socket.closed = true; },
      };
    },
  };
}

function attached(accepted: number | null): string {
  return JSON.stringify({
    type: 'attached', sessionId: 'cap_1', generation: 'g1', acceptedResumeFromSequence: accepted, latencyMode: 'low-latency',
  });
}

test('attach is the only frame on the wire until the gateway answers it', async () => {
  const { socket, factory } = harness();
  const opening = connectMeetingStream({
    url: 'wss://example.invalid/stream',
    attach: ATTACH,
    initializationSegmentFor: () => Uint8Array.from([7, 7]),
    socket: factory,
    handlers: { onEvent: () => undefined },
  });
  socket.listeners.onOpen();

  // One frame, and it is the credential-bearing one. A bootstrap sent here
  // instead would be the 1002 the gateway answers a second pre-attach frame with.
  assert.equal(socket.sent.length, 1);
  assert.equal(JSON.parse(socket.sent[0] as string).type, 'attach');

  socket.listeners.onMessage(attached(3));
  const connection = await opening;
  // …and the bootstrap is the SECOND frame, before the caller could send audio.
  assert.equal(socket.sent.length, 2);
  assert.deepEqual([...(socket.sent[1] as Uint8Array)], [0x01, 7, 7]);
  assert.equal(connection.acceptedResumeFromSequence, 3);
});

test('the bootstrap follows the checkpoint the gateway ACCEPTED, not the one asked for', async () => {
  const { socket, factory } = harness();
  const opening = connectMeetingStream({
    url: 'wss://example.invalid/stream',
    attach: { ...ATTACH, resumeFromSequence: 9 },
    // The same rule `segmentAudio.ts` applies to a batch upload: a stream that
    // starts at chunk 0 carries its own header, so prepending one would decode
    // the first seconds twice.
    initializationSegmentFor: (accepted) => (accepted === null ? new Uint8Array(0) : Uint8Array.from([1, 2, 3])),
    socket: factory,
    handlers: { onEvent: () => undefined },
  });
  socket.listeners.onOpen();
  // The adapter is allowed to accept LESS than was asked for — a new decode it
  // cannot resume gives null — and the bootstrap has to follow that answer.
  socket.listeners.onMessage(attached(null));
  const connection = await opening;

  assert.deepEqual([...(socket.sent[1] as Uint8Array)], [0x01]);
  assert.equal(connection.acceptedResumeFromSequence, null);
});

test('a close before attach is the handshake failing, not a connection with nothing on it', async () => {
  const { socket, factory } = harness();
  const opening = connectMeetingStream({
    url: 'wss://example.invalid/stream',
    attach: ATTACH,
    initializationSegmentFor: () => new Uint8Array(0),
    socket: factory,
    handlers: { onEvent: () => undefined },
  });
  socket.listeners.onOpen();
  socket.listeners.onClose(4401);
  await assert.rejects(opening, /closed the connection \(4401\)/);
});

test('an attach the endpoint never answers is bounded rather than held open for the meeting', async () => {
  const { socket, factory } = harness();
  const opening = connectMeetingStream({
    url: 'wss://example.invalid/stream',
    attach: ATTACH,
    initializationSegmentFor: () => new Uint8Array(0),
    socket: factory,
    handlers: { onEvent: () => undefined },
    attachTimeoutMs: 5,
  });
  socket.listeners.onOpen();
  await assert.rejects(opening, /did not answer the attach request/);
  assert.equal(socket.closed, true);
});

test('transcript events reach the handler exactly as sent, and finish waits for the tail', async () => {
  const { socket, factory } = harness();
  const events: unknown[] = [];
  const opening = connectMeetingStream({
    url: 'wss://example.invalid/stream',
    attach: ATTACH,
    initializationSegmentFor: () => new Uint8Array(0),
    socket: factory,
    handlers: { onEvent: (event) => { events.push(event); } },
    finishTimeoutMs: 5,
  });
  socket.listeners.onOpen();
  socket.listeners.onMessage(attached(null));
  const connection = await opening;

  socket.listeners.onMessage(JSON.stringify({
    type: 'transcript.event',
    event: { kind: 'partial', utteranceId: 'u0', revision: 0, text: 'hel', startMs: 0, endMs: 900 },
  }));
  // Handed on untouched: the reducer in core is the one validator of this shape.
  assert.deepEqual(events, [{ kind: 'partial', utteranceId: 'u0', revision: 0, text: 'hel', startMs: 0, endMs: 900 }]);

  connection.send({ sequence: 0, startMs: 0, endMs: 3_000, audio: Uint8Array.from([1]) });
  assert.equal(socket.sent.length, 3);

  const finishing = connection.finish();
  assert.deepEqual(JSON.parse(socket.sent[3] as string), { type: 'finish' });
  socket.listeners.onMessage(JSON.stringify({ type: 'finished' }));
  await finishing;

  socket.listeners.onClose(1000);
  assert.equal(await connection.closed, 'finished');
  // A send after the close would be a chunk the caller believes was delivered.
  assert.throws(() => connection.send({ sequence: 1, startMs: 3_000, endMs: 6_000, audio: Uint8Array.from([2]) }));
});

test('a stalled tail does not hold Stop open — the audio is already durable', async () => {
  const { socket, factory } = harness();
  const opening = connectMeetingStream({
    url: 'wss://example.invalid/stream',
    attach: ATTACH,
    initializationSegmentFor: () => new Uint8Array(0),
    socket: factory,
    handlers: { onEvent: () => undefined },
    finishTimeoutMs: 5,
  });
  socket.listeners.onOpen();
  socket.listeners.onMessage(attached(null));
  const connection = await opening;
  // No `finished` ever arrives. What the endpoint never seals is sealed by
  // `stopCapture` for the segmented queue, so waiting longer buys nothing.
  await connection.finish();
});

test('a transport error ends the connection as an endpoint failure, which is the resumable one', async () => {
  const { socket, factory } = harness();
  const opening = connectMeetingStream({
    url: 'wss://example.invalid/stream',
    attach: ATTACH,
    initializationSegmentFor: () => new Uint8Array(0),
    socket: factory,
    handlers: { onEvent: () => undefined },
  });
  socket.listeners.onOpen();
  socket.listeners.onMessage(attached(null));
  const connection = await opening;
  socket.listeners.onError(new Error('socket hang up'));
  assert.equal(await connection.closed, 'endpoint');
});
