/**
 * Scoped review-assurance query state.
 *
 * Consumers receive the shared durable contract as-is. The caller-provided
 * organization scope prevents a workspace switch from displaying cached data
 * for an identically named job in another tenant.
 */
import { useCallback } from "react";

import type { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { ReviewJobDetailResponse } from "@kinqs/brainrouter-types";

import { useRequestQuery } from "./useRequest.js";

const EMPTY_DETAIL: ReviewJobDetailResponse | null = null;

export function useReviewAssurance(
  client: BrainRouterClient,
  jobId: string,
  organizationScope = "",
) {
  const scopeKey = `${organizationScope}:${jobId}`;
  const load = useCallback(
    (signal: AbortSignal) => client.reviews.getJob(jobId, { signal }),
    [client, jobId],
  );
  const {
    value: detail,
    error,
    isLoading,
    reload,
  } = useRequestQuery(scopeKey, Boolean(jobId), EMPTY_DETAIL, load);

  return {
    detail,
    review: detail?.review ?? null,
    assurance: detail?.assurance ?? null,
    canRun: detail?.canRun ?? false,
    error,
    isLoading,
    reload,
  };
}
