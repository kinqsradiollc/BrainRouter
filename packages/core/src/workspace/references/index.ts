/**
 * ADR-029 Part A + C1 — the reference system's public surface.
 *
 * A deep subpath export (`@kinqs/brainrouter-core/workspace/references`) rather
 * than a re-export from the `workspace` barrel, because this module is pure
 * logic — no `node:fs`, no `node:crypto` — and the dashboard and the desktop
 * renderer both need it in a browser bundle. Reaching it through the barrel
 * would pull the workspace's filesystem surface in behind it.
 */
export * from './ref.js';
export * from './resolution.js';
export * from './registry.js';
export * from './backlinks.js';
