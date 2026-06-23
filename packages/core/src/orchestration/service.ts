/**
 * Orchestration session service (ADR-008, Wave 1) — a per-workspace port over
 * the child-session store (`orchestrator.ts`).
 *
 * Additive and behaviour-preserving: every method delegates to the existing
 * orchestrator functions. `workspaceRoot` is bound at construction. No logic
 * moved or removed; the port lives here alongside the worker/background/schedule
 * ports as part of the jobs tier. `formatSummary` is the one pure helper folded
 * into the contract because it renders a session record this service owns.
 */
import {
  listSessions, getSession, createSession, updateSession,
  pruneWorktreePatches, reconcileStale, formatSessionSummary,
  type ChildSessionRecord,
} from "./orchestrator.js";

/** Input accepted by {@link IOrchestrationService.create} — the store's exact shape. */
export type CreateChildSessionInput = Parameters<typeof createSession>[1];

/** The child-session orchestration store contract, scoped to one workspace. */
export interface IOrchestrationService {
  list(): ChildSessionRecord[];
  get(id: string): ChildSessionRecord | undefined;
  create(input: CreateChildSessionInput): ChildSessionRecord;
  update(id: string, patch: Partial<ChildSessionRecord>): ChildSessionRecord;
  pruneWorktreePatches(maxAgeMs?: number): number;
  reconcileStale(): number;
  formatSummary(session: ChildSessionRecord): string;
}

/** {@link IOrchestrationService} backed by the in-process session store — delegates only. */
export class OrchestrationService implements IOrchestrationService {
  constructor(private readonly workspaceRoot: string) {}
  list(): ChildSessionRecord[] {
    return listSessions(this.workspaceRoot);
  }
  get(id: string): ChildSessionRecord | undefined {
    return getSession(this.workspaceRoot, id);
  }
  create(input: CreateChildSessionInput): ChildSessionRecord {
    return createSession(this.workspaceRoot, input);
  }
  update(id: string, patch: Partial<ChildSessionRecord>): ChildSessionRecord {
    return updateSession(this.workspaceRoot, id, patch);
  }
  pruneWorktreePatches(maxAgeMs?: number): number {
    return maxAgeMs === undefined
      ? pruneWorktreePatches(this.workspaceRoot)
      : pruneWorktreePatches(this.workspaceRoot, maxAgeMs);
  }
  reconcileStale(): number {
    return reconcileStale(this.workspaceRoot);
  }
  formatSummary(session: ChildSessionRecord): string {
    return formatSessionSummary(session);
  }
}

/** Construct an orchestration session service bound to a workspace. */
export function createOrchestrationService(workspaceRoot: string): IOrchestrationService {
  return new OrchestrationService(workspaceRoot);
}
