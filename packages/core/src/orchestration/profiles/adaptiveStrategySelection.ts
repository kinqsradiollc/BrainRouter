/**
 * One bounded managed-model choice over already validated orchestration data.
 *
 * The model can select only eligible strategy/stage identifiers. The
 * deterministic resolver remains the authority chokepoint and every failed
 * attempt converges on the definition's validated primary-only fallback.
 */
import {
  buildAdaptiveStrategySelectionRequest,
  parseAdaptiveStrategySelection,
  type AdaptiveStrategySelectionModelCompletion,
  type EligibleAdaptiveStrategy,
} from './adaptiveStrategySelectionModel.js';
import {
  resolveWorkspaceOrchestrationPlan,
  type ResolvedWorkspaceOrchestrationPlan,
  type WorkspaceOrchestrationResolutionInput,
} from './orchestrationProfileResolver.js';

export const ADAPTIVE_STRATEGY_MODEL_TIMEOUT_MS = 5_000;

export type AdaptiveStrategySelectionFallbackReason =
  | 'model-unavailable'
  | 'model-timeout'
  | 'model-error'
  | 'invalid-model-output'
  | 'no-eligible-strategy';

export interface AdaptiveStrategySelectionResult {
  plan: ResolvedWorkspaceOrchestrationPlan;
  modelAttempted: boolean;
  fallbackReason?: AdaptiveStrategySelectionFallbackReason;
  /**
   * Bounded display-only explanation. Do not persist it as telemetry because a
   * model may restate user task content.
   */
  rationale?: string;
}

export interface AdaptiveStrategySelectionOptions {
  resolutionInput: WorkspaceOrchestrationResolutionInput;
  taskSummary: string;
  complete?: AdaptiveStrategySelectionModelCompletion;
  /** Test seam; production values are clamped to the five-second ceiling. */
  timeoutMs?: number;
}

/** Resolve one managed choice or the deterministic primary-only fallback. */
export async function resolveAdaptiveWorkspaceOrchestrationPlan(
  options: AdaptiveStrategySelectionOptions,
): Promise<AdaptiveStrategySelectionResult> {
  const input = options.resolutionInput;
  const deterministic = resolveWorkspaceOrchestrationPlan(input);
  if (
    !input.definition
    || !input.manifest
    || input.explicitStrategyId
    || input.manifest.orchestration.mode !== 'adaptive'
  ) {
    return { plan: deterministic, modelAttempted: false };
  }

  const eligible = eligibleStrategies(input);
  if (eligible.length === 0) {
    return {
      plan: deterministic,
      modelAttempted: false,
      fallbackReason: 'no-eligible-strategy',
    };
  }

  const fallback = () => resolveWorkspaceOrchestrationPlan({
    ...input,
    managedSelection: null,
    managedSelectionAttempted: true,
  });
  if (!options.complete) {
    return {
      plan: fallback(),
      modelAttempted: false,
      fallbackReason: 'model-unavailable',
    };
  }

  const request = buildAdaptiveStrategySelectionRequest(
    options.taskSummary,
    eligible,
  );
  const controller = new AbortController();
  try {
    const raw = await completeWithTimeout(
      () => options.complete!({
        ...request,
        signal: controller.signal,
      }),
      controller,
      boundedTimeout(options.timeoutMs),
    );
    const selection = parseAdaptiveStrategySelection(raw, eligible);
    if (!selection) {
      return invalidModelFallback(fallback(), true);
    }
    const plan = resolveWorkspaceOrchestrationPlan({
      ...input,
      managedSelection: {
        strategyId: selection.strategyId,
        enabledStageIds: selection.enabledStageIds,
      },
      managedSelectionAttempted: true,
    });
    if (plan.selectionSource !== 'adaptive-model') {
      return invalidModelFallback(fallback(), true);
    }
    return {
      plan,
      modelAttempted: true,
      rationale: selection.rationale,
    };
  } catch (error) {
    return {
      plan: fallback(),
      modelAttempted: true,
      fallbackReason: error instanceof AdaptiveStrategySelectionTimeoutError
        ? 'model-timeout'
        : 'model-error',
    };
  } finally {
    controller.abort();
  }
}

function eligibleStrategies(
  input: WorkspaceOrchestrationResolutionInput,
): EligibleAdaptiveStrategy[] {
  const definition = input.definition;
  if (!definition) return [];
  const eligible: EligibleAdaptiveStrategy[] = [];
  for (const strategy of definition.strategies) {
    if (strategy.activation.explicitOnly) continue;
    const matchedSignalIds = strategy.activation.signals.filter((signal) =>
      input.taskSignalIds.has(signal));
    if (matchedSignalIds.length === 0) continue;
    const preview = resolveWorkspaceOrchestrationPlan({
      ...input,
      explicitStrategyId: strategy.id,
      managedSelection: undefined,
      managedSelectionAttempted: false,
    });
    if (preview.selectionSource !== 'explicit' || preview.strategyId !== strategy.id) {
      continue;
    }
    eligible.push({ definition: strategy, matchedSignalIds });
  }
  return eligible;
}

function invalidModelFallback(
  plan: ResolvedWorkspaceOrchestrationPlan,
  modelAttempted: boolean,
): AdaptiveStrategySelectionResult {
  return {
    plan,
    modelAttempted,
    fallbackReason: 'invalid-model-output',
  };
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return ADAPTIVE_STRATEGY_MODEL_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(Math.trunc(value), ADAPTIVE_STRATEGY_MODEL_TIMEOUT_MS));
}

function completeWithTimeout(
  complete: () => Promise<string>,
  controller: AbortController,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AdaptiveStrategySelectionTimeoutError());
    }, timeoutMs);
    try {
      complete().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

class AdaptiveStrategySelectionTimeoutError extends Error {}
