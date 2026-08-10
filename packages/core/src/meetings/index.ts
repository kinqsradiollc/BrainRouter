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
export * from './types.js';
export * from './captureSession.js';
export * from './transcript.js';
export * from './recovery.js';
export * from './retryPolicy.js';
