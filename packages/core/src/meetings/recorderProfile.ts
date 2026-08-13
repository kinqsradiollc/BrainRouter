/**
 * ADR-035 D11 — how much of the device a recording is allowed to be.
 *
 * ## What it owns
 *
 * One number, and the arithmetic that explains it. Both hosts constructed
 * `new MediaRecorder(stream)` with no options, which means the browser's
 * default — around 128 kbps for Opus in WebM, about 60 MB an hour. D11 names
 * that as the cheap half of its remedy: speech is fine at 24–32 kbps, which is
 * nearer 15 MB, and everything that can go wrong with a recording gets four
 * times smaller with it.
 *
 * ## Why a shared constant rather than a literal in each recorder
 *
 * Because the number is load-bearing in three places that must agree. It is the
 * size of what the origin's quota can evict (D11), it is the size of what the
 * browser's escrow uploads over somebody's connection (D11 again), and it is the
 * size of a transcription unit against the endpoint's body limit (D9's
 * `chunkLedger` sizes units in SECONDS and reasons about the bytes those become).
 * Two hosts each picking their own bitrate would make one of those three
 * arguments quietly wrong on one host, which is the ADR-029 failure D1b names.
 *
 * ## What it is not
 *
 * It is not a quality setting anybody tunes, and it is not a codec choice. The
 * container and the codec stay the browser's — `MediaRecorder` with no
 * `mimeType` is what both hosts already ask for, and what the capture record
 * stores so recovery can read the bytes back. This only says how many bits a
 * second of speech is worth.
 */

/**
 * D11 — the bitrate a voice recording is made at.
 *
 * 32 kbps is the top of the ADR's 24–32 range, chosen there rather than at the
 * bottom because the thing being protected is a transcript: Opus at 32 kbps is
 * transparent for speech, and buying another 25% off the file at the cost of
 * intelligibility would be trading the meeting for the storage it lives in.
 *
 * `MediaRecorder` treats this as a hint. A browser that ignores it produces the
 * recording it would have produced anyway, which is exactly today's behaviour —
 * so this can only make the exposure smaller, never a recording impossible.
 */
export const MEETING_AUDIO_BITS_PER_SECOND = 32_000;

/** Roughly what an hour of that costs, for a sentence a surface can print. */
export const MEETING_AUDIO_BYTES_PER_HOUR = (MEETING_AUDIO_BITS_PER_SECOND / 8) * 3_600;

/**
 * The options both hosts construct their recorder with.
 *
 * A function rather than a frozen object literal so a caller can spread it
 * beside a host-specific member (a `mimeType` a browser needs pinned, say)
 * without the shared value being something two call sites could mutate for each
 * other. Structurally a `MediaRecorderOptions`, without this module having to
 * know that the DOM exists.
 */
export function meetingRecorderOptions(): { readonly audioBitsPerSecond: number } {
  return { audioBitsPerSecond: MEETING_AUDIO_BITS_PER_SECOND };
}
