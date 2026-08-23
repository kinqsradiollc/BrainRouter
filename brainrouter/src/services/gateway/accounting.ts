import type { PoolClient, QueryResultRow } from 'pg';

import type { ModelReasoningEffort } from '@kinqs/brainrouter-types';

import type { Executor } from '../../memory/store/postgres/queries/executor.js';
import type { GatewayAuthContext } from './auth.js';
import type { GatewayTokenUsage } from './usage.js';

export interface GatewayQuotaLimits {
  organizationRequestsPerMinute: number;
  principalRequestsPerMinute: number;
  organizationConcurrency: number;
  principalConcurrency: number;
}

export const DEFAULT_GATEWAY_QUOTA_LIMITS: GatewayQuotaLimits = Object.freeze({
  organizationRequestsPerMinute: 600,
  principalRequestsPerMinute: 120,
  organizationConcurrency: 64,
  principalConcurrency: 8,
});

export type GatewayPrincipalScope = 'user' | 'service';

export interface GatewayUsageEvent {
  requestId: string;
  orgId: string;
  userId: string | null;
  servicePrincipalId: string | null;
  publicModelId: string;
  selectedEffort: ModelReasoningEffort | null;
  upstreamRoute: string;
  latencyMs: number;
  httpStatus: number;
  usage: GatewayTokenUsage | null;
  costMicrousd: number | null;
  /** ADR-043 C7 (D4) — 'server' | 'client-tunnel' (which egress path was taken); null when unknown. */
  egressMode: string | null;
}

export class GatewayQuotaError extends Error {
  constructor(
    public readonly code: 'rate_limit_exceeded' | 'concurrency_limit_exceeded',
    public readonly retryAfterSeconds: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayQuotaError';
  }
}

interface PrincipalIdentity {
  type: GatewayPrincipalScope;
  id: string;
}

interface CountRow extends QueryResultRow {
  organization_count: string | number;
  principal_count: string | number;
}

interface CounterRow extends QueryResultRow {
  request_count: string | number;
}

function principal(auth: GatewayAuthContext): PrincipalIdentity {
  return auth.principalType === 'user'
    ? { type: 'user', id: auth.userId }
    : { type: 'service', id: auth.servicePrincipalId };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function count(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function lockScope(client: PoolClient, scope: string): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [scope],
  );
}

async function incrementWindow(
  client: PoolClient,
  input: { orgId: string; scopeType: 'organization' | GatewayPrincipalScope; subjectId: string },
): Promise<number> {
  const result = await client.query<CounterRow>(
    `INSERT INTO model_gateway_rate_windows (
       org_id, scope_type, subject_id, window_start, request_count
     ) VALUES ($1, $2, $3, date_trunc('minute', clock_timestamp()), 1)
     ON CONFLICT (org_id, scope_type, subject_id, window_start)
     DO UPDATE SET request_count = model_gateway_rate_windows.request_count + 1
     RETURNING request_count`,
    [input.orgId, input.scopeType, input.subjectId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Gateway quota counter was not persisted.');
  return count(row.request_count);
}

/**
 * Acquire one shared request permit. The organization lock serializes all
 * replicas, while the principal lock makes the scoping explicit and keeps the
 * algorithm safe if organization and principal policy later diverge.
 */
export async function acquireGatewayRequest(
  exec: Executor,
  input: {
    auth: GatewayAuthContext;
    requestId: string;
    leaseMs: number;
    limits?: GatewayQuotaLimits;
  },
): Promise<void> {
  const limits = input.limits ?? DEFAULT_GATEWAY_QUOTA_LIMITS;
  const leaseMs = positiveInteger(input.leaseMs, 'leaseMs');
  const organizationRequests = positiveInteger(
    limits.organizationRequestsPerMinute,
    'organizationRequestsPerMinute',
  );
  const principalRequests = positiveInteger(
    limits.principalRequestsPerMinute,
    'principalRequestsPerMinute',
  );
  const organizationConcurrency = positiveInteger(
    limits.organizationConcurrency,
    'organizationConcurrency',
  );
  const principalConcurrency = positiveInteger(
    limits.principalConcurrency,
    'principalConcurrency',
  );
  const actor = principal(input.auth);

  await exec.tx(async (client) => {
    const scopes = [
      `gateway:organization:${input.auth.orgId}`,
      `gateway:${actor.type}:${input.auth.orgId}:${actor.id}`,
    ].sort();
    for (const scope of scopes) await lockScope(client, scope);

    await client.query(
      `DELETE FROM model_gateway_concurrency_leases
        WHERE org_id = $1 AND expires_at <= clock_timestamp()`,
      [input.auth.orgId],
    );
    await client.query(
      `DELETE FROM model_gateway_rate_windows
        WHERE org_id = $1
          AND window_start < date_trunc('minute', clock_timestamp()) - interval '1 day'`,
      [input.auth.orgId],
    );
    const active = await client.query<CountRow>(
      `SELECT
         count(*)::int AS organization_count,
         count(*) FILTER (
           WHERE principal_type = $2 AND principal_id = $3
         )::int AS principal_count
       FROM model_gateway_concurrency_leases
       WHERE org_id = $1 AND expires_at > clock_timestamp()`,
      [input.auth.orgId, actor.type, actor.id],
    );
    const counts = active.rows[0] ?? { organization_count: 0, principal_count: 0 };
    if (
      count(counts.organization_count) >= organizationConcurrency
      || count(counts.principal_count) >= principalConcurrency
    ) {
      throw new GatewayQuotaError(
        'concurrency_limit_exceeded',
        1,
        'Too many model requests are already in progress.',
      );
    }

    const organizationCount = await incrementWindow(client, {
      orgId: input.auth.orgId,
      scopeType: 'organization',
      subjectId: input.auth.orgId,
    });
    const principalCount = await incrementWindow(client, {
      orgId: input.auth.orgId,
      scopeType: actor.type,
      subjectId: actor.id,
    });
    if (organizationCount > organizationRequests || principalCount > principalRequests) {
      throw new GatewayQuotaError(
        'rate_limit_exceeded',
        60,
        'The model request rate limit has been reached.',
      );
    }

    const inserted = await client.query<{ request_id: string }>(
      `INSERT INTO model_gateway_concurrency_leases (
         request_id, org_id, principal_type, principal_id, expires_at
       ) VALUES (
         $1, $2, $3, $4,
         clock_timestamp() + ($5::double precision * interval '1 millisecond')
       )
       ON CONFLICT (request_id) DO NOTHING
       RETURNING request_id`,
      [input.requestId, input.auth.orgId, actor.type, actor.id, leaseMs],
    );
    if (!inserted.rows[0]) throw new Error('Gateway request ID is already active.');
  });
}

export async function releaseGatewayRequest(
  exec: Executor,
  orgId: string,
  requestId: string,
): Promise<void> {
  await exec.run(
    `DELETE FROM model_gateway_concurrency_leases
      WHERE request_id = $1 AND org_id = $2`,
    [requestId, orgId],
  );
}

/** Append one fixed-shape metadata-only model usage event. */
export async function recordGatewayUsage(
  exec: Executor,
  event: GatewayUsageEvent,
): Promise<void> {
  await exec.run(
    `INSERT INTO model_usage_events (
       request_id, org_id, user_id, service_principal_id,
       public_model_id, selected_effort, upstream_route,
       latency_ms, http_status, input_tokens, output_tokens,
       cached_input_tokens, total_tokens, cost_microusd, egress_mode
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14, $15
     )
     ON CONFLICT (request_id) DO NOTHING`,
    [
      event.requestId,
      event.orgId,
      event.userId,
      event.servicePrincipalId,
      event.publicModelId,
      event.selectedEffort,
      event.upstreamRoute,
      event.latencyMs,
      event.httpStatus,
      event.usage?.inputTokens ?? null,
      event.usage?.outputTokens ?? null,
      event.usage?.cachedInputTokens ?? null,
      event.usage?.totalTokens ?? null,
      event.costMicrousd,
      event.egressMode,
    ],
  );
}
