/**
 * Cost + cache savings (0.3.9 item 14).
 *
 * Defaults live in `brainrouter-cli/config/models.json` (the `pricing`
 * field on each model entry) so vendor pricing updates can ship as a
 * JSON edit instead of a TypeScript edit. User overrides at
 * `~/.config/brainrouter/pricing.json` win over the shipped table.
 *
 * Cache-savings figure is computed against the model's miss rate vs.
 * the cache-hit rate — answers "how much did prefix caching actually
 * save me on the last turn?".
 *
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractCacheStats, type CacheStats } from './cacheStats.js';
import { loadModelsConfig, type ModelPricing } from './configLoader.js';

export type { ModelPricing } from './configLoader.js';

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
    // Bad / missing override → ignore, fall back to JSON defaults.
  }
  cachedOverride = {};
  return cachedOverride;
}

/** Test hook. */
export function _resetPricingCache(): void {
  cachedOverride = undefined;
}

/**
 * Resolve pricing for a model. Strips vendor prefixes; falls back to a
 * zero-cost row when no entry is found so callers don't divide-by-
 * undefined. Returns `undefined` ONLY when the model id is empty/invalid.
 */
export function pricingFor(modelId: string | undefined | null): ModelPricing | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const stripped = modelId.toLowerCase().includes('/')
    ? modelId.toLowerCase().slice(modelId.lastIndexOf('/') + 1)
    : modelId.toLowerCase();
  const override = loadOverride();
  if (override[stripped]) return override[stripped];
  const cfg = loadModelsConfig();
  const entry = cfg.models[stripped];
  if (entry?.pricing) return entry.pricing;
  return { inputCacheHit: 0, inputCacheMiss: 0, output: 0 };
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
 * USD savings from cache hits, vs. the same workload paying miss pricing
 * for every cached token. Always ≥ 0.
 */
export function cacheSavingsUsd(modelId: string, cachedTokens: number): number {
  if (cachedTokens <= 0) return 0;
  const p = pricingFor(modelId);
  if (!p) return 0;
  return (cachedTokens * (p.inputCacheMiss - p.inputCacheHit)) / 1_000_000;
}

/**
 * Format a USD cost with a colour band:
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
