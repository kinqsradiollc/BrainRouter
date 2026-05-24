/**
 * Single source of truth for "is this shell command destructive enough that we
 * must confirm even in /mode fast?"
 *
 * Used by:
 *   - agent.ts `run_command`: in `executionMode === 'fast'` we skip the
 *     `askYesNo` prompt for everyday commands, but route through askYesNo
 *     anyway when this returns true.
 *   - tests: invariant that fast mode ≠ unconditional auto-approve.
 *
 * Heuristic, not a sandbox. The real blast-radius limiter is
 * `BRAINROUTER_SANDBOX=on`. This list exists so that a typo
 * (`rm -rf /` instead of `rm -rf ./build`) doesn't get auto-approved
 * because the user happened to be in fast mode.
 *
 * Patterns are conservative on purpose: false-positives cost one extra y/N
 * prompt; false-negatives cost a wiped disk. Add a pattern when you spot one
 * — do not remove existing entries without a replacement.
 */

const DANGEROUS_PATTERNS: RegExp[] = [
  // Recursive / forced deletions
  /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive\b|--force\b)/,
  // Anything piped/awk'd into a shell — too easy to hide an `rm` inside.
  /\|\s*(?:sh|bash|zsh|fish)\b/,
  // Disk imaging / zeroing
  /\bdd\s+(?:if|of|bs|count)=/,
  /\bmkfs(?:\.[a-z0-9]+)?\b/,
  /\bfdisk\b/,
  /\bshred\b/,
  // Wide-open permission flips
  /\bchmod\s+(?:-R\s+)?(?:[0-7]*[7]{2,3}|a\+w)\b/,
  /\bchown\s+-R\b/,
  // Privilege escalation
  /\bsudo\b/,
  /\bsu\s+-/,
  // Forced or destructive git operations
  /\bgit\s+push\s+(?:-f|--force)/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-zA-Z]*[fF]/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+branch\s+-D\b/,
  // Package-manager mutators that touch the global tree or remove deps
  /\bnpm\s+(?:uninstall|unpublish)\b/,
  /\b(?:yarn|pnpm)\s+remove\b/,
  // Process / system control
  /\bkillall\b/,
  /\bkill\s+-9\b/,
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  // Outbound exec-from-network — the classic curl|sh exfil/exec pattern
  /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sh|bash|zsh)\b/,
  // Database wipes
  /\bDROP\s+(?:DATABASE|TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  // Docker / k8s wipes
  /\bdocker\s+system\s+prune\b/,
  /\bdocker\s+(?:rm|rmi)\s+-f/,
  /\bkubectl\s+delete\b/,
];

/**
 * Returns true when the command matches any pattern that fast mode should
 * still gate through `askYesNo`. The check is a single-pass regex sweep
 * against the literal command string — no shell parsing, no env expansion.
 *
 * The trailing wildcard semantics matter: `rm -rf foo` matches, `rm-rf` does
 * not (word boundary), `rmdir` does not (different keyword). When in doubt,
 * lean toward returning true: the cost of an extra y/N is much smaller than
 * the cost of accidentally letting a destructive command through.
 */
export function isDangerousCommand(command: string): boolean {
  if (!command) return false;
  const normalized = command.trim();
  if (!normalized) return false;
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

export type RunCommandApproval = 'auto-approve' | 'ask' | 'deny-silent';

/**
 * Pure decision for "what should happen when the agent calls `run_command`?"
 * Split out of `agent.ts` so the policy is unit-testable without TTY mocking.
 *
 *   - Silent children cannot answer a y/N prompt. We auto-approve only when
 *     the parent has opted in via `executionMode === 'fast'` AND the command
 *     is not in the dangerous set. Dangerous commands in silent children are
 *     always denied — there is no human to confirm the blast radius.
 *   - Interactive parents in `fast` mode skip the prompt for safe commands
 *     and still gate dangerous ones through `askYesNo`. In `planning` mode
 *     every command routes through `askYesNo`.
 *
 * The `executionMode === 'fast'` check is the single source of truth for
 * "yolo-ish" behavior — the legacy `autoApproveShell` flag is migrated into
 * `executionMode === 'fast'` on first read of `preferencesStore` so new
 * callers do not need to consult both.
 */
export function resolveRunCommandApproval(
  prefs: { executionMode: 'planning' | 'fast' },
  command: string,
  opts: { silent: boolean },
): RunCommandApproval {
  const fastMode = prefs.executionMode === 'fast';
  const dangerous = isDangerousCommand(command);
  if (opts.silent) {
    if (dangerous) return 'deny-silent';
    return fastMode ? 'auto-approve' : 'deny-silent';
  }
  if (fastMode && !dangerous) return 'auto-approve';
  return 'ask';
}
