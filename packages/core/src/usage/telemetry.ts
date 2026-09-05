/**
 * ADR-054 D2 — the best-effort client push of per-automation usage to the brain
 * server. Core stays NETWORK-FREE: the CLI (which knows the server URL + session
 * token) installs a transport via `setUsageTelemetryTransport`; core only invokes
 * it, gated by the opt-in `cli.usageTelemetry` knob. A failed push never affects a
 * turn — usage is advisory, not a correctness path.
 */
import { getCliKnobs } from '../config/config.js';

/** One per-automation increment the transport POSTs to `/api/usage/automation`. */
export interface UsageTelemetryDelta {
  automation: string;
  promptTokens: number;
  completionTokens: number;
  calls?: number;
  turns?: number;
  model?: string;
}

/** A transport the host installs — fire-and-forget; may return a promise (ignored). */
export type UsageTelemetryTransport = (delta: UsageTelemetryDelta) => void | Promise<void>;

let transport: UsageTelemetryTransport | null = null;

/** The CLI installs the actual network push here at startup; clears with null. */
export function setUsageTelemetryTransport(fn: UsageTelemetryTransport | null): void {
  transport = fn;
}

/**
 * Push one usage delta, best-effort. No-op unless `cli.usageTelemetry` is on AND a
 * transport is installed AND the delta names an automation. Any error (offline,
 * server down, a throwing transport) is swallowed.
 */
export function pushUsageTelemetry(delta: UsageTelemetryDelta): void {
  if (!transport) return;
  if (!delta || typeof delta.automation !== 'string' || !delta.automation.trim()) return;
  let on = false;
  try { on = getCliKnobs().usageTelemetry === true; } catch { on = false; }
  if (!on) return;
  try {
    const r = transport(delta);
    if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).then(undefined, () => {});
  } catch {
    /* advisory — a failed push never affects a turn */
  }
}
