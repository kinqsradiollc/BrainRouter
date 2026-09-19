/**
 * ADR-061 D6 — the configured port for one session.
 *
 * The one place `cli.decisions` is read. Every consumer takes its port from
 * here so the provider, the timeout, the state bound and the recording are
 * decided once rather than per gate.
 *
 * A provider that cannot be built is NOT silently downgraded: it becomes a
 * provider that fails on every call, so the port falls back to the rules floor
 * and writes *why* into `recent-decisions.json`. A configuration that does
 * nothing must say so; that is the whole lesson of the knob that promised a
 * 30-minute calendar cadence and applied nothing (#1721). Here that matters
 * twice over, because the two ways `local` fails — no model named, or a model
 * named that the router cannot place — need different fixes, so they say
 * different things.
 */

import { getCliKnobs, loadOrInitConfig, type Config, type ResolvedCliKnobs } from '../config/config.js';
import { resolveDecisionLlm } from '../provider/agentModels.js';
import { createLocalDecisionProvider } from './providers/local.js';
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
  /** The config the model request resolves against; defaults to the session's. */
  config?: Config;
}

/** What one consumer needs: the port, plus the bound its state must respect. */
export interface SessionDecisionPort {
  port: DecisionPort;
  maxStateChars: number;
  providerName: string;
}

function failing(name: string, reason: string): DecisionProvider {
  return {
    name,
    async answer() { throw new Error(reason); },
  };
}

/**
 * Our own System One tier: a declared small model, asked with a closed schema.
 *
 * Returns a FAILING provider rather than throwing, so a misconfigured decision
 * tier degrades to the rule floor with a readable reason instead of taking down
 * the gate it sits in front of.
 */
function localProvider(knobs: ResolvedCliKnobs['decisions'], config?: Config): DecisionProvider {
  if (!knobs.local.model) {
    return failing('local', 'no decision model is set — set cli.decisions.local.model to a small, fast model');
  }
  let resolved: Config;
  try {
    resolved = config ?? loadOrInitConfig();
  } catch (err) {
    return failing('local', `the config could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resolved.llm) {
    return failing('local', 'this workspace has no model configured, so there is nothing to ask');
  }
  const llm = resolveDecisionLlm(resolved, resolved.llm, knobs.local.model);
  if (!llm) {
    return failing('local', `cli.decisions.local.model "${knobs.local.model}" is not a model this workspace can route to`);
  }
  return createLocalDecisionProvider({ llm, maxStateChars: knobs.maxStateChars });
}

export function decisionPortForSession(options: SessionDecisionPortOptions = {}): SessionDecisionPort {
  const knobs = options.knobs ?? getCliKnobs().decisions;
  const configured = knobs.provider;
  const provider = configured === 'rules'
    ? rulesProvider
    : options.providers?.[configured] ?? localProvider(knobs, options.config);

  // Recording is the CONSUMER's, not the port's: only the consumer knows what
  // it did with the answer, and one row carrying the outcome and the threshold
  // is worth more than two rows carrying halves of it (D5).
  const port = createDecisionPort({ provider, timeoutMs: knobs.timeoutMs });
  return { port, maxStateChars: knobs.maxStateChars, providerName: provider.name };
}
