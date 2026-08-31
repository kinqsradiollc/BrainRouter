/**
 * ADR-054 D1 — the per-org, per-automation usage aggregate the dashboard reads.
 *
 * A bounded map (top-N automations) of token totals the client pushes; a pure
 * `mergeOrgUsage` folds a delta in, and `priceOrgUsage` turns it into
 * per-automation cost at the ORG's contracted rate (reusing ADR-052 P2b's
 * `effectiveModelRate`), so ADR-052 §5.3 — "the dashboard names the automation
 * behind any token spike, priced at the org's real rates" — is met.
 */
import { effectiveModelRate, type OrgPricingSettings } from "../pricing/orgPricingSettings.js";

/** Keep the aggregate small no matter how many automations report. */
export const MAX_AUTOMATIONS = 100;

export interface AutomationAggregate {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  turns: number;
  /** The dominant model id seen for this automation (last non-empty wins; used for pricing). */
  model?: string;
}

/** Keyed by automation id (loop id / fleet-job id / "subagent" / "interactive"). */
export type OrgUsageAggregate = Record<string, AutomationAggregate>;

/** One pushed increment for an automation. */
export interface UsageDelta {
  automation: string;
  promptTokens?: number;
  completionTokens?: number;
  calls?: number;
  turns?: number;
  model?: string;
}

function nonNegInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Fold one usage delta into the aggregate, then bound to the top-N automations by total tokens. */
export function mergeOrgUsage(existing: OrgUsageAggregate | undefined, delta: UsageDelta): OrgUsageAggregate {
  const out: OrgUsageAggregate = { ...(existing ?? {}) };
  const id = typeof delta.automation === "string" ? delta.automation.trim() : "";
  if (!id) return out; // an unattributed delta is dropped (never a nameless bucket)

  const cur: AutomationAggregate = out[id] ?? { promptTokens: 0, completionTokens: 0, calls: 0, turns: 0 };
  cur.promptTokens += nonNegInt(delta.promptTokens);
  cur.completionTokens += nonNegInt(delta.completionTokens);
  cur.calls += nonNegInt(delta.calls);
  cur.turns += nonNegInt(delta.turns);
  if (typeof delta.model === "string" && delta.model.trim()) cur.model = delta.model.trim();
  out[id] = cur;

  const ids = Object.keys(out);
  if (ids.length > MAX_AUTOMATIONS) {
    const kept = ids
      .sort((a, b) => (out[b].promptTokens + out[b].completionTokens) - (out[a].promptTokens + out[a].completionTokens))
      .slice(0, MAX_AUTOMATIONS);
    const bounded: OrgUsageAggregate = {};
    for (const k of kept) bounded[k] = out[k];
    return bounded;
  }
  return out;
}

export interface PricedAutomation {
  automation: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  turns: number;
  model?: string;
  /** Estimated USD cost at the org's contracted rate. */
  estCostUsd: number;
}

/** A list USD-per-Mtok rate for a model; unknown models default to zero (no phantom cost). */
export type ListRateLookup = (model: string) => { inputPerMTok: number; outputPerMTok: number };

/**
 * Price the aggregate into per-automation cost at the org's contracted rate,
 * newest-cost-first. `listRateFor` supplies each model's LIST rate; the org's
 * pricing (discount × / explicit per-model rate) is applied via P2b.
 */
export function priceOrgUsage(
  aggregate: OrgUsageAggregate,
  pricing: OrgPricingSettings,
  listRateFor: ListRateLookup,
): PricedAutomation[] {
  return Object.entries(aggregate)
    .map(([automation, a]) => {
      const model = a.model ?? "";
      const list = listRateFor(model);
      const rate = effectiveModelRate(pricing, model, list.inputPerMTok, list.outputPerMTok);
      const estCostUsd = (a.promptTokens / 1_000_000) * rate.inputPerMTok + (a.completionTokens / 1_000_000) * rate.outputPerMTok;
      return { automation, promptTokens: a.promptTokens, completionTokens: a.completionTokens, calls: a.calls, turns: a.turns, ...(a.model ? { model: a.model } : {}), estCostUsd };
    })
    .sort((x, y) => y.estCostUsd - x.estCostUsd);
}
