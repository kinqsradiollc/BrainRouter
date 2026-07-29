/**
 * Purpose: Own bounded provider-route execution and produce the shared,
 * secret-free recovery receipt used by host adapters.
 */
import type {
  ProviderRecoveryAttemptReceipt,
  ProviderRecoveryFailure,
  ProviderRecoveryOutcome,
  ProviderRecoveryReceipt,
  ProviderRouteRef,
} from '@kinqs/brainrouter-types';

import { classifyRouterFailure, type RouterPolicy } from './policy.js';
import type { ModelRegistryEntry, RouterFailure } from './routerTypes.js';

export interface ProviderRecoveryExecutionOptions<T> {
  routes: readonly ModelRegistryEntry[];
  execute: (route: ModelRegistryEntry, attempt: number) => Promise<T>;
  policy: RouterPolicy;
  maxAttempts?: number;
  sessionKey?: string;
  now?: () => Date;
  onReceipt?: (receipt: ProviderRecoveryReceipt) => void;
  initialFailure?: {
    route: ModelRegistryEntry;
    error: unknown;
    startedAt?: string;
    completedAt?: string;
  };
  onFallback?: (event: {
    from: ModelRegistryEntry;
    to: ModelRegistryEntry;
    failure: RouterFailure;
  }) => void;
}

export interface ProviderRecoveryExecution<T> {
  route: ModelRegistryEntry;
  result: T;
  receipt: ProviderRecoveryReceipt;
}

export class ProviderRecoveryExhaustedError extends Error {
  readonly code = 'PROVIDER_RECOVERY_EXHAUSTED';

  constructor(message = 'No route available.') {
    super(message);
    this.name = 'ProviderRecoveryExhaustedError';
  }
}

function routeRef(route: ModelRegistryEntry): ProviderRouteRef {
  return {
    slug: route.slug,
    provider: route.provider,
    model: route.model,
  };
}

function failureRef(failure: RouterFailure): ProviderRecoveryFailure {
  return {
    kind: failure.kind,
    retryable: failure.retryable,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
  };
}

function freezeReceipt(receipt: ProviderRecoveryReceipt): ProviderRecoveryReceipt {
  for (const attempt of receipt.attempts) {
    Object.freeze(attempt.route);
    if (attempt.failure) Object.freeze(attempt.failure);
    Object.freeze(attempt);
  }
  if (receipt.selectedRoute) Object.freeze(receipt.selectedRoute);
  Object.freeze(receipt.attempts);
  return Object.freeze(receipt);
}

function completeReceipt(
  startedAt: string,
  maxAttempts: number,
  outcome: ProviderRecoveryOutcome,
  attempts: ProviderRecoveryAttemptReceipt[],
  now: () => Date,
  selectedRoute?: ProviderRouteRef,
): ProviderRecoveryReceipt {
  return freezeReceipt({
    version: 1,
    startedAt,
    completedAt: now().toISOString(),
    maxAttempts,
    outcome,
    attempts,
    ...(selectedRoute ? { selectedRoute } : {}),
  });
}

async function notify(
  callback: ProviderRecoveryExecutionOptions<unknown>['onReceipt'],
  receipt: ProviderRecoveryReceipt,
): Promise<void> {
  try {
    await callback?.(receipt);
  } catch {
    // Telemetry/projection adapters cannot change model execution semantics.
  }
}

function boundedAttempts(value: number | undefined): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(1, Math.floor(value ?? 4));
}

/**
 * Execute each route at most once. Retryable failures may select another
 * policy-approved route; a non-retryable failure stops immediately.
 */
export async function executeWithProviderRecovery<T>(
  options: ProviderRecoveryExecutionOptions<T>,
): Promise<ProviderRecoveryExecution<T>> {
  const now = options.now ?? (() => new Date());
  const maxAttempts = boundedAttempts(options.maxAttempts);
  const startedAt = options.initialFailure?.startedAt ?? now().toISOString();
  const attempts: ProviderRecoveryAttemptReceipt[] = [];
  const tried = new Set<string>();
  let lastError: unknown;
  let lastFailedRoute: ModelRegistryEntry | undefined;
  let lastFailure: RouterFailure | undefined;

  if (options.initialFailure) {
    const failure = classifyRouterFailure(options.initialFailure.error);
    options.policy.markFailure(options.initialFailure.route, failure);
    tried.add(options.initialFailure.route.slug);
    attempts.push({
      attempt: 1,
      route: routeRef(options.initialFailure.route),
      startedAt,
      completedAt: options.initialFailure.completedAt ?? now().toISOString(),
      outcome: 'failed',
      failure: failureRef(failure),
    });
    lastError = options.initialFailure.error;
    lastFailedRoute = options.initialFailure.route;
    lastFailure = failure;
  }

  for (let index = attempts.length; index < maxAttempts; index += 1) {
    if (lastFailure && !lastFailure.retryable) break;
    const route = options.policy.pickRoute(
      options.routes.filter((candidate) => !tried.has(candidate.slug)),
      options.sessionKey,
    );
    if (!route) break;

    if (lastFailedRoute && lastFailure) {
      options.policy.noteFallback(lastFailedRoute.slug, route.slug, lastFailure);
      await options.onFallback?.({
        from: lastFailedRoute,
        to: route,
        failure: lastFailure,
      });
    }
    tried.add(route.slug);
    const attemptStartedAt = now().toISOString();

    try {
      const result = await options.execute(route, index + 1);
      options.policy.noteSuccess(route, options.sessionKey);
      attempts.push({
        attempt: index + 1,
        route: routeRef(route),
        startedAt: attemptStartedAt,
        completedAt: now().toISOString(),
        outcome: 'succeeded',
      });
      const receipt = completeReceipt(startedAt, maxAttempts, 'succeeded', attempts, now, routeRef(route));
      await notify(options.onReceipt, receipt);
      return { route, result, receipt };
    } catch (error) {
      lastError = error;
      const failure = classifyRouterFailure(error);
      options.policy.markFailure(route, failure);
      attempts.push({
        attempt: index + 1,
        route: routeRef(route),
        startedAt: attemptStartedAt,
        completedAt: now().toISOString(),
        outcome: 'failed',
        failure: failureRef(failure),
      });
      lastFailedRoute = route;
      lastFailure = failure;
      if (!failure.retryable) break;
    }
  }

  const outcome: ProviderRecoveryOutcome = lastFailure && !lastFailure.retryable ? 'failed' : 'exhausted';
  const receipt = completeReceipt(startedAt, maxAttempts, outcome, attempts, now);
  await notify(options.onReceipt, receipt);
  if (lastError instanceof Error) throw lastError;
  throw new ProviderRecoveryExhaustedError(lastError === undefined ? undefined : String(lastError));
}
