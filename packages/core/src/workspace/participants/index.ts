/**
 * ADR-029 C1 + C4 — the client-side switchboard and its fence.
 *
 * A deep subpath export rather than part of the `workspace` barrel, because the
 * participants reach `node:fs` (a code reference resolves against a checkout)
 * and the reference system itself must stay browser-safe for the renderer and
 * the dashboard. Merging the two would pull a filesystem surface into a browser
 * bundle behind an import that looks like a type.
 */
export * from './localModes.js';
export * from './agentContext.js';
