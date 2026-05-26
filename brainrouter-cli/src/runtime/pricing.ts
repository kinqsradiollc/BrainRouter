/**
 * Cost + cache savings (0.3.9 item 14).
 *
 * `/tokens` and the Ink status line surface per-turn USD by reading
 * the active model's pricing from this table plus any user override.
 * The cache-savings figure is computed against the model's miss rate
 * vs. the cache-hit rate, so it answers "how much did prefix caching
 * actually save me on the last turn?".
 *
 * Pricing source-of-truth: vendor docs at the time of writing. None
 * of this is hot-keyed; the table is intentionally small (the
 * 0.3.9 slim-catalog has three provider rows). Bigger / more dynamic
 * pricing lives behind `~/.config/brainrouter/pricing.json` overrides.
 *
 * Reference: openSrc/DeepSeek-Reasonix/src/telemetry/stats.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractCacheStats, type CacheStats } from './cacheStats.js';

export interface ModelPricing {
  /** USD per 1M cached-input tokens (hit). */
  inputCacheHit: number;
  /** USD per 1M un-cached-input tokens (miss). */
  inputCacheMiss: number;
  /** USD per 1M output tokens. */
  output: number;
}

/**
 * Built-in pricing as of 0.3.9. **Treat as a default, not a contract.**
 * Vendor pricing drifts; users should override via
 * `~/.config/brainrouter/pricing.json` for anything load-bearing.
 *
 * Lookup is case-insensitive; we strip any vendor prefix (`openai/`,
 * `openrouter/`) before matching. Anthropic-native rows were removed
 * in 0.3.9 alongside the native /v1/messages adapter — users routing
 * Claude through OpenRouter can supply override rows in
 * `~/.config/brainrouter/pricing.json`.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // OpenAI (gpt-5 family — placeholder, vendor list drifts).
  'gpt-5-pro': { inputCacheHit: 0.7, inputCacheMiss: 7.0, output: 28.0 },
  'gpt-5': { inputCacheHit: 0.125, inputCacheMiss: 1.25, output: 5.0 },
  'gpt-5-mini': { inputCacheHit: 0.025, inputCacheMiss: 0.25, output: 1.0 },
  // DeepSeek (numbers from Reasonix telemetry table).
  'deepseek-v4-pro': { inputCacheHit: 0.003625, inputCacheMiss: 0.435, output: 0.87 },
  'deepseek-v4-flash': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  // Local endpoints — free.
  'lm-studio': { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
  'ollama': { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
};

let cachedOverride: Record<string, ModelPricing> | undefined;

function loadOverride(): Record<string, ModelPricing> {
  if (cachedOverride !== undefined) return cachedOverride;
  const overridePath = path.join(os.homedir(), '.config', 'brainrouter', 'pricing.json');
  try {
    if (fs.existsSync(overridePath)) {
      const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        cachedOverride = raw as Record<string, ModelPricing>;
        return cachedOverride;
      }
    }
  } catch {
    // Bad / missing override → ignore, fall back to defaults.
  }
  cachedOverride = {};
  return cachedOverride;
}

/** Reset the cached override (test hook). */
export function _resetPricingCache(): void {
  cachedOverride = undefined;
}

/**
 * Resolve pricing for a model. Strips vendor prefixes; falls back to
 * a zero-cost row when no entry is found so callers don't divide-by-
 * undefined. Returns `undefined` ONLY when the model id is itself
 * empty/invalid.
 */
export function pricingFor(modelId: string | undefined | null): ModelPricing | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const stripped = modelId.toLowerCase().includes('/')
    ? modelId.toLowerCase().slice(modelId.lastIndexOf('/') + 1)
    : modelId.toLowerCase();
  const override = loadOverride();
  return override[stripped] ?? DEFAULT_PRICING[stripped] ?? { inputCacheHit: 0, inputCacheMiss: 0, output: 0 };
}

export interface UsageLike {
  cachedTokens: number;
  missedTokens: number;
  completionTokens: number;
}

/** Total USD cost: cache-hit input + cache-miss input + output. */
export function costUsd(modelId: string, usage: UsageLike): number {
  const p = pricingFor(modelId);
  if (!p) return 0;
  return (
    (usage.cachedTokens * p.inputCacheHit +
      usage.missedTokens * p.inputCacheMiss +
      usage.completionTokens * p.output) /
    1_000_000
  );
}

/**
 * USD savings from cache hits, vs. the same workload paying miss
 * pricing for every cached token. Always ≥ 0.
 */
export function cacheSavingsUsd(modelId: string, cachedTokens: number): number {
  if (cachedTokens <= 0) return 0;
  const p = pricingFor(modelId);
  if (!p) return 0;
  return (cachedTokens * (p.inputCacheMiss - p.inputCacheHit)) / 1_000_000;
}

/**
 * Format a USD cost with a colour band:
 *
 *   - green  <$0.05
 *   - yellow $0.05–0.20
 *   - red    ≥$0.20
 *
 * The threshold ratios match the Reasonix `StatsPanel` colouring (the
 * session band is 10× the turn band; callers pick which).
 */
export interface CostBadge {
  text: string;
  band: 'green' | 'yellow' | 'red' | 'mono';
}

export function formatCostBadge(usd: number, scale: 'turn' | 'session' = 'turn'): CostBadge {
  if (!Number.isFinite(usd) || usd === 0) {
    return { text: '$0.00', band: 'mono' };
  }
  const factor = scale === 'session' ? 10 : 1;
  const display = `$${usd.toFixed(usd >= 0.01 ? 3 : 4)}`;
  if (usd < 0.05 * factor) return { text: display, band: 'green' };
  if (usd < 0.20 * factor) return { text: display, band: 'yellow' };
  return { text: display, band: 'red' };
}

/**
 * Bundle that the `/tokens` panel and the status line render. Pure
 * pricing + cache math; no I/O.
 */
export interface CostSummary {
  turnCostUsd: number;
  sessionCostUsd: number;
  turnCacheSavedUsd: number;
  sessionCacheSavedUsd: number;
  turnBadge: CostBadge;
  sessionBadge: CostBadge;
  cacheStats: { turn: CacheStats; session: CacheStats };
}

export interface SessionUsageSnapshot {
  model: string;
  turnCachedTokens: number;
  turnMissedTokens: number;
  turnCompletionTokens: number;
  sessionCachedTokens: number;
  sessionMissedTokens: number;
  sessionCompletionTokens: number;
}

export function buildCostSummary(s: SessionUsageSnapshot): CostSummary {
  const turnUsage = {
    cachedTokens: s.turnCachedTokens,
    missedTokens: s.turnMissedTokens,
    completionTokens: s.turnCompletionTokens,
  };
  const sessionUsage = {
    cachedTokens: s.sessionCachedTokens,
    missedTokens: s.sessionMissedTokens,
    completionTokens: s.sessionCompletionTokens,
  };
  const turnCost = costUsd(s.model, turnUsage);
  const sessionCost = costUsd(s.model, sessionUsage);
  const turnSaved = cacheSavingsUsd(s.model, s.turnCachedTokens);
  const sessionSaved = cacheSavingsUsd(s.model, s.sessionCachedTokens);
  return {
    turnCostUsd: turnCost,
    sessionCostUsd: sessionCost,
    turnCacheSavedUsd: turnSaved,
    sessionCacheSavedUsd: sessionSaved,
    turnBadge: formatCostBadge(turnCost, 'turn'),
    sessionBadge: formatCostBadge(sessionCost, 'session'),
    cacheStats: {
      turn: extractCacheStats({
        prompt_tokens_details: { cached_tokens: s.turnCachedTokens },
        prompt_tokens: s.turnCachedTokens + s.turnMissedTokens,
        completion_tokens: s.turnCompletionTokens,
      }),
      session: extractCacheStats({
        prompt_tokens_details: { cached_tokens: s.sessionCachedTokens },
        prompt_tokens: s.sessionCachedTokens + s.sessionMissedTokens,
        completion_tokens: s.sessionCompletionTokens,
      }),
    },
  };
}
