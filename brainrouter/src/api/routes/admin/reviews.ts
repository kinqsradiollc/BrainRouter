/**
 * Reviews API (ADR-017 D5) — read model for the dashboard/desktop Reviews surface.
 * Lists the org's recent PR-review jobs (both lenses) from `memory_jobs`, projecting
 * the repo/PR from the job input and the findings/blocking tally from its output. No
 * new table — the review executor already persists its `PrReviewResult` to the job.
 * RBAC: owner/admin (triggers:manage), scoped to the caller's active org.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import type { MemoryJobRecord } from "@kinqs/brainrouter-types";

export const reviewsRouter = Router();
reviewsRouter.use(requireAnyAuth, requirePermission("triggers:manage"));

/** GET /api/admin/reviews/jobs?limit=30 — recent PR reviews for the active org. */
reviewsRouter.get("/jobs", async (req: AuthedRequest, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const store = memoryEngine.store as Partial<{ listReviewJobsForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]> }>;
  const jobs = (await store.listReviewJobsForOrg?.(req.orgId!, limit)) ?? [];
  const reviews = jobs.map((j) => {
    const input = (j.input ?? {}) as { repo?: string; prNumber?: number };
    const output = (j.output ?? {}) as { findings?: number; blocking?: number; posted?: boolean; error?: string; skipped?: string };
    return {
      id: j.id,
      lens: j.kind === "pr-code-review" ? "code" : "security",
      status: j.status,
      repo: input.repo ?? null,
      prNumber: input.prNumber ?? null,
      findings: typeof output.findings === "number" ? output.findings : null,
      blocking: typeof output.blocking === "number" ? output.blocking : null,
      skipped: output.skipped ?? null,
      error: j.error ?? output.error ?? null,
      updatedAt: j.updatedAt,
      createdAt: j.createdAt,
    };
  });
  res.json({ reviews });
});
