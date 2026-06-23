import type { BlackboardItem, BlackboardItemInput, BlackboardStatus } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { reconcileBlackboard } from "./reconcile.js";
import { redactSensitiveMemoryText } from "../util/redaction.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.6) — the blackboard-domain engine operations, extracted
 * verbatim from MemoryEngine as free functions taking the engine instance
 * (type-only `MemoryEngine` import → no runtime cycle). `engine.ts`'s methods are
 * now thin wrappers delegating here. No behavior change.
 */

/** The store cast to its blackboard surface, or null when unavailable. */
function bbStore(engine: MemoryEngine): {
  stageBlackboardItems(userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]>;
  getBlackboardItem(id: string): Promise<BlackboardItem | null>;
  getBlackboardItems(userId: string, status?: BlackboardStatus): Promise<BlackboardItem[]>;
  updateBlackboardItem(id: string, patch: { status?: BlackboardStatus; score?: number; conflictIds?: string[]; committedRecordId?: string | null }): Promise<void>;
} | null {
  const s = engine.store as any;
  return typeof s.stageBlackboardItems === "function" &&
    typeof s.getBlackboardItems === "function" &&
    typeof s.updateBlackboardItem === "function"
    ? s
    : null;
}

export async function stageBlackboardCandidates(engine: MemoryEngine, userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]> {
  const store = bbStore(engine);
  if (!store) return [];
  // MEM-13 — redact candidate content at the staging boundary, before it
  // persists, so secrets never land in the blackboard.
  const redacted = items.map((i) => ({
    ...i,
    candidate: { ...i.candidate, content: redactSensitiveMemoryText(i.candidate.content) },
  }));
  return store.stageBlackboardItems(userId, redacted);
}

export async function reconcilePendingBlackboard(engine: MemoryEngine, userId: string): Promise<{ reconciled: number; duplicate: number; rejected: number; items: BlackboardItem[] }> {
  const store = bbStore(engine);
  if (!store) return { reconciled: 0, duplicate: 0, rejected: 0, items: [] };
  const decisions = reconcileBlackboard(await store.getBlackboardItems(userId, "pending"));
  for (const d of decisions) await store.updateBlackboardItem(d.id, { status: d.status, score: d.score, conflictIds: d.conflictIds });
  const count = (st: string) => decisions.filter((d) => d.status === st).length;
  return { reconciled: count("reconciled"), duplicate: count("duplicate"), rejected: count("rejected"), items: await store.getBlackboardItems(userId) };
}

export async function commitBlackboardItem(engine: MemoryEngine, userId: string, itemId: string): Promise<{ committed: boolean; recordId?: string; reason?: string }> {
  const store = bbStore(engine);
  if (!store) return { committed: false, reason: "blackboard unavailable" };
  const item = await store.getBlackboardItem(itemId);
  if (!item || item.userId !== userId) return { committed: false, reason: "not found" };
  if (item.status === "committed") return { committed: true, recordId: item.committedRecordId ?? undefined };
  if (item.status !== "reconciled") return { committed: false, reason: `status is "${item.status}"; reconcile before committing` };

  const record = await engine.upsertEngineeringMemory({
    userId,
    type: item.candidate.type,
    content: item.candidate.content,
    priority: item.candidate.priority,
    confidence: item.candidate.confidence,
    metadata: { committedFromBlackboard: item.id, sourceChunkId: item.sourceChunkId },
  });
  await store.updateBlackboardItem(item.id, { status: "committed", committedRecordId: record.id });
  if (item.sourceChunkId) {
    const linker = engine.store as Partial<{ linkRecordSources(u: string, r: string, ids: string[]): Promise<void> }>;
    try { await linker.linkRecordSources?.(userId, record.id, [item.sourceChunkId]); } catch { /* best-effort */ }
  }
  return { committed: true, recordId: record.id };
}

export async function rejectBlackboardItem(engine: MemoryEngine, userId: string, itemId: string): Promise<boolean> {
  const store = bbStore(engine);
  if (!store) return false;
  const item = await store.getBlackboardItem(itemId);
  if (!item || item.userId !== userId) return false;
  await store.updateBlackboardItem(itemId, { status: "rejected" });
  return true;
}

export async function restoreBlackboardItem(engine: MemoryEngine, userId: string, itemId: string): Promise<{ restored: boolean; reason?: string; status?: BlackboardStatus }> {
  const store = bbStore(engine);
  if (!store) return { restored: false, reason: "blackboard store unavailable" };
  const item = await store.getBlackboardItem(itemId);
  if (!item || item.userId !== userId) return { restored: false, reason: "no such item" };
  if (item.status !== "rejected" && item.status !== "duplicate") {
    return { restored: false, reason: `status is "${item.status}"; only rejected/duplicate items can be restored`, status: item.status };
  }
  await store.updateBlackboardItem(itemId, { status: "pending", score: 0, conflictIds: [] });
  return { restored: true, status: "pending" };
}

export async function reviewBlackboard(engine: MemoryEngine, userId: string, status?: BlackboardStatus): Promise<BlackboardItem[]> {
  const store = bbStore(engine);
  return store ? store.getBlackboardItems(userId, status) : [];
}
