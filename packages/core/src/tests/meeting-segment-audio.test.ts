/**
 * ADR-035 D3 — the header-prefix rule, against real container prologues.
 *
 * This is the piece that decides whether per-segment transcription works at all:
 * get it wrong and every segment after the first is posted headerless, the
 * decoder refuses it, and the surface fills with stated gaps that look exactly
 * like a broken sidecar. So the assertions below are about byte offsets, not
 * about the function agreeing with itself.
 *
 * They live in core rather than in a host because the rule does (D1b). A copy
 * that existed on one surface only produced the worst possible version of this
 * feature: one transcribed segment, and 119 gaps that looked like a server
 * problem.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSegmentAudioReader,
  initializationSegmentLength,
  MAX_INITIALIZATION_SEGMENT_BYTES,
  segmentUploadBytes,
} from '../meetings/index.js';

/** EBML header bytes, then a Cluster element — the shape MediaRecorder emits. */
function webmFirstChunk(headerLength: number, payload = 8): Uint8Array {
  const bytes = new Uint8Array(headerLength + 4 + payload);
  bytes.fill(0xaa, 0, headerLength);
  bytes.set([0x1f, 0x43, 0xb6, 0x75], headerLength);
  bytes.fill(0xbb, headerLength + 4);
  return bytes;
}

/** `ftyp`/`moov` bytes, then a `moof` box (4-byte size, then the type). */
function mp4FirstChunk(initLength: number, payload = 8): Uint8Array {
  const bytes = new Uint8Array(initLength + 8 + payload);
  bytes.fill(0xaa, 0, initLength);
  bytes.set([0x00, 0x00, 0x00, 0x20], initLength);
  bytes.set([0x6d, 0x6f, 0x6f, 0x66], initLength + 4);
  bytes.fill(0xbb, initLength + 8);
  return bytes;
}

test('a WebM header ends where the first cluster begins', () => {
  assert.equal(initializationSegmentLength(webmFirstChunk(37)), 37);
});

test('an MP4 initialization segment ends at the start of the moof BOX, not its type', () => {
  // Off by four here and every later segment gets a truncated `moov`, which
  // decodes as nothing at all.
  assert.equal(initializationSegmentLength(mp4FirstChunk(96)), 96);
});

test('a container we do not recognise asks for no prefix rather than guessing one', () => {
  const opaque = new Uint8Array(64).fill(0x11);
  assert.equal(initializationSegmentLength(opaque), 0);
});

test('a marker found implausibly deep is audio data, not a header', () => {
  // Prepending a megabyte to every twenty-second segment would be the expensive
  // way to be wrong, so a match past the budget is treated as no match.
  assert.equal(initializationSegmentLength(webmFirstChunk(MAX_INITIALIZATION_SEGMENT_BYTES + 1, 1)), 0);
});

test('a cluster at offset zero is not a header', () => {
  // A later chunk handed here by mistake starts with a cluster; reporting a
  // zero-length prefix is right, and reporting -1 or throwing is not.
  const cluster = webmFirstChunk(0);
  assert.equal(initializationSegmentLength(cluster), 0);
});

test('segment 0 is passed through untouched', () => {
  const first = webmFirstChunk(12);
  assert.equal(segmentUploadBytes(0, first, first.slice(0, 12)), first);
});

test('a later segment is the header followed by exactly its own bytes', () => {
  const initialization = Uint8Array.from([1, 2, 3, 4]);
  const chunk = Uint8Array.from([9, 9, 9]);
  const upload = segmentUploadBytes(3, chunk, initialization);
  assert.deepEqual([...upload], [1, 2, 3, 4, 9, 9, 9]);
});

test('with no header to prepend, a later segment is still sent as-is', () => {
  // Better to let the endpoint judge the bytes than to refuse audio we hold.
  const chunk = Uint8Array.from([7, 7]);
  assert.equal(segmentUploadBytes(2, chunk, new Uint8Array(0)), chunk);
});

/** A host's chunk store: the first chunk carries a 12-byte header, the rest do not. */
function recorderChunks(count: number): { chunks: (Uint8Array | null)[]; reads: number[] } {
  const chunks: (Uint8Array | null)[] = [webmFirstChunk(12, 4)];
  for (let index = 1; index < count; index += 1) {
    // A bare cluster: exactly what MediaRecorder hands over after the first blob.
    chunks.push(Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, index, index]));
  }
  return { chunks, reads: [] };
}

function reader(store: { chunks: (Uint8Array | null)[]; reads: number[] }) {
  return createSegmentAudioReader({
    readChunk(index) {
      store.reads.push(index);
      return store.chunks[index] ?? null;
    },
  });
}

test('every segment after the first is posted with the header in front of it', async () => {
  // The fatal case: without this, segment 1 onward is a headerless fragment,
  // `ffmpeg -i` refuses it, and a working recording reads as a broken sidecar.
  const store = recorderChunks(3);
  const readSegment = reader(store);
  const first = await readSegment(0);
  assert.equal(first, store.chunks[0], 'segment 0 is already a file; do not copy it');

  const header = [...(store.chunks[0] as Uint8Array).slice(0, 12)];
  for (const index of [1, 2]) {
    const upload = await readSegment(index);
    assert.deepEqual([...upload.slice(0, 12)], header, `segment ${index} carries the container header`);
    assert.deepEqual([...upload.slice(12)], [...(store.chunks[index] as Uint8Array)]);
  }
});

test('the header is read once, not once per segment', async () => {
  // An hour-long meeting is ~180 segments; re-reading chunk 0 for each of them
  // would be 180 device reads for bytes that never change.
  const store = recorderChunks(4);
  const readSegment = reader(store);
  for (let index = 0; index < 4; index += 1) await readSegment(index);
  assert.deepEqual(store.reads, [0, 1, 2, 3]);
});

test('a queue rebuilt mid-meeting fetches the header it never saw', async () => {
  // §6's destructive test lands here: after a kill, the new queue may be asked
  // for segment 2 having never read segment 0.
  const store = recorderChunks(3);
  const readSegment = reader(store);
  const upload = await readSegment(2);
  assert.deepEqual(store.reads, [2, 0], 'it goes and gets the header on demand');
  assert.equal(upload.byteLength, 12 + 6);
  await readSegment(1);
  assert.deepEqual(store.reads, [2, 0, 1], 'and remembers it afterwards');
});

test('a missing first chunk costs a later segment nothing but its prefix', async () => {
  // Throwing here would spend a retry on a segment whose own audio is fine.
  const store = recorderChunks(2);
  store.chunks[0] = null;
  const upload = await reader(store)(1);
  assert.deepEqual([...upload], [...(store.chunks[1] as Uint8Array)]);
});

test('a chunk whose bytes are gone is this segment’s failure, and it says so', async () => {
  // D5 — it counts against the bound and ends as a stated gap, rather than
  // retrying for ever against a store that has nothing to give.
  const store = recorderChunks(2);
  store.chunks[1] = null;
  await assert.rejects(reader(store)(1), /segment 1 is no longer readable/);
});
