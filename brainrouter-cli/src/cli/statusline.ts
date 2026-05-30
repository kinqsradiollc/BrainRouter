import { execSync } from 'node:child_process';
import { formatBudget, readGoal } from '../state/goalStore.js';
import { readPlan } from '../state/taskStore.js';
import { getCurrentWorkflow } from '../state/workflowArtifacts.js';
import { readPreferences, resolveEffort } from '../state/preferencesStore.js';
import { costUsd } from '../runtime/pricing.js';

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
 *   - `exec`     — execution mode (fast); hidden when planning (the default)
 *   - `effort`   — reasoning depth (low / high); hidden when medium (the default)
 *   - `model`    — chat-LLM model name
 *   - `tokens`   — last turn's input/output tokens, only when calls > 0
 *   - `cost`     — last turn's USD cost + cache-hit %, only when calls > 0 (CLI-9)
 *   - `session`  — first ~22 chars of the sessionKey
 *   - `branch`   — git branch, only when in a git repo
 *   - `dirty`    — `*` when the working tree has uncommitted changes
 *   - `pr`       — github PR identifier (cached upstream of this helper)
 *   - `workflow` — current workflow slug if any
 *   - `goal`     — goal status + budget usage if any
 *   - `plan`     — completed/total plan items if a plan exists
 *
 * Note on segment naming: `mode` is the existing access-mode segment
 * (read/write/shell), kept under that name so user preference files like
 * `statusline: "mode,model"` keep working. The new execution-mode segment
 * is `exec` (fast / hidden-when-planning) to avoid colliding with `mode`
 * — `/mode` the command and `mode` the segment are deliberately decoupled.
 */

export const SEGMENT_NAMES = [
  'mode',
  'exec',
  'effort',
  'model',
  'tokens',
  'cost',
  'session',
  'branch',
  'dirty',
  'pr',
  'workflow',
  'goal',
  'plan',
  'brain',
] as const;

export type SegmentName = typeof SEGMENT_NAMES[number];

export interface SegmentInputs {
  workspaceRoot: string;
  sessionKey: string;
  accessMode: string;
  model: string;
  lastTurnUsage: { calls: number; promptTokens: number; completionTokens: number; cachedTokens?: number; missedTokens?: number };
  /** Optional GitHub PR identifier (e.g. "#42"). REPL caches the gh shell-out, so this is precomputed. */
  prDetector?: () => string | null;
  /**
   * 10c: brain-status detector (renders `brain` segment). REPL wires this
   * up by closing over the live `mcpClient.isConnected()` +
   * `mcpClient.getIdentity()` calls. Returns `'online'` / `'offline'` /
   * `'degraded'` when the active MCP is the BrainRouter brain, and
   * `undefined` otherwise so the segment hides for third-party MCPs.
   */
  brainStatus?: () => 'online' | 'offline' | 'degraded' | undefined;
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
    case 'exec': {
      // Show `fast` only — `planning` is the default, and surfacing it would
      // add chrome on every prompt for users who never touched /mode.
      try {
        const { executionMode } = readPreferences(inputs.workspaceRoot);
        return executionMode === 'fast' ? 'fast' : undefined;
      } catch {
        return undefined;
      }
    }
    case 'effort': {
      // Mirror the `exec` "show only when non-default" rule. `medium` is the
      // default and would just add chrome on every prompt for users who never
      // touched /effort.
      try {
        const resolved = resolveEffort(inputs.workspaceRoot);
        if (resolved.effort === 'medium') return undefined;
        return `effort:${resolved.effort}`;
      } catch {
        return undefined;
      }
    }
    case 'model':
      return inputs.model;
    case 'tokens': {
      const u = inputs.lastTurnUsage;
      if (u.calls <= 0) return undefined;
      return `${u.promptTokens}↑${u.completionTokens}↓`;
    }
    case 'cost': {
      // CLI-9 — last turn's USD cost (+ cache-hit % when known). Hidden before
      // the first turn; opt-in via the user's `statusline` preference.
      const u = inputs.lastTurnUsage;
      if (u.calls <= 0) return undefined;
      const cached = u.cachedTokens ?? 0;
      const missed = u.missedTokens ?? Math.max(0, u.promptTokens - cached);
      const usd = costUsd(inputs.model, { cachedTokens: cached, missedTokens: missed, completionTokens: u.completionTokens });
      const base = `$${usd.toFixed(4)}`;
      const totalPrompt = cached + missed;
      return totalPrompt > 0 ? `${base} ${Math.round((cached / totalPrompt) * 100)}% cached` : base;
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
      // The workflow segment is a pure navigation indicator: "which
      // workflow folder is this session writing artifacts to right now?"
      // Post-goal/workflow-decoupling (0.3.6) it does NOT carry a goal
      // status suffix — goals live at session scope (the `goal` segment),
      // workflows live at folder scope. Two orthogonal concerns.
      try {
        const slug = getCurrentWorkflow(inputs.workspaceRoot, inputs.sessionKey);
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
    case 'brain': {
      // 10c: only render when the active MCP is identified as BrainRouter
      // AND its state is non-default. The `brainStatus` detector returns
      // `undefined` for third-party MCPs (no brain to surface) and for
      // BrainRouter-online (default state — hide-when-default mirrors the
      // `exec` + `effort` pattern). Visible states: `offline` (red signal),
      // `degraded` (yellow signal — 10d local-only fallback).
      try {
        const state = inputs.brainStatus?.();
        if (!state || state === 'online') return undefined;
        if (state === 'offline') return 'brain:🔴';
        if (state === 'degraded') return 'brain:🟡';
        return undefined;
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
