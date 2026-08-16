import { randomUUID } from "node:crypto";
import type { Executor } from "./executor.js";

export const HOSTED_LEARNING_CHECKPOINT_JOB_KIND = "hosted-learning-checkpoint";

export interface HostedLearningAdmissionPolicy {
  maxCheckpointsPerSession: number;
  minCheckpointIntervalMs: number;
  sessionIdleResetMs: number;
  maxCheckpointsPerTenantDay: number;
}

export const DEFAULT_HOSTED_LEARNING_ADMISSION: HostedLearningAdmissionPolicy = {
  maxCheckpointsPerSession: 4,
  minCheckpointIntervalMs: 90_000,
  sessionIdleResetMs: 30 * 60_000,
  maxCheckpointsPerTenantDay: 64,
};

export type HostedLearningAdmissionReason =
  | "admitted"
  | "trajectory-too-short"
  | "duplicate"
  | "interval"
  | "session-budget"
  | "tenant-budget";

export interface HostedLearningAdmissionResult {
  admitted: boolean;
  reason: HostedLearningAdmissionReason;
  jobId?: string;
  sessionSpent: number;
  tenantSpent: number;
}

interface BudgetRow {
  spent: number | string;
  last_admitted_at?: string | Date | null;
  last_activity_at?: string | Date | null;
  last_request_key?: string | null;
  last_job_id?: string | null;
}

interface PriorJobRow {
  id: string;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function millis(value: unknown): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Atomically admit and enqueue one hosted checkpoint.
 *
 * The tenant row serializes different sessions in the same user/org partition;
 * the session row applies the tighter local limit. The memory_jobs insert is in
 * the same transaction, so a failed enqueue cannot consume budget and a
 * duplicate HTTP delivery cannot buy a second model call.
 */
export async function enqueueHostedLearningCheckpointJob(
  exec: Executor,
  input: {
    userId: string;
    orgId: string;
    sessionKeyHash: string;
    requestKey: string;
    jobInput: Record<string, unknown>;
  },
  options?: {
    now?: Date;
    policy?: Partial<HostedLearningAdmissionPolicy>;
    idGenerator?: () => string;
  },
): Promise<HostedLearningAdmissionResult> {
  const now = options?.now ?? new Date();
  const at = now.toISOString();
  const day = at.slice(0, 10);
  const policy = { ...DEFAULT_HOSTED_LEARNING_ADMISSION, ...(options?.policy ?? {}) };
  const jobId = (options?.idGenerator ?? (() => randomUUID()))();

  return exec.tx(async (client) => {
    await client.query(
      `INSERT INTO hosted_learning_tenant_budgets
        (org_id, user_id, budget_day, spent, updated_at)
       VALUES ($1,$2,$3,0,$4)
       ON CONFLICT (org_id, user_id, budget_day) DO NOTHING`,
      [input.orgId, input.userId, day, at],
    );
    const tenantResult = await client.query<BudgetRow>(
      `SELECT spent FROM hosted_learning_tenant_budgets
        WHERE org_id = $1 AND user_id = $2 AND budget_day = $3
        FOR UPDATE`,
      [input.orgId, input.userId, day],
    );
    const tenantSpent = count(tenantResult.rows[0]?.spent);

    await client.query(
      `INSERT INTO hosted_learning_session_budgets
        (org_id, user_id, session_key_hash, spent, last_activity_at)
       VALUES ($1,$2,$3,0,$4)
       ON CONFLICT (org_id, user_id, session_key_hash) DO NOTHING`,
      [input.orgId, input.userId, input.sessionKeyHash, at],
    );
    const sessionResult = await client.query<BudgetRow>(
      `SELECT spent, last_admitted_at, last_activity_at, last_request_key, last_job_id
         FROM hosted_learning_session_budgets
        WHERE org_id = $1 AND user_id = $2 AND session_key_hash = $3
        FOR UPDATE`,
      [input.orgId, input.userId, input.sessionKeyHash],
    );
    const row = sessionResult.rows[0] ?? { spent: 0 };
    const idle = millis(row.last_activity_at);
    const reset = idle !== null && now.getTime() - idle >= policy.sessionIdleResetMs;
    const sessionSpent = reset ? 0 : count(row.spent);
    const lastAdmitted = reset ? null : millis(row.last_admitted_at);
    // `last_request_key` is only a diagnostic convenience. Durable
    // idempotency comes from the queue itself, otherwise A -> B -> delayed A
    // forgets A and buys a second model call.
    const priorJob = await client.query<PriorJobRow>(
      `SELECT id FROM memory_jobs
        WHERE kind = $1 AND tenant = $2 AND idempotency_key = $3
        ORDER BY created_at DESC
        LIMIT 1`,
      [HOSTED_LEARNING_CHECKPOINT_JOB_KIND, input.orgId, input.requestKey],
    );
    if (priorJob.rows[0]?.id) {
      await client.query(
        `UPDATE hosted_learning_session_budgets SET last_activity_at = $1
          WHERE org_id = $2 AND user_id = $3 AND session_key_hash = $4`,
        [at, input.orgId, input.userId, input.sessionKeyHash],
      );
      return {
        admitted: false,
        reason: "duplicate",
        jobId: priorJob.rows[0].id,
        sessionSpent,
        tenantSpent,
      };
    }

    let reason: HostedLearningAdmissionReason | null = null;
    if (tenantSpent >= policy.maxCheckpointsPerTenantDay) reason = "tenant-budget";
    else if (sessionSpent >= policy.maxCheckpointsPerSession) reason = "session-budget";
    else if (lastAdmitted !== null
      && now.getTime() - lastAdmitted < policy.minCheckpointIntervalMs) reason = "interval";
    if (reason) {
      await client.query(
        `UPDATE hosted_learning_session_budgets
            SET spent = $1, last_admitted_at = $2, last_activity_at = $3,
                last_request_key = $4, last_job_id = $5
          WHERE org_id = $6 AND user_id = $7 AND session_key_hash = $8`,
        [sessionSpent, reset ? null : row.last_admitted_at ?? null, at,
          reset ? null : row.last_request_key ?? null, reset ? null : row.last_job_id ?? null,
          input.orgId, input.userId, input.sessionKeyHash],
      );
      return { admitted: false, reason, sessionSpent, tenantSpent };
    }

    await client.query(
      `INSERT INTO memory_jobs
        (id, kind, status, priority, attempts, max_attempts, run_after,
         locked_at, lease_epoch, parent_job_id, tenant, idempotency_key,
         input_json, output_json, error, created_at, updated_at)
       VALUES ($1,$2,'pending',25,0,3,$3,NULL,0,NULL,$4,$5,$6,NULL,NULL,$7,$8)`,
      [jobId, HOSTED_LEARNING_CHECKPOINT_JOB_KIND, at, input.orgId,
        input.requestKey, JSON.stringify(input.jobInput), at, at],
    );
    await client.query(
      `UPDATE hosted_learning_session_budgets
          SET spent = $1, last_admitted_at = $2, last_activity_at = $2,
              last_request_key = $3, last_job_id = $4
        WHERE org_id = $5 AND user_id = $6 AND session_key_hash = $7`,
      [sessionSpent + 1, at, input.requestKey, jobId,
        input.orgId, input.userId, input.sessionKeyHash],
    );
    await client.query(
      `UPDATE hosted_learning_tenant_budgets
          SET spent = spent + 1, updated_at = $1
        WHERE org_id = $2 AND user_id = $3 AND budget_day = $4`,
      [at, input.orgId, input.userId, day],
    );
    return {
      admitted: true,
      reason: "admitted",
      jobId,
      sessionSpent: sessionSpent + 1,
      tenantSpent: tenantSpent + 1,
    };
  });
}
