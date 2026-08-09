/**
 * ADR-033 — the repository-context evidence budget for ONE review.
 *
 * Lives here rather than in the benchmark entrypoint so the harness and the
 * evidence provider agree on it without the harness importing a script, and so
 * the production reviewer can adopt the same number.
 *
 * The value matches what a single-call review was always handed. That is the
 * point: bundling should change how evidence is DIVIDED between units, not how
 * much of it a review is allowed to spend. Left per-unit, a review's budget
 * grows with how many units it happens to split into, and two units whose
 * impact packets share dependencies pay for that shared context twice.
 */
export const REVIEW_CONTEXT_BUDGET_BYTES = 24 * 1_024;
