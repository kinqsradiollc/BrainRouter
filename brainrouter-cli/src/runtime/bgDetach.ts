/**
 * CLI-BG-DETACH (0.4.5) — pure helpers for the `/fg` and `/stop <id>` commands.
 *
 * Scope note: this ships the *management* half of CLI-BG-DETACH — inspect and
 * stop background work by id, and a unified `/ps`. Detaching an already-running
 * FOREGROUND turn into the background is intentionally NOT here: the CLI runs a
 * single `Agent` with shared `chatHistory`, so two turns can't run concurrently
 * without turn-state isolation (deferred to 0.5.0 TUI-NATIVE). These helpers
 * only ever read/stop work that already runs in its own detached context
 * (workers + child agents).
 */

export type BgTargetKind = 'worker' | 'agent' | 'unknown';

export interface BgTargetInput {
  id: string;
  status: string;
  role: string;
}

export interface BgTarget {
  kind: BgTargetKind;
  id: string;
  status?: string;
  role?: string;
  /** True when the target is still active (pending/running) — i.e. `/stop` is meaningful. */
  active: boolean;
}

const ACTIVE_WORKER = new Set(['running']);
const ACTIVE_AGENT = new Set(['pending', 'running']);

/**
 * Resolve a background id (as typed for `/fg` or `/stop`) to a worker or child
 * agent. Matched by EXACT id so a copy-paste from `/ps` always resolves; workers
 * are checked first only to break the (practically impossible) id collision
 * deterministically. Pure — callers pass the already-loaded worker + session
 * lists. Returns `kind:'unknown'` when nothing matches.
 */
export function resolveBackgroundTarget(
  id: string,
  workers: BgTargetInput[],
  agents: BgTargetInput[],
): BgTarget {
  const trimmed = (id ?? '').trim();
  if (!trimmed) return { kind: 'unknown', id: trimmed, active: false };
  const w = workers.find((x) => x.id === trimmed);
  if (w) return { kind: 'worker', id: trimmed, status: w.status, role: w.role, active: ACTIVE_WORKER.has(w.status) };
  const a = agents.find((x) => x.id === trimmed);
  if (a) return { kind: 'agent', id: trimmed, status: a.status, role: a.role, active: ACTIVE_AGENT.has(a.status) };
  return { kind: 'unknown', id: trimmed, active: false };
}

/** Human-readable result of a `/stop <id>` attempt — kept pure for testing the wording. */
export function describeStopOutcome(target: BgTarget): { ok: boolean; message: string } {
  switch (target.kind) {
    case 'worker':
      return target.active
        ? { ok: true, message: `Worker ${target.id} closed (best-effort — in-flight work may still finish writing its transcript).` }
        : { ok: true, message: `Worker ${target.id} was already ${target.status}; marked closed.` };
    case 'agent':
      return target.active
        ? { ok: true, message: `Child agent ${target.id} marked closed (best-effort — its detached turn may still finish).` }
        : { ok: false, message: `Child agent ${target.id} is already ${target.status}; nothing to stop.` };
    default:
      return { ok: false, message: `No background worker or child agent with id "${target.id}". Try /ps.` };
  }
}
