import { buildDeepReviewPolicy } from '@kinqs/brainrouter-core/review';
import type {
  DeepReviewPolicy,
  DeepReviewProgram,
  DeepReviewRequestConfig,
} from '@kinqs/brainrouter-types/review';

export interface BuildManualDeepReviewRequestInput {
  organizationId: string;
  repository: {
    forge: 'github' | 'gitlab';
    slug: string;
  };
  program: DeepReviewProgram;
  requestedBy: string;
  config: DeepReviewRequestConfig;
  now?: string;
}

/**
 * Construct the only deep-review policy accepted by the backend.
 *
 * Caller input contributes numeric limits only. Tenant, repository, program,
 * requester, and acceptance time always come from the authenticated request.
 */
export function buildManualDeepReviewRequest(
  input: BuildManualDeepReviewRequestInput,
): DeepReviewPolicy {
  const now = input.now ?? new Date().toISOString();
  return buildDeepReviewPolicy({
    organizationId: input.organizationId,
    repository: input.repository,
    program: input.program,
    requestedBy: input.requestedBy,
    telemetryThresholds: {
      ...input.config.telemetryThresholds,
      program: input.program,
      acceptedBy: input.requestedBy,
      acceptedAt: now,
    },
    packetLimits: input.config.packetLimits,
    budgets: input.config.budgets,
    cancellationPollIntervalMs: input.config.cancellationPollIntervalMs,
    now,
  });
}
