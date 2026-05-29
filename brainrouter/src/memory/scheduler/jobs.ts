/**
 * BRAIN-P1 (0.4.1) — scheduler job helpers (BRAIN-DESIGN-T2).
 *
 * Thin policy layer over the raw `memory_jobs` store primitives:
 *
 *   - `enqueueAgentJob` resolves the agent from the registry, computes
 *     its `idempotencyKey`, and refuses to enqueue a second job with
 *     the same key while one is still `pending` / `running` — returning
 *     the existing job instead (the contract `memory_agent_run` relies
 *     on for idempotency).
 *   - `failAgentJob` applies the exponential backoff schedule when it
 *     re-arms a job.
 *
 * The runner loop that actually dispatches `execute(input, job)` is a
 * later slice (BRAIN-P1-T3); this module is what the MCP tools call.
 */

import type { IMemoryStore, MemoryJobRecord, MemoryJobStatus } from "@kinqs/brainrouter-types";
import { findBrainAgentById } from "../agents/registry.js";
import { backoffDelayMs } from "./backoff.js";

export interface EnqueueAgentJobResult {
  job: MemoryJobRecord;
  /** True when an existing pending/running job was returned instead of a new one. */
  deduped: boolean;
}

export class UnknownBrainAgentError extends Error {
  constructor(public readonly agentId: string) {
    super(`Unknown brain agent: ${agentId}`);
    this.name = "UnknownBrainAgentError";
  }
}

/**
 * Enqueue a run of `agentId` with `input`. Idempotent per the agent's
 * `idempotencyKey`: when the key is non-empty and a pending/running job
 * of the same kind already carries that key, the existing job is
 * returned with `deduped: true` and nothing new is inserted.
 *
 * Throws `UnknownBrainAgentError` for ids not in the registry.
 */
export function enqueueAgentJob(
  store: IMemoryStore,
  agentId: string,
  input: unknown,
  options?: { priority?: number; now?: string; idGenerator?: () => string },
): EnqueueAgentJobResult {
  const agent = findBrainAgentById(agentId);
  if (!agent) throw new UnknownBrainAgentError(agentId);

  const key = agent.idempotencyKey(input);
  if (key) {
    const inFlight = store.listMemoryJobs({ kind: agentId, status: ["pending", "running"] });
    for (const job of inFlight) {
      if (agent.idempotencyKey(job.input) === key) {
        return { job, deduped: true };
      }
    }
  }

  const job = store.enqueueMemoryJob(
    {
      kind: agentId,
      input,
      priority: options?.priority,
      maxAttempts: agent.maxAttempts,
    },
    { now: options?.now, idGenerator: options?.idGenerator },
  );
  return { job, deduped: false };
}

/**
 * Fail a running job, applying the backoff schedule. Delegates the
 * attempts/maxAttempts decision (re-arm vs. terminal `failed`) to the
 * store; this wrapper just supplies the computed `backoffMs`.
 */
export function failAgentJob(
  store: IMemoryStore,
  jobId: string,
  error: string,
  options?: { now?: string; random?: () => number },
): MemoryJobRecord | null {
  const current = store.getMemoryJob(jobId);
  if (!current) return null;
  const backoffMs = backoffDelayMs(current.attempts + 1, options?.random);
  return store.failMemoryJob(jobId, error, { now: options?.now, backoffMs });
}

/** Re-arm a failed/cancelled job (delegates to the store). */
export function retryAgentJob(
  store: IMemoryStore,
  jobId: string,
  options?: { now?: string },
): { status: MemoryJobStatus } | null {
  const job = store.retryMemoryJob(jobId, options);
  return job ? { status: job.status } : null;
}
