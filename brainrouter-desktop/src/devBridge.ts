/**
 * DESK-4c — browser-dev mock bridge. In Electron the preload provides
 * `window.brainrouter`; in a plain browser (vite dev / UI work without the
 * shell) this installs a canned stand-in so every surface renders populated:
 * demo sessions, files, diff, plan, fleet, tokens, settings snapshot, the
 * command catalog, an echo turn with a tool group, and an approval dialog
 * when the prompt mentions "approve". No-op when the real bridge exists.
 *
 * The implementation is split into cohesive sibling modules under ./devBridge:
 *   - state.ts    — shared mutable state + helper closures (createDevState)
 *   - atlas.ts    — synthetic codebase graph builders
 *   - queries.ts  — the query handler map (createQueries)
 *   - commands.ts — window.brainrouter + __devEmitWs (installBridge)
 * This file stays the thin public entrypoint; the public surface is unchanged.
 */
import { installBridge } from './devBridge/commands.js';
import { createQueries } from './devBridge/queries.js';
import { createDevState } from './devBridge/state.js';

export function installDevBridge(): void {
  if (typeof window === 'undefined' || (window as { brainrouter?: unknown }).brainrouter) return;

  const S = createDevState();
  const queries = createQueries(S);
  installBridge(S, queries);
}
