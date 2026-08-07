/**
 * ADR-029 Part E — the editing model, as the browser-safe half of Notes.
 *
 * The `notes` barrel reaches the filesystem: `noteStore` reads and writes a
 * user-scoped JSON file, so importing it from a renderer pulls `node:fs` and
 * `node:path` into a browser bundle and the build fails. But almost everything
 * Part E decided is PURE — what `# ` means, what the slash menu offers, how a
 * mark toggles over a selection, what number a list item carries — and a
 * renderer needs exactly those, per keystroke.
 *
 * **Per keystroke is the whole reason this file exists.** Routing ⌘B or a
 * markdown input rule through the host would put an IPC round trip between a
 * key press and the character appearing. The judgement still has to live in
 * core — E1's parity test is that every surface behaves identically — so the
 * split is by PURITY, not by layer: decisions here, writes through the store.
 *
 * Nothing in this barrel may import `noteStore`, `notesSync`, `blockOps` or
 * anything else that touches IO. If a future module needs both, it belongs on
 * the `notes` barrel and the renderer reaches it through a host handler.
 */
export * from './block.js';
export * from './rank.js';
export * from './noteTree.js';
export * from './blockMerge.js';
export * from './blockLease.js';
export * from './trash.js';
export * from './inlineMarks.js';
export * from './inputRules.js';
export * from './slashCatalog.js';
export * from './listNumbering.js';
export * from './tableBlock.js';
// E3's database model, minus `databaseOps` — a surface renders a projection per
// keystroke and writes through a host handler, which is the same split by PURITY
// this barrel already makes for the editing gestures.
export * from './properties.js';
export * from './databaseView.js';
export * from './database.js';
