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

import { loadModelsConfig } from '../config/configLoader.js';
import { lookupLmStudioModel } from '../provider/providers/lmstudio/index.js';
import { lookupManagedModelContext } from '../provider/managedModelContext.js';
import { getCliKnobs } from '../config/config.js';

/**
 * ADR-045 — the config.json `cli.contextWindows` per-model override, read lazily
 * so this module keeps no eager dependency on the config module (cycle-safe:
 * `getCliKnobs` is only called at lookup time, never at module init). Values are
 * already validated + lowercased by `sanitizeContextWindows`.
 *
 * ADR-045 M5 — the legacy `~/.config/brainrouter/contextWindows.json` override
 * file is RETIRED: it is migrated into `cli.contextWindows` once, at boot
 * (`migrateLegacyContextWindowsFile`), so this lookup reads one authoritative
 * source instead of two.
 */
function cliContextWindowOverride(): Record<string, number> {
  try {
    return getCliKnobs().contextWindows ?? {};
  } catch {
    return {};
  }
}

/**
 * Test hook, retained for API compatibility (called on config reload by
 * `context/service.ts`). The per-model override now lives in `cli.contextWindows`
 * — read live via `getCliKnobs()` with no local cache — so there is nothing to
 * reset here since M5 retired the separate legacy-file cache.
 */
export function _resetContextWindowCache(): void {
  /* no-op — see doc above */
}

/**
 * Look up a model's context window in tokens.
 *
 * Resolution order (first hit wins):
 *   1. `cli.contextWindows` (config.json) — exact match. The user's own setting
 *      (the legacy `contextWindows.json` file is migrated into this at boot).
 *   2. Same knob — vendor-prefix-stripped (`openai/gpt-5` → `gpt-5`).
 *   3. **LM Studio's native `/api/v1/models` cache** — when the user
 *      is on a local LM Studio endpoint, the model's `max_context_length`
 *      from LM Studio is *more* authoritative than our shipped JSON
 *      (it reflects the actual loaded variant + quantisation).
 *   4. `brainrouter-cli/config/models.json` — exact match.
 *   5. Same file — vendor-prefix-stripped.
 *   6. `models.json` `familyFallbacks` — regex match for versioned
 *      variants (`gpt-5-2025-04-01` → `gpt-5`).
 *
 *   7. ADR-045 M4 — a window resolved above is CLAMPED to a BrainRouter
 *      gateway's advertised `context_window` (an org cap only ever tightens).
 *
 * Returns `undefined` when nothing matches.
 */
function baseContextWindow(modelId: string): number | undefined {
  const raw = modelId.toLowerCase();
  const stripped = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const cfg = loadModelsConfig();

  // ADR-045 — the config.json `cli.contextWindows` knob is the authoritative
  // per-model override (the legacy override file was migrated into it at boot).
  const cli = cliContextWindowOverride();
  if (raw in cli) return cli[raw];
  if (stripped in cli) return cli[stripped];

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

export function contextWindowFor(modelId: string | undefined | null): number | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const base = baseContextWindow(modelId);
  // ADR-045 M4 — clamp to a gateway-advertised cap. The cap only tightens:
  // with a known base it is `min(base, cap)`; with no base the cap IS the window
  // (a managed model carries none locally). No cap advertised ⇒ base unchanged.
  const cap = lookupManagedModelContext(modelId);
  if (cap !== undefined && cap > 0) {
    return base === undefined ? cap : Math.min(base, cap);
  }
  return base;
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

/**
 * §5.6 — a context window that is ALWAYS a usable number, for budget / ring math.
 * `contextWindowFor` returns `undefined` for an unknown model so the footer can
 * honestly render "?"; a consumer sizing a context ring or a token budget needs
 * a real number instead, so this falls back to a safe 128k default.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function contextWindowForBudget(modelId: string | undefined | null): number {
  return contextWindowFor(modelId) ?? DEFAULT_CONTEXT_WINDOW;
}
