import { loadModelsConfig, type ModelPricing } from '../config/configLoader.js';

export const BUDGET_EXCEEDED_CLASSIFICATION = 'budget_exceeded' as const;

export interface TaskBudgetCaps {
  maxPerTaskUSD: number;
  maxPerTaskTokens: number;
}

export interface BudgetUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  missedTokens?: number;
}

export interface BudgetSnapshot {
  classification: typeof BUDGET_EXCEEDED_CLASSIFICATION;
  capUsd?: number;
  spentUsd?: number;
  capTokens?: number;
  spentTokens?: number;
}

export class BudgetExceededError extends Error {
  readonly classification = BUDGET_EXCEEDED_CLASSIFICATION;
  readonly budget: BudgetSnapshot;

  constructor(snapshot: Omit<BudgetSnapshot, 'classification'>) {
    const details = [
      snapshot.capUsd !== undefined && snapshot.spentUsd !== undefined
        ? `$${snapshot.spentUsd.toFixed(6)} >= $${snapshot.capUsd.toFixed(6)}`
        : '',
      snapshot.capTokens !== undefined && snapshot.spentTokens !== undefined
        ? `${snapshot.spentTokens} >= ${snapshot.capTokens} tokens`
        : '',
    ].filter(Boolean).join(', ');
    super(`Task budget exceeded${details ? ` (${details})` : ''}`);
    this.name = 'BudgetExceededError';
    this.budget = { classification: BUDGET_EXCEEDED_CLASSIFICATION, ...snapshot };
  }
}

export function isBudgetExceededError(error: unknown): error is BudgetExceededError {
  return Boolean(error && typeof error === 'object' && (error as { classification?: unknown }).classification === BUDGET_EXCEEDED_CLASSIFICATION);
}

export function pricingForBudget(modelId: string | undefined | null): ModelPricing | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const stripped = modelId.toLowerCase().includes('/')
    ? modelId.toLowerCase().slice(modelId.lastIndexOf('/') + 1)
    : modelId.toLowerCase();
  const cfg = loadModelsConfig();
  const entry = cfg.models[stripped];
  if (entry?.pricing) return entry.pricing;
  for (const fb of cfg.familyFallbacks) {
    if (fb.pattern.test(stripped)) {
      const target = cfg.models[fb.fallbackTo];
      if (target?.pricing) return target.pricing;
    }
  }
  return { inputCacheHit: 0, inputCacheMiss: 0, output: 0 };
}

export function taskUsageTokens(usage: BudgetUsage): number {
  return Math.max(0, Math.floor(usage.promptTokens + usage.completionTokens));
}

export function taskUsageUsd(modelId: string, usage: BudgetUsage): number {
  const pricing = pricingForBudget(modelId);
  if (!pricing) return 0;
  const cachedTokens = Math.max(0, Math.floor(usage.cachedTokens ?? 0));
  const reportedMissed = Math.max(0, Math.floor(usage.missedTokens ?? 0));
  const promptTokens = Math.max(0, Math.floor(usage.promptTokens));
  const missedTokens = cachedTokens > 0 || reportedMissed > 0
    ? reportedMissed
    : promptTokens;
  const completionTokens = Math.max(0, Math.floor(usage.completionTokens));
  return (
    (cachedTokens * (pricing.inputCacheHit ?? 0) +
      missedTokens * pricing.inputCacheMiss +
      completionTokens * pricing.output) /
    1_000_000
  );
}

export function enforceTaskBudget(input: {
  caps: TaskBudgetCaps;
  modelId: string;
  usage: BudgetUsage;
}): void {
  const capTokens = Math.max(0, Math.floor(input.caps.maxPerTaskTokens));
  if (capTokens > 0) {
    const spentTokens = taskUsageTokens(input.usage);
    if (spentTokens >= capTokens) {
      throw new BudgetExceededError({ capTokens, spentTokens });
    }
  }

  const capUsd = Math.max(0, input.caps.maxPerTaskUSD);
  if (capUsd > 0) {
    const spentUsd = taskUsageUsd(input.modelId, input.usage);
    if (spentUsd >= capUsd) {
      throw new BudgetExceededError({ capUsd, spentUsd });
    }
  }
}
