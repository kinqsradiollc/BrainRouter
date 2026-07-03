/**
 * CC-SAFETY-B1 — classify-all-shell gate.
 *
 * When `cli.autoClassifyShell` is `'on'` or `'strict'`, EVERY `run_command` call
 * is routed through the safety classifier BEFORE it runs (a pre-tool gate), not
 * just the ones a downstream heuristic happens to catch. This reuses the existing
 * safety primitives — the destructive-command guard (`evaluateDestructiveCommand`)
 * and the dangerous-command heuristic / allowlist policy — so there is ONE source
 * of truth for "is this shell call risky", surfaced uniformly at the gate.
 *
 * Posture (`mode`):
 *   - `'off'`    — inert; the caller shouldn't even invoke this.
 *   - `'on'`     — a destructive/dangerous command → 'ask' (attended) or 'deny'
 *                  (silent / enforced); everything else allowed.
 *   - `'strict'` — DENY unless every segment is on the `commandAllowlist`
 *                  whitelist (the strictest posture, for unattended runs).
 *
 * `enforceWhenSilent` mirrors the sandbox/hook knobs: when a human is watching
 * (`silent: false`) and enforcement is relaxed, an `'on'`-mode risky command may
 * downgrade to an advisory `'ask'` instead of a hard `'deny'`. When nobody is
 * watching (`silent: true`) OR enforcement is on, the classification is enforced
 * (a risky call is denied, since a silent session can't answer a prompt).
 *
 * Pure → unit-tested. No I/O, no process/env reads.
 */

import { evaluateDestructiveCommand, type DestructiveContext } from '../guard/destructiveCommandGuard.js';
import { isDangerousCommand } from '../guard/dangerousCommand.js';
import { evaluateCommandPolicy } from './commandPolicy.js';

export type ShellClassifyMode = 'off' | 'on' | 'strict';
export type ShellClassifyDecision = 'allow' | 'ask' | 'deny';

export interface ShellClassifyResult {
  decision: ShellClassifyDecision;
  /** Human-readable reason (shown to the model / recorded in recent-denials). */
  reason: string;
  /** Coarse rule tag for logging/telemetry. */
  rule: 'allowed' | 'not-whitelisted' | 'destructive' | 'dangerous';
}

export interface ShellClassifyOptions {
  mode: ShellClassifyMode;
  /** Session can't answer a y/N prompt (child / headless) → risky ⇒ deny. */
  silent: boolean;
  /** Enforce even when attended (default true, mirrors hooks/sandbox). */
  enforceWhenSilent?: boolean;
  /** Whitelist for `'strict'` mode (typically `cli.commandAllowlist`). */
  allowlist?: string[];
  /** Context for the destructive-command guard (user intent, HEAD, our commits). */
  destructiveContext?: DestructiveContext;
}

/**
 * Classify a single `run_command` string. Returns the gate decision + reason.
 * The caller (the pre-tool gate) turns 'deny' into a refusal, 'ask' into an
 * approval prompt (attended) or a fail-closed refusal (silent), 'allow' into
 * a pass-through.
 */
export function classifyShellCommand(command: string, opts: ShellClassifyOptions): ShellClassifyResult {
  const { mode, silent } = opts;
  if (mode === 'off') return { decision: 'allow', reason: 'auto-classify disabled', rule: 'allowed' };

  const enforce = opts.enforceWhenSilent !== false; // default true
  // A risky call is HARD-denied when the session can't answer (silent) or when
  // enforcement is on; otherwise it downgrades to an advisory 'ask'.
  const riskyDecision: ShellClassifyDecision = silent || enforce ? 'deny' : 'ask';

  // strict — DENY unless every segment is whitelisted.
  if (mode === 'strict') {
    const allowlist = opts.allowlist ?? [];
    const allWhitelisted = allowlist.length > 0 && evaluateCommandPolicy(command, allowlist).allAllowlisted;
    if (!allWhitelisted) {
      return {
        decision: 'deny',
        reason:
          'strict autoClassifyShell — this command is not on the cli.commandAllowlist whitelist. ' +
          'Add its prefix to commandAllowlist to permit it, or run a whitelisted command.',
        rule: 'not-whitelisted',
      };
    }
    // Whitelisted — the dangerous floor still applies below (a whitelisted-but-
    // dangerous command shouldn't slip through in strict mode either).
  }

  // Destructive-command guard (git/IaC actions the user didn't ask for).
  const destructive = evaluateDestructiveCommand(command, opts.destructiveContext ?? {});
  if (destructive.decision === 'block') {
    return { decision: riskyDecision, reason: destructive.reason ?? 'destructive command', rule: 'destructive' };
  }

  // Dangerous-command heuristic (rm -rf, sudo, force-push, curl|sh, …).
  if (isDangerousCommand(command)) {
    return {
      decision: riskyDecision,
      reason: 'flagged by the safety classifier as potentially destructive (rm -rf / sudo / force-push / curl|sh / …)',
      rule: 'dangerous',
    };
  }

  return { decision: 'allow', reason: 'classified safe', rule: 'allowed' };
}
