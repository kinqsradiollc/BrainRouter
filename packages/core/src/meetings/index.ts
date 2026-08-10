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
//
// `capturePhase` is the sixth and the plainest: the one sentence a live panel
// prints about the queue. It is surface WORDING, which is why it took two
// rounds to arrive here — but it is a rule (which state outranks which) and it
// had already drifted between the hosts while it lived in each of them.
//
// `captureHolder` is all that is left of an eighth, and the story is worth
// keeping because the module is the shape of the lesson. "Is someone recording
// into this capture right now" was once kept in React state in one mount, while
// the store it describes is per-process on the desktop and per-origin in the
// browser — so a second window or a second tab was offered a live recording back
// with an enabled Delete. The correction moved the fact INTO the record, as a
// lease with a heartbeat and a fencing epoch, and that was wrong for a reason no
// amount of care about epochs could fix: a heartbeat is a claim about an instant
// that has passed, and the case this subsystem is judged on (§6) is a process
// that was killed. A killed writer's stamp looks fresh, so the recovered meeting
// was withheld from the offer for a staleness window, and a reloaded renderer's
// stamp was renewed for ever by a process the page had already left. Both hosts
// now hold liveness in something that dies when the writer does — a per-process
// writer map behind a single-instance lock; a Web Lock per browsing context —
// and hand it to this module's rules as `exclude`. What is shared is the NAME a
// writer goes by, because a host that minted its own would get the
// insecure-context fallback wrong; the answer is not shared, because it is not
// the same question on both hosts.
//
// `transcriptFold` is the seventh, and the one that had already drifted into
// two DIFFERENT answers rather than two copies of one: the desktop appended to
// the compose box and the dashboard recomposed it from a stripped base, so the
// same edit and the same typed note survived a kill on one host and were
// relocated or reverted on the other. Composition is one rule now, and it is
// the append one — position in that box is the person's, not the surface's.
export * from './types.js';
export * from './captureHolder.js';
export * from './captureSession.js';
export * from './transcript.js';
export * from './recovery.js';
export * from './retryPolicy.js';
export * from './queuePlan.js';
export * from './segmentAudio.js';
export * from './chunkAdoption.js';
export * from './draftReconcile.js';
export * from './transcriptFold.js';
export * from './transcriptionQueue.js';
export * from './capturePhase.js';
