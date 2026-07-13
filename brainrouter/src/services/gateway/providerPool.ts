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
import { resolveProviderConfig } from "../../providers/resolver.js";
import type { ProviderStore } from "../../providers/store.js";
import type { ProviderKind, ResolvedProviderConfig } from "../../providers/types.js";

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

export class GatewayProviderService {
  private readonly pool: pg.Pool;
  private readonly store: ProviderStore;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
    this.store = makePoolProviderStore(makePoolExecutor(this.pool));
  }

  /** DB-first (env fallback) resolved provider for (org, kind). */
  resolve(orgId: string, kind: ProviderKind): Promise<ResolvedProviderConfig | null> {
    return resolveProviderConfig(this.store, orgId, kind);
  }

  async ping(): Promise<boolean> {
    try { await this.pool.query("SELECT 1"); return true; } catch { return false; }
  }

  async close(): Promise<void> { await this.pool.end(); }
}
