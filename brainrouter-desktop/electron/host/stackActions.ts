/**
 * ADR-027 D13 — the desktop host implementations behind the `stack.*` control
 * actions.
 *
 * The control layer (D6) declares these actions with their types and side
 * effects; this is the half that actually does something. Until now they were
 * declarations with no host, which is the same "module with no caller" gap that
 * made the stack model inert when it first shipped.
 *
 * The desktop drives GitHub through the `gh` CLI rather than raw HTTP, so these
 * shell out. The runner is injected so the behaviour can be tested without a
 * GitHub account, a network, or an Electron window.
 */
import {
  validateStack,
  evaluateStackMerge,
  describeStack,
  adviseStacking,
  highestMergeableLayer,
  type PullRequestStack,
  type StackLayer,
} from '@kinqs/brainrouter-core/review';

/** Runs `gh api …` and parses JSON. Mirrors the host's existing gh runner. */
export type GhJson = <T>(args: string[], opts?: { timeout?: number }) => Promise<{ data?: T; error?: string }>;

export interface StackActionDeps {
  ghJson: GhJson;
  /** `owner/repo` for the active workspace, when one is known. */
  repo: () => string | null;
  /** Changed lines and file groups for the working tree, for stacking advice. */
  workingTreeGroups: () => Promise<{
    totalChangedLines: number;
    groups: Array<{ label: string; files: string[]; changedLines: number }>;
  }>;
}

interface RawLayer {
  number?: unknown;
  head?: { ref?: unknown } | unknown;
  base?: { ref?: unknown } | unknown;
  merged?: unknown;
  mergeable_state?: unknown;
  draft?: unknown;
}

function ref(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { ref?: unknown }).ref === 'string') {
    return (value as { ref: string }).ref;
  }
  return null;
}

function ready(raw: RawLayer): boolean {
  if (raw.draft === true) return false;
  const state = typeof raw.mergeable_state === 'string' ? raw.mergeable_state : 'unknown';
  return state === 'clean' || state === 'unstable';
}

/**
 * Build the validated stack, or explain why there is not one.
 *
 * Same posture as the brain-side adapter: everything degrades to "no stack"
 * with a reason, EXCEPT a chain that cannot be verified, which is refused
 * outright because an unverified chain must not be used to state merge order.
 */
export async function readStack(
  deps: StackActionDeps,
  pullNumber: number,
): Promise<{ stack: PullRequestStack | null; reason?: string }> {
  const repo = deps.repo();
  if (!repo) return { stack: null, reason: 'no GitHub repository is associated with this workspace' };
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    return { stack: null, reason: `"${pullNumber}" is not a pull request number` };
  }

  const result = await deps.ghJson<{ trunk?: unknown; base_ref?: unknown; pull_requests?: unknown; layers?: unknown }>(
    ['api', `repos/${repo}/stacks?pull_request=${pullNumber}`],
    { timeout: 10_000 },
  );
  if (result.error || !result.data) {
    return { stack: null, reason: result.error ?? 'the stack lookup returned nothing' };
  }

  try {
    const body = result.data;
    const rawLayers = Array.isArray(body.pull_requests)
      ? body.pull_requests
      : Array.isArray(body.layers) ? body.layers : [];
    if (rawLayers.length === 0) return { stack: null, reason: 'this pull request is not part of a stack' };

    const layers: StackLayer[] = [];
    for (const raw of rawLayers) {
      if (!raw || typeof raw !== 'object') return { stack: null, reason: 'a stack layer was not an object' };
      const entry = raw as RawLayer;
      const number = Number(entry.number);
      const head = ref(entry.head);
      const base = ref(entry.base);
      if (!Number.isInteger(number) || number <= 0 || !head || !base) {
        return { stack: null, reason: 'a stack layer was missing its number or branch refs' };
      }
      layers.push({ number, head, base, ready: ready(entry), ...(entry.merged === true ? { merged: true } : {}) });
    }
    const trunk = typeof body.trunk === 'string'
      ? body.trunk
      : typeof body.base_ref === 'string' ? body.base_ref : layers[0]!.base;
    const stack: PullRequestStack = { trunk, layers };
    validateStack(stack);
    return { stack };
  } catch (error) {
    return { stack: null, reason: `the stack could not be read (${error instanceof Error ? error.message : 'unknown'})` };
  }
}

/** `stack.describe` — layers, what can merge, and what is waiting on what. */
export async function describeStackAction(
  deps: StackActionDeps,
  args: Record<string, unknown>,
): Promise<{ stacked: boolean; text: string; mergeable?: number | null }> {
  const pullNumber = Number(args.pullNumber);
  const { stack, reason } = await readStack(deps, pullNumber);
  if (!stack) return { stacked: false, text: reason ?? 'no stack' };
  const next = highestMergeableLayer(stack);
  const verdicts = evaluateStackMerge(stack);
  const mine = verdicts.find((v) => v.number === pullNumber);
  const blocked = mine && !mine.mergeable && mine.reason.kind === 'blocked_below'
    ? `\n\n#${pullNumber} is waiting on #${mine.reason.by} below it — not on anything in #${pullNumber} itself.`
    : '';
  return {
    stacked: true,
    text: `${describeStack(stack)}${blocked}`,
    mergeable: next ? next.number : null,
  };
}

/** `stack.advise` — should this change be split, and where. */
export async function adviseStackingAction(
  deps: StackActionDeps,
): Promise<{ shouldStack: boolean; reason: string; layers: Array<{ label: string; files: readonly string[] }> }> {
  const { totalChangedLines, groups } = await deps.workingTreeGroups();
  const advice = adviseStacking({ totalChangedLines, groups });
  return {
    shouldStack: advice.shouldStack,
    reason: advice.reason,
    layers: advice.suggestedLayers.map((l) => ({ label: l.label, files: l.files })),
  };
}

/*
 * `createStackLayerAction` was REMOVED here — ADR-028 A2.
 *
 * It called `gh api repos/{repo}/pulls` with `base` set to the branch below.
 * That opens a pull request which TARGETS the right branch and is not
 * registered as a stack: no stack object, no bottom-up merge, no auto-retarget.
 * It returned `created: true` and a URL, so the caller believed they had a
 * stack they did not have.
 *
 * It is removed rather than deprecated because a tool that reports success for
 * work it did not do is worse than a missing tool — the human stops checking.
 * There is no deprecation window for a wrong answer.
 *
 * The replacement (A2) builds on `gh stack add` + `gh stack submit`, or
 * `gh stack link` where the branches and pull requests already exist, and needs
 * the exit-code contract from A3 to report failures honestly. Until then this
 * capability is absent, and absent is the truthful state.
 */
