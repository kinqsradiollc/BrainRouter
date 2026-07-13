/**
 * ADR-007 Phase 2 (step 2) — native-async Postgres + pgvector memory store.
 *
 * A faithful port of `SqliteMemoryStore` to `node-postgres`, implementing the
 * async `IMemoryStore` contract plus the full set of concrete capability methods
 * the engine reaches via `store as ...` casts (tree, blackboard, source,
 * compression, vault, lessons, graph extras). Behaviour mirrors the SQLite store
 * 1:1; the differences are purely the storage layer:
 *
 *   * FTS5 virtual tables → a generated `content_tsv tsvector` column + GIN
 *     index (created by migration 002). "FTS insert" is therefore a no-op here
 *     (the column is maintained by Postgres); FTS search uses
 *     `content_tsv @@ plainto_tsquery('english', $q)` ranked by `ts_rank`.
 *   * sqlite-vec `cognitive_vec` (vec0 virtual table) → a real
 *     `cognitive_vec(record_id, embedding vector(N))` table created at runtime in
 *     `initVec(N)` with a cosine ANN index; search uses the `<=>` operator.
 *   * `BEGIN IMMEDIATE` write-lock claims → a pooled client running
 *     `BEGIN`/`SELECT ... FOR UPDATE SKIP LOCKED`/`COMMIT` for the atomic
 *     job/delegation claim methods.
 *
 * The schema (001_init + 002_schema) is applied by `init()` via the migration
 * runner; `cognitive_vec` is deferred to `initVec` because its dimension is
 * embedder-dependent.
 *
 * ── Structure ──────────────────────────────────────────────────────────────
 * The concrete SQL for every domain was extracted (byte-identical) into the
 * `queries/*.ts` sibling modules; each helper is a free function taking an
 * `Executor` (this store's `rows`/`one`/`run`/`tx` primitives) plus, where a
 * method reached into store state, a small `VecContext`/`CcrContext`. The class
 * below keeps the `IMemoryStore` surface + lifecycle/pgvector bootstrap and
 * delegates the rest.
 */

import { fileURLToPath } from "node:url";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  ActiveSessionFilters,
  ActiveSessionRecord,
  ActiveSessionUsage,
  SessionInboxFilters,
  SessionInboxRecord,
  PendingDelegationRecord,
  PendingDelegationEnqueueInput,
  PendingDelegationFilters,
  MemoryJobRecord,
  MemoryJobEnqueueInput,
  MemoryJobListFilters,
  MemoryJobKindAggregate,
  ContradictionRecord,
  CursorPaginationOptions,
  EvidenceListFilters,
  ExtractionStatus,
  ImportResult,
  SensoryRecord,
  CognitiveRecord,
  CognitiveFtsResult,
  MemoryEvidence,
  MemoryExport,
  MemoryImport,
  MemoryListFilters,
  MemoryListItem,
  MemoryOperation,
  MemoryStatus,
  OperationLogFilters,
  VectorSearchResult,
  SkillActivationRecord,
  SkillHintsRecord,
  ContextualFocusRecord,
  CoreIdentityRecord,
  SchedulerState,
  GraphNode,
  GraphEdge,
  StalledExtractionBacklog,
  UserRecord,
  SourceDocument,
  SourceChunk,
  SourceChunkInput,
  BlackboardItem,
  BlackboardItemInput,
  BlackboardStatus,
  MemoryTreeNode,
  MemoryTreeNodeInput,
  MemoryTreeKind,
  VaultExportEntry,
  VaultExportInput,
  AtlasGraph,
  AtlasWorkspaceSummary,
  FleetSnapshotEntry,
  IMemoryStore,
  PentestTargetInput,
  PentestTargetRecord,
} from "@kinqs/brainrouter-types";
import { createPgPool } from "./connection.js";
import { loadMigrations, applyMigrations } from "./migrate.js";
import {
  asNumber,
  type CompressionEntryInput,
  type CompressionEntryMetadata,
  type CompressionRetrieval,
  type CompressionStats,
} from "./converters.js";
import { mapWithConcurrency, readEmbedConcurrency } from "../../util/concurrency.js";
import type { Executor } from "./queries/executor.js";
import type { VecContext } from "./queries/searchQueries.js";
import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_ENTRIES,
  type CcrContext,
} from "./queries/compressionQueries.js";
import * as sensory from "./queries/sensoryQueries.js";
import * as cognitive from "./queries/cognitiveQueries.js";
import * as operations from "./queries/operationsQueries.js";
import * as search from "./queries/searchQueries.js";
import * as contradiction from "./queries/contradictionQueries.js";
import * as skillFocus from "./queries/skillFocusQueries.js";
import * as session from "./queries/sessionQueries.js";
import * as job from "./queries/jobQueries.js";
import * as compression from "./queries/compressionQueries.js";
import * as atlasIdentity from "./queries/atlasIdentityQueries.js";
import * as graph from "./queries/graphQueries.js";
import * as userStats from "./queries/userStatsQueries.js";
import * as sourcesTree from "./queries/sourcesTreeQueries.js";
import * as tenancy from "./queries/tenancyQueries.js";
import * as emailAuth from "./queries/emailAuthQueries.js";
import * as orgPersona from "./queries/orgPersonaQueries.js";
import * as sharing from "./queries/memorySharingQueries.js";
import * as projects from "./queries/projectQueries.js";
import * as adminConsole from "./queries/adminConsoleQueries.js";
import * as providerCfg from "./queries/providerConfigQueries.js";
import * as integrationCfg from "./queries/integrationConfigQueries.js";
import * as connectorCfg from "./queries/connectorConfigQueries.js";
import * as pentestTargets from "./queries/pentestTargetQueries.js";
import type { TenancyStore } from "../../../tenancy/store.js";
import type { Role } from "../../../tenancy/rbac.js";
import type { OrganizationRecord, OrgMemberRecord, OrgMembership, OrgPlan } from "../../../tenancy/types.js";
import type { ProviderStore } from "../../../providers/store.js";
import type { ProviderConfigRecord, ProviderConfigInput, ProviderKind, ResolvedProviderConfig } from "../../../providers/types.js";
import type { IntegrationStore } from "../../../integrations/store.js";
import type { ConnectorStore, ConnectorConfigRecord, ConnectorConfigInput, ConnectorConfigPatch, ResolvedConnector, OAuthAppConfig, ResolvedOAuthApp } from "../../../connectors/store.js";
import type { IntegrationConfigRecord, IntegrationConfigInput, IntegrationKind, ResolvedIntegration } from "../../../integrations/types.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build the `cognitive_vec` ANN index DDL from env (see initVec for the knobs).
 * Returns null when the index is disabled (`BRAINROUTER_PGVECTOR_INDEX=none`).
 * Default preserves the prior behaviour: ivfflat, lists=100, cosine ops.
 */
export function vecIndexDdl(): string | null {
  const kind = (process.env.BRAINROUTER_PGVECTOR_INDEX ?? "ivfflat").trim().toLowerCase();
  if (kind === "none") return null;
  const head = "CREATE INDEX IF NOT EXISTS idx_cognitive_vec_cos ON cognitive_vec USING";
  if (kind === "hnsw") {
    const m = readPositiveInteger(process.env.BRAINROUTER_PGVECTOR_HNSW_M, 16);
    const efc = readPositiveInteger(process.env.BRAINROUTER_PGVECTOR_HNSW_EF_CONSTRUCTION, 64);
    return `${head} hnsw (embedding vector_cosine_ops) WITH (m = ${m}, ef_construction = ${efc})`;
  }
  // ivfflat (default, and the fallback for any unknown value).
  const lists = readPositiveInteger(process.env.BRAINROUTER_PGVECTOR_LISTS, 100);
  return `${head} ivfflat (embedding vector_cosine_ops) WITH (lists = ${lists})`;
}

export interface PostgresMemoryStoreOptions {
  /** Pass an existing pool (e.g. a test harness on a scratch database). */
  pool?: Pool;
  compressionStore?: { ttlSeconds?: number; maxEntries?: number; now?: () => number };
}

export class PostgresMemoryStore implements IMemoryStore, TenancyStore, ProviderStore, IntegrationStore, ConnectorStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private vecReady = false;
  private vecDimensions = 0;

  // CCR config
  private readonly ccrTtlSeconds: number;
  private readonly ccrMaxEntries: number;
  private readonly ccrClock: () => number;
  private ccrLastPurgeAt = Number.NEGATIVE_INFINITY;

  // Execution surfaces threaded to the extracted query helpers.
  private readonly exec: Executor;
  private readonly vecCtx: VecContext;
  private readonly ccrCtx: CcrContext;

  constructor(connection: string | Pool, options?: PostgresMemoryStoreOptions) {
    if (options?.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else if (typeof connection === "string") {
      this.pool = createPgPool(connection);
      this.ownsPool = true;
    } else {
      this.pool = connection;
      this.ownsPool = false;
    }
    this.ccrTtlSeconds = options?.compressionStore?.ttlSeconds ?? readPositiveInteger(process.env.BRAINROUTER_CCR_TTL_SECONDS, DEFAULT_TTL_SECONDS);
    this.ccrMaxEntries = options?.compressionStore?.maxEntries ?? readPositiveInteger(process.env.BRAINROUTER_CCR_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
    this.ccrClock = options?.compressionStore?.now ?? (() => Math.floor(Date.now() / 1_000));

    // `self` lets the context getters read this instance's mutable pgvector /
    // CCR-purge state live, rather than snapshotting it at construction time.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.exec = {
      rows: (text, params) => this.rows(text, params),
      one: (text, params) => this.one(text, params),
      run: (text, params) => this.run(text, params),
      tx: (fn) => this.tx(fn),
    };
    this.vecCtx = {
      get vecReady() { return self.vecReady; },
      get vecDimensions() { return self.vecDimensions; },
      initVec: (dimensions) => this.initVec(dimensions),
    };
    this.ccrCtx = {
      ccrTtlSeconds: this.ccrTtlSeconds,
      ccrMaxEntries: this.ccrMaxEntries,
      ccrClock: () => this.ccrClock(),
      getCcrLastPurgeAt: () => self.ccrLastPurgeAt,
      setCcrLastPurgeAt: (value) => { self.ccrLastPurgeAt = value; },
    };
  }

  // ── low-level query helpers ────────────────────────────────────────────

  /** Run a parameterized query and return the rows. `params` are positional ($1..). */
  private async rows<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  /** Run a query and return the first row, or null. */
  private async one<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<T | null> {
    const res = await this.pool.query<T>(text, params);
    return res.rows[0] ?? null;
  }

  /** Run a write and return rowCount (mirrors SQLite's `changes`). */
  private async run(text: string, params: any[] = []): Promise<number> {
    const res = await this.pool.query(text, params);
    return res.rowCount ?? 0;
  }

  /** Execute `fn` inside a single transaction on one pooled client. */
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  public async init(): Promise<void> {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    await applyMigrations(this.pool, migrations);
  }

  public async initVec(dimensions: number): Promise<void> {
    if (dimensions <= 0) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        id integer PRIMARY KEY CHECK (id = 1),
        dimensions integer NOT NULL,
        created_at text NOT NULL
      )
    `);

    // Detect an existing cognitive_vec and its dimension. pgvector stores the
    // declared dim in the column's atttypmod (typmod - 4 == dimensions for
    // `vector(N)`). Drop + recreate on a dimension change, mirroring the SQLite
    // store's vec0 recreate path.
    const dimRow = await this.one<{ dim: number | null }>(
      `SELECT (atttypmod - 4) AS dim
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'cognitive_vec' AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped`,
    );
    const existingDim = dimRow && dimRow.dim != null ? asNumber(dimRow.dim, -1) : -1;

    if (existingDim !== -1 && existingDim !== dimensions) {
      await this.pool.query("DROP TABLE IF EXISTS cognitive_vec");
      await this.run("UPDATE embedding_meta SET dimensions = $1, created_at = $2 WHERE id = 1", [dimensions, new Date().toISOString()]);
    } else {
      const meta = await this.one<{ dimensions: number }>("SELECT dimensions FROM embedding_meta WHERE id = 1");
      if (!meta) {
        await this.run("INSERT INTO embedding_meta (id, dimensions, created_at) VALUES (1, $1, $2)", [dimensions, new Date().toISOString()]);
      }
    }

    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS cognitive_vec (
         record_id text PRIMARY KEY,
         embedding vector(${dimensions})
       )`,
    );
    // Cosine ANN index — tunable via env (defaults preserve the prior behaviour:
    // ivfflat, lists=100). `IF NOT EXISTS` keeps it idempotent across boots.
    //   BRAINROUTER_PGVECTOR_INDEX            ivfflat (default) | hnsw | none
    //   BRAINROUTER_PGVECTOR_LISTS            ivfflat clusters (default 100; ~sqrt(rows))
    //   BRAINROUTER_PGVECTOR_HNSW_M           hnsw graph degree (default 16)
    //   BRAINROUTER_PGVECTOR_HNSW_EF_CONSTRUCTION  hnsw build breadth (default 64)
    // An existing index is NOT rebuilt on a knob change (IF NOT EXISTS); drop
    // `idx_cognitive_vec_cos` manually to re-tune. Build is best-effort: a build
    // that the server rejects leaves the table searchable via a sequential scan.
    const indexDdl = vecIndexDdl();
    if (indexDdl) {
      try {
        await this.pool.query(indexDdl);
      } catch {
        // Some pgvector builds reject specific params / index types; the table
        // still works with a sequential scan, so index creation is best-effort.
      }
    }

    this.vecDimensions = dimensions;
    this.vecReady = true;
  }

  public isVecAvailable(): boolean {
    return this.vecReady && this.vecDimensions > 0;
  }

  /** The active embedding dimension (0 when the vector table isn't built yet). Used
   *  by the dashboard guard that warns before a dimension-changing embedder swap. */
  public getVecDimensions(): number {
    return this.vecReady ? this.vecDimensions : 0;
  }

  public async reembedStaleRecords(embedder: (text: string) => Promise<Float32Array>): Promise<number> {
    if (!this.vecReady) return 0;
    const rows = await this.rows<{ record_id: string; content: string }>(`
      SELECT r.record_id, r.content
      FROM cognitive_records r
      LEFT JOIN cognitive_vec v ON r.record_id = v.record_id
      WHERE r.invalid_at IS NULL AND r.archived = 0 AND v.record_id IS NULL
      ORDER BY r.created_time ASC, r.record_id ASC
    `);
    const outcomes = await mapWithConcurrency(rows, readEmbedConcurrency(), async (row) => {
      try {
        const embedding = await embedder(row.content);
        await this.upsertCognitiveVec(row.record_id, embedding);
        return true;
      } catch (error) {
        console.error(`[BrainRouter] Failed to re-embed record ${row.record_id}:`, error instanceof Error ? error.message : error);
        return false;
      }
    });
    return outcomes.reduce((acc, ok) => acc + (ok ? 1 : 0), 0);
  }

  public async getSqliteVersion(): Promise<string> {
    try {
      const row = await this.one<{ version: string }>("SELECT version() AS version");
      return row?.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Close the pool (only if this store created it). For test/teardown use. */
  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  /** Liveness probe for the status gateway — a trivial round-trip to Postgres. */
  public async ping(): Promise<boolean> {
    try { await this.exec.one("SELECT 1 AS ok"); return true; } catch { return false; }
  }

  // ── email/auth (ADR-014 P-B2: settings, tokens, invites) ─────────────────
  public getSetting<T = unknown>(key: string): Promise<T | null> { return emailAuth.getSetting<T>(this.exec, key); }
  public setSetting(key: string, value: unknown): Promise<void> { return emailAuth.setSetting(this.exec, key, value, new Date().toISOString()); }
  public createAuthToken(rec: { tokenHash: string; kind: string; userId?: string | null; email?: string | null; expiresAt: string; createdAt: string }): Promise<void> { return emailAuth.createAuthToken(this.exec, rec); }
  public consumeAuthToken(tokenHash: string, kind: string, nowIso: string): Promise<emailAuth.AuthTokenRecord | null> { return emailAuth.consumeAuthToken(this.exec, tokenHash, kind, nowIso); }
  public setEmailVerified(userId: string): Promise<void> { return emailAuth.setEmailVerified(this.exec, userId); }
  public createInvite(rec: emailAuth.OrgInviteRecord): Promise<void> { return emailAuth.createInvite(this.exec, rec); }
  public getInviteByHash(tokenHash: string): Promise<emailAuth.OrgInviteRecord | null> { return emailAuth.getInviteByHash(this.exec, tokenHash); }
  public acceptInvite(tokenHash: string, nowIso: string): Promise<emailAuth.OrgInviteRecord | null> { return emailAuth.acceptInvite(this.exec, tokenHash, nowIso); }
  public listInvites(orgId: string): Promise<emailAuth.OrgInviteRecord[]> { return emailAuth.listInvites(this.exec, orgId); }
  public revokeInvite(tokenHash: string): Promise<void> { return emailAuth.revokeInvite(this.exec, tokenHash); }

  // ── team consensus persona (ADR-014 P-C) ─────────────────────────────────
  public getOrgSharedIdentityCognitives(orgId: string, limit = 100): Promise<any[]> { return orgPersona.getOrgSharedIdentityCognitives(this.exec, orgId, limit); }
  public getOrgIdentity(orgId: string): Promise<orgPersona.OrgIdentityRecord | null> { return orgPersona.getOrgIdentity(this.exec, orgId); }
  public upsertOrgIdentity(rec: orgPersona.OrgIdentityRecord): Promise<void> { return orgPersona.upsertOrgIdentity(this.exec, rec); }

  // ── artifact/memory sharing (ADR-014 P-D) ────────────────────────────────
  public setMemoryVisibility(recordId: string, userId: string, orgId: string, visibility: "private" | "org"): Promise<boolean> { return sharing.setMemoryVisibility(this.exec, recordId, userId, orgId, visibility); }
  public listOrgSharedMemories(orgId: string, limit = 50): Promise<sharing.SharedMemory[]> { return sharing.listOrgSharedMemories(this.exec, orgId, limit); }

  // ── projects + per-project access (ADR-014 P-E) ──────────────────────────
  public createProject(rec: projects.ProjectRecord): Promise<void> { return projects.createProject(this.exec, rec); }
  public getProject(projectId: string): Promise<projects.ProjectRecord | null> { return projects.getProject(this.exec, projectId); }
  public countProjects(orgId: string): Promise<number> { return projects.countProjects(this.exec, orgId); }
  public updateProject(projectId: string, patch: { name?: string; repoUrl?: string | null; restricted?: boolean }): Promise<projects.ProjectRecord | null> { return projects.updateProject(this.exec, projectId, patch); }
  public deleteProject(projectId: string): Promise<void> { return projects.deleteProject(this.exec, projectId); }
  public listAccessibleProjects(orgId: string, userId: string, isOrgAdmin: boolean): Promise<projects.ProjectRecord[]> { return projects.listAccessibleProjects(this.exec, orgId, userId, isOrgAdmin); }
  public addProjectMember(projectId: string, userId: string, role: string, now: string): Promise<void> { return projects.addProjectMember(this.exec, projectId, userId, role, now); }
  public removeProjectMember(projectId: string, userId: string): Promise<void> { return projects.removeProjectMember(this.exec, projectId, userId); }
  public listProjectMembers(projectId: string): Promise<projects.ProjectMemberRecord[]> { return projects.listProjectMembers(this.exec, projectId); }

  // ── admin console + audit (ADR-014 P-F) ──────────────────────────────────
  public listAllOrgsWithStats(limit = 500): Promise<adminConsole.OrgStatsRow[]> { return adminConsole.listAllOrgsWithStats(this.exec, limit); }
  public logOrgAudit(rec: { orgId: string; actorId?: string | null; action: string; target?: string | null; detail?: string | null; createdAt: string }): Promise<void> { return adminConsole.logOrgAudit(this.exec, rec); }
  public listOrgAudit(orgId: string, limit = 100): Promise<adminConsole.OrgAuditRow[]> { return adminConsole.listOrgAudit(this.exec, orgId, limit); }

  // ── tenancy (ADR-010 P1: organizations + membership/roles) ───────────────

  public createOrganization(input: { orgId: string; name: string; slug: string; plan?: OrgPlan }): Promise<OrganizationRecord> {
    return tenancy.createOrganization(this.exec, input);
  }
  public getOrganization(orgId: string): Promise<OrganizationRecord | null> {
    return tenancy.getOrganization(this.exec, orgId);
  }
  public updateOrganizationPlan(orgId: string, plan: OrgPlan): Promise<OrganizationRecord> {
    return tenancy.updateOrganizationPlan(this.exec, orgId, plan);
  }
  public updateAllowedDomains(orgId: string, domains: string[]): Promise<OrganizationRecord> {
    return tenancy.updateAllowedDomains(this.exec, orgId, domains);
  }
  public addOrgMember(orgId: string, userId: string, role: Role): Promise<void> {
    return tenancy.addOrgMember(this.exec, orgId, userId, role);
  }
  public removeOrgMember(orgId: string, userId: string): Promise<void> {
    return tenancy.removeOrgMember(this.exec, orgId, userId);
  }
  public getMemberRole(orgId: string, userId: string): Promise<Role | null> {
    return tenancy.getMemberRole(this.exec, orgId, userId);
  }
  public listOrgMembers(orgId: string): Promise<OrgMemberRecord[]> {
    return tenancy.listOrgMembers(this.exec, orgId);
  }
  public listOrgMembershipsForUser(userId: string): Promise<OrgMembership[]> {
    return tenancy.listOrgMembershipsForUser(this.exec, userId);
  }
  public setDefaultOrg(userId: string, orgId: string): Promise<void> {
    return tenancy.setDefaultOrg(this.exec, userId, orgId);
  }
  public getDefaultOrgId(userId: string): Promise<string | null> {
    return tenancy.getDefaultOrgId(this.exec, userId);
  }
  public ensurePersonalOrg(userId: string, displayName?: string): Promise<OrganizationRecord> {
    return tenancy.ensurePersonalOrg(this.exec, userId, displayName);
  }

  // ── provider configs (ADR-010 P2: DB-backed providers, no .env) ──────────

  public listProviderConfigs(orgId: string, kind?: ProviderKind): Promise<ProviderConfigRecord[]> {
    return providerCfg.listProviderConfigs(this.exec, orgId, kind);
  }
  public getProviderConfig(id: string): Promise<ProviderConfigRecord | null> {
    return providerCfg.getProviderConfig(this.exec, id);
  }
  public createProviderConfig(orgId: string, input: ProviderConfigInput, createdBy?: string): Promise<ProviderConfigRecord> {
    return providerCfg.createProviderConfig(this.exec, orgId, input, createdBy);
  }
  public updateProviderConfig(id: string, patch: Partial<ProviderConfigInput>): Promise<ProviderConfigRecord | null> {
    return providerCfg.updateProviderConfig(this.exec, id, patch);
  }
  public deleteProviderConfig(id: string): Promise<void> {
    return providerCfg.deleteProviderConfig(this.exec, id);
  }
  public setDefaultProvider(orgId: string, kind: ProviderKind, id: string): Promise<void> {
    return providerCfg.setDefaultProvider(this.exec, orgId, kind, id);
  }
  public getDefaultResolvedProvider(orgId: string, kind: ProviderKind): Promise<ResolvedProviderConfig | null> {
    return providerCfg.getDefaultResolvedProvider(this.exec, orgId, kind);
  }
  public getResolvedProvider(id: string): Promise<ResolvedProviderConfig | null> {
    return providerCfg.getResolvedProvider(this.exec, id);
  }

  // ── integrations (ADR-010 P6: org-scoped GitHub App etc.) ────────────────

  public listIntegrationConfigs(orgId: string, kind?: IntegrationKind): Promise<IntegrationConfigRecord[]> {
    return integrationCfg.listIntegrationConfigs(this.exec, orgId, kind);
  }
  public getIntegrationConfig(id: string): Promise<IntegrationConfigRecord | null> {
    return integrationCfg.getIntegrationConfig(this.exec, id);
  }
  public createIntegrationConfig(orgId: string, input: IntegrationConfigInput, createdBy?: string): Promise<IntegrationConfigRecord> {
    return integrationCfg.createIntegrationConfig(this.exec, orgId, input, createdBy);
  }
  public updateIntegrationConfig(id: string, patch: Partial<IntegrationConfigInput>): Promise<IntegrationConfigRecord | null> {
    return integrationCfg.updateIntegrationConfig(this.exec, id, patch);
  }
  public deleteIntegrationConfig(id: string): Promise<void> {
    return integrationCfg.deleteIntegrationConfig(this.exec, id);
  }
  public getResolvedIntegration(orgId: string, kind: IntegrationKind): Promise<ResolvedIntegration | null> {
    return integrationCfg.getResolvedIntegration(this.exec, orgId, kind);
  }
  public findIntegrationByInstallation(kind: IntegrationKind, installationId: string): Promise<(ResolvedIntegration & { orgId: string }) | null> {
    return integrationCfg.findIntegrationByInstallation(this.exec, kind, installationId);
  }

  // ── connectors (ADR-016 C2: per-user connector config + sealed OAuth token) ──
  public listConnectors(userId: string): Promise<ConnectorConfigRecord[]> { return connectorCfg.listConnectors(this.exec, userId); }
  public listAllEnabledConnectors(): Promise<ConnectorConfigRecord[]> { return connectorCfg.listAllEnabledConnectors(this.exec); }
  public getConnector(id: string): Promise<ConnectorConfigRecord | null> { return connectorCfg.getConnector(this.exec, id); }
  public getResolvedConnector(id: string): Promise<ResolvedConnector | null> { return connectorCfg.getResolvedConnector(this.exec, id); }
  public createConnector(userId: string, input: ConnectorConfigInput): Promise<ConnectorConfigRecord> { return connectorCfg.createConnector(this.exec, userId, input); }
  public updateConnector(id: string, patch: ConnectorConfigPatch): Promise<ConnectorConfigRecord | null> { return connectorCfg.updateConnector(this.exec, id, patch); }
  public deleteConnector(id: string): Promise<void> { return connectorCfg.deleteConnector(this.exec, id); }
  public getResolvedOAuthApp(orgId: string, source: string): Promise<ResolvedOAuthApp | null> { return connectorCfg.getResolvedOAuthApp(this.exec, orgId, source); }
  public upsertOAuthApp(orgId: string, source: string, clientId: string, clientSecret: string | undefined, scopes?: string): Promise<OAuthAppConfig> { return connectorCfg.upsertOAuthApp(this.exec, orgId, source, clientId, clientSecret, scopes); }

  // ── sensory ────────────────────────────────────────────────────────────

  public upsertSensory(record: SensoryRecord): Promise<void> {
    return sensory.upsertSensory(this.exec, record);
  }

  public getRecentSensoryMessages(userId: string, sessionKey: string, limit: number, afterIsoTime = ""): Promise<SensoryRecord[]> {
    return sensory.getRecentSensoryMessages(this.exec, userId, sessionKey, limit, afterIsoTime);
  }

  public getUnextractedSensoryCount(userId: string, sessionKey: string): Promise<number> {
    return sensory.getUnextractedSensoryCount(this.exec, userId, sessionKey);
  }

  public markSensoryExtracted(userId: string, sessionKey: string, recordIds: string[], extractedAt = new Date().toISOString()): Promise<void> {
    return sensory.markSensoryExtracted(this.exec, userId, sessionKey, recordIds, extractedAt);
  }

  // ── cognitive ──────────────────────────────────────────────────────────

  public upsertCognitiveBatch(entries: Array<{ record: CognitiveRecord; embedding?: Float32Array }>, options?: { skipAudit?: boolean }): Promise<void> {
    return cognitive.upsertCognitiveBatch(this.exec, this.vecReady, entries, options);
  }

  public upsertCognitive(record: CognitiveRecord, options?: { skipAudit?: boolean }): Promise<void> {
    return cognitive.upsertCognitive(this.exec, record, options);
  }

  public invalidateCognitiveRecord(userId: string, recordId: string, supersededById: string): Promise<void> {
    return cognitive.invalidateCognitiveRecord(this.exec, userId, recordId, supersededById);
  }

  public getMemoryById(userId: string, recordId: string): Promise<CognitiveRecord | null> {
    return cognitive.getMemoryById(this.exec, userId, recordId);
  }

  public getMemoriesByFilePath(userId: string, filePath: string, limit: number): Promise<CognitiveRecord[]> {
    return cognitive.getMemoriesByFilePath(this.exec, userId, filePath, limit);
  }

  public findLessonByFingerprint(userId: string, fingerprint: string): Promise<CognitiveRecord | null> {
    return cognitive.findLessonByFingerprint(this.exec, userId, fingerprint);
  }

  public findLessonsByConflictKey(userId: string, conflictKey: string): Promise<CognitiveRecord[]> {
    return cognitive.findLessonsByConflictKey(this.exec, userId, conflictKey);
  }

  public listLessonsForHygiene(userId: string, limit: number): Promise<CognitiveRecord[]> {
    return cognitive.listLessonsForHygiene(this.exec, userId, limit);
  }

  public updateCognitiveConfidence(userId: string, recordId: string, confidence: number, status: MemoryStatus): Promise<void> {
    return cognitive.updateCognitiveConfidence(this.exec, userId, recordId, confidence, status);
  }

  // ── evidence + operations ───────────────────────────────────────────────

  public insertEvidence(ev: MemoryEvidence): Promise<void> {
    return operations.insertEvidence(this.exec, ev);
  }

  public getEvidenceByRecord(userId: string, recordId: string): Promise<MemoryEvidence[]> {
    return operations.getEvidenceByRecord(this.exec, userId, recordId);
  }

  public listEvidence(
    userId: string,
    filters?: EvidenceListFilters,
    pagination?: CursorPaginationOptions<{ observedAt: string; id: string }>,
  ): Promise<MemoryEvidence[]> {
    return operations.listEvidence(this.exec, userId, filters, pagination);
  }

  public insertOperation(op: MemoryOperation): Promise<void> {
    return operations.insertOperation(this.exec, op);
  }

  public getOperationLog(
    userId: string,
    options?: CursorPaginationOptions<{ createdAt: string; id: string }>,
    filters?: OperationLogFilters,
  ): Promise<MemoryOperation[]> {
    return operations.getOperationLog(this.exec, userId, options, filters);
  }

  public exportMemories(userId: string): Promise<MemoryExport> {
    return operations.exportMemories(this.exec, userId);
  }

  public importMemories(userId: string, data: MemoryImport): Promise<ImportResult> {
    return operations.importMemories(this.exec, userId, data);
  }

  public hardDeleteMemory(userId: string, recordId: string, reason: string): Promise<void> {
    return operations.hardDeleteMemory(this.exec, userId, recordId, reason);
  }

  // ── FTS (tsvector + GIN) ──────────────────────────────────────────────

  public searchCognitiveFts(userId: string, query: string, limit: number, orgId?: string): Promise<CognitiveFtsResult[]> {
    return search.searchCognitiveFts(this.exec, userId, query, limit, orgId);
  }

  public searchCognitiveFtsAsOf(userId: string, query: string, limit: number, asOf: string): Promise<CognitiveFtsResult[]> {
    return search.searchCognitiveFtsAsOf(this.exec, userId, query, limit, asOf);
  }

  // ── vector (pgvector) ────────────────────────────────────────────────

  public upsertCognitiveVec(recordId: string, embedding: Float32Array): Promise<void> {
    return search.upsertCognitiveVec(this.exec, this.vecCtx, recordId, embedding);
  }

  public searchCognitiveVec(userId: string, queryEmbedding: Float32Array, limit: number, orgId?: string): Promise<VectorSearchResult[]> {
    return search.searchCognitiveVec(this.exec, this.vecCtx, userId, queryEmbedding, limit, orgId);
  }

  // ── contradictions ───────────────────────────────────────────────────

  public upsertContradiction(data: {
    id: string; userId: string; recordIdA: string; recordIdB: string; reason: string; confidence: number; createdTime?: string;
  }): Promise<void> {
    return contradiction.upsertContradiction(this.exec, data);
  }

  public getPendingContradictions(userId: string, pagination?: CursorPaginationOptions<{ confidence: number; id: string }>, statusFilter: "pending" | "resolved" | "dismissed" | "all" = "pending"): Promise<ContradictionRecord[]> {
    return contradiction.getPendingContradictions(this.exec, userId, pagination, statusFilter);
  }

  public resolveContradiction(id: string, userId: string, status: "resolved" | "dismissed"): Promise<void> {
    return contradiction.resolveContradiction(this.exec, id, userId, status);
  }

  // ── skill hints / activations ───────────────────────────────────────────

  public upsertSkillHints(skillName: string, hints: string, sourceFile = ""): Promise<void> {
    return skillFocus.upsertSkillHints(this.exec, skillName, hints, sourceFile);
  }

  public listSkillHints(): Promise<SkillHintsRecord[]> {
    return skillFocus.listSkillHints(this.exec);
  }

  public getSkillHints(skillName: string): Promise<string | null> {
    return skillFocus.getSkillHints(this.exec, skillName);
  }

  public getSkillActivations(userId: string): Promise<SkillActivationRecord[]> {
    return skillFocus.getSkillActivations(this.exec, userId);
  }

  public upsertSkillActivations(userId: string, activations: SkillActivationRecord[]): Promise<void> {
    return skillFocus.upsertSkillActivations(this.exec, userId, activations);
  }

  // ── contextual focus ───────────────────────────────────────────────────

  public upsertContextualFocus(record: ContextualFocusRecord): Promise<void> {
    return skillFocus.upsertContextualFocus(this.exec, record);
  }

  public getTopContextualFocus(userId: string, limit = 3, cursor?: { heatScore: number; id: string }): Promise<ContextualFocusRecord[]> {
    return skillFocus.getTopContextualFocus(this.exec, userId, limit, cursor);
  }

  public decayContextualFocusHeatScores(userId: string, decayFactor = 0.95): Promise<void> {
    return skillFocus.decayContextualFocusHeatScores(this.exec, userId, decayFactor);
  }

  public boostContextualFocusHeatScore(userId: string, sceneName: string, boost = 20): Promise<void> {
    return skillFocus.boostContextualFocusHeatScore(this.exec, userId, sceneName, boost);
  }

  public getCognitivesByFocus(userId: string, sceneName: string, limit = 30): Promise<any[]> {
    return skillFocus.getCognitivesByFocus(this.exec, userId, sceneName, limit);
  }

  public getContextualFocusCount(userId: string): Promise<number> {
    return skillFocus.getContextualFocusCount(this.exec, userId);
  }

  public getColdContextualFocus(userId: string, limit: number): Promise<ContextualFocusRecord[]> {
    return skillFocus.getColdContextualFocus(this.exec, userId, limit);
  }

  public deleteContextualFocus(userId: string, sceneIds: string[]): Promise<void> {
    return skillFocus.deleteContextualFocus(this.exec, userId, sceneIds);
  }

  public getContextualFocusByName(userId: string, sceneName: string): Promise<ContextualFocusRecord | null> {
    return skillFocus.getContextualFocusByName(this.exec, userId, sceneName);
  }

  public getDistinctSceneNames(userId: string): Promise<string[]> {
    return skillFocus.getDistinctSceneNames(this.exec, userId);
  }

  public renameFocusInCognitiveRecords(userId: string, oldName: string, canonicalName: string): Promise<void> {
    return skillFocus.renameFocusInCognitiveRecords(this.exec, userId, oldName, canonicalName);
  }

  // ── workspace / project tags ─────────────────────────────────────────────

  public getWorkspaceTagsByRecordIds(userId: string, recordIds: string[]): Promise<Map<string, string | null>> {
    return skillFocus.getWorkspaceTagsByRecordIds(this.exec, userId, recordIds);
  }

  public getProjectTagsByRecordIds(userId: string, recordIds: string[]): Promise<Map<string, string | null>> {
    return skillFocus.getProjectTagsByRecordIds(this.exec, userId, recordIds);
  }

  // ── active sessions (federation) ─────────────────────────────────────────

  public registerActiveSession(record: ActiveSessionRecord): Promise<ActiveSessionRecord> {
    return session.registerActiveSession(this.exec, record);
  }

  public heartbeatActiveSession(userId: string, sessionKey: string, at: string, usage?: ActiveSessionUsage | null): Promise<boolean> {
    return session.heartbeatActiveSession(this.exec, userId, sessionKey, at, usage);
  }

  public listActiveSessions(filters: ActiveSessionFilters): Promise<ActiveSessionRecord[]> {
    return session.listActiveSessions(this.exec, filters);
  }

  public unregisterActiveSession(userId: string, sessionKey: string): Promise<boolean> {
    return session.unregisterActiveSession(this.exec, userId, sessionKey);
  }

  public sweepActiveSessions(olderThanMs: number): Promise<number> {
    return session.sweepActiveSessions(this.exec, olderThanMs);
  }

  // ── session inbox (federation) ───────────────────────────────────────────

  public sendSessionMessage(
    record: Omit<SessionInboxRecord, "id" | "createdAt" | "deliveredAt">,
    options?: { idGenerator?: () => string; now?: string },
  ): Promise<SessionInboxRecord[]> {
    return session.sendSessionMessage(this.exec, record, options);
  }

  public readSessionInbox(filters: SessionInboxFilters): Promise<SessionInboxRecord[]> {
    return session.readSessionInbox(this.exec, filters);
  }

  public ackSessionInbox(userId: string, toSessionKey: string, ids: string[], at: string): Promise<number> {
    return session.ackSessionInbox(this.exec, userId, toSessionKey, ids, at);
  }

  public sweepSessionInbox(olderThanMs: number): Promise<number> {
    return session.sweepSessionInbox(this.exec, olderThanMs);
  }

  // ── pending delegations (federation) ─────────────────────────────────────

  public enqueuePendingDelegation(input: PendingDelegationEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<PendingDelegationRecord> {
    return session.enqueuePendingDelegation(this.exec, input, options);
  }

  public listPendingDelegations(filters: PendingDelegationFilters): Promise<PendingDelegationRecord[]> {
    return session.listPendingDelegations(this.exec, filters);
  }

  public claimPendingDelegation(userId: string, toAgentKind: string, toSessionKey: string, at: string): Promise<PendingDelegationRecord | null> {
    return session.claimPendingDelegation(this.exec, userId, toAgentKind, toSessionKey, at);
  }

  // ── memory jobs queue (BRAIN-P1) ─────────────────────────────────────────

  public enqueueMemoryJob(input: MemoryJobEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<MemoryJobRecord> {
    return job.enqueueMemoryJob(this.exec, input, options);
  }

  public getMemoryJob(id: string): Promise<MemoryJobRecord | null> {
    return job.getMemoryJob(this.exec, id);
  }

  public listMemoryJobs(filters?: MemoryJobListFilters): Promise<MemoryJobRecord[]> {
    return job.listMemoryJobs(this.exec, filters);
  }

  public appendJobProgress(id: string, event: import("@kinqs/brainrouter-types").MemoryJobProgressEvent): Promise<void> {
    return job.appendJobProgress(this.exec, id, event);
  }

  /** ADR-017 D5 — recent PR-review jobs for an org's Reviews dashboard (newest-first). */
  public listReviewJobsForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]> {
    return job.listReviewJobsForOrg(this.exec, orgId, limit);
  }
  public listPentestJobsForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]> { return job.listPentestJobsForOrg(this.exec, orgId, limit); }

  public createPentestTarget(orgId: string, createdBy: string, input: PentestTargetInput): Promise<PentestTargetRecord> { return pentestTargets.createPentestTarget(this.exec, orgId, createdBy, input); }
  public getPentestTarget(id: string): Promise<PentestTargetRecord | null> { return pentestTargets.getPentestTarget(this.exec, id); }
  public listPentestTargets(orgId: string): Promise<PentestTargetRecord[]> { return pentestTargets.listPentestTargets(this.exec, orgId); }
  public deletePentestTarget(orgId: string, id: string): Promise<boolean> { return pentestTargets.deletePentestTarget(this.exec, orgId, id); }

  public claimNextMemoryJob(options?: { now?: string }): Promise<MemoryJobRecord | null> {
    return job.claimNextMemoryJob(this.exec, options);
  }

  public startMemoryJob(id: string, options?: { now?: string }): Promise<MemoryJobRecord | null> {
    return job.startMemoryJob(this.exec, id, options);
  }

  public completeMemoryJob(id: string, output: unknown, options?: { now?: string }): Promise<MemoryJobRecord | null> {
    return job.completeMemoryJob(this.exec, id, output, options);
  }

  public failMemoryJob(id: string, error: string, options?: { now?: string; backoffMs?: number }): Promise<MemoryJobRecord | null> {
    return job.failMemoryJob(this.exec, id, error, options);
  }

  public retryMemoryJob(id: string, options?: { now?: string }): Promise<MemoryJobRecord | null> {
    return job.retryMemoryJob(this.exec, id, options);
  }

  public cancelMemoryJob(id: string, options?: { now?: string; reason?: string }): Promise<MemoryJobRecord | null> {
    return job.cancelMemoryJob(this.exec, id, options);
  }

  public sweepStuckMemoryJobs(stuckMs: number, options?: { now?: string }): Promise<number> {
    return job.sweepStuckMemoryJobs(this.exec, stuckMs, options);
  }

  public getMemoryJobKindAggregates(options?: { now?: string }): Promise<MemoryJobKindAggregate[]> {
    return job.getMemoryJobKindAggregates(this.exec, options);
  }

  // ── compression cache (CCR) ──────────────────────────────────────────────

  public storeCompressionEntry(input: CompressionEntryInput): Promise<CompressionEntryMetadata> {
    return compression.storeCompressionEntry(this.exec, this.ccrCtx, input);
  }

  public retrieveCompressionEntry(userId: string, hash: string, query?: string): Promise<CompressionRetrieval | null> {
    return compression.retrieveCompressionEntry(this.exec, this.ccrCtx, userId, hash, query);
  }

  public getCompressionEntryMetadata(userId: string, hash: string): Promise<CompressionEntryMetadata | null> {
    return compression.getCompressionEntryMetadata(this.exec, userId, hash);
  }

  public getCompressionStats(userId: string): Promise<CompressionStats> {
    return compression.getCompressionStats(this.exec, this.ccrCtx, userId);
  }

  // ── core identity ─────────────────────────────────────────────────────

  public upsertCoreIdentity(record: CoreIdentityRecord): Promise<void> {
    return atlasIdentity.upsertCoreIdentity(this.exec, record);
  }

  public getCoreIdentity(userId: string): Promise<CoreIdentityRecord | null> {
    return atlasIdentity.getCoreIdentity(this.exec, userId);
  }

  // ── Atlas graph persistence (REMOTE-BRAIN Phase 3) ──────────────────────

  public putAtlasGraph(userId: string, workspaceTag: string, graph: AtlasGraph): Promise<void> {
    return atlasIdentity.putAtlasGraph(this.exec, userId, workspaceTag, graph);
  }

  public getAtlasGraph(userId: string, workspaceTag: string): Promise<AtlasGraph | null> {
    return atlasIdentity.getAtlasGraph(this.exec, userId, workspaceTag);
  }

  public listAtlasWorkspaces(userId: string): Promise<AtlasWorkspaceSummary[]> {
    return atlasIdentity.listAtlasWorkspaces(this.exec, userId);
  }

  public putFleetSnapshot(userId: string, host: string, snapshot: unknown, jobCount: number): Promise<void> {
    return atlasIdentity.putFleetSnapshot(this.exec, userId, host, snapshot, jobCount);
  }

  public getFleetSnapshots(userId: string): Promise<FleetSnapshotEntry[]> {
    return atlasIdentity.getFleetSnapshots(this.exec, userId);
  }

  public getIdentityAndInstructionCognitives(userId: string, limit = 100): Promise<any[]> {
    return atlasIdentity.getIdentityAndInstructionCognitives(this.exec, userId, limit);
  }

  // ── scheduler state ───────────────────────────────────────────────────

  public getSchedulerState(userId: string): Promise<SchedulerState> {
    return atlasIdentity.getSchedulerState(this.exec, userId);
  }

  public incrementSchedulerCognitiveCount(userId: string, count: number): Promise<void> {
    return atlasIdentity.incrementSchedulerCognitiveCount(this.exec, userId, count);
  }

  public resetSchedulerFocusCount(userId: string): Promise<void> {
    return atlasIdentity.resetSchedulerFocusCount(this.exec, userId);
  }

  public resetSchedulerIdentityCount(userId: string): Promise<void> {
    return atlasIdentity.resetSchedulerIdentityCount(this.exec, userId);
  }

  public recordExtractionFailure(userId: string, message: string): Promise<void> {
    return atlasIdentity.recordExtractionFailure(this.exec, userId, message);
  }

  public resetExtractionFailures(userId: string): Promise<void> {
    return atlasIdentity.resetExtractionFailures(this.exec, userId);
  }

  public getExtractionStatus(userId: string): Promise<ExtractionStatus> {
    return atlasIdentity.getExtractionStatus(this.exec, userId);
  }

  public sweepUnextractedBacklog(options: { olderThanMs: number; minUnextracted?: number; maxFailures?: number; limit?: number }): Promise<StalledExtractionBacklog[]> {
    return atlasIdentity.sweepUnextractedBacklog(this.exec, options);
  }

  // ── graph (nodes + edges) ─────────────────────────────────────────────

  public getAllGraphNodes(userId: string): Promise<GraphNode[]> {
    return graph.getAllGraphNodes(this.exec, userId);
  }

  public getAllGraphEdges(userId: string): Promise<GraphEdge[]> {
    return graph.getAllGraphEdges(this.exec, userId);
  }

  public upsertGraphNode(node: GraphNode): Promise<void> {
    return graph.upsertGraphNode(this.exec, node);
  }

  public upsertGraphEdge(edge: GraphEdge): Promise<void> {
    return graph.upsertGraphEdge(this.exec, edge);
  }

  public getGraphNodeByEntity(userId: string, entity: string): Promise<GraphNode | null> {
    return graph.getGraphNodeByEntity(this.exec, userId, entity);
  }

  public getGraphNeighbors(userId: string, entityId: string, skillTag?: string, maxHops = 2): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return graph.getGraphNeighbors(this.exec, userId, entityId, skillTag, maxHops);
  }

  // ── ACE feedback loop ──────────────────────────────────────────────────

  public markCited(userId: string, recordIds: string[]): Promise<void> {
    return cognitive.markCited(this.exec, userId, recordIds);
  }

  public incrementNeverCited(userId: string, recordIds: string[]): Promise<{ recordId: string; neverCitedCount: number }[]> {
    return cognitive.incrementNeverCited(this.exec, userId, recordIds);
  }

  public archiveCognitiveRecord(userId: string, recordId: string): Promise<void> {
    return cognitive.archiveCognitiveRecord(this.exec, userId, recordId);
  }

  public getRecentSkillContextCognitives(userId: string, limit: number): Promise<{ skillTag: string; createdTime: string }[]> {
    return cognitive.getRecentSkillContextCognitives(this.exec, userId, limit);
  }

  // ── users ──────────────────────────────────────────────────────────────

  public createUser(userId: string, apiKey: string, displayName = "", isAdmin = false): Promise<UserRecord> {
    return userStats.createUser(this.exec, userId, apiKey, displayName, isAdmin);
  }

  public getUserByApiKey(apiKey: string): Promise<UserRecord | null> {
    return userStats.getUserByApiKey(this.exec, apiKey);
  }

  public getUserByEmail(email: string): Promise<UserRecord | null> {
    return userStats.getUserByEmail(this.exec, email);
  }

  public getUserById(userId: string): Promise<UserRecord | null> {
    return userStats.getUserById(this.exec, userId);
  }

  public updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    return userStats.updateUserPassword(this.exec, userId, passwordHash);
  }
  public updateUserEmail(userId: string, email: string): Promise<void> {
    return userStats.updateUserEmail(this.exec, userId, email);
  }
  public updateUserDisplayName(userId: string, displayName: string): Promise<void> {
    return userStats.updateUserDisplayName(this.exec, userId, displayName);
  }
  public updateUserStatus(userId: string, status: "active" | "disabled"): Promise<void> {
    return userStats.updateUserStatus(this.exec, userId, status);
  }
  public updateUserApiKey(userId: string, apiKey: string): Promise<void> {
    return userStats.updateUserApiKey(this.exec, userId, apiKey);
  }

  public listUsers(pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): Promise<UserRecord[]> {
    return userStats.listUsers(this.exec, pagination);
  }

  public deleteUser(userId: string): Promise<void> {
    return userStats.deleteUser(this.exec, userId);
  }

  // ── list + stats ─────────────────────────────────────────────────────

  public listMemories(
    userId: string,
    filters?: MemoryListFilters,
    pagination?: CursorPaginationOptions<{ createdTime: string; recordId: string }>,
  ): Promise<MemoryListItem[]> {
    return userStats.listMemories(this.exec, userId, filters, pagination);
  }

  public getMemoryStats(userId: string): Promise<{
    total: number; archived: number; byType: Record<string, number>; citationRate: number;
    lastRecallAt: string | null; sensoryTotal: number; sensoryUnextracted: number;
    focusSceneTotal: number; extraction: ExtractionStatus;
  }> {
    return userStats.getMemoryStats(this.exec, userId);
  }

  // ── dendritic connections ───────────────────────────────────────────────

  public upsertConnection(userId: string, sourceId: string, targetId: string, weight: number): Promise<void> {
    return userStats.upsertConnection(this.exec, userId, sourceId, targetId, weight);
  }

  public getConnectionsForSource(userId: string, sourceId: string): Promise<Array<{ targetId: string; weight: number }>> {
    return userStats.getConnectionsForSource(this.exec, userId, sourceId);
  }

  public strengthenConnectionsBatch(userId: string, pairs: Array<{ source: string; target: string }>, delta: number): Promise<void> {
    return userStats.strengthenConnectionsBatch(this.exec, userId, pairs, delta);
  }

  public decayConnections(userId: string, decayFactor: number): Promise<void> {
    return userStats.decayConnections(this.exec, userId, decayFactor);
  }

  public pruneConnections(userId: string, threshold: number): Promise<void> {
    return userStats.pruneConnections(this.exec, userId, threshold);
  }

  public getAllConnections(userId: string): Promise<Array<{ sourceId: string; targetId: string; weight: number; lastActivatedAt: string }>> {
    return userStats.getAllConnections(this.exec, userId);
  }

  // ── source documents + chunks ───────────────────────────────────────────

  public getSourceDocumentByHash(userId: string, hash: string): Promise<SourceDocument | null> {
    return sourcesTree.getSourceDocumentByHash(this.exec, userId, hash);
  }

  public getSourceDocument(id: string): Promise<SourceDocument | null> {
    return sourcesTree.getSourceDocument(this.exec, id);
  }

  public hasFreshSourceDocument(userId: string, uri: string): Promise<boolean> {
    return sourcesTree.hasFreshSourceDocument(this.exec, userId, uri);
  }

  public setSourceDocumentChurn(documentId: string, commitCount90d: number | null, lastCommitDate: string | null): Promise<void> {
    return sourcesTree.setSourceDocumentChurn(this.exec, documentId, commitCount90d, lastCommitDate);
  }

  public getRecordsMaxChurn(userId: string, recordIds: string[]): Promise<Map<string, number>> {
    return sourcesTree.getRecordsMaxChurn(this.exec, userId, recordIds);
  }

  public getSourceDocuments(userId: string, limit = 100): Promise<Array<SourceDocument & { chunkCount: number }>> {
    return sourcesTree.getSourceDocuments(this.exec, userId, limit);
  }

  public pruneTranscriptSources(userId: string, beforeIso: string): Promise<{ prunedDocs: number; prunedChunks: number }> {
    return sourcesTree.pruneTranscriptSources(this.exec, userId, beforeIso);
  }

  public createSourceDocument(input: Omit<SourceDocument, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<SourceDocument> {
    return sourcesTree.createSourceDocument(this.exec, input);
  }

  public lookupDocumentByPathHash(userId: string, uri: string, hash: string): Promise<{ id: string; stale: boolean } | null> {
    return sourcesTree.lookupDocumentByPathHash(this.exec, userId, uri, hash);
  }

  public markSourceDocumentsStaleByPath(userId: string, uri: string): Promise<number> {
    return sourcesTree.markSourceDocumentsStaleByPath(this.exec, userId, uri);
  }

  public reviveSourceDocument(documentId: string): Promise<void> {
    return sourcesTree.reviveSourceDocument(this.exec, documentId);
  }

  public findImportedDocument(userId: string, candidateBase: string): Promise<SourceDocument | null> {
    return sourcesTree.findImportedDocument(this.exec, userId, candidateBase);
  }

  public addSourceChunks(documentId: string, chunks: SourceChunkInput[]): Promise<SourceChunk[]> {
    return sourcesTree.addSourceChunks(this.exec, documentId, chunks);
  }

  public getSourceChunk(id: string): Promise<SourceChunk | null> {
    return sourcesTree.getSourceChunk(this.exec, id);
  }

  public getSourceChunksByDocument(documentId: string): Promise<SourceChunk[]> {
    return sourcesTree.getSourceChunksByDocument(this.exec, documentId);
  }

  public getSourceChunkByFileLine(userId: string, filePath: string, line: number): Promise<SourceChunk | null> {
    return sourcesTree.getSourceChunkByFileLine(this.exec, userId, filePath, line);
  }

  public searchSourceChunksFts(
    userId: string,
    query: string,
    limit: number,
    opts?: { excludeChunkId?: string; excludeDocumentId?: string; filePathLike?: string[] },
  ): Promise<Array<SourceChunk & { ftsRank: number }>> {
    return sourcesTree.searchSourceChunksFts(this.exec, userId, query, limit, opts);
  }

  public isSourceDocumentReferenced(documentId: string): Promise<boolean> {
    return sourcesTree.isSourceDocumentReferenced(this.exec, documentId);
  }

  public replaceSourceChunks(documentId: string, chunks: SourceChunkInput[]): Promise<SourceChunk[]> {
    return sourcesTree.replaceSourceChunks(this.exec, documentId, chunks);
  }

  public getCodeEdgeNeighbors(userId: string, chunkId: string, direction: "callees" | "callers"): Promise<SourceChunk[]> {
    return sourcesTree.getCodeEdgeNeighbors(this.exec, userId, chunkId, direction);
  }

  public linkRecordSources(userId: string, recordId: string, chunkIds: string[]): Promise<void> {
    return sourcesTree.linkRecordSources(this.exec, userId, recordId, chunkIds);
  }

  public getStorageGovernanceStats(userId: string): Promise<{
    sourceDocuments: number;
    sourceChunks: { count: number; chars: number; orphanCount: number; orphanChars: number };
    treeNodes: { count: number; chars: number };
    vaultExports: number;
  }> {
    return sourcesTree.getStorageGovernanceStats(this.exec, userId);
  }

  public getRecordSourceChunks(userId: string, recordId: string): Promise<SourceChunk[]> {
    return sourcesTree.getRecordSourceChunks(this.exec, userId, recordId);
  }

  public isRecordSourceStale(userId: string, recordId: string): Promise<boolean> {
    return sourcesTree.isRecordSourceStale(this.exec, userId, recordId);
  }

  // ── blackboard ─────────────────────────────────────────────────────────

  public stageBlackboardItems(userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]> {
    return sourcesTree.stageBlackboardItems(this.exec, userId, items);
  }

  public getBlackboardItem(id: string): Promise<BlackboardItem | null> {
    return sourcesTree.getBlackboardItem(this.exec, id);
  }

  public getBlackboardItems(userId: string, status?: BlackboardStatus): Promise<BlackboardItem[]> {
    return sourcesTree.getBlackboardItems(this.exec, userId, status);
  }

  public updateBlackboardItem(
    id: string,
    patch: { status?: BlackboardStatus; score?: number; conflictIds?: string[]; committedRecordId?: string | null },
  ): Promise<void> {
    return sourcesTree.updateBlackboardItem(this.exec, id, patch);
  }

  // ── memory tree ─────────────────────────────────────────────────────────

  public getTreeNodeIdByChunkId(userId: string, chunkId: string): Promise<string | null> {
    return sourcesTree.getTreeNodeIdByChunkId(this.exec, userId, chunkId);
  }

  public appendTreeNode(userId: string, input: MemoryTreeNodeInput): Promise<MemoryTreeNode> {
    return sourcesTree.appendTreeNode(this.exec, userId, input);
  }

  public getDistinctScenes(userId: string): Promise<Array<{ sceneName: string; recordCount: number }>> {
    return sourcesTree.getDistinctScenes(this.exec, userId);
  }

  public getSceneLeafKeys(userId: string): Promise<string[]> {
    return sourcesTree.getSceneLeafKeys(this.exec, userId);
  }

  public getSceneRecordContents(userId: string, sceneName: string, limit = 8): Promise<string[]> {
    return sourcesTree.getSceneRecordContents(this.exec, userId, sceneName, limit);
  }

  public getUnsealedSceneLeaves(userId: string, limit = 50): Promise<MemoryTreeNode[]> {
    return sourcesTree.getUnsealedSceneLeaves(this.exec, userId, limit);
  }

  public getTreeNode(id: string): Promise<MemoryTreeNode | null> {
    return sourcesTree.getTreeNode(this.exec, id);
  }

  public getTreeChildren(parentId: string): Promise<MemoryTreeNode[]> {
    return sourcesTree.getTreeChildren(this.exec, parentId);
  }

  public getTreeRoots(userId: string, kind?: MemoryTreeKind): Promise<MemoryTreeNode[]> {
    return sourcesTree.getTreeRoots(this.exec, userId, kind);
  }

  public setTreeParent(childIds: string[], parentId: string): Promise<void> {
    return sourcesTree.setTreeParent(this.exec, childIds, parentId);
  }

  public sealTreeNode(id: string): Promise<void> {
    return sourcesTree.sealTreeNode(this.exec, id);
  }

  public updateTreeNodeSummary(id: string, summaryMd: string): Promise<void> {
    return sourcesTree.updateTreeNodeSummary(this.exec, id, summaryMd);
  }

  public getAllTreeNodes(userId: string): Promise<MemoryTreeNode[]> {
    return sourcesTree.getAllTreeNodes(this.exec, userId);
  }

  // ── vault export ledger ──────────────────────────────────────────────────

  public upsertVaultExport(userId: string, input: VaultExportInput): Promise<void> {
    return sourcesTree.upsertVaultExport(this.exec, userId, input);
  }

  public getVaultExports(userId: string): Promise<VaultExportEntry[]> {
    return sourcesTree.getVaultExports(this.exec, userId);
  }
}
