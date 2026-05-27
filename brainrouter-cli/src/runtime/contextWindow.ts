/**
 * Per-model context-window lookup (0.3.9 follow-up).
 *
 * Defaults live in `brainrouter-cli/config/models.json` so vendor SKU
 * updates can ship as a JSON-file patch instead of a TypeScript edit.
 * User overrides at `~/.config/brainrouter/contextWindows.json` win.
 *
 * Lookup order on `formatContextWindow(modelId)`:
 *   1. Exact match in user override (lowercase).
 *   2. Vendor-prefix-stripped match in user override.
 *   3. Exact match in `models.json`.
 *   4. Vendor-prefix-stripped match in `models.json`.
 *   5. Heuristic family fallback from `models.json` `familyFallbacks`
 *      (e.g. `gpt-5-2025-04-01` → `gpt-5`).
 *
 * Returns `undefined` when nothing matches — callers render a neutral
 * "?" rather than guessing.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadModelsConfig } from './configLoader.js';
import { lookupLmStudioModel } from './lmStudioApi.js';

let cachedOverride: Record<string, number> | undefined;

function loadOverride(): Record<string, number> {
  if (cachedOverride !== undefined) return cachedOverride;
  const overridePath = path.join(os.homedir(), '.config', 'brainrouter', 'contextWindows.json');
  try {
    if (fs.existsSync(overridePath)) {
      const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        const lowered: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
            lowered[k.toLowerCase()] = v;
          }
        }
        cachedOverride = lowered;
        return cachedOverride;
      }
    }
  } catch {
    // Bad / missing override → ignore.
  }
  cachedOverride = {};
  return cachedOverride;
}

/** Test hook. */
export function _resetContextWindowCache(): void {
  cachedOverride = undefined;
}

/**
 * Look up a model's context window in tokens.
 *
 * Resolution order (first hit wins):
 *   1. `~/.config/brainrouter/contextWindows.json` — exact match.
 *   2. Same file — vendor-prefix-stripped (`openai/gpt-5` → `gpt-5`).
 *   3. **LM Studio's native `/api/v1/models` cache** — when the user
 *      is on a local LM Studio endpoint, the model's `max_context_length`
 *      from LM Studio is *more* authoritative than our shipped JSON
 *      (it reflects the actual loaded variant + quantisation).
 *   4. `brainrouter-cli/config/models.json` — exact match.
 *   5. Same file — vendor-prefix-stripped.
 *   6. `models.json` `familyFallbacks` — regex match for versioned
 *      variants (`gpt-5-2025-04-01` → `gpt-5`).
 *
 * Returns `undefined` when nothing matches.
 */
export function contextWindowFor(modelId: string | undefined | null): number | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const raw = modelId.toLowerCase();
  const stripped = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const override = loadOverride();
  const cfg = loadModelsConfig();

  if (raw in override) return override[raw];
  if (stripped in override) return override[stripped];

  // LM Studio enrichment. Only fires when the cache was populated at
  // session boot via `refreshLmStudioCache(endpoint)` — populates only
  // for LM Studio endpoints. When the user is NOT on LM Studio this
  // lookup short-circuits to `undefined` and we fall through to the
  // shipped JSON.
  const lm = lookupLmStudioModel(modelId);
  if (lm?.maxContextLength !== undefined && lm.maxContextLength > 0) {
    return lm.maxContextLength;
  }

  const exact = cfg.models[raw];
  if (exact?.contextWindow !== undefined) return exact.contextWindow;
  const strippedHit = cfg.models[stripped];
  if (strippedHit?.contextWindow !== undefined) return strippedHit.contextWindow;

  // Family fallback — compiled regexes from models.json `familyFallbacks`.
  for (const fb of cfg.familyFallbacks) {
    if (fb.pattern.test(stripped)) {
      const target = cfg.models[fb.fallbackTo];
      if (target?.contextWindow !== undefined) return target.contextWindow;
    }
  }
  return undefined;
}

/**
 * Format a context window for footer rendering. Returns "200k" / "1M" /
 * "128k" for common sizes; returns "?" when unknown so the footer never
 * lies about an unseen model.
 */
export function formatContextWindow(modelId: string | undefined | null): string {
  const w = contextWindowFor(modelId);
  if (w === undefined) return '?';
  if (w >= 1_000_000) {
    const m = w / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (w >= 1_000) {
    const k = Math.round(w / 1_000);
    return `${k}k`;
  }
  return String(w);
}
