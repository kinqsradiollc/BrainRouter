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
import { distillCoreIdentity } from "../pipeline/identity-distiller.js";
import { distillFocusScenes } from "../pipeline/contextual-focus-builder.js";

/**
 * 0.4.3 (MEM-10) — engine operations the depth-agent executors call. Declared
 * structurally (not by importing `MemoryEngine`) so this module stays free of
 * the engine import cycle and importable from vitest. `MemoryEngine`
 * structurally satisfies it; the runner injects the live engine into the ctx.
 */
export interface JobEngineOps {
  exportVault(userId: string, baseDir?: string): { dir: string; written: number; unchanged: number; total: number };
  reconcilePendingBlackboard(userId: string): { reconciled: number; duplicate: number; rejected: number; items: Array<{ id: string; status: string }> };
  commitBlackboardItem(userId: string, itemId: string): { committed: boolean; recordId?: string; reason?: string };
  summarizeBucket(userId: string, childIds: string[], kind: string): { id: string } | null;
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
}

function requireEngine(ctx: JobExecContext): JobEngineOps {
  if (!ctx.engine) {
    throw new Error("depth-agent executor requires an engine in the job context (not wired)");
  }
  return ctx.engine;
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
    const r = requireEngine(ctx).exportVault(userIdOf(input));
    return { written: r.written, unchanged: r.unchanged, total: r.total };
  },
  blackboard_reconciler: async (input, ctx) => {
    const engine = requireEngine(ctx);
    const userId = userIdOf(input);
    const rec = engine.reconcilePendingBlackboard(userId);
    // Reconcile scores/dedups the pending candidates; commit the ones it
    // accepted so they actually land as cognitive records (the full
    // stage → reconcile → commit pipeline). Duplicates/rejects are left as-is.
    let committed = 0;
    for (const item of rec.items) {
      if (item.status === "reconciled" && engine.commitBlackboardItem(userId, item.id).committed) committed++;
    }
    return { reconciled: rec.reconciled, duplicate: rec.duplicate, rejected: rec.rejected, committed };
  },
  tree_sealer: async (input, ctx) => {
    const childIds: string[] = Array.isArray(input?.childIds) ? input.childIds.map(String) : [];
    if (childIds.length === 0) return { parentId: null, reason: "no childIds supplied" };
    const kind = typeof input?.kind === "string" ? input.kind : "topic";
    const parent = requireEngine(ctx).summarizeBucket(userIdOf(input), childIds, kind);
    return { parentId: parent?.id ?? null, sealed: parent ? childIds.length : 0 };
  },
};

export function getJobExecutor(agentId: string): JobExecutor | undefined {
  return EXECUTORS[agentId];
}

/** Agent ids the async runner can execute on demand. */
export function onDemandRunnableAgentIds(): string[] {
  return Object.keys(EXECUTORS);
}
