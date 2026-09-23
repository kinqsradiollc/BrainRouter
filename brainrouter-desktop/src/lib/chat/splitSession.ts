/**
 * ADR-057 D2 — pure helpers for the split chat view's second pane.
 *
 * Kept out of the component so they are unit-testable: the component itself
 * reuses the app's full row renderer, which transitively pulls the panels
 * barrel (and `@xterm/xterm`) and so is only exercisable in the real app / the
 * preview, not the renderer test harness.
 */
import type { SessionRow } from '../../types.js';

/** Committed-state events after which the pane re-reads the transcript from disk. */
export const RELOAD_EVENT_KINDS = new Set<string>([
  'assistant-turn-end', 'turn-complete', 'turn-error', 'tool-end', 'child-complete', 'artifact', 'changeset', 'plan-update',
]);

/** True when a host event for the viewed session means "the committed transcript changed". */
export function shouldReloadOnEvent(kind: string | undefined): boolean {
  return !!kind && RELOAD_EVENT_KINDS.has(kind);
}

/** A short, human title for a session — its first user message, bounded, or a fallback. */
export function splitSessionTitle(sessions: readonly SessionRow[], key: string): string {
  const raw = sessions.find((s) => s.sessionKey === key)?.firstUserMessage?.trim();
  if (!raw) return 'New session';
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
}

/** The session a fresh split should open on: the first that is NOT the active one, else the newest, else null. */
export function defaultSplitSession(sessions: readonly SessionRow[], activeKey: string | undefined): string | null {
  return sessions.find((s) => s.sessionKey !== activeKey)?.sessionKey ?? sessions[0]?.sessionKey ?? null;
}
