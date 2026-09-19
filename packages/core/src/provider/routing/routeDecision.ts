/**
 * ADR-061 D3.3 — which route the chain starts on.
 *
 * `resolveRoutes` answers `auto` with a static ordered chain: the configured
 * provider order, optionally sorted free-first. That is a good fallback order
 * and a poor first guess, because it never reads the request. Every question
 * gets the same head — the small local model that cannot hold the file someone
 * pasted, or the frontier model being paid for to reformat some JSON.
 *
 * This asks one `choice` over the chain the resolver already produced: *which
 * of these routes is the least costly one that can do this?* The options ARE
 * the chain's own routes, described from what the registry already knows —
 * free, local, context window, tool support — so the tier can neither name a
 * model that is not configured nor invent a criterion for picking one.
 *
 * Three properties make it safe in front of a router that is always on:
 *
 *  - **`resolveRoutes` is untouched.** It stays pure and synchronous; this runs
 *    after it, on the array it returned. An explicit model request never
 *    reaches here — only `auto` does (ADR-041's contract is unchanged).
 *  - **The chain is not reordered, only re-headed.** The chosen route moves to
 *    the front and every other route keeps its relative position, so the
 *    fallback order someone configured still reads the same way down the list.
 *  - **The floor is the head.** `rulesAnswer` is the chain's own first route,
 *    so on the default `rules` provider the same array comes back — the same
 *    entries, in the same order, by identity. That equivalence is pinned by a
 *    test, and it is what makes this landable in an always-on router.
 *
 * Pure: no I/O of its own, and no clock. The provider behind the port owns both.
 */

import { MAX_CHOICE_OPTIONS, type DecisionAnswer, type DecisionPort, type DecisionState } from '../../decision/types.js';
import type { ModelRegistryEntry } from './types.js';

/**
 * How many of the chain's routes are described to a provider.
 *
 * This bounds what leaves the machine (D4) and keeps the question a decision
 * rather than a catalog: a chain longer than this still falls back through
 * every route, but only its first N are candidates to START on.
 */
export const ROUTE_CHOICE_DEFAULT_MAX_CANDIDATES = 12;

export interface RouteChoiceInput {
  /** What the caller asked for, ALREADY REDACTED by the caller (D4). */
  task?: string;
  /** Roughly how much text the request carries — the context-window signal. */
  approxPromptChars?: number;
  /** The request offers tools, so a route that cannot call them cannot serve it. */
  requiresTools?: boolean;
}

export interface RouteChoiceVerdict {
  /** The chain to attempt, in order. The same array contents, possibly re-headed. */
  routes: ModelRegistryEntry[];
  /** The slug now at the head. Empty only when the chain was empty. */
  promoted: string;
  /** True only when the head actually moved. */
  changed: boolean;
  /**
   * Absent when there was nothing to decide — an empty or single-route chain.
   * A decision nobody made is not recorded as one.
   */
  answer?: DecisionAnswer;
}

const QUESTION_ID = 'start';

const INSTRUCTIONS =
  'Pick the least costly route that can complete this task safely. Prefer a free or local '
  + 'route when it can do the work. Prefer a larger context window when the task carries a lot '
  + 'of text, and a route that supports tool calls when the task needs them. Do not pick a more '
  + 'capable route than the task requires.';

/** One line per candidate, from what the registry knows — never from a catalog blurb. */
export function describeRoute(route: ModelRegistryEntry): string {
  const def = route.providerDef as
    { local?: boolean; contextWindow?: number; supportsTools?: boolean } | undefined;
  const parts = [`${route.model} on ${route.provider}`];
  parts.push(route.llm.free === true || def?.local === true ? 'free to run' : 'billed per token');
  if (def?.local === true) parts.push('runs on this machine');
  if (typeof def?.contextWindow === 'number' && def.contextWindow > 0) {
    parts.push(`${formatContext(def.contextWindow)} context`);
  }
  if (def?.supportsTools === false) parts.push('cannot call tools');
  return parts.join(', ');
}

/** The state a provider sees. Bounded here so no consumer can forget to (D4). */
export function routeDecisionState(input: RouteChoiceInput, maxChars: number): DecisionState {
  const limit = Math.max(40, Math.floor(maxChars * 0.5));
  const task = input.task?.trim();
  const chars = input.approxPromptChars;
  return {
    ...(task ? { task: task.length > limit ? `${task.slice(0, limit)}…` : task } : {}),
    ...(typeof chars === 'number' && Number.isFinite(chars)
      ? { approxPromptChars: Math.max(0, Math.round(chars)) }
      : {}),
    ...(input.requiresTools ? { needsToolCalls: true } : {}),
  };
}

/**
 * Promote the route the chain should START on.
 *
 * Never throws and never drops a route: the worst case is the array it was
 * handed, which is the outcome the caller already had.
 */
export async function chooseStartingRoute(
  port: DecisionPort,
  routes: readonly ModelRegistryEntry[],
  input: RouteChoiceInput = {},
  options: { maxCandidates?: number; maxStateChars?: number } = {},
): Promise<RouteChoiceVerdict> {
  const chain = [...routes];
  const limit = Math.max(1, Math.min(
    options.maxCandidates ?? ROUTE_CHOICE_DEFAULT_MAX_CANDIDATES,
    MAX_CHOICE_OPTIONS,
  ));
  const candidates = chain.slice(0, limit);
  const head = candidates[0];
  // One route is not a choice, and no route is the caller's 404, not ours.
  if (!head || candidates.length < 2) {
    return { routes: chain, promoted: head?.slug ?? '', changed: false };
  }

  const choices: Record<string, string> = {};
  for (const route of candidates) choices[route.slug] = describeRoute(route);

  const answers = await port.ask(
    routeDecisionState(input, options.maxStateChars ?? 8_000),
    {
      [QUESTION_ID]: {
        kind: 'choice',
        instructions: INSTRUCTIONS,
        options: choices,
        // The chain's own head — so the floor keeps the configured order.
        rulesAnswer: head.slug,
      },
    },
  );
  const answer = answers[QUESTION_ID]!;
  const promoted = typeof answer.value === 'string' ? answer.value : head.slug;
  const chosen = chain.find((route) => route.slug === promoted);
  if (!chosen || promoted === chain[0]!.slug) {
    return { routes: chain, promoted: chain[0]!.slug, changed: false, answer };
  }
  return {
    routes: [chosen, ...chain.filter((route) => route.slug !== promoted)],
    promoted,
    changed: true,
    answer,
  };
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
