/**
 * Raised before a local review Agent would exceed its physical provider-request
 * ceiling. Keeping this distinct from provider failures prevents the normal
 * streaming/router/model recovery paths from treating a budget stop as another
 * reason to retry.
 */
export class ReviewProviderRequestBudgetExceededError extends Error {
  public readonly limit: number;

  constructor(limit: number) {
    super(
      `Review provider-request budget exhausted after ${limit} physical `
      + `request${limit === 1 ? '' : 's'}; no additional provider request is allowed in this turn.`,
    );
    this.name = 'ReviewProviderRequestBudgetExceededError';
    this.limit = limit;
  }
}
