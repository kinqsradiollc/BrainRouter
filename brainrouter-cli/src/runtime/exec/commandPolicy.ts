/**
 * CODEX-EXEC-POLICY (0.4.7) — command-segment approval precision.
 *
 * BrainRouter maps tools to coarse action kinds (`execPolicy.ts`); `run_command`
 * is then a single coarse "shell" gate plus the `isDangerousCommand` floor.
 * That's too blunt for engineering shells: `git status` and `rm -rf` get the
 * same treatment. Codex instead evaluates command *segments* against rules
 * (`exec_policy.rs:272`).
 *
 * This module splits a shell command into segments (`&&`, `||`, `|`, `;`,
 * newlines), classifies each, and reports whether the whole command is
 * pre-approved. It is the precise, pure core the approval decision
 * (`resolveRunCommandApproval`) consults — NO shell execution, NO env
 * expansion.
 *
 * Conservative by construction:
 *  - `dangerous` (any segment matches the destructive floor) is the hard gate.
 *  - `allowlisted` segments are ones the user pre-approved via
 *    `cli.commandAllowlist` (guarded against over-broad prefixes by
 *    CODEX-APPROVAL-GUARD).
 *  - `safe` segments are provably read-only built-ins (informational — surfaced
 *    for display/telemetry; the default approval gating is unchanged).
 *  - everything else is `unknown` (the neutral middle — gated by access mode /
 *    execution mode exactly as before).
 */

import { isDangerousCommand } from './dangerousCommand.js';

export type SegmentClass = 'allowlisted' | 'safe' | 'dangerous' | 'unknown';

export interface CommandSegment {
  /** The raw segment text (trimmed). */
  text: string;
  /** The resolved head program (lowercased; '' when indeterminate). */
  head: string;
  classification: SegmentClass;
}

export interface CommandPolicy {
  segments: CommandSegment[];
  /** Any segment is destructive — the hard approval/deny floor. */
  anyDangerous: boolean;
  /** Every segment is explicitly allowlisted by the user (→ any-mode auto-approve). */
  allAllowlisted: boolean;
  /** Every segment is allowlisted or provably read-only (informational). */
  allReadOnlyOrAllowlisted: boolean;
}

/** Provably read-only programs — they cannot mutate the fs/system by themselves. */
const SAFE_PROGRAMS = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'which', 'whoami', 'date',
  'true', 'false', 'basename', 'dirname', 'realpath', 'stat', 'file', 'tree',
  'uname', 'hostname', 'id', 'uptime', 'printenv', 'grep', 'egrep', 'fgrep',
  'rg', 'sort', 'uniq', 'nl', 'type', 'arch', 'groups', 'tty', 'logname',
]);

/** Read-only first-arg subcommands for a few common multiplexers. */
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'ls-files', 'describe', 'shortlog']),
};

/** Split a command line into pipeline/sequence segments. */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||[|;\n])\s*/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Resolve the head program of a segment, skipping leading `FOO=bar` env-assignments. */
export function segmentHead(segment: string): string {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const head = tokens[i] ?? '';
  // Strip a leading path component so `/usr/bin/ls` and `./ls` resolve to `ls`.
  const base = head.split('/').pop() ?? head;
  return base.toLowerCase();
}

function matchesAllowlist(segment: string, allowlist: string[]): boolean {
  const s = segment.trim();
  return allowlist.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    // Prefix match on a word boundary: `git status` matches `git status -s`
    // but NOT `git status-hack` (next char must be whitespace or end).
    return s === e || s.startsWith(`${e} `);
  });
}

function classifySegment(segment: string, allowlist: string[]): CommandSegment {
  const head = segmentHead(segment);
  // 1. Dangerous floor wins outright.
  if (isDangerousCommand(segment)) return { text: segment, head, classification: 'dangerous' };
  // 2. User pre-approval.
  if (matchesAllowlist(segment, allowlist)) return { text: segment, head, classification: 'allowlisted' };
  // 3. A redirect (`>`/`>>`) makes even a read-only head write a file → unknown.
  const hasOutputRedirect = /(^|[^0-9>])>>?(?![&>])/.test(segment);
  // Command substitution / process substitution → can't reason → unknown.
  const hasSubstitution = segment.includes('$(') || segment.includes('`') || segment.includes('<(');
  if (!hasOutputRedirect && !hasSubstitution) {
    if (SAFE_PROGRAMS.has(head)) return { text: segment, head, classification: 'safe' };
    const subs = SAFE_SUBCOMMANDS[head];
    if (subs) {
      const tokens = segment.split(/\s+/).filter(Boolean);
      const sub = (tokens[1] ?? '').toLowerCase();
      if (subs.has(sub)) return { text: segment, head, classification: 'safe' };
    }
  }
  // 4. Neutral middle.
  return { text: segment, head, classification: 'unknown' };
}

/**
 * Evaluate a shell command against the user's allowlist. Pure — never executes.
 */
export function evaluateCommandPolicy(command: string, allowlist: string[] = []): CommandPolicy {
  const segments = splitCommandSegments(command).map((s) => classifySegment(s, allowlist));
  const anyDangerous = segments.some((s) => s.classification === 'dangerous');
  const nonEmpty = segments.length > 0;
  const allAllowlisted = nonEmpty && segments.every((s) => s.classification === 'allowlisted');
  const allReadOnlyOrAllowlisted =
    nonEmpty && !anyDangerous && segments.every((s) => s.classification === 'allowlisted' || s.classification === 'safe');
  return { segments, anyDangerous, allAllowlisted, allReadOnlyOrAllowlisted };
}
