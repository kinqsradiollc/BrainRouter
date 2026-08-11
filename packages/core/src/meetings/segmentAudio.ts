/**
 * ADR-035 D3 — turning ONE stored chunk into something the STT endpoint can
 * decode.
 *
 * This module exists because of a property of `MediaRecorder` that quietly
 * breaks per-segment transcription if nobody accounts for it: with an explicit
 * timeslice (D1), only the FIRST blob carries the container header. Every blob
 * after it is a bare media fragment — a Matroska cluster, or an MP4
 * `moof`/`mdat` pair — and a bare fragment is not a file. Post one to
 * `/v1/audio/transcriptions` and the decoder (`ffmpeg -i`) rejects it.
 *
 * So D3's "each segment is transcribed as it lands" would, without this, produce
 * exactly one successful segment and 119 stated gaps. That failure is worse than
 * the one the ADR set out to fix, because it would look like the feature working.
 *
 * The fix is the one the browser's own Media Source Extensions use: an
 * INITIALIZATION SEGMENT (everything in the first blob before its first media
 * fragment) followed by any single media fragment is a valid, decodable stream.
 * So this module finds where the first blob stops being a header and starts
 * being audio, and the queue's `readSegment` port prepends that prefix to every
 * later chunk.
 *
 * Why prepend a prefix rather than the alternatives:
 *
 * - Prepending the WHOLE first chunk would make every segment's transcript begin
 *   with a repeat of the meeting's first twenty seconds.
 * - Restarting the recorder every twenty seconds would give self-contained blobs
 *   but drop real audio at each boundary — the ADR already worries (§5.1) about
 *   segment edges cutting words in half, and this would cut them on purpose.
 * - Posting chunks 0..N cumulatively grows without bound, which is the 40 MB
 *   ceiling D3 exists to remove.
 *
 * **Why it lives in core and not in a host.** This is container framing: pure
 * byte inspection, no `Blob`, no `MediaRecorder`, no filesystem, no network. It
 * is precisely what D1b means by "the segment protocol is SHARED — only the
 * write target is host-specific". A host that had its own copy, or no copy at
 * all, would be the ADR-029 failure this repo keeps paying for: the second host
 * silently transcribing segment 0 and nothing else. Being pure is also what lets
 * the marker search be tested against real container prologues in a runner with
 * no `MediaRecorder` in it.
 */

/**
 * Matroska/WebM `Cluster` element id. A cluster is the first thing in the file
 * that is audio rather than description, so everything before the first one is
 * the initialization segment.
 */
const WEBM_CLUSTER_ID = Uint8Array.from([0x1f, 0x43, 0xb6, 0x75]);

/**
 * The ISO-BMFF `moof` box TYPE, which sits four bytes into the box (after its
 * size). Safari records fragmented MP4, where `ftyp` + `moov` is the
 * initialization segment and each `moof`/`mdat` pair is a fragment — the same
 * shape as WebM with different spelling.
 */
const MP4_FRAGMENT_TYPE = Uint8Array.from([0x6d, 0x6f, 0x6f, 0x66]);

/** Bytes from the `moof` type back to the start of its box (the 32-bit size field). */
const MP4_BOX_HEADER_LENGTH = 4;

/**
 * How far into the first chunk we are willing to call something a header.
 *
 * A real initialization segment is hundreds of bytes to a few kilobytes. If the
 * first marker only turns up a megabyte in, we did not find a header — we found
 * a byte pattern inside audio data — and prepending a megabyte to every segment
 * would be the expensive way to be wrong. 256 KB is far above any real prologue
 * and far below "this is now the payload".
 */
export const MAX_INITIALIZATION_SEGMENT_BYTES = 256 * 1024;

/** What a host says when the chunk a segment record claims exists is gone. */
export const MEETING_SEGMENT_AUDIO_MISSING = 'The audio for segment {index} is no longer readable on this device.';

/**
 * The length of the container header at the front of a recording's first chunk,
 * or 0 when this is not a container we can read.
 *
 * Zero is a deliberate, honest answer rather than a failure: an unrecognised
 * container means we prepend nothing and let the endpoint judge the bytes. A
 * segment that fails to decode becomes a stated gap with a retry (D5), which is
 * a far better outcome than refusing to record at all because we did not
 * recognise a MIME type.
 */
export function initializationSegmentLength(first: Uint8Array): number {
  const cluster = indexOfBytes(first, WEBM_CLUSTER_ID);
  if (cluster > 0) return withinBudget(cluster);
  const fragment = indexOfBytes(first, MP4_FRAGMENT_TYPE);
  if (fragment >= MP4_BOX_HEADER_LENGTH) return withinBudget(fragment - MP4_BOX_HEADER_LENGTH);
  return 0;
}

/**
 * The bytes to POST for one segment.
 *
 * Segment 0 already IS a complete file, so it is passed through untouched —
 * copying it would double the largest allocation on the recording path for
 * nothing. Later segments get the header in front of them.
 */
export function segmentUploadBytes(index: number, chunk: Uint8Array, initialization: Uint8Array): Uint8Array {
  if (index === 0 || initialization.byteLength === 0) return chunk;
  const joined = new Uint8Array(initialization.byteLength + chunk.byteLength);
  joined.set(initialization, 0);
  joined.set(chunk, initialization.byteLength);
  return joined;
}

/**
 * The one thing a host still owns: handing back the bytes it wrote for a chunk.
 *
 * `null` means the chunk is gone — evicted from OPFS, deleted from the capture
 * directory, never written. It is a fact about THIS segment, so the reader turns
 * it into a throw the shared queue counts against the retry bound (D5) rather
 * than retrying forever against a store that has nothing to give.
 */
export interface SegmentAudioSource {
  readChunk(index: number): Promise<Uint8Array | null> | Uint8Array | null;
}

/**
 * A `readSegment` port for `MeetingTranscriptionQueue`, built over one host's
 * chunk store.
 *
 * Both hosts need exactly this and neither should write it twice: read the
 * chunk, and for anything after the first put the container header back in front
 * of it. The header is read once and reused, because re-deriving it per attempt
 * would read chunk 0 off the device ~180 times in an hour-long meeting.
 *
 * The mid-meeting case is the subtle one, and it is why this is a function
 * rather than a note in a comment: a queue rebuilt after a crash or a reload may
 * be asked for segment 57 having never read segment 0. So the reader fetches
 * chunk 0 for its header on demand — and if chunk 0 is itself gone, it prepends
 * nothing rather than throwing. That is the right failure: the endpoint still
 * gets the fragment and may well decode it, whereas throwing would spend a retry
 * on a segment whose audio is perfectly fine.
 */
export function createSegmentAudioReader(source: SegmentAudioSource): (index: number) => Promise<Uint8Array> {
  let initialization: Uint8Array | undefined;
  return async (index: number): Promise<Uint8Array> => {
    const chunk = await source.readChunk(index);
    if (!chunk) throw new Error(MEETING_SEGMENT_AUDIO_MISSING.replace('{index}', String(index)));
    if (index === 0) {
      initialization = chunk.slice(0, initializationSegmentLength(chunk));
      return chunk;
    }
    if (!initialization) {
      const first = await source.readChunk(0);
      initialization = first ? first.slice(0, initializationSegmentLength(first)) : new Uint8Array(0);
    }
    return segmentUploadBytes(index, chunk, initialization);
  };
}

/**
 * First occurrence of `needle` in `haystack`, or -1.
 *
 * A plain scan rather than anything cleverer: the needle is four bytes and the
 * haystack is bounded by `MAX_INITIALIZATION_SEGMENT_BYTES`, so the search is
 * over before a smarter algorithm would have finished building its table.
 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const limit = Math.min(haystack.byteLength, MAX_INITIALIZATION_SEGMENT_BYTES + needle.byteLength)
    - needle.byteLength;
  outer: for (let start = 0; start <= limit; start += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

function withinBudget(length: number): number {
  return length > MAX_INITIALIZATION_SEGMENT_BYTES ? 0 : length;
}
