/**
 * BRAIN-P1 (0.4.1) — on-demand job executors.
 *
 * The async runner (`runner.ts`) drains queued `memory_jobs` rows that
 * were enqueued via `memory_agent_run` / `/brain run`. To run one it
 * needs a binding from a brain-agent id to the real pipeline function.
 *
 * NOT every agent is on-demand runnable. The extraction-family stages
 * (`cognitive_extractor`, `memory_deduper`, `contradiction_checker`,
 * `graph_extractor`, `focus_shift_judge`) run *inline* during capture
 * (wrapped by `runAsJob`, already observable) and need rich per-turn
 * input that a manual enqueue can't supply. Those have no executor here
 * — the runner cancels a manual run of them with a clear reason instead
 * of hanging.
 *
 * The agents that ARE meaningful to trigger on demand are the per-user
 * synthesis distillers: "re-distill my identity / focus scenes now".
 */

import type { IMemoryStore, LLMRunner } from "@kinqs/brainrouter-types";
import type { LLMConfig } from "@kinqs/brainrouter-core/config";
import { distillCoreIdentity } from "../pipeline/identity/identity-distiller.js";
import { distillFocusScenes } from "../pipeline/focus/contextual-focus-builder.js";
import { digestTreeNodes } from "../tree/digest.js";
import { enqueueAgentJob } from "./jobs.js";
import { runConnectorSync } from "../../connectors/syncExecutor.js";
import { runPrSecurityReview, runPrCodeReview, runPrPentest, type PrReviewInput, type PrReviewDeps } from "../../integrations/prSecurityReview.js";
import { runDomainPentest } from "../../integrations/domainPentest.js";
import { loadVulnerabilityIntelligence } from "@kinqs/brainrouter-core/review";

/**
 * 0.4.3 (MEM-10) — engine operations the depth-agent executors call. Declared
 * structurally (not by importing `MemoryEngine`) so this module stays free of
 * the engine import cycle and importable from vitest. `MemoryEngine`
 * structurally satisfies it; the runner injects the live engine into the ctx.
 */
export interface JobEngineOps {
  exportVault(userId: string, baseDir?: string): Promise<{ dir: string; written: number; unchanged: number; total: number }>;
  reconcilePendingBlackboard(userId: string): Promise<{ reconciled: number; duplicate: number; rejected: number; items: Array<{ id: string; status: string }> }>;
  commitBlackboardItem(userId: string, itemId: string): Promise<{ committed: boolean; recordId?: string; reason?: string }>;
  summarizeBucket(userId: string, childIds: string[], kind: string): Promise<{ id: string } | null>;
  rechunkSources(userId: string, documentIds: string[]): Promise<{ rechunked: number; skipped: number; chunksWritten: number }>;
  runRetrievalBenchmark(userId: string, opts?: { sampleSize?: number; baseDir?: string }): Promise<{ summaryPath: string | null; statsByMode: Record<string, unknown>; sampled: number; passed: boolean }>;
  /** ADR-017 D5 — the org's GitHub App creds (non-secret config + opened secret) for a webhook installation. */
  findGithubAppByInstallation(installationId: string): Promise<{ config: Record<string, unknown>; secret: Record<string, string> } | null>;
  reviewRunner?(lens: "security" | "code" | "pentest", orgId?: string): LLMRunner | Promise<LLMRunner | undefined> | undefined;
  reviewAssignment?(lens: "security" | "code" | "pentest", orgId?: string): { maxDiffChars?: number; timeoutMs?: number } | Promise<{ maxDiffChars?: number; timeoutMs?: number } | undefined> | undefined;
  pentestAgentConfig?(orgId: string): Promise<LLMConfig | null>;
  /** Ingest completed pentest findings into the org's cognitive memory (redacted, org-scoped). */
  recordPentestFindings?(params: {
    orgId: string; userId: string; target: string; reviewId: string;
    findings: Array<{ id: string; severity: string; summary: string; details?: string; file?: string; line?: number; cvss?: number; cvssVector?: string; cwe?: string; cve?: string; poc?: string; remediation?: string; status?: string; confidence?: number }>;
  }): Promise<number>;
}

export interface JobExecContext {
  store: IMemoryStore;
  llmRunner: LLMRunner;
  /**
   * Live engine (capability-detection layer for vault / blackboard / tree).
   * Optional so test harnesses that inject their own executors via
   * `resolveExecutor` need not construct one; the depth executors below guard
   * its presence and the production runner always supplies it.
   */
  engine?: JobEngineOps;
  /** Bound by the scheduler for best-effort persistent progress events. */
  jobId?: string;
}

function requireEngine(ctx: JobExecContext): JobEngineOps {
  if (!ctx.engine) {
    throw new Error("depth-agent executor requires an engine in the job context (not wired)");
  }
  return ctx.engine;
}

/** Shared plumbing for the PR-review lenses (security + code review) — one input/deps shape. */
function prReviewInput(input: any): PrReviewInput {
  return {
    orgId: typeof input?.orgId === "string" ? input.orgId : undefined,
    installationId: String(input?.installationId ?? ""),
    repo: String(input?.repo ?? ""),
    prNumber: Number(input?.prNumber),
    headSha: String(input?.headSha ?? ""),
  };
}
async function prReviewDeps(ctx: JobExecContext, lens: "security" | "code" | "pentest", orgId?: string): Promise<PrReviewDeps> {
  const engine = requireEngine(ctx);
  const assignment = await engine.reviewAssignment?.(lens, orgId);
  const reviewRunner = await engine.reviewRunner?.(lens, orgId);
  return {
    llmRunner: reviewRunner ?? ctx.llmRunner,
    fetchImpl: fetch,
    nowSec: () => Math.floor(Date.now() / 1000),
    getIntegration: (installationId) => engine.findGithubAppByInstallation(installationId),
    getVulnerabilityIntelligence: () => loadVulnerabilityIntelligence(),
    maxDiffChars: assignment?.maxDiffChars,
    timeoutMs: assignment?.timeoutMs,
    onProgress: (event) => {
      if (!ctx.jobId) return;
      void ctx.store.appendJobProgress(ctx.jobId, { ts: new Date().toISOString(), ...event }).catch(() => {});
    },
  };
}

/** Runs the agent's work for `input`; returns a compact JSON summary for `output`. */
export type JobExecutor = (input: any, ctx: JobExecContext) => Promise<unknown>;

function userIdOf(input: any): string {
  const u = input?.userId;
  return typeof u === "string" && u ? u : "default";
}

const EXECUTORS: Record<string, JobExecutor> = {
  identity_distiller: async (input, { store, llmRunner }) => {
    const r = await distillCoreIdentity({ userId: userIdOf(input), store, llmRunner });
    return { success: r.success };
  },
  focus_distiller: async (input, { store, llmRunner }) => {
    const r = await distillFocusScenes({ userId: userIdOf(input), store, llmRunner });
    return { sceneNames: r.sceneNames };
  },

  // ── 0.4.3 (MEM-10) — depth-pipeline executors. Thin glue onto existing,
  // capability-detected engine operations; each is idempotent / safe to re-run.
  vault_exporter: async (input, ctx) => {
    const r = await requireEngine(ctx).exportVault(userIdOf(input));
    return { written: r.written, unchanged: r.unchanged, total: r.total };
  },
  blackboard_reconciler: async (input, ctx) => {
    const engine = requireEngine(ctx);
    const userId = userIdOf(input);
    const rec = await engine.reconcilePendingBlackboard(userId);
    // Reconcile scores/dedups the pending candidates; commit the ones it
    // accepted so they actually land as cognitive records (the full
    // stage → reconcile → commit pipeline). Duplicates/rejects are left as-is.
    let committed = 0;
    for (const item of rec.items) {
      if (item.status === "reconciled" && (await engine.commitBlackboardItem(userId, item.id)).committed) committed++;
    }
    return { reconciled: rec.reconciled, duplicate: rec.duplicate, rejected: rec.rejected, committed };
  },
  tree_sealer: async (input, ctx) => {
    const childIds: string[] = Array.isArray(input?.childIds) ? input.childIds.map(String) : [];
    if (childIds.length === 0) return { parentId: null, reason: "no childIds supplied" };
    const kind = typeof input?.kind === "string" ? input.kind : "topic";
    const parent = await requireEngine(ctx).summarizeBucket(userIdOf(input), childIds, kind);
    // Auto-chain: refine the freshly-sealed parent's deterministic summary with
    // an LLM digest. No-ops gracefully if no LLM is configured (tree_digest
    // keeps the deterministic summary). Best-effort — a failed enqueue must not
    // fail the seal.
    if (parent?.id && ctx.store) {
      try { await enqueueAgentJob(ctx.store, "tree_digest", { userId: userIdOf(input), nodeIds: [parent.id] }); } catch { /* seal still succeeded */ }
    }
    return { parentId: parent?.id ?? null, sealed: parent ? childIds.length : 0 };
  },
  tree_digest: async (input, { store, llmRunner }) => {
    const nodeIds: string[] = Array.isArray(input?.nodeIds) ? input.nodeIds.map(String) : [];
    if (nodeIds.length === 0) return { summarized: [], skipped: 0, reason: "no nodeIds supplied" };
    return digestTreeNodes({ userId: userIdOf(input), nodeIds, store, llmRunner });
  },
  source_chunker: async (input, ctx) => {
    // Re-chunk specific documents with the current chunker (provenance-safe;
    // referenced docs are skipped by the engine). Requires explicit
    // documentIds — there's no "chunk everything" sweep (chunking already runs
    // inline on ingest, so a blind re-chunk would needlessly churn the store).
    const documentIds: string[] = Array.isArray(input?.documentIds) ? input.documentIds.map(String) : [];
    if (documentIds.length === 0) return { rechunked: 0, skipped: 0, chunksWritten: 0, reason: "no documentIds supplied" };
    return requireEngine(ctx).rechunkSources(userIdOf(input), documentIds);
  },
  benchmark_eval: async (input, ctx) => {
    const sampleSize = typeof input?.sampleSize === "number" ? input.sampleSize : undefined;
    return requireEngine(ctx).runRetrievalBenchmark(userIdOf(input), sampleSize !== undefined ? { sampleSize } : undefined);
  },
  // ADR-016 C3 — sync one server-side connector (DB config + sealed token → core
  // runtime → owner's memory), persisting the checkpoint back to the DB.
  connector_sync: async (input) => runConnectorSync(String(input?.connectorId ?? "")),

  // ADR-017 D5 — the GitHub App bot's automatic PR reviews. Both are enqueued by the
  // pull_request webhook; each mints the installation token, reviews the diff with its
  // LENS, and posts back inline suggestions + a summary + a gating check-run.
  "pr-security-review": async (input, ctx) => runPrSecurityReview(prReviewInput(input), await prReviewDeps(ctx, "security", typeof input?.orgId === "string" ? input.orgId : undefined)),
  "pr-code-review": async (input, ctx) => runPrCodeReview(prReviewInput(input), await prReviewDeps(ctx, "code", typeof input?.orgId === "string" ? input.orgId : undefined)),
  "pr-pentest": async (input, ctx) => runPrPentest(prReviewInput(input), await prReviewDeps(ctx, "pentest", typeof input?.orgId === "string" ? input.orgId : undefined)),
  "domain-pentest": async (input, ctx) => runDomainPentest(input, ctx),
};

export function getJobExecutor(agentId: string): JobExecutor | undefined {
  return EXECUTORS[agentId];
}

/** Agent ids the async runner can execute on demand. */
export function onDemandRunnableAgentIds(): string[] {
  return Object.keys(EXECUTORS);
}
