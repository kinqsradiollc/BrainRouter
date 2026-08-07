/**
 * ADR-029 Part B — the Notes core.
 *
 * A barrel, matching the planner's, so the backend and the desktop import one
 * path instead of eight. It also means the merge rules the SERVER applies are
 * literally the functions the client applies — one implementation, so the two
 * halves cannot drift into disagreeing about who won a conflict.
 *
 * `noteStore.ts` reaches the filesystem; everything else is pure. A renderer
 * that needs only the pure half should deep-import the module it wants rather
 * than pull this barrel into a browser bundle.
 */
// The clock and the field-merge primitives live under `sync/`, shared with the
// planner per B3. Re-exported here for the same reason the planner barrel
// re-exports them: the server merges with these functions and stamps with this
// clock, and a backend that had to reach two packages deep for the type of a
// field it is merging would eventually reach for a second implementation.
export * from '../sync/hybridClock.js';
export * from '../sync/stamped.js';
export * from './block.js';
export * from './rank.js';
export * from './blockLease.js';
export * from './blockMerge.js';
export * from './noteTree.js';
export * from './noteSearch.js';
export * from './noteStore.js';
export * from './notesSync.js';
