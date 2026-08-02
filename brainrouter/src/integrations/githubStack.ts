/**
 * ADR-027 D13 — read a stacked pull request from GitHub.
 *
 * GitHub's stacked PRs (public preview, 2026-07-30) expose the stack on the
 * pull-request payload. This adapter turns that into the `PullRequestStack`
 * shape the core model validates and reasons over, so the review path can say
 * something true about a layer whose mergeability depends on layers below it.
 *
 * Everything here is BEST EFFORT and fails soft. A repository not in the
 * preview, an API shape that shifts while the feature is in preview, or a plain
 * unstacked pull request must all degrade to "no stack" — the review still runs
 * and still reports findings. Making a review fail because a preview-era
 * endpoint changed shape would trade a working gate for a cosmetic one.
 */
import {
  validateStack,
  type PullRequestStack,
  type StackLayer,
} from "@kinqs/brainrouter-core/review";

/** Minimal shape we read from the API. Unknown fields are ignored. */
interface RawStackEntry {
  number?: unknown;
  head?: { ref?: unknown } | unknown;
  base?: { ref?: unknown } | unknown;
  merged?: unknown;
  mergeable_state?: unknown;
  draft?: unknown;
}

function branchRef(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { ref?: unknown }).ref === "string") {
    return (value as { ref: string }).ref;
  }
  return null;
}

/**
 * A layer is "ready" when GitHub says it is mergeable and it is not a draft.
 *
 * `mergeable_state` is deliberately treated as ready ONLY for the states that
 * positively mean it: `clean`, and `unstable` (non-required checks failing).
 * `unknown` means GitHub has not finished computing it, and calling that ready
 * would produce a merge button that fails when pressed — worse than waiting.
 */
function layerReady(entry: RawStackEntry): boolean {
  if (entry.draft === true) return false;
  const state = typeof entry.mergeable_state === "string" ? entry.mergeable_state : "unknown";
  return state === "clean" || state === "unstable";
}

export interface StackFetchResult {
  stack: PullRequestStack | null;
  /** Why there is no stack, for the activity log. Never surfaced as an error. */
  reason?: string;
}

/**
 * Read the stack containing `prNumber`, or null when there is not one.
 *
 * The layers come back bottom-first because the core model's ordering is
 * meaningful and validated; if the API ever returns them in another order this
 * throws in `validateStack` and we degrade to "no stack" rather than reporting
 * a merge order that is not real.
 */
export async function fetchPullRequestStack(input: {
  fetchImpl: typeof fetch;
  apiBase: string;
  repo: string;
  prNumber: number;
  token: string;
  headers: (token: string) => Record<string, string>;
}): Promise<StackFetchResult> {
  const { fetchImpl, apiBase, repo, prNumber, token, headers } = input;
  let payload: unknown;
  try {
    const response = await fetchImpl(
      `${apiBase}/repos/${repo}/pulls/${prNumber}/stack`,
      { headers: headers(token) },
    );
    if (response.status === 404) {
      return { stack: null, reason: "not part of a stack" };
    }
    if (!response.ok) {
      return { stack: null, reason: `stack lookup returned HTTP ${response.status}` };
    }
    payload = await response.json();
  } catch (error) {
    return {
      stack: null,
      reason: error instanceof Error ? error.message : "stack lookup failed",
    };
  }

  const body = (payload ?? {}) as { trunk?: unknown; base_ref?: unknown; pull_requests?: unknown; layers?: unknown };
  const rawLayers = Array.isArray(body.pull_requests)
    ? body.pull_requests
    : Array.isArray(body.layers) ? body.layers : [];
  if (rawLayers.length === 0) return { stack: null, reason: "the stack has no layers" };

  const layers: StackLayer[] = [];
  for (const raw of rawLayers as RawStackEntry[]) {
    const number = Number(raw.number);
    const head = branchRef(raw.head);
    const base = branchRef(raw.base);
    if (!Number.isInteger(number) || number <= 0 || !head || !base) {
      // A layer we cannot identify makes the whole chain unverifiable, and a
      // chain we cannot verify must not be used to decide merge order.
      return { stack: null, reason: "a stack layer was missing its number or branch refs" };
    }
    layers.push({
      number,
      head,
      base,
      ready: layerReady(raw),
      ...(raw.merged === true ? { merged: true } : {}),
    });
  }

  const trunk = typeof body.trunk === "string"
    ? body.trunk
    : typeof body.base_ref === "string"
      ? body.base_ref
      : layers[0]!.base;

  const stack: PullRequestStack = { trunk, layers };
  try {
    validateStack(stack);
  } catch (error) {
    return {
      stack: null,
      reason: `stack failed validation (${error instanceof Error ? error.message : "unknown"})`,
    };
  }
  if (!layers.some((layer) => layer.number === prNumber)) {
    return { stack: null, reason: "the returned stack does not contain this pull request" };
  }
  return { stack };
}
