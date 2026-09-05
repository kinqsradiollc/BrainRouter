/**
 * ADR-052 P2b — per-ORG contracted pricing, stored in the system-settings KV
 * (`pricingSettings:${orgId}`) — the same pattern as recall/agent settings. Cost
 * surfaces (dashboard spend, telemetry cost) read this so an org with a
 * negotiated rate sees ITS numbers, not list price. Every field is optional; an
 * unset field falls back to list price.
 *
 * Two independent levers:
 *   - a global `discountMultiplier` applied to every list price (0.8 = 20% off);
 *   - explicit per-model `rates` (USD per 1M tokens) that OVERRIDE list price for
 *     the models named.
 */

/** A contracted per-model rate, USD per 1,000,000 tokens. Either side optional. */
export interface ModelRate {
  inputPerMTok?: number;
  outputPerMTok?: number;
}

/** All fields optional; an unset field ⇒ list price. */
export interface OrgPricingSettings {
  /** A multiplier applied to every list price (e.g. 0.8 = a 20% contracted discount). */
  discountMultiplier?: number;
  /** Explicit contracted rates by model id (override list price for those models). */
  rates?: Record<string, ModelRate>;
}

export interface PricingSettingField {
  key: 'discountMultiplier';
  label: string;
  kind: 'float';
  min: number;
  max: number;
  envDefault: number;
  help: string;
}

export const PRICING_SETTING_FIELDS: readonly PricingSettingField[] = [
  { key: 'discountMultiplier', label: 'Contracted discount ×', kind: 'float', min: 0.01, max: 2, envDefault: 1, help: 'Multiplier applied to every list price. 1 = list price; 0.8 = a 20% contracted discount.' },
] as const;

/** A non-negative, finite USD rate, or undefined when unparseable. */
function cleanRate(v: unknown): number | undefined {
  const n = Number.parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/**
 * Validate + clamp an untrusted pricing object (from the admin API or the KV
 * store). Unknown keys dropped; the multiplier clamped to its range; each model
 * rate kept only when it has at least one non-negative finite side. Returns a
 * clean object with only the fields actually set.
 */
export function normalizeOrgPricingSettings(input: unknown): OrgPricingSettings {
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {};
  const out: OrgPricingSettings = {};

  const rawMult = src.discountMultiplier;
  if (rawMult !== undefined && rawMult !== null && rawMult !== '') {
    const n = Number.parseFloat(String(rawMult));
    if (Number.isFinite(n)) out.discountMultiplier = Math.min(2, Math.max(0.01, n));
  }

  const rawRates = src.rates;
  if (rawRates && typeof rawRates === 'object' && !Array.isArray(rawRates)) {
    const rates: Record<string, ModelRate> = {};
    for (const [model, val] of Object.entries(rawRates as Record<string, unknown>)) {
      const id = typeof model === 'string' ? model.trim() : '';
      if (!id || !val || typeof val !== 'object') continue;
      const v = val as Record<string, unknown>;
      const rate: ModelRate = {};
      const inp = cleanRate(v.inputPerMTok);
      const outp = cleanRate(v.outputPerMTok);
      if (inp !== undefined) rate.inputPerMTok = inp;
      if (outp !== undefined) rate.outputPerMTok = outp;
      if (rate.inputPerMTok !== undefined || rate.outputPerMTok !== undefined) rates[id] = rate;
    }
    if (Object.keys(rates).length) out.rates = rates;
  }

  return out;
}

/**
 * Resolve the effective USD-per-Mtok rate for a model given the org's settings:
 * an explicit contracted rate wins; otherwise the list rate scaled by the
 * discount multiplier. `listInput`/`listOutput` are the list USD-per-Mtok rates.
 */
export function effectiveModelRate(
  settings: OrgPricingSettings,
  model: string,
  listInput: number,
  listOutput: number,
): { inputPerMTok: number; outputPerMTok: number } {
  const explicit = settings.rates?.[model];
  const mult = settings.discountMultiplier ?? 1;
  return {
    inputPerMTok: explicit?.inputPerMTok ?? listInput * mult,
    outputPerMTok: explicit?.outputPerMTok ?? listOutput * mult,
  };
}
