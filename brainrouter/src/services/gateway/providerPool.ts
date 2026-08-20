/**
 * Provider/LLM-Gateway (ADR-010 P7 / ADR-006 service #1) — the standalone
 * provider-resolution service. It runs on its own Postgres pool (NOT the full
 * MemoryEngine — the brain owns the schema/migrations; the gateway is read-mostly
 * over provider_configs) and reuses the SAME query + resolver code the in-process
 * brain uses, so there is one source of truth for provider resolution.
 */
import pg from "pg";
import type { Executor } from "../../memory/store/postgres/queries/executor.js";
import * as providerCfg from "../../memory/store/postgres/queries/providerConfigQueries.js";
import * as modelPolicy from "../../memory/store/postgres/queries/modelPolicyQueries.js";
import * as tenancy from "../../memory/store/postgres/queries/tenancyQueries.js";
import * as users from "../../memory/store/postgres/queries/userStatsQueries.js";
import * as remoteAccess from "../../memory/store/postgres/queries/remoteAccessQueries.js";
import { getSetting } from "../../memory/store/postgres/queries/emailAuthQueries.js";
import type { DeviceSessionRecord } from "../../remote/store.js";
import { resolveProviderConfig } from "../../providers/resolver.js";
import type { ProviderStore } from "../../providers/store.js";
import type { ProviderKind, ResolvedProviderConfig } from "../../providers/types.js";
import {
  authenticateGatewayCredential,
  type GatewayAuthContext,
  type GatewayIdentityStore,
} from "./auth.js";
import {
  resolveGatewayModel,
  type GatewayResolvedModel,
} from "./modelPolicy.js";
import {
  acquireGatewayRequest,
  DEFAULT_GATEWAY_QUOTA_LIMITS,
  recordGatewayUsage,
  releaseGatewayRequest,
  type GatewayQuotaLimits,
  type GatewayUsageEvent,
} from "./accounting.js";

/** A minimal Executor over a `pg.Pool` (mirrors PostgresMemoryStore's `this.exec`). */
export function makePoolExecutor(pool: pg.Pool): Executor {
  return {
    async rows(text, params) { return (await pool.query(text, params)).rows as any[]; },
    async one(text, params) { const r = await pool.query(text, params); return (r.rows[0] ?? null) as any; },
    async run(text, params) { const r = await pool.query(text, params); return r.rowCount ?? 0; },
    async tx(fn) {
      const client = await pool.connect();
      try { await client.query("BEGIN"); const out = await fn(client); await client.query("COMMIT"); return out; }
      catch (e) { await client.query("ROLLBACK"); throw e; }
      finally { client.release(); }
    },
  };
}

/** A ProviderStore backed by a pool executor (only the read path the resolver needs). */
export function makePoolProviderStore(exec: Executor): ProviderStore {
  return {
    listProviderConfigs: (orgId, kind) => providerCfg.listProviderConfigs(exec, orgId, kind),
    getProviderConfig: (id) => providerCfg.getProviderConfig(exec, id),
    createProviderConfig: (orgId, input, by) => providerCfg.createProviderConfig(exec, orgId, input, by),
    updateProviderConfig: (id, patch) => providerCfg.updateProviderConfig(exec, id, patch),
    deleteProviderConfig: (id) => providerCfg.deleteProviderConfig(exec, id),
    setDefaultProvider: (orgId, kind, id) => providerCfg.setDefaultProvider(exec, orgId, kind, id),
    getDefaultResolvedProvider: (orgId, kind) => providerCfg.getDefaultResolvedProvider(exec, orgId, kind),
    getResolvedProvider: (id) => providerCfg.getResolvedProvider(exec, id),
  };
}

/** Identity lookups stay on the gateway's own pool and re-check every request. */
export function makePoolGatewayIdentityStore(exec: Executor): GatewayIdentityStore {
  return {
    getUserByApiKey: (apiKey) => users.getUserByApiKey(exec, apiKey),
    getUserById: (userId) => users.getUserById(exec, userId),
    getDefaultOrgId: (userId) => tenancy.getDefaultOrgId(exec, userId),
    getMemberRole: (orgId, userId) => tenancy.getMemberRole(exec, orgId, userId),
    async getServicePrincipal(id) {
      const row = await exec.one<{
        id: string;
        org_id: string;
        active: boolean;
        scopes_json: string;
      }>(
        `SELECT id, org_id, active, scopes_json
           FROM model_gateway_service_principals
          WHERE id = $1`,
        [id],
      );
      if (!row) return null;
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(row.scopes_json);
        if (Array.isArray(parsed)) scopes = parsed.filter((value): value is string => typeof value === "string");
      } catch { /* malformed persistence fails closed through an empty scope set */ }
      return { id: row.id, orgId: row.org_id, active: Boolean(row.active), scopes };
    },
  };
}

export class GatewayProviderService {
  private readonly pool: pg.Pool;
  private readonly exec: Executor;
  private readonly store: ProviderStore;
  private readonly identityStore: GatewayIdentityStore;
  private readonly jwtSecret: string;
  private readonly quotaLimits: GatewayQuotaLimits;

  constructor(
    connectionString: string,
    jwtSecret: string,
    quotaLimits: GatewayQuotaLimits = DEFAULT_GATEWAY_QUOTA_LIMITS,
  ) {
    this.pool = new pg.Pool({ connectionString });
    const exec = makePoolExecutor(this.pool);
    this.exec = exec;
    this.store = makePoolProviderStore(exec);
    this.identityStore = makePoolGatewayIdentityStore(exec);
    this.jwtSecret = jwtSecret;
    this.quotaLimits = quotaLimits;
  }

  authenticate(bearer: string, requestedOrgId?: string): Promise<GatewayAuthContext> {
    return authenticateGatewayCredential({
      bearer,
      requestedOrgId,
      jwtSecret: this.jwtSecret,
      store: this.identityStore,
    });
  }

  /** DB-first (env fallback) resolved provider for (org, kind). */
  resolve(orgId: string, kind: ProviderKind): Promise<ResolvedProviderConfig | null> {
    return resolveProviderConfig(this.store, orgId, kind);
  }

  /** Member-safe source rows; the HTTP route serializes public ids only. */
  listModels(auth: GatewayAuthContext) {
    return modelPolicy.listProviderModels(this.exec, auth.orgId, true);
  }

  /** Internal-only model resolution; callers must never serialize this result. */
  resolveModel(
    auth: GatewayAuthContext,
    publicModelId: string,
    reasoningEffort?: unknown,
  ): Promise<GatewayResolvedModel> {
    return resolveGatewayModel({
      auth,
      publicModelId,
      reasoningEffort,
      store: {
        getProviderModelByPublicId: (orgId, modelId, enabledOnly) => (
          modelPolicy.getProviderModelByPublicId(this.exec, orgId, modelId, enabledOnly)
        ),
        getResolvedProvider: (id) => providerCfg.getResolvedProvider(this.exec, id),
      },
    });
  }

  acquireRequest(auth: GatewayAuthContext, requestId: string, leaseMs: number): Promise<void> {
    return acquireGatewayRequest(this.exec, {
      auth,
      requestId,
      leaseMs,
      limits: this.quotaLimits,
    });
  }

  releaseRequest(orgId: string, requestId: string): Promise<void> {
    return releaseGatewayRequest(this.exec, orgId, requestId);
  }

  recordUsage(event: GatewayUsageEvent): Promise<void> {
    return recordGatewayUsage(this.exec, event);
  }

  /** ADR-043 C6b — device-session lookup for the egress control channel's hello auth. */
  getDeviceSessionByTokenHash(orgId: string, userId: string, tokenHash: string): Promise<DeviceSessionRecord | null> {
    return remoteAccess.getDeviceSessionByTokenHash(this.exec, orgId, userId, tokenHash);
  }

  /** ADR-043 C6b — read a per-org system-settings value (e.g. the egress opt-in flag). */
  getOrgSetting<T = unknown>(key: string): Promise<T | null> {
    return getSetting<T>(this.exec, key);
  }

  async ping(): Promise<boolean> {
    try { await this.pool.query("SELECT 1"); return true; } catch { return false; }
  }

  async close(): Promise<void> { await this.pool.end(); }
}
