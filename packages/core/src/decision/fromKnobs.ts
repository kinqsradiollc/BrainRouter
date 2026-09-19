/**
 * ADR-061 D6 — the configured port for one session.
 *
 * The one place `cli.decisions` is read. Every consumer takes its port from
 * here so the provider, the timeout, the state bound and the recording are
 * decided once rather than per gate.
 *
 * A provider this build does not carry is NOT silently downgraded: it becomes a
 * provider that fails on every call, so the port falls back to the rules floor
 * and writes *why* into `recent-decisions.json`. A configuration that does
 * nothing must say so; that is the whole lesson of the knob that promised a
 * 30-minute calendar cadence and applied nothing (#1721).
 */

import { getCliKnobs, type ResolvedCliKnobs } from '../config/config.js';
import { createDecisionPort, rulesProvider, type DecisionProvider } from './port.js';
import type { DecisionPort } from './types.js';

export interface SessionDecisionPortOptions {
  /** Providers beyond `rules` that this build carries, by name. */
  providers?: Record<string, DecisionProvider>;
  /**
   * The knobs to read, when the caller was handed a config rather than running
   * inside the session's own. The gateway is the case: it serves whichever
   * `Config` it was started with, and reading the ambient one instead would
   * let a decision disagree with the router it is deciding for.
   */
  knobs?: ResolvedCliKnobs['decisions'];
}

/** What one consumer needs: the port, plus the bound its state must respect. */
export interface SessionDecisionPort {
  port: DecisionPort;
  maxStateChars: number;
  providerName: string;
}

function unavailable(name: string): DecisionProvider {
  return {
    name,
    async answer() {
      throw new Error(`provider "${name}" is configured but not available in this build`);
    },
  };
}

export function decisionPortForSession(options: SessionDecisionPortOptions = {}): SessionDecisionPort {
  const knobs = options.knobs ?? getCliKnobs().decisions;
  const configured = knobs.provider;
  const provider = configured === 'rules'
    ? rulesProvider
    : options.providers?.[configured] ?? unavailable(configured);

  // Recording is the CONSUMER's, not the port's: only the consumer knows what
  // it did with the answer, and one row carrying the outcome and the threshold
  // is worth more than two rows carrying halves of it (D5).
  const port = createDecisionPort({ provider, timeoutMs: knobs.timeoutMs });
  return { port, maxStateChars: knobs.maxStateChars, providerName: provider.name };
}
