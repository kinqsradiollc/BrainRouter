/**
 * Blackboard service (ADR-008, Wave 2) — an engine-bound port over the
 * candidate-staging blackboard (stage → reconcile → commit/reject/restore →
 * review). Binds the MemoryEngine at construction. Additive and
 * behaviour-preserving: every method delegates to the existing blackboardOps
 * functions; no logic moved or removed.
 */
import type { BlackboardItem, BlackboardItemInput, BlackboardStatus } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import {
  stageBlackboardCandidates, reconcilePendingBlackboard, commitBlackboardItem,
  rejectBlackboardItem, restoreBlackboardItem, reviewBlackboard,
} from "./blackboardOps.js";

/** Result of {@link IBlackboardService.reconcile}. */
export type ReconcileResult = ReturnType<typeof reconcilePendingBlackboard>;
/** Result of {@link IBlackboardService.commit}. */
export type CommitResult = ReturnType<typeof commitBlackboardItem>;
/** Result of {@link IBlackboardService.restore}. */
export type RestoreResult = ReturnType<typeof restoreBlackboardItem>;

/** The candidate-staging blackboard contract, bound to one engine. */
export interface IBlackboardService {
  stage(userId: string, items: BlackboardItemInput[]): BlackboardItem[];
  reconcile(userId: string): ReconcileResult;
  commit(userId: string, itemId: string): CommitResult;
  reject(userId: string, itemId: string): boolean;
  restore(userId: string, itemId: string): RestoreResult;
  review(userId: string, status?: BlackboardStatus): BlackboardItem[];
}

/** {@link IBlackboardService} backed by the in-process blackboard ops — delegates only. */
export class BlackboardService implements IBlackboardService {
  constructor(private readonly engine: MemoryEngine) {}
  stage(userId: string, items: BlackboardItemInput[]): BlackboardItem[] {
    return stageBlackboardCandidates(this.engine, userId, items);
  }
  reconcile(userId: string): ReconcileResult {
    return reconcilePendingBlackboard(this.engine, userId);
  }
  commit(userId: string, itemId: string): CommitResult {
    return commitBlackboardItem(this.engine, userId, itemId);
  }
  reject(userId: string, itemId: string): boolean {
    return rejectBlackboardItem(this.engine, userId, itemId);
  }
  restore(userId: string, itemId: string): RestoreResult {
    return restoreBlackboardItem(this.engine, userId, itemId);
  }
  review(userId: string, status?: BlackboardStatus): BlackboardItem[] {
    return reviewBlackboard(this.engine, userId, status);
  }
}

/** Construct a blackboard service bound to an engine. */
export function createBlackboardService(engine: MemoryEngine): IBlackboardService {
  return new BlackboardService(engine);
}
