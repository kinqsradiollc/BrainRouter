/**
 * Purpose: Adapt a failed agent LLM attempt to the shared provider recovery
 * executor without leaking agent transcript or presentation concerns into it.
 */
import type { ProviderRecoveryReceipt } from '@kinqs/brainrouter-types';

import {
  executeWithProviderRecovery,
  type ProviderRecoveryExecution,
} from '../../provider/routing/recovery.js';
import type { RouterPolicy } from '../../provider/routing/policy.js';
import type { ModelRegistryEntry, RouterFailure } from '../../provider/routing/types.js';

export interface AgentProviderRecoveryFallback {
  from: ModelRegistryEntry;
  to: ModelRegistryEntry;
  failure: RouterFailure;
}

export interface AgentProviderRecoveryOptions<T> {
  initialRoute: ModelRegistryEntry;
  initialError: unknown;
  initialStartedAt: string;
  routes: readonly ModelRegistryEntry[];
  triedRoutes: Set<string>;
  policy: RouterPolicy;
  sessionKey?: string;
  execute: (route: ModelRegistryEntry, attempt: number) => Promise<T>;
  onFallback?: (event: AgentProviderRecoveryFallback) => void;
  onReceipt?: (receipt: ProviderRecoveryReceipt) => void;
}

/**
 * Include the already-failed primary attempt in one bounded campaign, then
 * attempt each remaining per-turn route no more than once.
 */
export async function recoverAgentProviderRoute<T>(
  options: AgentProviderRecoveryOptions<T>,
): Promise<ProviderRecoveryExecution<T>> {
  options.triedRoutes.add(options.initialRoute.slug);
  const candidates = options.routes.filter((route) => (
    route.slug === options.initialRoute.slug || !options.triedRoutes.has(route.slug)
  ));
  const initialRouteIncluded = candidates.some((route) => route.slug === options.initialRoute.slug);
  const maxAttempts = candidates.length + (initialRouteIncluded ? 0 : 1);

  return executeWithProviderRecovery({
    routes: candidates,
    policy: options.policy,
    sessionKey: options.sessionKey,
    maxAttempts,
    initialFailure: {
      route: options.initialRoute,
      error: options.initialError,
      startedAt: options.initialStartedAt,
    },
    onFallback: async (event) => {
      options.triedRoutes.add(event.to.slug);
      await options.onFallback?.(event);
    },
    onReceipt: options.onReceipt,
    execute: options.execute,
  });
}
