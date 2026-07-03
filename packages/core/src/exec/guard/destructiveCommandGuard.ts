/**
 * DESTRUCTIVE-COMMAND GUARD (WS5) — a "BLOCK unless the user asked" gate for
 * commands that throw away work or tear down infrastructure.
 *
 * This is STRICTER than, and separate from, `dangerousCommand.ts` (which only
 * raises an extra y/N confirm). The dangerous-command list never distinguishes a
 * destructive action the USER requested from one the agent volunteered. This
 * guard does: it BLOCKS the destructive command unless the turn's user-intent
 * text shows the user actually asked for it (discard / destroy that stack), or —
 * for `git commit --amend` — unless the commit being rewritten was authored by
 * the agent itself this session.
 *
 * Pure + unit-tested; the agent calls `evaluateDestructiveCommand` in the
 * run_command handler and turns a `block` into a refusal (silent agents) or a
 * confirm (attended). Per-segment so `a && git reset --hard` is caught.
 */
import { splitCommandSegments } from '../policy/commandPolicy.js';

export interface DestructiveContext {
  /** The turn's user-intent text (the prompt). A destructive command the user
   *  explicitly asked for is allowed. */
  userIntent?: string;
  /** Current git HEAD sha, if known (for the `--amend` author check). */
  headSha?: string;
  /** Commits the agent itself created THIS session (for the `--amend` check). */
  agentAuthoredCommits?: ReadonlySet<string>;
}

export type DestructiveRule = 'discard-work' | 'amend-foreign' | 'iac-destroy';

export interface DestructiveVerdict {
  decision: 'allow' | 'block';
  /** The matched rule (logging/telemetry); set only when blocked. */
  rule?: DestructiveRule;
  /** Human-readable reason shown to the model when blocked. */
  reason?: string;
}

// Intent the user must express for a discard-work command to be allowed.
const DISCARD_INTENT =
  /\b(discard|throw\s+(?:it\s+)?away|reset|revert|wipe|nuke|blow\s+away|start\s+over|scrap|undo\s+(?:my|the|all|local|these|those)\b|get\s+rid\s+of|clean\s+(?:out|up)?)\b/i;
// Verbs that, together with the SPECIFIC stack name, authorize an IaC destroy.
const DESTROY_INTENT = /\b(destroy|tear\s*down|teardown|delete|remove|decommission|nuke)\b/i;

// --- per-segment matchers (each tested against a single command segment) ---
const RE_RESET_HARD = /\bgit\s+reset\b[^|;&]*--hard\b/i;
const RE_CHECKOUT_DISCARD = /\bgit\s+checkout\s+--(\s|$)/i; // `git checkout -- .` / `-- <path>`
const RE_CLEAN_FORCE = /\bgit\s+clean\s+-[a-zA-Z]*f/i; // `git clean -fd`, `-xf`, `-f`
const RE_STASH_DROP = /\bgit\s+stash\s+(drop|clear)\b/i;
const RE_AMEND = /\bgit\s+commit\b[^|;&]*--amend\b/i;
const RE_IAC_DESTROY = /\b(terraform|pulumi|cdk)\b[^|;&]*\bdestroy\b/i;

/** Best-effort extraction of the stack/target a destroy command targets, so we
 *  can require the user named THAT stack (not just "destroy something"). */
export function extractIacTarget(segment: string): string | undefined {
  // pulumi destroy --stack <X> / -s <X>
  const stackFlag = segment.match(/--stack(?:=|\s+)([^\s]+)|(?:\s|^)-s\s+([^\s]+)/i);
  if (stackFlag) return (stackFlag[1] ?? stackFlag[2])?.replace(/^['"]|['"]$/g, '');
  // cdk destroy <Stack> [<Stack2> …] — the first non-flag token after `destroy`
  const cdkPos = segment.match(/\bcdk\b[^|;&]*\bdestroy\s+([^\s-][^\s]*)/i);
  if (cdkPos) return cdkPos[1]?.replace(/^['"]|['"]$/g, '');
  // terraform workspace / -target
  const target = segment.match(/-target(?:=|\s+)([^\s]+)/i);
  if (target) return target[1]?.replace(/^['"]|['"]$/g, '');
  return undefined;
}

function mentionsToken(intent: string, token: string): boolean {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`, 'i').test(intent);
}

/**
 * Decide whether a `run_command` string is a destructive action the user did
 * NOT authorize. Returns the FIRST blocking segment's verdict, else `allow`.
 */
export function evaluateDestructiveCommand(command: string, ctx: DestructiveContext = {}): DestructiveVerdict {
  const intent = ctx.userIntent ?? '';
  for (const seg of splitCommandSegments(command)) {
    // 1) Discard-work family — block unless the user expressed discard intent.
    if (RE_RESET_HARD.test(seg) || RE_CHECKOUT_DISCARD.test(seg) || RE_CLEAN_FORCE.test(seg) || RE_STASH_DROP.test(seg)) {
      if (DISCARD_INTENT.test(intent)) continue;
      return {
        decision: 'block',
        rule: 'discard-work',
        reason: `"${seg}" discards local/uncommitted work, and you didn't ask to throw work away. If that's intended, say so explicitly (e.g. "discard my changes" / "reset the branch") and run it again.`,
      };
    }
    // 2) `git commit --amend` — only on a commit the agent authored this session.
    if (RE_AMEND.test(seg)) {
      const mine = !!ctx.headSha && !!ctx.agentAuthoredCommits?.has(ctx.headSha);
      if (mine) continue;
      return {
        decision: 'block',
        rule: 'amend-foreign',
        reason: `"git commit --amend" rewrites HEAD, but that commit wasn't created by me this session — amending could clobber work you or someone else authored. Make a NEW commit instead, or confirm explicitly that you want HEAD amended.`,
      };
    }
    // 3) IaC destroy — require the user to have named THIS specific stack/target.
    if (RE_IAC_DESTROY.test(seg)) {
      const target = extractIacTarget(seg);
      const authorized = DESTROY_INTENT.test(intent) && (target ? mentionsToken(intent, target) : false);
      if (authorized) continue;
      return {
        decision: 'block',
        rule: 'iac-destroy',
        reason: `"${seg}" tears down infrastructure. I only run an IaC destroy when you've explicitly asked to destroy that specific stack${target ? ` ("${target}")` : ''}. Name the stack to confirm.`,
      };
    }
  }
  return { decision: 'allow' };
}
