/**
 * Purpose: Define the host-neutral, secret-free record of bounded model route
 * attempts so every BrainRouter host can project the same recovery outcome.
 */
export type ProviderRecoveryFailureKind =
  'provider_retryable' | 'model_lockout' | 'auth_rejected' | 'context_overflow' | 'non_retryable';

export type ProviderRecoveryOutcome = 'succeeded' | 'failed' | 'exhausted';
export type ProviderRecoveryAttemptOutcome = 'succeeded' | 'failed';

export interface ProviderRouteRef {
  readonly slug: string;
  readonly provider: string;
  readonly model: string;
}

export interface ProviderRecoveryFailure {
  readonly kind: ProviderRecoveryFailureKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export interface ProviderRecoveryAttemptReceipt {
  readonly attempt: number;
  readonly route: ProviderRouteRef;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: ProviderRecoveryAttemptOutcome;
  readonly failure?: ProviderRecoveryFailure;
}

export interface ProviderRecoveryReceipt {
  readonly version: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly maxAttempts: number;
  readonly outcome: ProviderRecoveryOutcome;
  readonly attempts: readonly ProviderRecoveryAttemptReceipt[];
  readonly selectedRoute?: ProviderRouteRef;
}
