// Public entrypoint for the `meetings` subsystem (ADR-035). Consumers import
// `@kinqs/brainrouter-core/meetings` instead of deep `dist/meetings/*.js` paths,
// keeping the subsystem's file layout internal.
//
// The whole surface is pure: no filesystem, no OPFS/IndexedDB, no network. That
// is what D1b requires of it — the desktop writes segment bytes to a `0700`
// capture directory and the dashboard writes them to OPFS, but both compute the
// SAME session, the same transcript-with-gaps and the same retry schedule from
// this module. A shared promise with two implementations is two features, and
// the second one is always the worse one.
//
// `transcriptionQueue` is the same idea applied to behaviour rather than to
// data: the scheduler that turns segments into text lives here too, with the
// transcribing, the reading and the writing injected as ports, so the two hosts
// share a drain loop instead of each growing their own.
//
// `segmentAudio` is the third: the container framing that makes a segment after
// the first decodable at all. It is byte inspection with no `Blob` and no file
// handle in it, so there is no honest reason for either host to own a copy —
// and a host WITHOUT one transcribes segment 0 and nothing else, which is the
// lesser-second-host failure D1b names.
//
// `chunkAdoption` and `draftReconcile` are the fourth and fifth, and both got
// here the same way: a rule each host had worked out for itself, twice, and got
// wrong or nearly wrong in the same place. Adoption decides which stored chunks
// a stale record may claim after a kill; reconciliation decides what the compose
// box should hold when a restored draft and a recovered session both already
// contain the transcript. That second one is why a recovered meeting used to be
// summarized twice on BOTH hosts.
export * from './types.js';
export * from './captureSession.js';
export * from './transcript.js';
export * from './recovery.js';
export * from './retryPolicy.js';
export * from './queuePlan.js';
export * from './segmentAudio.js';
export * from './chunkAdoption.js';
export * from './draftReconcile.js';
export * from './transcriptionQueue.js';
