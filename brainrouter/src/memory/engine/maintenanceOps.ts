import type { BlackboardItem, BlackboardItemInput, BlackboardStatus } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { enqueueAgentJob } from "../scheduler/jobs.js";
import { parentDomain, SCENE_LEAF_DOMAIN } from "../tree/policy.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.17) — the scheduled-maintenance cadence engine
 * operation, extracted verbatim from MemoryEngine as a free function taking the
 * engine instance (type-only import → no runtime cycle). The maintenance
 * throttle counters (`maintenanceLastAt` / `maintenancePass`) are private
 * instance state, reached through a narrow cast so the extracted body keeps its
 * exact semantics. `engine.ts`'s method is now a thin wrapper delegating here.
 * No behavior change.
 */

/** The blackboard store surface, capability-detected (null when unavailable). */
type BlackboardSurface = {
  stageBlackboardItems(userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]>;
  getBlackboardItem(id: string): Promise<BlackboardItem | null>;
  getBlackboardItems(userId: string, status?: BlackboardStatus): Promise<BlackboardItem[]>;
  updateBlackboardItem(id: string, patch: { status?: BlackboardStatus; score?: number; conflictIds?: string[]; committedRecordId?: string | null }): Promise<void>;
} | null;

/** Private maintenance-throttle state on the engine, reached via a narrow cast. */
type MaintenanceState = {
  maintenanceLastAt: number;
  maintenancePass: number;
  blackboardStore(): BlackboardSurface;
};

export async function enqueueScheduledMaintenance(engine: MemoryEngine, force = false): Promise<{ enqueued: Record<string, number>; skipped?: boolean }> {
  const self = engine as unknown as MaintenanceState;
  if (process.env.BRAINROUTER_JOB_MAINTENANCE === "off") return { enqueued: {}, skipped: true };
  const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
  const VAULT_MAINTENANCE_EVERY = 12; // ~hourly at the 5-min cadence
  const BENCH_MAINTENANCE_EVERY = 288; // ~daily at the 5-min cadence
  const benchScheduleEnabled = (process.env.BRAINROUTER_BENCH_SCHEDULE ?? "").trim().toLowerCase() !== "off";
  const now = Date.now();
  if (!force && now - self.maintenanceLastAt < MAINTENANCE_INTERVAL_MS) return { enqueued: {}, skipped: true };
  self.maintenanceLastAt = now;
  const pass = self.maintenancePass++;

  const enqueued: Record<string, number> = { blackboard_reconciler: 0, vault_exporter: 0, tree_sealer: 0 };
  const bb = self.blackboardStore();
  let users: { userId: string }[] = [];
  try { users = await engine.store.listUsers(); } catch { users = []; }
  for (const { userId } of users) {
    if (!userId) continue;
    if (bb && (await bb.getBlackboardItems(userId, "pending")).length > 0) {
      await enqueueAgentJob(engine.store, "blackboard_reconciler", { userId });
      enqueued.blackboard_reconciler++;
    }
    if (pass % VAULT_MAINTENANCE_EVERY === 0) {
      await enqueueAgentJob(engine.store, "vault_exporter", { userId });
      enqueued.vault_exporter++;
    }
    // 0.4.3 — grow the scene-tree (leaf per mature scene); when a bucket of
    // unsealed leaves fills OR settles, enqueue tree_sealer to seal it into a
    // parent. Wrapped so a tree failure can't abort the rest of the pass.
    try {
      const tree = await engine.autobuildSceneTree(userId);
      if (tree.sealableBucket) {
        await enqueueAgentJob(engine.store, "tree_sealer", { userId, childIds: tree.sealableBucket, kind: parentDomain(SCENE_LEAF_DOMAIN) });
        enqueued.tree_sealer++;
      }
    } catch (err: any) {
      console.error("[BrainRouter] scene-tree autobuild failed:", err?.message ?? err);
    }
    // MEM-10b — periodically run the retrieval benchmark so benchmark_eval
    // isn't permanently idle. Expensive (up to ~5 min) so daily by default,
    // with an early pass for first-run visibility; disable via
    // BRAINROUTER_BENCH_SCHEDULE=off.
    if (benchScheduleEnabled && (pass === 2 || (pass > 0 && pass % BENCH_MAINTENANCE_EVERY === 0))) {
      await enqueueAgentJob(engine.store, "benchmark_eval", { userId });
      enqueued.benchmark_eval = (enqueued.benchmark_eval ?? 0) + 1;
    }
    // BRAIN-P4-T5 — roll accumulated global roots into a higher global digest.
    try {
      if (await engine.rollupGlobalTree(userId)) enqueued.global_rollup = (enqueued.global_rollup ?? 0) + 1;
    } catch (err: any) {
      console.error("[BrainRouter] global rollup failed:", err?.message ?? err);
    }
  }
  return { enqueued };
}
