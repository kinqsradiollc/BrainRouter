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
export * from './comment.js';
export * from './blockLease.js';
export * from './blockMerge.js';
export * from './noteTree.js';
export * from './noteSearch.js';
export * from './noteStore.js';
export * from './notesSync.js';
// ADR-029 Part E — the editing model. Pure except for `blockOps`, which
// composes the store's mutations rather than writing beside them.
export * from './inputRules.js';
export * from './slashCatalog.js';
export * from './inlineMarks.js';
export * from './blockOps.js';
export * from './listNumbering.js';
export * from './tableBlock.js';
export * from './trash.js';
// ADR-029 E3 — databases. `properties`, `databaseView` and `database` are pure;
// `databaseOps` composes the store's mutations rather than writing beside them,
// which is what keeps a row on the block model instead of in a second store.
export * from './properties.js';
export * from './databaseView.js';
export * from './database.js';
export * from './databaseProjection.js';
export * from './databaseOps.js';
// ADR-029 F2/F3 — the derived columns. `formula/` is a bounded parser and a
// total evaluator, `rollup` is the aggregate and what it says about the rows it
// could not see, and `computed` is the one place that decides what a derived
// cell says — so a table, a board and the agent's summary read one answer.
export * from './formula/index.js';
export * from './rollup.js';
export * from './computed.js';
// ADR-029 Part F — the blocks the slash menu offered and could not draw. Both
// reach the network through `net/guardedFetch.ts`, which is why they are on this
// barrel rather than the browser-safe one.
export * from './bookmarkPreview.js';
export * from './noteImage.js';
// ADR-029 F4/F3 — page-level undo and templates. `noteHistory` is the model and
// is pure; `templates` composes the store's mutations rather than writing beside
// them, which is what keeps a template a page instead of a second kind of thing.
export * from './noteHistory.js';
export * from './noteRefRemap.js';
export * from './templates.js';
// ADR-030 D5 — a parsed document becomes a page of blocks with a real address.
export * from './importDocument.js';
// ADR-029 F3 — synced blocks (one block, many places) and getting data out.
// `syncedBlock` is pure and `export/` writes text; both are here rather than on
// a browser-safe subpath because their callers are the host and the server,
// which already hold the store.
export * from './syncedBlock.js';
export * from './export/index.js';
