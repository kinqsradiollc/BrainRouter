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
import type { AssessmentEvidenceCleanupResult } from "@kinqs/brainrouter-types/review";
import { createPgPool } from "./connection.js";
import { loadMigrations, applyMigrations, withSchemaLock } from "./migrate.js";
import {
  asNumber,
  type CompressionEntryInput,
  type CompressionEntryMetadata,
  type CompressionRetrieval,
  type CompressionStats,
} from "./converters.js";
import { mapWithConcurrency, readEmbedConcurrency } from "../../util/concurrency.js";
import type { Executor } from "./queries/executor.js";
import type { KnowledgeBaseRecord, UpdateKnowledgeBaseInput } from "../../../knowledge/contracts/base.js";
import type {
  KnowledgeChunkEmbeddingInput,
  KnowledgeChunkInput,
  KnowledgeChunkRecord,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDerivedDocumentInput,
  KnowledgeDerivedDocumentResult,
  KnowledgeDocumentListFilters,
  KnowledgeDocumentProcessingRecord,
  KnowledgeDocumentRecord,
  KnowledgeDocumentRetryRecord,
  KnowledgeDocumentStatusUpdate,
  KnowledgeParseCommitResult,
  KnowledgeParseJobInput,
} from "../../../knowledge/contracts/document.js";
import type {
  KnowledgeLexicalSearchHit,
  KnowledgeSearchScope,
  KnowledgeVectorSearchHit,
  KnowledgeVectorSearchInput,
} from "../../../knowledge/contracts/search.js";
import type { VecContext } from "./queries/searchQueries.js";
import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_ENTRIES,
  type CcrContext,
} from "./queries/compressionQueries.js";
import * as sensory from "./queries/sensoryQueries.js";
import * as meetings from "./queries/meetingsQueries.js";
import * as track from "./queries/trackQueries.js";
import * as planner from "./queries/plannerQueries.js";
import * as notes from "./queries/notesQueries.js";
import * as teams from "./queries/teamsQueries.js";
import * as chatThreads from "./queries/chatThreadsQueries.js";
import * as vulnerability from "./queries/vulnerabilityQueries.js";
import * as vulnScans from "./queries/vulnerabilityScanQueries.js";
import * as cognitive from "./queries/cognitiveQueries.js";
import * as learnedBehavior from "./queries/learnedBehaviorQueries.js";
import * as hostedLearning from "./queries/hostedLearningQueries.js";
import * as operations from "./queries/operationsQueries.js";
import * as search from "./queries/searchQueries.js";
import * as contradiction from "./queries/contradictionQueries.js";
import * as skillFocus from "./queries/skillFocusQueries.js";
import * as session from "./queries/sessionQueries.js";
import * as job from "./queries/jobQueries.js";
import * as retention from "./queries/retentionQueries.js";
import * as assurance from "./queries/assuranceQueries.js";
import * as assessmentEvidence from "./queries/assessmentEvidenceQueries.js";
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
import * as knowledgeBases from "./queries/knowledgeBaseQueries.js";
import * as knowledgeDocuments from "./queries/knowledgeDocumentQueries.js";
import * as knowledgeSearch from "./queries/knowledgeSearchQueries.js";
import * as adminConsole from "./queries/adminConsoleQueries.js";
import * as providerCfg from "./queries/providerConfigQueries.js";
import * as modelPolicy from "./queries/modelPolicyQueries.js";
import * as remoteAccess from "./queries/remoteAccessQueries.js";
import * as remoteControl from "./queries/remoteControlQueries.js";
import * as integrationCfg from "./queries/integrationConfigQueries.js";
import * as connectorCfg from "./queries/connectorConfigQueries.js";
import * as pentestTargets from "./queries/pentestTargetQueries.js";
import type { TenancyStore } from "../../../tenancy/store.js";
import type { Role } from "../../../tenancy/rbac.js";
import type { OrganizationRecord, OrgMemberRecord, OrgMembership, OrgPlan } from "../../../tenancy/types.js";
import type { ProviderStore } from "../../../providers/store.js";
import type { ProviderConfigRecord, ProviderConfigInput, ProviderKind, ResolvedProviderConfig } from "../../../providers/types.js";
import type {
  ModelPolicyStore,
  ProviderModelInput,
  ProviderModelPatch,
  ProviderModelRecord,
} from "../../../providers/modelPolicyStore.js";
import type {
  DeviceSessionInput,
  DeviceSessionRecord,
  DeviceSessionRotationInput,
  DeviceSessionRotationResult,
  RemoteAccessAuditInput,
  RemoteAccessAuditRecord,
  RemoteAccessGrantInput,
  RemoteAccessGrantRecord,
  RemoteAccessStore,
  RemoteDeviceInput,
  RemoteDeviceKind,
  RemoteDeviceRecord,
  RemoteEnrollmentChallengeInput,
  RemoteEnrollmentChallengeRecord,
  RemoteGrantDecision,
  RemoteRelayTicketInput,
  RemoteRelayTicketRecord,
  RemoteRelayTicketRevocation,
} from "../../../remote/store.js";
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

export class PostgresMemoryStore implements IMemoryStore, TenancyStore, ProviderStore, ModelPolicyStore, RemoteAccessStore, IntegrationStore, ConnectorStore {
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
      initVec: (dimensions, opts) => this.initVec(dimensions, opts),
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
    await job.backfillReviewLifecycle(this.exec);
  }

  public async initVec(dimensions: number, opts?: { allowRebuild?: boolean }): Promise<void> {
    if (dimensions <= 0) return;
    // Serialize this DDL with migrations across processes (see withSchemaLock):
    // CREATE TABLE IF NOT EXISTS embedding_meta / cognitive_vec race the same way
    // migrations do when two boots overlap.
    //
    // allowRebuild (default true): the WRITE path passes a CONFIRMED embedding
    // length and MAY drop+recreate cognitive_vec on a genuine dimension change
    // (an embedder swap → the old vectors are the wrong width and get re-embedded).
    // BOOT passes allowRebuild:false — it must NEVER drop on a *guessed* dimension,
    // so the existing store's width is adopted as-is and stored vectors are safe
    // even when the boot hint is stale.
    const allowRebuild = opts?.allowRebuild ?? true;
    const effectiveDim = await withSchemaLock(this.pool, () => this.initVecLocked(dimensions, allowRebuild));
    this.vecDimensions = effectiveDim;
    this.vecReady = true;
  }

  private async initVecLocked(dimensions: number, allowRebuild: boolean): Promise<number> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        id integer PRIMARY KEY CHECK (id = 1),
        dimensions integer NOT NULL,
        created_at text NOT NULL
      )
    `);

    // Read the EXISTING cognitive_vec column dimension. pgvector stores the
    // declared dimension verbatim in atttypmod (NO varlena +4 header: a
    // `vector(768)` column has atttypmod = 768; an undimensioned `vector` column
    // has atttypmod = -1). NULLIF(...,-1) maps the latter to NULL.
    const dimRow = await this.one<{ dim: number | null }>(
      `SELECT NULLIF(a.atttypmod, -1) AS dim
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'cognitive_vec' AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped`,
    );
    const existingDim = dimRow && dimRow.dim != null ? asNumber(dimRow.dim, -1) : -1;
    const metaRow = await this.one<{ dimensions: number }>("SELECT dimensions FROM embedding_meta WHERE id = 1");
    const metaDim = metaRow ? asNumber(metaRow.dimensions, -1) : -1;

    // Effective dimension. On the write path the passed length is authoritative.
    // On boot we ADOPT what already exists (the live column, else the recorded
    // meta) and only fall back to the passed default for a truly fresh store —
    // so a stale boot hint can never drop a populated cognitive_vec.
    const effectiveDim = allowRebuild
      ? dimensions
      : (existingDim > 0 ? existingDim : (metaDim > 0 ? metaDim : dimensions));

    // Destructive rebuild ONLY when a real, differing dimension is confirmed.
    if (existingDim > 0 && existingDim !== effectiveDim) {
      await this.pool.query("DROP TABLE IF EXISTS cognitive_vec");
    }
    if (metaDim !== effectiveDim) {
      await this.run(
        `INSERT INTO embedding_meta (id, dimensions, created_at) VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET dimensions = EXCLUDED.dimensions, created_at = EXCLUDED.created_at`,
        [effectiveDim, new Date().toISOString()],
      );
    }

    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS cognitive_vec (
         record_id text PRIMARY KEY,
         embedding vector(${effectiveDim})
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

    return effectiveDim;
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
  public setMemoryVisibility(recordId: string, userId: string, orgId: string, visibility: "private" | "team" | "org", teamId?: string | null): Promise<boolean> { return sharing.setMemoryVisibility(this.exec, recordId, userId, orgId, visibility, teamId); }
  public listOrgSharedMemories(orgId: string, limit = 50): Promise<sharing.SharedMemory[]> { return sharing.listOrgSharedMemories(this.exec, orgId, limit); }

  // ── projects + per-project access (ADR-014 P-E) ──────────────────────────
  public createProject(rec: projects.ProjectRecord): Promise<void> { return projects.createProject(this.exec, rec); }
  public getProject(projectId: string): Promise<projects.ProjectRecord | null> { return projects.getProject(this.exec, projectId); }
  public getAccessibleProject(projectId: string, orgId: string, userId: string, canAccessRestricted: boolean): Promise<projects.ProjectRecord | null> { return projects.getAccessibleProject(this.exec, projectId, orgId, userId, canAccessRestricted); }
  public countProjects(orgId: string): Promise<number> { return projects.countProjects(this.exec, orgId); }
  public updateProject(projectId: string, patch: { name?: string; repoUrl?: string | null; restricted?: boolean }): Promise<projects.ProjectRecord | null> { return projects.updateProject(this.exec, projectId, patch); }
  public deleteProject(projectId: string): Promise<void> { return projects.deleteProject(this.exec, projectId); }
  public listAccessibleProjects(orgId: string, userId: string, isOrgAdmin: boolean): Promise<projects.ProjectRecord[]> { return projects.listAccessibleProjects(this.exec, orgId, userId, isOrgAdmin); }
  public addProjectMember(projectId: string, userId: string, role: string, now: string): Promise<void> { return projects.addProjectMember(this.exec, projectId, userId, role, now); }
  public removeProjectMember(projectId: string, userId: string): Promise<void> { return projects.removeProjectMember(this.exec, projectId, userId); }
  // ── project knowledge bases (ADR-021) ─────────────────────────────────────
  public createKnowledgeBase(record: KnowledgeBaseRecord): Promise<void> { return knowledgeBases.createKnowledgeBase(this.exec, record); }
  public getKnowledgeBase(baseId: string, orgId: string, projectId: string): Promise<KnowledgeBaseRecord | null> { return knowledgeBases.getKnowledgeBase(this.exec, baseId, orgId, projectId); }
  public listKnowledgeBases(orgId: string, projectId: string): Promise<KnowledgeBaseRecord[]> { return knowledgeBases.listKnowledgeBases(this.exec, orgId, projectId); }
  public updateKnowledgeBase(baseId: string, orgId: string, projectId: string, patch: UpdateKnowledgeBaseInput & { updatedAt: string }): Promise<KnowledgeBaseRecord | null> { return knowledgeBases.updateKnowledgeBase(this.exec, baseId, orgId, projectId, patch); }
  public deleteKnowledgeBase(baseId: string, orgId: string, projectId: string): Promise<boolean> { return knowledgeBases.deleteKnowledgeBase(this.exec, baseId, orgId, projectId); }
  public createKnowledgeDocument(record: KnowledgeDocumentRecord): Promise<void> { return knowledgeDocuments.createKnowledgeDocument(this.exec, record); }
  public enqueueKnowledgeDocument(record: KnowledgeDocumentRecord, jobId: string): Promise<KnowledgeDocumentEnqueueResult> { return knowledgeDocuments.enqueueKnowledgeDocument(this.exec, record, jobId); }
  public enqueueDerivedKnowledgeDocuments(inputs: KnowledgeDerivedDocumentInput[]): Promise<KnowledgeDerivedDocumentResult[]> { return knowledgeDocuments.enqueueDerivedKnowledgeDocuments(this.exec, inputs); }
  public markKnowledgeDocumentParsing(input: KnowledgeParseJobInput, updatedAt: string): Promise<KnowledgeDocumentRecord | null> { return knowledgeDocuments.markKnowledgeDocumentParsing(this.exec, input, updatedAt); }
  public commitKnowledgeDocumentParse(input: KnowledgeParseJobInput, chunks: KnowledgeChunkInput[], readyAt: string): Promise<KnowledgeParseCommitResult | null> { return knowledgeDocuments.commitKnowledgeDocumentParse(this.exec, input, chunks, readyAt); }
  public failKnowledgeDocumentParse(input: KnowledgeParseJobInput, statusMessage: string, updatedAt: string): Promise<KnowledgeDocumentRecord | null> { return knowledgeDocuments.failKnowledgeDocumentParse(this.exec, input, statusMessage, updatedAt); }
  public listKnowledgeChunks(documentId: string, baseId: string, orgId: string, projectId: string): Promise<KnowledgeChunkRecord[]> { return knowledgeDocuments.listKnowledgeChunks(this.exec, documentId, baseId, orgId, projectId); }
  public upsertKnowledgeChunkEmbeddings(input: KnowledgeParseJobInput, embeddings: KnowledgeChunkEmbeddingInput[], updatedAt: string): Promise<number> { return knowledgeDocuments.upsertKnowledgeChunkEmbeddings(this.exec, input, embeddings, updatedAt); }
  public getKnowledgeDocumentProcessing(input: KnowledgeParseJobInput): Promise<KnowledgeDocumentProcessingRecord | null> { return knowledgeDocuments.getKnowledgeDocumentProcessing(this.exec, input); }
  public retryKnowledgeDocumentProcessing(input: KnowledgeParseJobInput, jobId: string, now: string): Promise<KnowledgeDocumentRetryRecord | null> { return knowledgeDocuments.retryKnowledgeDocumentProcessing(this.exec, input, jobId, now); }
  public getKnowledgeDocument(documentId: string, baseId: string, orgId: string, projectId: string): Promise<KnowledgeDocumentRecord | null> { return knowledgeDocuments.getKnowledgeDocument(this.exec, documentId, baseId, orgId, projectId); }
  public listKnowledgeDocumentSourceIds(derivedDocumentId: string, baseId: string, orgId: string, projectId: string): Promise<string[]> { return knowledgeDocuments.listKnowledgeDocumentSourceIds(this.exec, derivedDocumentId, baseId, orgId, projectId); }
  public getKnowledgeDocumentByContentHash(contentSha256: string, baseId: string, orgId: string, projectId: string): Promise<KnowledgeDocumentRecord | null> { return knowledgeDocuments.getKnowledgeDocumentByContentHash(this.exec, contentSha256, baseId, orgId, projectId); }
  public listKnowledgeDocuments(baseId: string, orgId: string, projectId: string, filters?: KnowledgeDocumentListFilters): Promise<KnowledgeDocumentRecord[]> { return knowledgeDocuments.listKnowledgeDocuments(this.exec, baseId, orgId, projectId, filters); }
  public updateKnowledgeDocumentStatus(documentId: string, baseId: string, orgId: string, projectId: string, update: KnowledgeDocumentStatusUpdate): Promise<KnowledgeDocumentRecord | null> { return knowledgeDocuments.updateKnowledgeDocumentStatus(this.exec, documentId, baseId, orgId, projectId, update); }
  public searchKnowledgeChunksByText(scope: KnowledgeSearchScope, query: string): Promise<KnowledgeLexicalSearchHit[]> { return knowledgeSearch.searchKnowledgeChunksByText(this.exec, scope, query); }
  public searchKnowledgeChunksByVector(scope: KnowledgeSearchScope, input: KnowledgeVectorSearchInput): Promise<KnowledgeVectorSearchHit[]> { return knowledgeSearch.searchKnowledgeChunksByVector(this.exec, scope, input); }
  // Meetings (ADR-018) — index table + revocable public share tokens.
  public createMeeting(m: meetings.CreateMeetingInput): Promise<void> { return meetings.createMeeting(this.exec, m); }
  public listMeetings(orgId: string, userId: string, limit?: number): Promise<meetings.MeetingRow[]> { return meetings.listMeetings(this.exec, orgId, userId, limit); }
  public listMeetingsPage(orgId: string, userId: string, limit?: number, cursor?: meetings.MeetingListCursor): Promise<meetings.MeetingRow[]> { return meetings.listMeetingsPage(this.exec, orgId, userId, limit, cursor); }
  public getMeeting(orgId: string, userId: string, id: string): Promise<meetings.MeetingRow | null> { return meetings.getMeeting(this.exec, orgId, userId, id); }
  public getMeetingOverview(orgId: string, userId: string, id: string): Promise<meetings.MeetingRow | null> { return meetings.getMeetingOverview(this.exec, orgId, userId, id); }
  public getMeetingTranscriptText(orgId: string, userId: string, id: string): Promise<string | null> { return meetings.getMeetingTranscriptText(this.exec, orgId, userId, id); }
  public insertMeetingTranscriptSegments(meetingId: string, segments: meetings.MeetingTranscriptSegment[]): Promise<void> { return meetings.insertMeetingTranscriptSegments(this.exec, meetingId, segments); }
  public listMeetingTranscriptSegments(orgId: string, userId: string, id: string, cursor?: number, limit?: number): Promise<meetings.MeetingTranscriptSegment[]> { return meetings.listMeetingTranscriptSegments(this.exec, orgId, userId, id, cursor, limit); }
  public setMeetingScope(id: string, orgId: string, userId: string, scope: meetings.MeetingScope, teamId: string | null): Promise<boolean> { return meetings.setMeetingScope(this.exec, id, orgId, userId, scope, teamId); }
  public createMeetingShareToken(s: { token: string; meetingId: string; orgId: string; createdBy: string; expiresAt?: string }): Promise<void> { return meetings.createShareToken(this.exec, s); }
  public revokeMeetingShareTokens(meetingId: string): Promise<number> { return meetings.revokeShareTokens(this.exec, meetingId); }
  public getMeetingActiveShareToken(meetingId: string): Promise<{ token: string; expiresAt: string | null } | null> { return meetings.getActiveShareToken(this.exec, meetingId); }
  public updateMeetingSummary(id: string, userId: string, summaryMarkdown: string, actionItems: meetings.MeetingRow["actionItems"]): Promise<boolean> { return meetings.updateMeetingSummary(this.exec, id, userId, summaryMarkdown, actionItems); }
  public updateMeetingActionItems(id: string, userId: string, actionItems: meetings.MeetingRow["actionItems"]): Promise<boolean> { return meetings.updateMeetingActionItems(this.exec, id, userId, actionItems); }
  public setMeetingSummaryStatus(id: string, userId: string, status: meetings.MeetingRow["summaryStatus"], error?: string | null): Promise<boolean> { return meetings.setMeetingSummaryStatus(this.exec, id, userId, status, error); }
  public setMeetingSummaryRecords(id: string, userId: string, summaryRecordId: string | null, transcriptSourceId: string | null): Promise<boolean> { return meetings.setMeetingSummaryRecords(this.exec, id, userId, summaryRecordId, transcriptSourceId); }
  public getMeetingByShareToken(token: string): Promise<meetings.MeetingRow | null> { return meetings.getMeetingByShareToken(this.exec, token); }
  public deleteMeeting(id: string, orgId: string, userId: string): Promise<meetings.DeletedMeetingRefs | null> { return meetings.deleteMeeting(this.exec, id, orgId, userId); }

  // ── Track (migration 034) — org-scoped, collaborative work items ──
  public createTrackItem(input: track.CreateTrackItemInput): Promise<track.TrackItemRow> { return track.createTrackItem(this.exec, input); }
  public listTrackItems(orgId: string, opts?: { includeArchived?: boolean; limit?: number }): Promise<track.TrackItemRow[]> { return track.listTrackItems(this.exec, orgId, opts); }

  // ADR-028 Part D — planner (migration 051). Keyed by (org, USER): a planner is
  // personal, so the user is part of the key rather than an author column.
  public listPlannerItemsSince(orgId: string, userId: string, since?: string): Promise<planner.PlannerItemRow[]> { return planner.listPlannerItemsSince(this.exec, orgId, userId, since); }
  public getPlannerItem(orgId: string, userId: string, id: string): Promise<planner.PlannerItemRow | null> { return planner.getPlannerItem(this.exec, orgId, userId, id); }
  public upsertPlannerItem(orgId: string, userId: string, item: Parameters<typeof planner.upsertPlannerItem>[3]): Promise<planner.PlannerItemRow> { return planner.upsertPlannerItem(this.exec, orgId, userId, item); }
  public latestPlannerRevision(orgId: string, userId: string): Promise<string> { return planner.latestPlannerRevision(this.exec, orgId, userId); }
  public wasOperationApplied(orgId: string, userId: string, key: string): Promise<boolean> { return planner.wasOperationApplied(this.exec, orgId, userId, key); }
  public recordOperationApplied(orgId: string, userId: string, key: string, itemId: string): Promise<void> { return planner.recordOperationApplied(this.exec, orgId, userId, key, itemId); }
  public listPlannerBlocks(orgId: string, userId: string): Promise<planner.PlannerBlockRow[]> { return planner.listPlannerBlocks(this.exec, orgId, userId); }
  public upsertPlannerBlock(orgId: string, userId: string, block: planner.PlannerBlockRow): Promise<planner.PlannerBlockRow> { return planner.upsertPlannerBlock(this.exec, orgId, userId, block); }
  public compactCompletedPlannerItems(orgId: string, userId: string, retentionDays: number): Promise<number> { return planner.compactCompletedPlannerItems(this.exec, orgId, userId, retentionDays); }

  // ADR-029 Part D — notes (migration 052). Same (org, USER, id) partition as
  // the planner (D1). `notes_refs`/`notes_index` are derived from block content
  // alone (A2), which is why the only writers here take a block id and a text.
  public databaseNowMs(): Promise<number> { return notes.databaseNowMs(this.exec); }
  public listNoteBlocksSince(orgId: string, userId: string, since?: string): Promise<notes.NoteBlockRow[]> { return notes.listNoteBlocksSince(this.exec, orgId, userId, since); }
  public listAllNoteBlocks(orgId: string, userId: string): Promise<notes.NoteBlockRow[]> { return notes.listAllNoteBlocks(this.exec, orgId, userId); }
  public getNoteBlock(orgId: string, userId: string, id: string): Promise<notes.NoteBlockRow | null> { return notes.getNoteBlock(this.exec, orgId, userId, id); }
  public findNoteBlockInOrg(orgId: string, id: string): Promise<notes.NoteBlockOwnerRow | null> { return notes.findNoteBlockInOrg(this.exec, orgId, id); }
  public upsertNoteBlock(orgId: string, userId: string, block: Parameters<typeof notes.upsertNoteBlock>[3]): Promise<notes.NoteBlockRow> { return notes.upsertNoteBlock(this.exec, orgId, userId, block); }
  public listNoteChildBlocks(orgId: string, userId: string, parentId: string, limit?: number): Promise<notes.NoteBlockRow[]> { return notes.listNoteChildBlocks(this.exec, orgId, userId, parentId, limit); }
  public setNoteBlockVisibility(orgId: string, userId: string, id: string, visibility: string): Promise<number> { return notes.setNoteBlockVisibility(this.exec, orgId, userId, id, visibility); }
  public latestNoteRevision(orgId: string, userId: string): Promise<string> { return notes.latestNoteRevision(this.exec, orgId, userId); }
  public wasNoteOperationApplied(orgId: string, userId: string, key: string): Promise<boolean> { return notes.wasNoteOperationApplied(this.exec, orgId, userId, key); }
  public recordNoteOperationApplied(orgId: string, userId: string, key: string, blockId: string): Promise<void> { return notes.recordNoteOperationApplied(this.exec, orgId, userId, key, blockId); }
  public replaceNoteRefs(orgId: string, userId: string, blockId: string, refs: Parameters<typeof notes.replaceNoteRefs>[4]): Promise<void> { return notes.replaceNoteRefs(this.exec, orgId, userId, blockId, refs); }
  public listNoteRefsFrom(orgId: string, userId: string, blockId: string): Promise<notes.NoteRefRow[]> { return notes.listNoteRefsFrom(this.exec, orgId, userId, blockId); }
  public listNoteBacklinks(orgId: string, viewerUserId: string, targetKey: string, limit?: number): Promise<notes.NoteBacklinkRow[]> { return notes.listNoteBacklinks(this.exec, orgId, viewerUserId, targetKey, limit); }
  public upsertNoteIndex(orgId: string, userId: string, blockId: string, entry: Parameters<typeof notes.upsertNoteIndex>[4]): Promise<void> { return notes.upsertNoteIndex(this.exec, orgId, userId, blockId, entry); }
  public deleteNoteIndexEntry(orgId: string, userId: string, blockId: string): Promise<void> { return notes.deleteNoteIndexEntry(this.exec, orgId, userId, blockId); }
  public clearNoteDerived(orgId: string, userId: string): Promise<void> { return notes.clearNoteDerived(this.exec, orgId, userId); }
  // ADR-029 Part E (migration 053) — the two projections that make a page list
  // and a database view queries rather than a read of the whole corpus. Derived,
  // exactly like `notes_refs`/`notes_index`: written only by the re-derive path.
  public upsertNotePageMeta(orgId: string, userId: string, meta: notes.NotePageMetaRow): Promise<void> { return notes.upsertNotePageMeta(this.exec, orgId, userId, meta); }
  public deleteNotePageMeta(orgId: string, userId: string, blockId: string): Promise<void> { return notes.deleteNotePageMeta(this.exec, orgId, userId, blockId); }
  public listNotePageMeta(orgId: string, userId: string, opts?: Parameters<typeof notes.listNotePageMeta>[3]): Promise<notes.NotePageMetaRow[]> { return notes.listNotePageMeta(this.exec, orgId, userId, opts); }
  public getNotePageMeta(orgId: string, userId: string, blockId: string): Promise<notes.NotePageMetaRow | null> { return notes.getNotePageMeta(this.exec, orgId, userId, blockId); }
  public replaceNoteRowValues(orgId: string, userId: string, blockId: string, parentId: string | null, values: readonly notes.NoteRowValueInput[]): Promise<void> { return notes.replaceNoteRowValues(this.exec, orgId, userId, blockId, parentId, values); }
  public listNoteDatabaseRows(orgId: string, userId: string, databaseId: string, opts?: Parameters<typeof notes.listNoteDatabaseRows>[4]): Promise<notes.NoteBlockRow[]> { return notes.listNoteDatabaseRows(this.exec, orgId, userId, databaseId, opts); }
  public countNoteDatabaseRows(orgId: string, userId: string, databaseId: string): Promise<number> { return notes.countNoteDatabaseRows(this.exec, orgId, userId, databaseId); }
  public listNoteIndexEntries(orgId: string, userId: string): ReturnType<typeof notes.listNoteIndexEntries> { return notes.listNoteIndexEntries(this.exec, orgId, userId); }
  public searchNoteIndex(orgId: string, userId: string, query: string, limit?: number): Promise<notes.NoteSearchRow[]> { return notes.searchNoteIndex(this.exec, orgId, userId, query, limit); }
  public readNoteBlockLease(orgId: string, userId: string, blockId: string): ReturnType<typeof notes.readNoteBlockLease> { return notes.readNoteBlockLease(this.exec, orgId, userId, blockId); }
  public upsertNoteBlockLease(orgId: string, userId: string, lease: notes.NoteBlockLeaseRow): Promise<void> { return notes.upsertNoteBlockLease(this.exec, orgId, userId, lease); }
  public sweepNoteBlockLeases(orgId: string, maxAgeMs: number): Promise<number> { return notes.sweepNoteBlockLeases(this.exec, orgId, maxAgeMs); }
  public registerNoteAttachment(orgId: string, object: Parameters<typeof notes.registerNoteAttachment>[2]): Promise<notes.NoteAttachmentRow> { return notes.registerNoteAttachment(this.exec, orgId, object); }
  public linkNoteAttachment(orgId: string, userId: string, link: Parameters<typeof notes.linkNoteAttachment>[3]): Promise<void> { return notes.linkNoteAttachment(this.exec, orgId, userId, link); }
  public unlinkNoteAttachment(orgId: string, userId: string, blockId: string, contentHash: string): Promise<number> { return notes.unlinkNoteAttachment(this.exec, orgId, userId, blockId, contentHash); }
  public listNoteAttachments(orgId: string, userId: string, blockId: string): Promise<notes.NoteAttachmentUseRow[]> { return notes.listNoteAttachments(this.exec, orgId, userId, blockId); }
  public countNoteAttachmentUses(orgId: string, contentHash: string): Promise<number> { return notes.countNoteAttachmentUses(this.exec, orgId, contentHash); }
  public listUnreferencedNoteAttachments(orgId: string, olderThanMs: number, limit?: number): Promise<notes.NoteAttachmentRow[]> { return notes.listUnreferencedNoteAttachments(this.exec, orgId, olderThanMs, limit); }
  public getTrackItem(orgId: string, id: string): Promise<track.TrackItemRow | null> { return track.getTrackItem(this.exec, orgId, id); }
  public getTrackItemBySourceRef(orgId: string, sourceRef: string): Promise<track.TrackItemRow | null> { return track.getTrackItemBySourceRef(this.exec, orgId, sourceRef); }
  public transitionTrackItem(orgId: string, id: string, status: string, statusCategory: track.TrackStatusCategory): Promise<track.TrackItemRow | null> { return track.transitionTrackItem(this.exec, orgId, id, status, statusCategory); }
  public updateTrackItem(orgId: string, id: string, patch: track.UpdateTrackItemPatch): Promise<track.TrackItemRow | null> { return track.updateTrackItem(this.exec, orgId, id, patch); }
  public deleteTrackItem(orgId: string, id: string): Promise<boolean> { return track.deleteTrackItem(this.exec, orgId, id); }

  // ── Team spaces (migrations 035/037) — organization + personal groups ──
  public createTeam(input: teams.CreateTeamInput): Promise<teams.TeamRow> { return teams.createTeam(this.exec, input); }
  public listTeamsForUser(orgId: string, userId: string, includeAllOrgTeams?: boolean): Promise<teams.TeamRow[]> { return teams.listTeamsForUser(this.exec, orgId, userId, includeAllOrgTeams); }
  public getTeam(orgId: string, id: string): Promise<teams.TeamRow | null> { return teams.getTeam(this.exec, orgId, id); }
  public isTeamMember(orgId: string, teamId: string, userId: string): Promise<boolean> { return teams.isTeamMember(this.exec, orgId, teamId, userId); }
  public listTeamMembers(orgId: string, teamId: string, callerUserId: string, canViewAllOrgTeams?: boolean): Promise<teams.TeamMemberRow[]> { return teams.listTeamMembers(this.exec, orgId, teamId, callerUserId, canViewAllOrgTeams); }
  public insertTeamOwner(teamId: string, userId: string): Promise<boolean> { return teams.insertTeamOwner(this.exec, teamId, userId); }
  public addTeamMember(orgId: string, teamId: string, userId: string, role: teams.TeamMemberRole | undefined, callerUserId: string, canManageOrgTeams?: boolean): Promise<boolean> { return teams.addTeamMember(this.exec, orgId, teamId, userId, role, callerUserId, canManageOrgTeams); }
  public removeTeamMember(orgId: string, teamId: string, userId: string, callerUserId: string, canManageOrgTeams?: boolean): Promise<boolean> { return teams.removeTeamMember(this.exec, orgId, teamId, userId, callerUserId, canManageOrgTeams); }
  public transferPersonalTeamOwnership(teamId: string, fromUserId: string, toUserId: string): Promise<boolean> { return teams.transferPersonalTeamOwnership(this.exec, teamId, fromUserId, toUserId); }
  public deleteTeam(orgId: string, id: string): Promise<boolean> { return teams.deleteTeam(this.exec, orgId, id); }

  // ── Chat threads (migration 036) — per-user private chat history within an org ──
  public createChatThread(input: chatThreads.CreateChatThreadInput): Promise<chatThreads.ChatThreadRow> { return chatThreads.createThread(this.exec, input); }
  public listChatThreads(orgId: string, userId: string, limit?: number): Promise<chatThreads.ChatThreadRow[]> { return chatThreads.listThreads(this.exec, orgId, userId, limit); }
  public getChatThread(orgId: string, userId: string, id: string): Promise<chatThreads.ChatThreadWithMessages | null> { return chatThreads.getThread(this.exec, orgId, userId, id); }
  public countChatThreads(orgId: string, userId: string): Promise<number> { return chatThreads.threadCount(this.exec, orgId, userId); }
  public appendChatMessage(orgId: string, userId: string, threadId: string, msg: chatThreads.AppendChatMessageInput): Promise<chatThreads.ChatMessageRow | null> { return chatThreads.appendMessage(this.exec, orgId, userId, threadId, msg); }
  public renameChatThread(orgId: string, userId: string, id: string, title: string, model?: string | null): Promise<chatThreads.ChatThreadRow | null> { return chatThreads.renameThread(this.exec, orgId, userId, id, title, model); }
  public deleteChatThread(orgId: string, userId: string, id: string): Promise<boolean> { return chatThreads.deleteThread(this.exec, orgId, userId, id); }
  public replaceChatMessages(orgId: string, userId: string, threadId: string, messages: chatThreads.AppendChatMessageInput[]): Promise<chatThreads.ChatThreadWithMessages | null> { return chatThreads.replaceMessages(this.exec, orgId, userId, threadId, messages); }
  // CVE catalog (spec §10, Task 26) — global world data, no org scoping.
  public ensureVulnerabilitySource(source: { id: import("../../../vulnerability/types.js").VulnerabilitySourceId; displayName: string; kind: string }): Promise<void> { return vulnerability.ensureVulnerabilitySource(this.exec, source); }
  public getVulnerabilitySource(id: string) { return vulnerability.getVulnerabilitySource(this.exec, id); }
  public listVulnerabilitySources() { return vulnerability.listVulnerabilitySources(this.exec); }
  public listActiveVulnerabilityFeedRuns() { return vulnerability.listActiveVulnerabilityFeedRuns(this.exec); }
  public startVulnerabilityFeedRun(sourceId: string) { return vulnerability.startVulnerabilityFeedRun(this.exec, sourceId); }
  public updateVulnerabilityFeedRunProgress(runId: string, progress: { itemsSeen: number; itemsUpserted: number; cursorAfter?: Record<string, unknown> }) { return vulnerability.updateVulnerabilityFeedRunProgress(this.exec, runId, progress); }
  public finishVulnerabilityFeedRun(runId: string, outcome: Parameters<typeof vulnerability.finishVulnerabilityFeedRun>[2]) { return vulnerability.finishVulnerabilityFeedRun(this.exec, runId, outcome); }
  public upsertVulnerabilityObservation(observation: import("../../../vulnerability/types.js").VulnerabilityObservation) { return vulnerability.upsertVulnerabilityObservation(this.exec, observation); }
  public listVulnerabilities(filters: vulnerability.VulnerabilityListFilters) { return vulnerability.listVulnerabilities(this.exec, filters); }
  public getVulnerability(cveId: string) { return vulnerability.getVulnerability(this.exec, cveId); }
  public listVulnerabilityRangesForPackage(ecosystem: string, packageName: string) { return vulnerability.listRangesForPackage(this.exec, ecosystem, packageName); }
  // Org-scoped exposure (spec §10, Tasks 29-31).
  public createVulnerabilityScan(input: { orgId: string; userId: string; repo: string }) { return vulnScans.createVulnerabilityScan(this.exec, input); }
  public finishVulnerabilityScan(orgId: string, scanId: string, outcome: Parameters<typeof vulnScans.finishVulnerabilityScan>[3]) { return vulnScans.finishVulnerabilityScan(this.exec, orgId, scanId, outcome); }
  public getVulnerabilityScan(orgId: string, scanId: string) { return vulnScans.getVulnerabilityScan(this.exec, orgId, scanId); }
  public listVulnerabilityScans(orgId: string, limit?: number) { return vulnScans.listVulnerabilityScans(this.exec, orgId, limit); }
  public replaceAssetComponents(orgId: string, repo: string, scanId: string, components: Parameters<typeof vulnScans.replaceAssetComponents>[4]) { return vulnScans.replaceAssetComponents(this.exec, orgId, repo, scanId, components); }
  public listAssetComponents(filters: Parameters<typeof vulnScans.listAssetComponents>[1]) { return vulnScans.listAssetComponents(this.exec, filters); }
  public listVulnerabilityMatches(orgId: string, filters?: Parameters<typeof vulnScans.listVulnerabilityMatches>[2]) { return vulnScans.listVulnerabilityMatches(this.exec, orgId, filters); }
  public upsertVulnerabilityMatch(orgId: string, repo: string, scanId: string, match: import("../../../vulnerability/types.js").VulnerabilityMatch) { return vulnScans.upsertVulnerabilityMatch(this.exec, orgId, repo, scanId, match); }
  public setVulnerabilityMatchStatus(orgId: string, matchId: string, status: "open" | "dismissed", reason?: string) { return vulnScans.setVulnerabilityMatchStatus(this.exec, orgId, matchId, status, reason); }
  public upsertVulnerabilityWatch(input: { orgId: string; userId: string; repo: string }) { return vulnScans.upsertVulnerabilityWatch(this.exec, input); }
  public listVulnerabilityWatches(orgId: string) { return vulnScans.listVulnerabilityWatches(this.exec, orgId); }
  public listActiveVulnerabilityWatches(limit?: number) { return vulnScans.listActiveVulnerabilityWatches(this.exec, limit); }
  public finishVulnerabilityWatchRun(watchId: string, outcome: { status: "active" | "error"; error?: string }) { return vulnScans.finishVulnerabilityWatchRun(this.exec, watchId, outcome); }
  public deleteVulnerabilityWatch(orgId: string, watchId: string) { return vulnScans.deleteVulnerabilityWatch(this.exec, orgId, watchId); }
  public recordVulnerabilityWatchEvent(event: { watchId: string; matchId: string; transition: string }) { return vulnScans.recordWatchEvent(this.exec, event); }
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

  // ── server-managed model policies ─────────────────────────────────────────

  public listProviderModels(orgId: string, enabledOnly = false): Promise<ProviderModelRecord[]> {
    return modelPolicy.listProviderModels(this.exec, orgId, enabledOnly);
  }
  public getProviderModel(orgId: string, id: string): Promise<ProviderModelRecord | null> {
    return modelPolicy.getProviderModel(this.exec, orgId, id);
  }
  public getProviderModelByPublicId(orgId: string, publicModelId: string, enabledOnly = false): Promise<ProviderModelRecord | null> {
    return modelPolicy.getProviderModelByPublicId(this.exec, orgId, publicModelId, enabledOnly);
  }
  public createProviderModel(orgId: string, input: ProviderModelInput): Promise<ProviderModelRecord> {
    return modelPolicy.createProviderModel(this.exec, orgId, input);
  }
  public updateProviderModel(orgId: string, id: string, patch: ProviderModelPatch): Promise<ProviderModelRecord | null> {
    return modelPolicy.updateProviderModel(this.exec, orgId, id, patch);
  }
  public deleteProviderModel(orgId: string, id: string): Promise<boolean> {
    return modelPolicy.deleteProviderModel(this.exec, orgId, id);
  }
  public setDefaultProviderModel(orgId: string, id: string): Promise<boolean> {
    return modelPolicy.setDefaultProviderModel(this.exec, orgId, id);
  }
  public reorderProviderModels(orgId: string, ids: readonly string[]): Promise<void> {
    return modelPolicy.reorderProviderModels(this.exec, orgId, ids);
  }
  public ensureModelGatewayServicePrincipal(orgId: string): Promise<string> {
    return modelPolicy.ensureModelGatewayServicePrincipal(this.exec, orgId);
  }

  // ── remote device identities, sessions, grants, and metadata audit ────────

  public createRemoteDevice(orgId: string, userId: string, input: RemoteDeviceInput): Promise<RemoteDeviceRecord> {
    return remoteAccess.createRemoteDevice(this.exec, orgId, userId, input);
  }
  public getRemoteDevice(orgId: string, userId: string, deviceId: string): Promise<RemoteDeviceRecord | null> {
    return remoteAccess.getRemoteDevice(this.exec, orgId, userId, deviceId);
  }
  public getRemoteDeviceByInstallation(orgId: string, userId: string, installationId: string): Promise<RemoteDeviceRecord | null> {
    return remoteAccess.getRemoteDeviceByInstallation(this.exec, orgId, userId, installationId);
  }
  public listRemoteDevices(orgId: string, userId: string, kind?: RemoteDeviceKind): Promise<RemoteDeviceRecord[]> {
    return remoteAccess.listRemoteDevices(this.exec, orgId, userId, kind);
  }
  public touchRemoteDevice(orgId: string, userId: string, deviceId: string, at?: string): Promise<boolean> {
    return remoteAccess.touchRemoteDevice(this.exec, orgId, userId, deviceId, at);
  }
  public revokeRemoteDevice(orgId: string, userId: string, deviceId: string, reasonCode: string, at?: string): Promise<boolean> {
    return remoteAccess.revokeRemoteDevice(this.exec, orgId, userId, deviceId, reasonCode, at);
  }
  public createDeviceSession(orgId: string, userId: string, input: DeviceSessionInput): Promise<DeviceSessionRecord> {
    return remoteAccess.createDeviceSession(this.exec, orgId, userId, input);
  }
  public getDeviceSession(orgId: string, userId: string, sessionId: string): Promise<DeviceSessionRecord | null> {
    return remoteAccess.getDeviceSession(this.exec, orgId, userId, sessionId);
  }
  public getDeviceSessionByTokenHash(orgId: string, userId: string, tokenHash: string): Promise<DeviceSessionRecord | null> {
    return remoteAccess.getDeviceSessionByTokenHash(this.exec, orgId, userId, tokenHash);
  }
  public rotateDeviceSession(orgId: string, userId: string, input: DeviceSessionRotationInput, at?: string): Promise<DeviceSessionRotationResult> {
    return remoteAccess.rotateDeviceSession(this.exec, orgId, userId, input, at);
  }
  public revokeDeviceSessionFamily(orgId: string, userId: string, familyId: string, reasonCode: string, at?: string): Promise<boolean> {
    return remoteAccess.revokeDeviceSessionFamily(this.exec, orgId, userId, familyId, reasonCode, at);
  }
  public createRemoteAccessGrant(orgId: string, userId: string, input: RemoteAccessGrantInput): Promise<RemoteAccessGrantRecord> {
    return remoteAccess.createRemoteAccessGrant(this.exec, orgId, userId, input);
  }
  public getRemoteAccessGrant(orgId: string, userId: string, grantId: string): Promise<RemoteAccessGrantRecord | null> {
    return remoteAccess.getRemoteAccessGrant(this.exec, orgId, userId, grantId);
  }
  public listRemoteAccessGrants(orgId: string, userId: string): Promise<RemoteAccessGrantRecord[]> {
    return remoteAccess.listRemoteAccessGrants(this.exec, orgId, userId);
  }
  public decideRemoteAccessGrant(orgId: string, userId: string, grantId: string, desktopDeviceId: string, decision: RemoteGrantDecision, at?: string): Promise<RemoteAccessGrantRecord | null> {
    return remoteAccess.decideRemoteAccessGrant(this.exec, orgId, userId, grantId, desktopDeviceId, decision, at);
  }
  public revokeRemoteAccessGrant(orgId: string, userId: string, grantId: string, reasonCode: string, at?: string): Promise<boolean> {
    return remoteAccess.revokeRemoteAccessGrant(this.exec, orgId, userId, grantId, reasonCode, at);
  }
  public appendRemoteAccessAudit(orgId: string, userId: string, input: RemoteAccessAuditInput, at?: string): Promise<RemoteAccessAuditRecord> {
    return remoteAccess.appendRemoteAccessAudit(this.exec, orgId, userId, input, at);
  }
  public listRemoteAccessAudit(orgId: string, userId: string, limit?: number): Promise<RemoteAccessAuditRecord[]> {
    return remoteAccess.listRemoteAccessAudit(this.exec, orgId, userId, limit);
  }

  public createRemoteEnrollmentChallenge(orgId: string, userId: string, input: RemoteEnrollmentChallengeInput, at?: string): Promise<RemoteEnrollmentChallengeRecord> {
    return remoteControl.createRemoteEnrollmentChallenge(this.exec, orgId, userId, input, at);
  }
  public getRemoteEnrollmentChallenge(orgId: string, userId: string, challengeId: string): Promise<RemoteEnrollmentChallengeRecord | null> {
    return remoteControl.getRemoteEnrollmentChallenge(this.exec, orgId, userId, challengeId);
  }
  public consumeRemoteEnrollmentChallenge(orgId: string, userId: string, challengeId: string, challengeHash: string, at?: string): Promise<boolean> {
    return remoteControl.consumeRemoteEnrollmentChallenge(this.exec, orgId, userId, challengeId, challengeHash, at);
  }
  public createRemoteRelayTicket(orgId: string, userId: string, input: RemoteRelayTicketInput, at?: string): Promise<RemoteRelayTicketRecord> {
    return remoteControl.createRemoteRelayTicket(this.exec, orgId, userId, input, at);
  }
  public consumeRemoteRelayTicket(tokenHash: string, audience: "remote-relay", presentingDeviceId: string, at?: string): Promise<RemoteRelayTicketRecord | null> {
    return remoteControl.consumeRemoteRelayTicket(this.exec, tokenHash, audience, presentingDeviceId, at);
  }
  public revokeRemoteRelayTickets(orgId: string, userId: string, selector: RemoteRelayTicketRevocation, reasonCode: string, at?: string): Promise<number> {
    return remoteControl.revokeRemoteRelayTickets(this.exec, orgId, userId, selector, reasonCode, at);
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

  public findLessonByFingerprint(
    userId: string,
    fingerprint: string,
    orgId: string | null = null,
  ): Promise<CognitiveRecord | null> {
    return cognitive.findLessonByFingerprint(this.exec, userId, fingerprint, orgId);
  }

  public findLessonsByConflictKey(userId: string, conflictKey: string): Promise<CognitiveRecord[]> {
    return cognitive.findLessonsByConflictKey(this.exec, userId, conflictKey);
  }

  public listLessonsForHygiene(userId: string, limit: number): Promise<CognitiveRecord[]> {
    return cognitive.listLessonsForHygiene(this.exec, userId, limit);
  }

  /** ADR-032 Q4 — central, tenant-scoped records for hosted inspection. */
  public listHostedLearnedRecords(userId: string, orgId: string, limit?: number): Promise<CognitiveRecord[]> {
    return learnedBehavior.listHostedLearnedRecords(this.exec, userId, orgId, limit);
  }

  /** ADR-032 D6 — persistent fair partition for bounded retirement work. */
  public takeHostedLearnedRetirementBatch(
    userId: string,
    orgId: string,
    limit?: number,
    now?: Date,
  ): Promise<CognitiveRecord[]> {
    return learnedBehavior.takeHostedLearnedRetirementBatch(this.exec, userId, orgId, limit, now);
  }

  public getHostedLearnedRecordByItemId(
    userId: string,
    orgId: string,
    itemId: string,
  ): Promise<CognitiveRecord | null> {
    return learnedBehavior.getHostedLearnedRecordByItemId(this.exec, userId, orgId, itemId);
  }

  public retrieveHostedLearnedRecords(
    userId: string,
    orgId: string,
    limit?: number,
    now?: Date,
  ): Promise<CognitiveRecord[]> {
    return learnedBehavior.retrieveHostedLearnedRecords(this.exec, userId, orgId, limit, now);
  }

  public noteHostedLearningOutcomes(
    userId: string,
    orgId: string,
    sessionIdentity: string,
    jobId: string,
    outcomes: readonly learnedBehavior.HostedLearningOutcomeInput[],
    now?: Date,
    expectedRecordId?: string,
  ): Promise<CognitiveRecord[]> {
    return learnedBehavior.noteHostedLearningOutcomes(
      this.exec,
      userId,
      orgId,
      sessionIdentity,
      jobId,
      outcomes,
      now,
      expectedRecordId,
    );
  }

  /** ADR-032 D4 — atomic central archive + explicit human-revert marker. */
  public revertHostedLearnedRecord(
    userId: string,
    orgId: string,
    itemId: string,
    reason: string,
    now?: Date,
  ): Promise<CognitiveRecord | null> {
    return learnedBehavior.revertHostedLearnedRecord(this.exec, userId, orgId, itemId, reason, now);
  }

  /** ADR-032 D4/D8 — inspect one learned lifecycle through both tenant keys. */
  public getHostedLearnedLifecycle(
    userId: string,
    orgId: string,
    recordId: string,
    itemId: string,
  ): Promise<learnedBehavior.HostedLearnedLifecycleResult | null> {
    return learnedBehavior.getHostedLearnedLifecycle(this.exec, userId, orgId, recordId, itemId);
  }

  /** ADR-032 D4/D6 — authenticated learned-only archive/restore transition. */
  public transitionHostedLearnedLifecycle(
    userId: string,
    orgId: string,
    recordId: string,
    itemId: string,
    operation: "archive" | "restore",
    reason: string,
    now?: Date,
  ): Promise<learnedBehavior.HostedLearnedLifecycleResult | null> {
    return learnedBehavior.transitionHostedLearnedLifecycle(
      this.exec, userId, orgId, recordId, itemId, operation, reason, now,
    );
  }

  /** ADR-032 D6/Q4 — mirror bounded outcomes without overriding human revert. */
  public syncHostedLearnedRecord(
    userId: string,
    orgId: string,
    recordId: string,
    itemId: string,
    learned: Record<string, unknown>,
    now?: Date,
  ): Promise<learnedBehavior.HostedLearnedSyncResult | null> {
    return learnedBehavior.syncHostedLearnedRecord(
      this.exec, userId, orgId, recordId, itemId, learned, now,
    );
  }

  /** ADR-032 D5/Q1 — atomic durable cost admission plus queue insertion. */
  public enqueueHostedLearningCheckpointJob(
    input: Parameters<typeof hostedLearning.enqueueHostedLearningCheckpointJob>[1],
    options?: Parameters<typeof hostedLearning.enqueueHostedLearningCheckpointJob>[2],
  ): ReturnType<typeof hostedLearning.enqueueHostedLearningCheckpointJob> {
    return hostedLearning.enqueueHostedLearningCheckpointJob(this.exec, input, options);
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

  public searchCognitiveFtsAsOf(userId: string, query: string, limit: number, asOf: string, orgId?: string): Promise<CognitiveFtsResult[]> {
    return search.searchCognitiveFtsAsOf(this.exec, userId, query, limit, asOf, orgId);
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

  public recordSkillOutcome(skillName: string, success: boolean): Promise<SkillHintsRecord | null> {
    return skillFocus.recordSkillOutcome(this.exec, skillName, success);
  }

  public listSkillReliability(): Promise<SkillHintsRecord[]> {
    return skillFocus.listSkillReliability(this.exec);
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

  public appendJobProgress(id: string, event: import("@kinqs/brainrouter-types").MemoryJobProgressEvent, leaseEpoch?: number): Promise<void> {
    return job.appendJobProgress(this.exec, id, event, leaseEpoch);
  }
  public heartbeatMemoryJob(id: string, leaseEpoch?: number): Promise<boolean> {
    return job.heartbeatMemoryJob(this.exec, id, undefined, leaseEpoch);
  }

  /** ADR-017 D5 — recent PR-review jobs for an org's Reviews dashboard (newest-first). */
  public listReviewJobsForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]> {
    return job.listReviewJobsForOrg(this.exec, orgId, limit);
  }
  public listReviewJobSummariesForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]> {
    return job.listReviewJobSummariesForOrg(this.exec, orgId, limit);
  }
  public listReviewAnalyticsForOrg(orgId: string, since: string, limit?: number): Promise<MemoryJobRecord[]> {
    return job.listReviewAnalyticsForOrg(this.exec, orgId, since, limit);
  }
  public getReviewLifecycleSummaryForOrg(orgId: string, since: string): Promise<job.ReviewLifecycleSummary> {
    return job.getReviewLifecycleSummaryForOrg(this.exec, orgId, since);
  }
  public listReviewJobsForPr(orgId: string, repo: string, prNumber: number, limit?: number): Promise<MemoryJobRecord[]> {
    return job.listReviewJobsForPr(this.exec, orgId, repo, prNumber, limit);
  }
  public listReviewFindingsForOrg(orgId: string, query?: job.ReviewFindingQuery): Promise<job.ReviewFindingRow[]> {
    return job.listReviewFindingsForOrg(this.exec, orgId, query);
  }
  public listPentestJobsForOrg(orgId: string, limit?: number): Promise<MemoryJobRecord[]> { return job.listPentestJobsForOrg(this.exec, orgId, limit); }

  public createPentestTarget(orgId: string, createdBy: string, input: PentestTargetInput): Promise<PentestTargetRecord> { return pentestTargets.createPentestTarget(this.exec, orgId, createdBy, input); }
  public getPentestTarget(id: string): Promise<PentestTargetRecord | null> { return pentestTargets.getPentestTarget(this.exec, id); }
  public listPentestTargets(orgId: string): Promise<PentestTargetRecord[]> { return pentestTargets.listPentestTargets(this.exec, orgId); }
  public deletePentestTarget(orgId: string, id: string): Promise<boolean> { return pentestTargets.deletePentestTarget(this.exec, orgId, id); }

  public claimNextMemoryJob(options?: { now?: string; perTenantLimit?: number }): Promise<MemoryJobRecord | null> {
    return job.claimNextMemoryJob(this.exec, options);
  }

  /** Supersede-cancel still-pending review jobs for a PR when a newer push arrives. */
  public cancelSupersededReviewJobs(input: { orgId: string; repo: string; prNumber: number }, options?: { now?: string }): Promise<number> {
    return job.cancelSupersededReviewJobs(this.exec, input, options);
  }

  public startMemoryJob(id: string, options?: { now?: string }): Promise<MemoryJobRecord | null> {
    return job.startMemoryJob(this.exec, id, options);
  }

  public completeMemoryJob(id: string, output: unknown, options?: { now?: string; leaseEpoch?: number }): Promise<MemoryJobRecord | null> {
    return job.completeMemoryJob(this.exec, id, output, options);
  }

  public failMemoryJob(id: string, error: string, options?: { now?: string; backoffMs?: number; leaseEpoch?: number }): Promise<MemoryJobRecord | null> {
    return job.failMemoryJob(this.exec, id, error, options);
  }

  public retryMemoryJob(id: string, options?: { now?: string }): Promise<MemoryJobRecord | null> {
    return job.retryMemoryJob(this.exec, id, options);
  }

  public cancelMemoryJob(id: string, options?: { now?: string; reason?: string }): Promise<MemoryJobRecord | null> {
    return job.cancelMemoryJob(this.exec, id, options);
  }

  public sweepStuckMemoryJobs(stuckMs: number, options?: { now?: string; backoffMs?: number }): Promise<number> {
    return job.sweepStuckMemoryJobs(this.exec, stuckMs, options);
  }

  /**
   * ADR-027 D11 / P1-6 — one bounded retention pass: fold expired usage events
   * into their daily rollup and compact old job-progress timelines.
   */
  public runRetentionPass(
    options?: retention.RetentionOptions,
  ): Promise<retention.RetentionPassResult> {
    return retention.runRetentionPass(this.exec, options);
  }

  public expireAuthorizedAssessmentEvidence(
    options?: { now?: string },
  ): Promise<AssessmentEvidenceCleanupResult> {
    return assessmentEvidence.expireAuthorizedAssessmentEvidence(this.exec, options);
  }

  public getMemoryJobKindAggregates(options?: { now?: string }): Promise<MemoryJobKindAggregate[]> {
    return job.getMemoryJobKindAggregates(this.exec, options);
  }

  // ── repository assurance receipts ───────────────────────────────────────

  public createRepositoryAssuranceRun(
    input: assurance.CreateRepositoryAssuranceRunInput,
  ): Promise<import("@kinqs/brainrouter-types/review").RepositoryAssuranceRun> {
    return assurance.createRepositoryAssuranceRun(this.exec, input);
  }

  public getRepositoryAssuranceRun(
    orgId: string,
    runId: string,
  ): Promise<import("@kinqs/brainrouter-types/review").RepositoryAssuranceRun | null> {
    return assurance.getRepositoryAssuranceRun(this.exec, orgId, runId);
  }

  public getRepositoryAssuranceRunForJob(
    orgId: string,
    jobId: string,
  ): Promise<import("@kinqs/brainrouter-types/review").RepositoryAssuranceRun | null> {
    return assurance.getRepositoryAssuranceRunForJob(this.exec, orgId, jobId);
  }

  public getRepositoryAssuranceFinding(
    orgId: string,
    runId: string,
    findingId: string,
  ): Promise<import("@kinqs/brainrouter-types/review").AssuranceFinding | null> {
    return assurance.getRepositoryAssuranceFinding(this.exec, orgId, runId, findingId);
  }

  public listRepositoryAssuranceFindings(
    orgId: string,
    runId: string,
  ): Promise<import("@kinqs/brainrouter-types/review").AssuranceFinding[]> {
    return assurance.listRepositoryAssuranceFindings(this.exec, orgId, runId);
  }

  public saveRepositoryAssuranceFinding(
    input: assurance.SaveRepositoryAssuranceFindingInput,
  ): Promise<import("@kinqs/brainrouter-types/review").AssuranceFinding> {
    return assurance.saveRepositoryAssuranceFinding(this.exec, input);
  }

  public listReplaceableRepositoryAssuranceRunIds(
    input: assurance.ReplaceableAssuranceRunsInput,
  ): Promise<string[]> {
    return assurance.listReplaceableRepositoryAssuranceRunIds(this.exec, input);
  }

  public transitionRepositoryAssuranceRun(
    input: assurance.AssuranceRunTransition,
  ): Promise<import("@kinqs/brainrouter-types/review").RepositoryAssuranceRun> {
    return assurance.transitionRepositoryAssuranceRun(this.exec, input);
  }

  public updateRepositorySourceSnapshot(
    orgId: string,
    runId: string,
    source: import("@kinqs/brainrouter-types/review").SourceSnapshot,
  ): Promise<import("@kinqs/brainrouter-types/review").SourceSnapshot> {
    return assurance.updateRepositorySourceSnapshot(this.exec, orgId, runId, source);
  }

  public updateRepositoryAssuranceCoverage(
    orgId: string,
    runId: string,
    coverage: import("@kinqs/brainrouter-types/review").AssuranceCoverage,
  ): Promise<import("@kinqs/brainrouter-types/review").AssuranceCoverage> {
    return assurance.updateRepositoryAssuranceCoverage(this.exec, orgId, runId, coverage);
  }

  public recordRepositoryAssuranceStage(
    orgId: string,
    runId: string,
    stage: import("@kinqs/brainrouter-types/review").AssuranceStageReceipt,
  ): Promise<import("@kinqs/brainrouter-types/review").AssuranceStageReceipt> {
    return assurance.recordRepositoryAssuranceStage(this.exec, orgId, runId, stage);
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

  public promoteDurableMemories(minConfidence: number, minCorroborations: number): Promise<number> {
    return cognitive.promoteDurableMemories(this.exec, minConfidence, minCorroborations);
  }

  public listMemoryUserIds(): Promise<string[]> {
    return cognitive.listMemoryUserIds(this.exec);
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

  public getSourceDocumentByHash(userId: string, hash: string, scope?: sourcesTree.SourceDocumentScope): Promise<SourceDocument | null> {
    return sourcesTree.getSourceDocumentByHash(this.exec, userId, hash, scope);
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

  public getSourceDocuments(
    userId: string,
    limit = 100,
    filters: sourcesTree.SourceDocumentListFilters = {},
  ): Promise<Array<SourceDocument & { chunkCount: number }>> {
    return sourcesTree.getSourceDocuments(this.exec, userId, limit, filters);
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
