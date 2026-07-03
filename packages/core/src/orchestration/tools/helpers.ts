import fs from 'node:fs';
import path from 'node:path';
import { getCliKnobs } from '../../config/config.js';
// MAS-P5-T2: the child-output offload thresholds are now the shared
// result-handoff constants (single source of truth in runtime/resultHandoff).
import { RESULT_HANDOFF_THRESHOLD_CHARS, RESULT_PREVIEW_CHARS } from '../../util/resultHandoff.js';
import type { AccessMode } from '../registry/roles.js';
import type { OrchestrationContext } from './context.js';

// Threshold above which a child agent's final output is offloaded to the
// BrainRouter working-memory canvas rather than embedded directly in the
// parent's context. ~6k chars ≈ 1.5k tokens — enough room for short reports
// in-line, big enough that a 20k-char architecture analysis goes out-of-band.
export const OFFLOAD_THRESHOLD_CHARS = RESULT_HANDOFF_THRESHOLD_CHARS;
export const OFFLOAD_PREVIEW_CHARS = RESULT_PREVIEW_CHARS;

/**
 * Order the three access modes by power so spawn_agent can refuse to grant
 * a child more than the parent already has.
 */
const ACCESS_RANK: Record<AccessMode, number> = { read: 0, write: 1, shell: 2 };

export function clampAccess(parent: AccessMode, requested: AccessMode): AccessMode {
  return ACCESS_RANK[requested] <= ACCESS_RANK[parent] ? requested : parent;
}

/**
 * Build the parent-visible preview of an offloaded child output. The naive
 * `slice(0, N)` form hid the conclusion when children wrote long reports;
 * here we prefer an explicit summary section (the role overlays nudge each
 * child to start with one) and fall back to head+tail so both the framing
 * and the punchline survive the clamp.
 *
 * Exported for testability.
 */
export function extractChildPreview(output: string, maxChars: number): string {
  // 1. Pick a leading Markdown summary heading if present. The role overlays
  //    encourage children to open with one of these.
  const HEADING_PATTERNS = [
    /^#{1,3}\s+(headline|tl;?dr|summary|key findings?|bottom line|conclusion)[^\n]*/im,
  ];
  for (const heading of HEADING_PATTERNS) {
    const match = heading.exec(output);
    if (match) {
      const start = match.index;
      // Section runs until the next `##` heading or end of doc.
      const next = output.slice(start + match[0].length).search(/\n#{1,3}\s/);
      const end = next < 0 ? output.length : start + match[0].length + next;
      const section = output.slice(start, end).trim();
      if (section.length <= maxChars) return section;
      return section.slice(0, maxChars - 1) + '…';
    }
  }
  // 2. Otherwise show head + tail so the conclusion isn't hidden.
  if (output.length <= maxChars) return output;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 6; // 6 chars for the `\n...\n` divider
  return output.slice(0, head) + '\n…\n' + output.slice(-tail);
}

// Default wait timeout for foreground delegation. 0 = wait until completion.
// Child execution itself is not killed by this value; its inner loops are
// bounded by maxToolLoops plus per-call LLM/MCP/shell timeouts and reconnect.
export const DEFAULT_TASK_AGENT_TIMEOUT_MS = 0;
export const DEFAULT_CHILD_AGENT_TIMEOUT_MS = 0;

/**
 * Heuristic auto-router. Maps a free-text task to the best role based on
 * leading verbs and intent keywords. Pure text-classification — used by
 * `route_task` and the batch-spawn role inference, no LLM turn required.
 */
export function inferRoleFromTask(task: string): 'explorer' | 'architect' | 'reviewer' | 'worker' | 'verifier' {
  const t = task.trim().toLowerCase();
  if (/^(investigate|explore|map|survey|find|locate|inspect|audit|scan|read|look at|grep|trace)/.test(t)
    || /\b(where is|where does|how does|what files|which files)\b/.test(t)) {
    return 'explorer';
  }
  if (/^(design|propose|architect|plan|outline|sketch|model|compare)/.test(t)
    || /\b(architecture|design alternatives|tradeoff|spec)\b/.test(t)) {
    return 'architect';
  }
  if (/^(review|critique|evaluate|assess|grade)/.test(t)
    || /\b(code review|nitpick|smell|maintainability)\b/.test(t)) {
    return 'reviewer';
  }
  if (/^(test|verify|run tests|check|validate)/.test(t)
    || /\b(typecheck|lint|build passes?|tests? pass)\b/.test(t)) {
    return 'verifier';
  }
  // Default — implementation work.
  return 'worker';
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveChildLaunchCwd(ctx: OrchestrationContext, rawWorkdir: unknown): string {
  const parentCwd = (() => {
    try {
      const root = fs.realpathSync(ctx.workspaceRoot);
      const real = fs.realpathSync(ctx.launchCwd);
      return isInside(root, real) ? real : root;
    } catch {
      return ctx.workspaceRoot;
    }
  })();
  if (typeof rawWorkdir !== 'string' || rawWorkdir.trim() === '') return parentCwd;

  try {
    const root = fs.realpathSync(ctx.workspaceRoot);
    const requested = path.isAbsolute(rawWorkdir)
      ? path.resolve(rawWorkdir)
      : path.resolve(parentCwd, rawWorkdir);
    if (!fs.existsSync(requested)) return parentCwd;
    const realRequested = fs.realpathSync(requested);
    if (!fs.statSync(realRequested).isDirectory()) return parentCwd;
    if (!isInside(root, realRequested)) return parentCwd;
    return realRequested;
  } catch {
    return parentCwd;
  }
}

export function parentWaitTimeoutMsFromArgs(args: any): number {
  const knobValue = getCliKnobs().childAgentTimeoutMs;
  const raw = Number(args?.timeoutMs ?? knobValue ?? DEFAULT_CHILD_AGENT_TIMEOUT_MS);
  // 0 / invalid / negative ⇒ no parent wait timeout.
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}
