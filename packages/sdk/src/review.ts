/**
 * Typed repository-review client.
 *
 * The parent SDK owns authentication and transport. This module owns only
 * review paths and preserves the shared assurance response without reshaping
 * lifecycle, evidence, or verifier state.
 */
import type { ReviewJobDetailResponse } from "@kinqs/brainrouter-types";

import type { BrainRouterRequestOptions } from "./request.js";

type ReviewGet = <T>(path: string, options?: BrainRouterRequestOptions) => Promise<T>;

export class BrainRouterReviewClient {
  constructor(private readonly get: ReviewGet) {}

  /**
   * Load one review and its exact durable assurance projection.
   *
   * @param jobId - Review job identifier.
   * @param options - Optional request cancellation controls.
   * @returns The review, durable assurance state, and current run permission.
   */
  getJob(
    jobId: string,
    options?: BrainRouterRequestOptions,
  ): Promise<ReviewJobDetailResponse> {
    return this.get<ReviewJobDetailResponse>(
      `/api/admin/reviews/jobs/${encodeURIComponent(jobId)}`,
      options,
    );
  }
}
