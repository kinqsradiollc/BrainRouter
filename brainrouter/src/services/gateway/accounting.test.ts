import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Executor } from '../../memory/store/postgres/queries/executor.js';
import type { GatewayAuthContext } from './auth.js';
import {
  acquireGatewayRequest,
  GatewayQuotaError,
  recordGatewayUsage,
  releaseGatewayRequest,
} from './accounting.js';

const auth: GatewayAuthContext = {
  credentialType: 'jwt',
  principalType: 'user',
  userId: 'user-1',
  orgId: 'org-1',
  role: 'developer',
  scopes: ['models:invoke'],
};

function queryExecutor(input: {
  organizationConcurrency?: number;
  principalConcurrency?: number;
  organizationRate?: number;
  principalRate?: number;
} = {}) {
  let rateQueries = 0;
  const query = vi.fn(async (text: string) => {
    if (text.includes('organization_count')) {
      return {
        rows: [{
          organization_count: input.organizationConcurrency ?? 0,
          principal_count: input.principalConcurrency ?? 0,
        }],
        rowCount: 1,
      };
    }
    if (text.includes('RETURNING request_count')) {
      rateQueries += 1;
      return {
        rows: [{ request_count: rateQueries === 1
          ? input.organizationRate ?? 1
          : input.principalRate ?? 1 }],
        rowCount: 1,
      };
    }
    if (text.includes('RETURNING request_id')) {
      return { rows: [{ request_id: 'req_test' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const run = vi.fn(async (_text: string, _params?: unknown[]) => 1);
  const client = { query } as unknown as PoolClient;
  const exec: Executor = {
    rows: vi.fn(async () => []),
    one: vi.fn(async () => null),
    run,
    tx: vi.fn(async (fn) => fn(client)),
  };
  return { exec, query, run };
}

const limits = {
  organizationRequestsPerMinute: 10,
  principalRequestsPerMinute: 5,
  organizationConcurrency: 4,
  principalConcurrency: 2,
};

describe('model gateway shared accounting', () => {
  it('serializes organization and principal acquisition through shared Postgres state', async () => {
    const { exec, query } = queryExecutor();

    await acquireGatewayRequest(exec, {
      auth,
      requestId: 'req_test',
      leaseMs: 30_000,
      limits,
    });

    const sql = query.mock.calls.map(([text]) => String(text)).join('\n');
    expect(sql.match(/pg_advisory_xact_lock/g)).toHaveLength(2);
    expect(sql).toContain('model_gateway_rate_windows');
    expect(sql).toContain('model_gateway_concurrency_leases');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('RETURNING request_id'),
      ['req_test', 'org-1', 'user', 'user-1', 30_000],
    );
  });

  it('rejects shared concurrency before incrementing request windows', async () => {
    const { exec, query } = queryExecutor({ principalConcurrency: 2 });

    await expect(acquireGatewayRequest(exec, {
      auth,
      requestId: 'req_test',
      leaseMs: 30_000,
      limits,
    })).rejects.toMatchObject({
      code: 'concurrency_limit_exceeded',
      retryAfterSeconds: 1,
    } satisfies Partial<GatewayQuotaError>);

    expect(query.mock.calls.some(([text]) => String(text).includes('RETURNING request_count'))).toBe(false);
  });

  it('rejects an organization or principal minute quota atomically', async () => {
    const { exec, query } = queryExecutor({ principalRate: 6 });

    await expect(acquireGatewayRequest(exec, {
      auth,
      requestId: 'req_test',
      leaseMs: 30_000,
      limits,
    })).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
      retryAfterSeconds: 60,
    } satisfies Partial<GatewayQuotaError>);

    expect(query.mock.calls.some(([text]) => String(text).includes('RETURNING request_id'))).toBe(false);
  });

  it('releases leases and writes only fixed-shape usage metadata', async () => {
    const { exec, run } = queryExecutor();
    await releaseGatewayRequest(exec, 'org-1', 'req_test');
    await recordGatewayUsage(exec, {
      requestId: 'req_test',
      orgId: 'org-1',
      userId: 'user-1',
      servicePrincipalId: null,
      publicModelId: 'gpt-public',
      selectedEffort: 'high',
      upstreamRoute: 'provider:pc-1',
      latencyMs: 25,
      httpStatus: 200,
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cachedInputTokens: 2,
        totalTokens: 10,
      },
      costMicrousd: null,
      egressMode: 'server',
    });

    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('model_gateway_concurrency_leases'),
      ['req_test', 'org-1'],
    );
    const [usageSql, usageParams] = run.mock.calls[1]!;
    expect(usageSql).toContain('model_usage_events');
    expect(usageSql).not.toMatch(/prompt|response|bearer|provider_key|api_key/i);
    expect(usageParams).toEqual([
      'req_test', 'org-1', 'user-1', null, 'gpt-public', 'high', 'provider:pc-1',
      25, 200, 7, 3, 2, 10, null, 'server',
    ]);
  });
});
