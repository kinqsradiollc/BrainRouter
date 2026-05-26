/**
 * Model-tier self-escalation (0.3.9 item 13).
 *
 * `/effort low|medium|high` tunes reasoning depth but does not change
 * model tiers. Users on multi-tier providers cannot let the *model*
 * decide when a task exceeds its current tier's reasoning budget.
 *
 * Reasonix exposes this via the `<<<NEEDS_PRO>>>` marker — the model
 * emits it on the FIRST line of its response when it has decided that
 * the task needs a stronger model. The runtime aborts the current
 * call and retries on the next tier.
 *
 * Our generalisation: `<<<NEEDS_HIGH>>>` (and `<<<NEEDS_HIGH: <reason>>>>`),
 * mapped through a per-provider `tierLadder` so the same contract
 * works on OpenAI / DeepSeek / OpenRouter without hard-coding any one
 * vendor's model names into the runtime.
 *
 * Behaviour:
 *
 *   - The marker MUST be the first non-empty line of the response.
 *   - The runtime aborts the current call, walks up the ladder by one
 *     step, and retries the same turn on the new tier.
 *   - On the top tier the marker is a no-op (Pillar 3.4 contract).
 *   - Auxiliary calls (`runCompaction`, child-agent spawns, repair
 *     retries) ALWAYS pin to the lowest tier — there's no reason to
 *     pay top-tier rates for "paraphrase these tool results".
 *   - Every escalation is surfaced as a yellow Ink warning row. Silent
 *     escalation is intentionally rejected.
 */

import { readPreferences, writePreferences } from '../state/preferencesStore.js';

/** First-line marker. Matches both forms: bare and with `:reason`. */
export const NEEDS_HIGH_MARKER_RE = /^\s*<<<NEEDS_HIGH(?::\s*([^>]*))?>>>/m;

export type TierName = 'flash' | 'standard' | 'pro';

export interface TierLadder {
  /** Provider id (`openai` / `deepseek` / generic). */
  provider: string;
  /** Model ids per tier. Each step is one provider-tier up. */
  ladder: Record<TierName, string>;
}

/**
 * Built-in ladders. Add the user's `tierLadder` override from
 * `~/.config/brainrouter/config.json` via `resolveTierLadder()`.
 *
 * The default ladders mirror the published model families as of
 * 0.3.9. They aren't authoritative — every key can be overridden in
 * the user's config. Don't ship a list that pins one vendor's marketing.
 */
export const DEFAULT_LADDERS: Record<string, TierLadder> = {
  // Anthropic native ladder removed in 0.3.9 alongside the native
  // /v1/messages adapter. Users who route Claude through OpenRouter or
  // a similar OpenAI-compat gateway can supply a custom ladder via the
  // user override in `~/.config/brainrouter/config.json`.
  openai: {
    provider: 'openai',
    ladder: {
      flash: 'gpt-5-mini',
      standard: 'gpt-5',
      pro: 'gpt-5-pro',
    },
  },
  deepseek: {
    provider: 'deepseek',
    ladder: {
      flash: 'deepseek-v4-flash',
      standard: 'deepseek-v4-flash',
      pro: 'deepseek-v4-pro',
    },
  },
};

/**
 * Detect a self-escalation marker on the first non-empty line of the
 * model's response. Returns `null` when absent.
 */
export interface NeedsHighDetection {
  reason: string | null;
}

export function detectNeedsHigh(content: string | null | undefined): NeedsHighDetection | null {
  if (!content) return null;
  // Anchor to first non-whitespace line — markers later in the content
  // are likely the model quoting itself, not a real escalation request.
  const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const match = firstLine.match(NEEDS_HIGH_MARKER_RE);
  if (!match) return null;
  const reason = (match[1] ?? '').trim();
  return { reason: reason || null };
}

/**
 * Strip the marker from a response so the user-visible content
 * doesn't contain it. Returns the original string when no marker was
 * present.
 */
export function stripNeedsHigh(content: string | null | undefined): string {
  if (!content) return '';
  return content.replace(NEEDS_HIGH_MARKER_RE, '').trimStart();
}

export interface ResolveTierLadderOptions {
  /** Provider id from `LLMConfig.provider`. */
  provider: string | undefined;
  /** Optional custom ladder read from `~/.config/brainrouter/config.json`. */
  override?: Partial<Record<TierName, string>>;
}

/**
 * Pick the ladder for a provider, layering any user override over the
 * default. Returns a normalised `{ flash, standard, pro }` map. Falls
 * back to a single-tier ladder when the provider isn't recognised AND
 * no override is supplied — the marker becomes a no-op there.
 */
export function resolveTierLadder(opts: ResolveTierLadderOptions): TierLadder {
  const builtin = DEFAULT_LADDERS[opts.provider ?? ''];
  if (builtin) {
    return {
      provider: builtin.provider,
      ladder: { ...builtin.ladder, ...(opts.override ?? {}) },
    };
  }
  if (opts.override && opts.override.flash && opts.override.standard && opts.override.pro) {
    return {
      provider: opts.provider ?? 'custom',
      ladder: {
        flash: opts.override.flash,
        standard: opts.override.standard,
        pro: opts.override.pro,
      },
    };
  }
  // Unknown provider + no override → no escalation possible.
  const model = opts.override?.flash ?? opts.override?.standard ?? opts.override?.pro ?? '';
  return {
    provider: opts.provider ?? 'custom',
    ladder: { flash: model, standard: model, pro: model },
  };
}

/**
 * Identify the user's current tier given the active model id and the
 * resolved ladder. Returns the highest matching tier in case of a
 * collision (which can happen on providers like DeepSeek where flash
 * = standard).
 */
export function currentTier(modelId: string, ladder: TierLadder): TierName | null {
  const order: TierName[] = ['pro', 'standard', 'flash'];
  for (const t of order) {
    if (ladder.ladder[t] === modelId) return t;
  }
  return null;
}

/**
 * Return the next tier up, or null if we're already at the top. The
 * `<<<NEEDS_HIGH>>>` contract says "top tier marker is a no-op" — this
 * helper encodes that contract.
 */
export function nextTier(current: TierName | null): TierName | null {
  if (current === 'flash') return 'standard';
  if (current === 'standard') return 'pro';
  return null;
}

export interface PinTierOptions {
  workspaceRoot: string;
  tier: TierName;
}

/**
 * Persist `/tier <name>` to `~/.config/brainrouter/config.json` under
 * the existing preferences store. Auxiliary calls still pin to flash
 * regardless of this setting.
 */
export function pinTier(opts: PinTierOptions): void {
  const prefs = readPreferences(opts.workspaceRoot);
  writePreferences(opts.workspaceRoot, { ...prefs, tier: opts.tier });
}

export function readPinnedTier(workspaceRoot: string): TierName | null {
  const prefs = readPreferences(workspaceRoot);
  const t = (prefs as any).tier;
  if (t === 'flash' || t === 'standard' || t === 'pro') return t;
  return null;
}
