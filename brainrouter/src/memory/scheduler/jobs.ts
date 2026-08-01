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

import { randomUUID } from "node:crypto";
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
export async function enqueueAgentJob(
  store: IMemoryStore,
  agentId: string,
  input: unknown,
  options?: { priority?: number; now?: string; idGenerator?: () => string },
): Promise<EnqueueAgentJobResult> {
  const agent = findBrainAgentById(agentId);
  if (!agent) throw new UnknownBrainAgentError(agentId);

  // ADR-027 D12 — dedup is enforced by a partial unique index on
  // (kind, idempotency_key) over in-flight rows, not by listing first. The old
  // list-then-insert was a read-then-write race: two concurrent redeliveries of
  // the same webhook could both observe an empty queue and both enqueue.
  //
  // We mint the id here so `deduped` needs no extra query: the store returns
  // OUR id when this call won the insert, and the winner's id when it lost.
  const key = agent.idempotencyKey(input);
  const intendedId = (options?.idGenerator ?? (() => randomUUID()))();
  const job = await store.enqueueMemoryJob(
    {
      kind: agentId,
      input,
      priority: options?.priority,
      maxAttempts: agent.maxAttempts,
      ...(key ? { idempotencyKey: key } : {}),
    },
    { now: options?.now, idGenerator: () => intendedId },
  );
  return { job, deduped: job.id !== intendedId };
}

/**
 * Fail a running job, applying the backoff schedule. Delegates the
 * attempts/maxAttempts decision (re-arm vs. terminal `failed`) to the
 * store; this wrapper just supplies the computed `backoffMs`.
 */
export async function failAgentJob(
  store: IMemoryStore,
  jobId: string,
  error: string,
  options?: { now?: string; random?: () => number; leaseEpoch?: number },
): Promise<MemoryJobRecord | null> {
  const current = await store.getMemoryJob(jobId);
  if (!current) return null;
  const backoffMs = backoffDelayMs(current.attempts + 1, options?.random);
  // The attempts/maxAttempts decision itself is made atomically inside
  // `failMemoryJob`; this read only sizes the backoff, so a stale value here
  // costs a slightly wrong delay, never a wrong terminal state.
  return store.failMemoryJob(jobId, error, { now: options?.now, backoffMs, leaseEpoch: options?.leaseEpoch });
}

/** Re-arm a failed/cancelled job (delegates to the store). */
export async function retryAgentJob(
  store: IMemoryStore,
  jobId: string,
  options?: { now?: string },
): Promise<{ status: MemoryJobStatus } | null> {
  const job = await store.retryMemoryJob(jobId, options);
  return job ? { status: job.status } : null;
}
