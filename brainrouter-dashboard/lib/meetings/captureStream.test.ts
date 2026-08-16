/**
 * ADR-035 D10 — the browser's persistent-audio client, driven over a socket.
 *
 * Everything here asserts a VALUE that reached the wire or a value that came off
 * it: the bytes of a frame, the exact attach document, the sentence a close code
 * turns into. Asserting that `send` was called would pin the shape and not the
 * property — and the gateway closes the connection on a frame whose layout is
 * one byte out, which is a meeting that silently stops producing text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  captureStreamDrop,
  encodeAudioFrame,
  encodeInitializationFrame,
  openCaptureStream,
  type CaptureStreamDrop,
  type CaptureStreamSocket,
} from "./captureStream";

/** A `WebSocket` a test drives from the server's side. */
class TestSocket implements CaptureStreamSocket {
  binaryType = "";

  readonly sent: (string | ArrayBufferView)[] = [];

  closedWith: number | undefined | "none" = "none";

  onopen: (() => void) | null = null;

  onmessage: ((event: { readonly data: unknown }) => void) | null = null;

  onclose: ((event: { readonly code: number }) => void) | null = null;

  onerror: (() => void) | null = null;

  send(data: string | ArrayBufferView): void {
    if (this.closedWith !== "none") throw new Error("InvalidStateError: the socket is closed");
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  /** The handshake completes at the transport level. */
  open(): void {
    this.onopen?.();
  }

  /** The server says something. */
  deliver(value: unknown): void {
    this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  /** The server (or the network) closes with a code. */
  serverClose(code: number): void {
    this.onclose?.({ code });
  }

  get texts(): string[] {
    return this.sent.filter((frame): frame is string => typeof frame === "string");
  }

  get binaries(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
  }
}

interface Harness {
  readonly socket: TestSocket;
  readonly events: unknown[];
  readonly drops: CaptureStreamDrop[];
  readonly urls: string[];
  readonly stream: Promise<Awaited<ReturnType<typeof openCaptureStream>>>;
}

function connect(overrides: Partial<Parameters<typeof openCaptureStream>[0]> = {}): Harness {
  const socket = new TestSocket();
  const events: unknown[] = [];
  const drops: CaptureStreamDrop[] = [];
  const urls: string[] = [];
  const stream = openCaptureStream({
    baseUrl: "https://brain.example",
    token: "jwt-abc",
    orgId: "org-frozen-at-record",
    sessionId: "mtg-live",
    mimeType: "audio/webm;codecs=opus",
    language: "en",
    latencyMode: "low-latency",
    resumeFrom: null,
    handlers: {
      onEvent: (event) => events.push(event),
      onDrop: (drop) => drops.push(drop),
    },
    socket: (url) => {
      urls.push(url);
      return socket;
    },
    ...overrides,
  });
  // The promise is only settled by `attached`; a caller that never gets one
  // would otherwise leave an unhandled rejection behind a failing assertion.
  void stream.catch(() => undefined);
  return { socket, events, drops, urls, stream };
}

function attached(socket: TestSocket, acceptedResumeFromSequence: number | null = null): void {
  socket.deliver({
    type: "attached",
    sessionId: "mtg-live",
    generation: "gen-1",
    acceptedResumeFromSequence,
    latencyMode: "low-latency",
  });
}

test("D10 — the FIRST frame is the credential, and it names the recording's workspace and the PERSISTED resume position", async () => {
  const harness = connect({ resumeFrom: { kind: "transcript-committed", acknowledgedThroughSequence: 4 } });
  harness.socket.open();

  assert.equal(harness.socket.sent.length, 1, "nothing at all precedes the attach frame");
  assert.deepEqual(JSON.parse(harness.socket.texts[0]!), {
    type: "attach",
    bearer: "jwt-abc",
    requestedOrgId: "org-frozen-at-record",
    sessionId: "mtg-live",
    mimeType: "audio/webm;codecs=opus",
    language: "en",
    latencyMode: "low-latency",
    // Not 5, and not null: the gateway resumes at `accepted + 1`, so the token
    // names the last chunk already covered.
    resumeFromSequence: 4,
  });

  // The credential is in the frame and NOT in the URL, which every proxy on the
  // way would otherwise log — and the gateway refuses an upgrade with any query.
  assert.deepEqual(harness.urls, ["wss://brain.example/v1/audio/transcriptions/stream"]);
  assert.equal(harness.urls[0]!.includes("jwt-abc"), false);
  assert.equal(harness.urls[0]!.includes("?"), false);

  attached(harness.socket, 4);
  assert.equal((await harness.stream).acceptedThroughSequence, 4);
});

test("an endpoint that accepts LESS than was asked for is believed, so the host replays the rest", async () => {
  const harness = connect({ resumeFrom: { kind: "transcript-committed", acknowledgedThroughSequence: 9 } });
  harness.socket.open();
  attached(harness.socket, 3);
  assert.equal((await harness.stream).acceptedThroughSequence, 3);

  // …and an endpoint that holds nothing says so, which is a replay from zero.
  const fresh = connect();
  fresh.socket.open();
  attached(fresh.socket, null);
  assert.equal((await fresh.stream).acceptedThroughSequence, null);
});

test("the audio frame is the gateway's exact layout — kind, big-endian sequence and range, then the bytes", async () => {
  const harness = connect();
  harness.socket.open();
  attached(harness.socket);
  const stream = await harness.stream;

  stream.initialize({ mimeType: "audio/webm", initializationSegment: new Uint8Array([0xaa, 0xbb]) });
  await stream.send({ sequence: 0x01020304, startMs: 3_000, endMs: 6_000, audio: new Uint8Array([9, 8, 7]) });

  const [initialization, audio] = harness.socket.binaries;
  assert.deepEqual([...initialization!], [0x01, 0xaa, 0xbb], "0x01 then the container header, verbatim");

  assert.equal(audio![0], 0x02);
  const view = new DataView(audio!.buffer, audio!.byteOffset, audio!.byteLength);
  // Big-endian, which is what `parseGatewayAudioBinaryFrame` reads. A
  // little-endian writer produces a plausible frame with an absurd sequence and
  // the gateway closes on "audio sequence is not contiguous".
  assert.equal(view.getUint32(1, false), 0x01020304);
  assert.equal(view.getBigUint64(5, false), 3_000n);
  assert.equal(view.getBigUint64(13, false), 6_000n);
  assert.deepEqual([...audio!.subarray(21)], [9, 8, 7]);
  assert.equal(audio!.byteLength, 21 + 3, "header is 1 + 4 + 8 + 8 and the audio is the tail");

  // An empty initialization segment stays an EXPLICIT frame rather than none:
  // the gateway requires one before any audio, and a container with no prologue
  // is a real answer.
  assert.deepEqual([...encodeInitializationFrame(new Uint8Array(0))], [0x01]);
  assert.equal(encodeAudioFrame({ sequence: 0, startMs: 0, endMs: 1, audio: new Uint8Array([1]) }).byteLength, 22);
});

test("a transcript event is handed through UNREAD, so no second reader can grow in the transport", async () => {
  const harness = connect();
  harness.socket.open();
  attached(harness.socket);
  await harness.stream;

  // Deliberately not a valid event. Core's reducer is the only thing that says
  // what one means, and it fails closed; a client that filtered here would be a
  // second, laxer opinion in the one place nobody would look for it.
  harness.socket.deliver({ type: "transcript.event", event: { kind: "partial", nonsense: true } });
  harness.socket.deliver({ type: "transcript.event", event: { kind: "coverage", coveredThroughSequence: 2 } });
  harness.socket.deliver({ type: "something.else", event: { kind: "partial" } });

  assert.deepEqual(harness.events, [
    { kind: "partial", nonsense: true },
    { kind: "coverage", coveredThroughSequence: 2 },
  ]);
});

test("golden rule 23 — a close code becomes a SENTENCE, and a refusal is not an outage", async () => {
  // The distinction is D7's, drawn for the live path: an outage is waited out on
  // the recorder's own cadence, while a refusal stops this capture trying at all.
  // Collapsing them reconnects for ever against an endpoint that will never take
  // these bytes — or gives up on one that was only busy.
  assert.equal(captureStreamDrop(4422).kind, "refused");
  assert.match(captureStreamDrop(4422).reason, /decode/i);
  assert.equal(captureStreamDrop(4401).kind, "refused");
  assert.match(captureStreamDrop(4401).reason, /sign-in/i);
  assert.equal(captureStreamDrop(4409).kind, "refused");
  assert.equal(captureStreamDrop(1011).kind, "outage");
  assert.equal(captureStreamDrop(1013).kind, "outage");
  assert.equal(captureStreamDrop(1006).kind, "outage");
  // A code this table has never seen is an OUTAGE, which is the recoverable
  // reading: a mistaken outage costs a reconnect, a mistaken refusal costs the
  // live path for the rest of the meeting.
  assert.equal(captureStreamDrop(4999).kind, "outage");
  assert.notEqual(captureStreamDrop(4999).reason, "");

  const harness = connect();
  harness.socket.open();
  attached(harness.socket);
  await harness.stream;
  harness.socket.serverClose(4422);
  assert.deepEqual(harness.drops, [captureStreamDrop(4422)]);

  // Once, and only once: a second close must not report a second fallback.
  harness.socket.serverClose(1011);
  assert.equal(harness.drops.length, 1);
});

test("a connection that never attaches REJECTS, rather than resolving into a stream that swallows audio", async () => {
  const harness = connect();
  harness.socket.open();
  harness.socket.serverClose(4401);

  await assert.rejects(harness.stream, /sign-in/i);
  assert.deepEqual(harness.drops, [captureStreamDrop(4401)]);
});

test("close() says end-of-audio and waits for the endpoint's last word — and never waits on a socket already gone", async () => {
  const harness = connect();
  harness.socket.open();
  attached(harness.socket);
  const stream = await harness.stream;

  let done = false;
  const closing = Promise.resolve(stream.close()).then(() => {
    done = true;
  });
  assert.deepEqual(JSON.parse(harness.socket.texts[1]!), { type: "finish" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, "the endpoint still has a last utterance to seal");
  // Its final words are delivered BEFORE `finished`, which is the reason this
  // waits at all.
  harness.socket.deliver({ type: "transcript.event", event: { kind: "final", text: "last words" } });
  harness.socket.deliver({ type: "finished" });
  await closing;
  assert.equal(done, true);
  assert.deepEqual(harness.events, [{ kind: "final", text: "last words" }]);
  assert.notEqual(harness.socket.closedWith, "none", "and then the socket is let go");
  assert.deepEqual(harness.drops, [], "a close this host asked for is not a fallback");

  // The other ordering: the socket is already gone when Stop is pressed. A
  // `close()` that waited on a resolver nothing will ever call would wedge the
  // settle behind a network that has already answered.
  const gone = connect();
  gone.socket.open();
  attached(gone.socket);
  const goneStream = await gone.stream;
  gone.socket.serverClose(1006);
  await Promise.resolve(goneStream.close());
});
