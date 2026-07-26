import type { ChildSessionRecord } from './orchestrator.js';

/**
 * CODEX-AGENT-LIFECYCLE (0.4.7) — spawn slots: a cap on the number of
 * CONCURRENTLY-LIVE child agents.
 *
 * BrainRouter already tracks each child's live/terminal state centrally
 * (`orchestrator.ts` session registry: pending → running → completed/failed/
 * stale/closed) and `maxSpawnDepth` caps the spawn *chain depth*. What was
 * missing is a cap on *breadth* — nothing stopped a parent from fanning out an
 * unbounded number of children at once, which exhausts the LLM semaphore and
 * leaves orphan sessions drifting. Codex enforces spawn slots in its
 * `AgentRegistry` (`registry.rs:79`); this is the equivalent.
 *
 * Pure decision core (tested in isolation); wired into the single spawn
 * chokepoint (`handleSpawn`).
 */

/** A child is "live" while it is still pending or actively running. */
export function isLiveChild(record: Pick<ChildSessionRecord, 'status'>): boolean {
  return record.status === 'pending' || record.status === 'running';
}

/** Count the currently-live children among a set of session records. */
export function countLiveChildren(records: ReadonlyArray<Pick<ChildSessionRecord, 'status'>>): number {
  return records.reduce((n, r) => (isLiveChild(r) ? n + 1 : n), 0);
}

/**
 * Count children actively occupying a run slot — `running` only. Deliberately
 * EXCLUDES `pending`: a session is `pending` only in the brief window between
 * `createSession` and the child actually launching, and a spawn that crashes in
 * that window leaves an orphan `pending` record that should NOT wedge the cap
 * forever. The breadth cap is a guardrail against concurrent runaway fan-out, so
 * counting genuinely-running children is both safer and more accurate.
 */
export function countRunningChildren(records: ReadonlyArray<Pick<ChildSessionRecord, 'status'>>): number {
  return records.reduce((n, r) => (r.status === 'running' ? n + 1 : n), 0);
}

export interface SlotDecision {
  allow: boolean;
  reason: string;
  live: number;
  max: number;
}

/**
 * Intersect the legacy CLI breadth cap with the reviewed workspace ceiling.
 * Missing/non-positive inputs keep their existing "uncapped" meaning; when
 * both are present the narrower positive ceiling wins.
 */
export function effectiveSpawnSlotLimit(
  cliMax: number,
  manifestMaxParallel?: number,
): number {
  const ceilings = [cliMax, manifestMaxParallel]
    .filter((value): value is number =>
      value !== undefined && Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));
  return ceilings.length > 0 ? Math.min(...ceilings) : 0;
}

/**
 * Decide whether another child may be spawned given the live count and the cap.
 * A non-positive `max` means "no concurrency cap" (always allow). At/over the
 * cap denies with actionable guidance.
 */
export function spawnSlotDecision(live: number, max: number): SlotDecision {
  if (!Number.isFinite(max) || max <= 0) {
    return { allow: true, reason: 'no concurrency cap configured', live, max };
  }
  if (live >= max) {
    return {
      allow: false,
      reason:
        `spawn slot limit reached (${live}/${max} child agents already running) — ` +
        `wait for one to finish (wait_agent / wait_agents) before spawning more, ` +
        `or review the effective workspace and CLI concurrency ceilings.`,
      live,
      max,
    };
  }
  return { allow: true, reason: `slot available (${live}/${max})`, live, max };
}
