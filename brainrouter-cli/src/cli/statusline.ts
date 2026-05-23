import { execSync } from 'node:child_process';
import { formatBudget, readGoal } from '../state/goalStore.js';
import { readPlan } from '../state/taskStore.js';
import { getCurrentWorkflow } from '../state/workflowArtifacts.js';

/**
 * Status-line segment renderers. Each segment is a pure-ish function from
 * (Inputs) → string|undefined; the prompt builder joins the non-empty
 * results with " · " and wraps them in the access-mode color.
 *
 * Why split this out from repl.ts? The 0.3.6 redesign adds workflow / goal /
 * plan / pr segments, so the inline switch in repl.ts was about to grow
 * past readable. Putting one function per segment keeps each rule small
 * AND makes the segment set unit-testable without booting a REPL.
 *
 * Segments deliberately stay narrow:
 *   - `mode`     — access mode (read/write/shell)
 *   - `model`    — chat-LLM model name
 *   - `tokens`   — last turn's input/output tokens, only when calls > 0
 *   - `session`  — first ~22 chars of the sessionKey
 *   - `branch`   — git branch, only when in a git repo
 *   - `dirty`    — `*` when the working tree has uncommitted changes
 *   - `pr`       — github PR identifier (cached upstream of this helper)
 *   - `workflow` — current workflow slug if any (NEW)
 *   - `goal`     — goal status + budget usage if any (NEW)
 *   - `plan`     — completed/total plan items if a plan exists (NEW)
 */

export const SEGMENT_NAMES = [
  'mode',
  'model',
  'tokens',
  'session',
  'branch',
  'dirty',
  'pr',
  'workflow',
  'goal',
  'plan',
] as const;

export type SegmentName = typeof SEGMENT_NAMES[number];

export interface SegmentInputs {
  workspaceRoot: string;
  sessionKey: string;
  accessMode: string;
  model: string;
  lastTurnUsage: { calls: number; promptTokens: number; completionTokens: number };
  /** Optional GitHub PR identifier (e.g. "#42"). REPL caches the gh shell-out, so this is precomputed. */
  prDetector?: () => string | null;
}

export function isKnownSegment(name: string): name is SegmentName {
  return (SEGMENT_NAMES as readonly string[]).includes(name);
}

/**
 * Render a single segment. Returns undefined when the segment has nothing
 * worth showing (e.g. `tokens` before the first turn, `branch` outside a
 * git repo, `goal` with no goal set). Callers should filter undefined out
 * before joining with separators.
 */
export function renderSegment(name: SegmentName, inputs: SegmentInputs): string | undefined {
  switch (name) {
    case 'mode':
      return inputs.accessMode;
    case 'model':
      return inputs.model;
    case 'tokens': {
      const u = inputs.lastTurnUsage;
      if (u.calls <= 0) return undefined;
      return `${u.promptTokens}↑${u.completionTokens}↓`;
    }
    case 'session': {
      const k = inputs.sessionKey;
      return k.length > 22 ? `${k.slice(0, 22)}…` : k;
    }
    case 'branch':
    case 'dirty': {
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: inputs.workspaceRoot,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
        if (name === 'branch') return branch;
        // dirty: only emit "*" when changes are present; quiet otherwise.
        const dirty = execSync('git status --porcelain', {
          cwd: inputs.workspaceRoot,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim() !== '';
        return dirty ? '*' : undefined;
      } catch {
        return undefined;
      }
    }
    case 'pr':
      return inputs.prDetector?.() ?? undefined;
    case 'workflow': {
      try {
        const slug = getCurrentWorkflow(inputs.workspaceRoot);
        if (!slug) return undefined;
        return `wf:${slug}`;
      } catch {
        return undefined;
      }
    }
    case 'goal': {
      try {
        const goal = readGoal(inputs.workspaceRoot, inputs.sessionKey);
        if (!goal) return undefined;
        const cap = formatBudget(goal.budget.maxIterations);
        const used = goal.budget.iterationsUsed;
        const statusLabel = goal.status === 'usage_limited' ? 'limited' : goal.status;
        // Active goals get the iteration ratio; terminal states stay terse.
        if (goal.status === 'active') return `goal:${statusLabel} ${used}/${cap}`;
        return `goal:${statusLabel}`;
      } catch {
        return undefined;
      }
    }
    case 'plan': {
      try {
        const plan = readPlan(inputs.workspaceRoot, inputs.sessionKey);
        if (!plan.items.length) return undefined;
        const done = plan.items.filter((i) => i.status === 'completed').length;
        return `plan:${done}/${plan.items.length}`;
      } catch {
        return undefined;
      }
    }
  }
}

/**
 * Render an ordered list of segments, dropping the ones that have nothing
 * to show. Returns a flat array of strings the caller joins with its own
 * separator + color treatment.
 */
export function renderSegments(names: readonly SegmentName[], inputs: SegmentInputs): string[] {
  const out: string[] = [];
  for (const name of names) {
    const rendered = renderSegment(name, inputs);
    if (rendered) out.push(rendered);
  }
  return out;
}
