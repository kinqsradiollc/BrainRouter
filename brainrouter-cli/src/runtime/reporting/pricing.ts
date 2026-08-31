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
import { extractCacheStats, type CacheStats } from '@kinqs/brainrouter-core/util';
import { loadModelsConfig, type ModelPricing } from '@kinqs/brainrouter-core/config';

export type { ModelPricing } from '@kinqs/brainrouter-core/config';

let cachedOverride: Record<string, ModelPricing> | undefined;
// ADR-052 P2b — a global discount multiplier over the resolved rates, so an org
// with a contracted discount sees its real cost, not list price. Read from a
// reserved `__discount` key in pricing.json; defaults to 1 (no discount).
let cachedDiscount = 1;

function loadOverride(): Record<string, ModelPricing> {
  if (cachedOverride !== undefined) return cachedOverride;
  // Respect BRAINROUTER_CONFIG_DIR the same way config.ts does, so the override
  // is redirectable (tests, hosts) — default stays ~/.config/brainrouter.
  const dir = process.env.BRAINROUTER_CONFIG_DIR?.trim() || path.join(os.homedir(), '.config', 'brainrouter');
  const overridePath = path.join(dir, 'pricing.json');
  try {
    if (fs.existsSync(overridePath)) {
      const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        // ADR-052 P2b — pull the reserved discount key out of the model map.
        const { __discount, ...models } = raw as Record<string, unknown>;
        if (typeof __discount === 'number' && Number.isFinite(__discount) && __discount > 0) {
          cachedDiscount = __discount;
        }
        cachedOverride = models as Record<string, ModelPricing>;
        return cachedOverride;
      }
    }
  } catch {
    // Bad / missing override → ignore, fall back to JSON defaults.
  }
  cachedOverride = {};
  return cachedOverride;
}

/** ADR-052 P2b — the contracted discount multiplier (1 = list price). */
export function discountMultiplier(): number {
  loadOverride(); // ensure the discount is read from disk
  return cachedDiscount;
}

/** Test hook. */
export function _resetPricingCache(): void {
  cachedOverride = undefined;
  cachedDiscount = 1;
}

/**
 * Resolve pricing for a model. Strips vendor prefixes, then resolves in the
 * SAME order as `contextWindowFor()`: user override → exact entry →
 * `familyFallbacks` regex → zero-cost row. The family-fallback walk is what
 * lets a new dot-versioned SKU (e.g. `gpt-5.3-codex`, absent from models.json)
 * resolve to its family's pricing instead of silently zeroing to "$0.00".
 * Returns `undefined` ONLY when the model id is empty/invalid.
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
  // Family fallback — mirror contextWindowFor() so pricing survives a new SKU
  // id the same way the context window does. Without this, ranking-correct
  // context resolution and $0 pricing diverge for every unlisted variant.
  for (const fb of cfg.familyFallbacks) {
    if (fb.pattern.test(stripped)) {
      const target = cfg.models[fb.fallbackTo];
      if (target?.pricing) return target.pricing;
    }
  }
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
  const listCost = (
    usage.cachedTokens * (p.inputCacheHit ?? 0) +
    usage.missedTokens * p.inputCacheMiss +
    usage.completionTokens * p.output
  ) / 1_000_000;
  // ADR-052 P2b — scale by the contracted discount so cost surfaces show real spend.
  return listCost * discountMultiplier();
}

/**
 * USD savings from cache hits, vs. the same workload paying miss pricing
 * for every cached token. Always ≥ 0.
 */
export function cacheSavingsUsd(modelId: string, cachedTokens: number): number {
  if (cachedTokens <= 0) return 0;
  const p = pricingFor(modelId);
  if (!p) return 0;
  return (cachedTokens * (p.inputCacheMiss - (p.inputCacheHit ?? 0))) / 1_000_000;
}

/**
 * Format a USD cost with a colour band:
 *   - green  <$0.05
 *   - yellow $0.05–0.20
 *   - red    ≥$0.20
 *
 * The session band is 10× the turn band; callers pick which.
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
