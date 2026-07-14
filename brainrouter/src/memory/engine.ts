import { PostgresMemoryStore } from "./store/postgres/PostgresMemoryStore.js";
import { pgUrlFromEnv } from "./store/postgres/connection.js";
import type { StalenessThresholds } from "./lessons/lessonHygiene.js";
// REFAC-ENGINE-SPLIT (0.4.6) — lesson-domain ops live in lessons/lessonOps.ts;
// the engine methods below are thin wrappers delegating to them.
import * as lessonOps from "./lessons/lessonOps.js";
import * as blackboardOps from "./blackboard/blackboardOps.js";
import * as treeOps from "./tree/treeOps.js";
// REFAC-ENGINE-SPLIT (0.4.17) — the bulk of the engine's method bodies now live
// in cohesive sibling modules under ./engine/; the class methods below delegate
// to them (type-only import of MemoryEngine inside the modules → no cycle).
import * as sourceOps from "./engine/sourceOps.js";
import * as vaultOps from "./engine/vaultOps.js";
import * as maintenanceOps from "./engine/maintenanceOps.js";
import * as memoryOps from "./engine/memoryOps.js";
import * as benchOps from "./engine/benchOps.js";
import * as sweepersOps from "./engine/sweepersOps.js";
import * as lifecycleOps from "./engine/lifecycleOps.js";
import type { ModeStats } from "./bench/regression.js";
import type { CodeRecallResult } from "./bench/code-recall.js";
import type { RetrievalMetrics } from "./bench/code-scale.js";
import type { CursorPaginationOptions, DiagnosticsBundle, EvidenceListFilters, IMemoryStore, MemoryListFilters, OperationLogFilters } from "@kinqs/brainrouter-types";
import type { TenancyStore, EmailAuthStore, OrgPersonaStore, MemorySharingStore, ProjectStore, AdminConsoleStore } from "../tenancy/store.js";
import type { ProviderStore } from "../providers/store.js";
import type { ModelPolicyStore } from "../providers/modelPolicyStore.js";
import type { RemoteAccessStore } from "../remote/store.js";
import type { IntegrationStore } from "../integrations/store.js";
import type { ConnectorStore } from "../connectors/store.js";
import { resolveGithubAccountToken } from "../connectors/githubAccountToken.js";
import { isSsrfBlockedHost } from "../connectors/gitlabTrackProxy.js";
import { resolveProviderConfig } from "../providers/resolver.js";
import { seedProvidersFromEnv } from "../providers/seed.js";
import { systemProviderOrgId } from "../providers/runtime.js";
import { modelGateway, resolveScopedModelSelection, ScopedModelSelectionError } from "../services/modelGateway/modelGateway.js";
import { MemoryCapturePipeline } from "./capture.js";
import { MemoryRecallPipeline } from "./recall.js";
import { MemoryJobRunner } from "./scheduler/runner.js";
import { EmbeddingService } from "./store/embedding.js";
import { RerankerService } from "./store/reranker.js";
import { RelevanceJudgeService } from "./store/relevance-judge.js";
import { scanSkillsForHints } from "./skills/skill-hints-loader.js";
import { distillFocusScenes } from "./pipeline/focus/contextual-focus-builder.js";
import { planGovernance, planStorageGovernance, type GovernancePlanFilters, type GovernancePlanResult, type StorageGovernanceStats, type StorageGovernanceResult } from "./governance/governance-plan.js";
import { distillCoreIdentity } from "./pipeline/identity/identity-distiller.js";
import { distillOrgPersona } from "./pipeline/identity/org-identity-distiller.js";
import { spikeSkill as spikeSkillActivation } from "./pipeline/skill/skill-prewarm.js";
import type { LLMRunner } from "@kinqs/brainrouter-types";
import { ModelLLMRunner } from "./llm/modelRunner.js";
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import type { CognitiveRecord, MemoryEvidence, MemoryImport, MemoryOperation, MemoryStatus, MemoryType, SourceChunk, SourceDocument, UserRecord, BlackboardItem, BlackboardItemInput, BlackboardStatus, MemoryTreeNode, MemoryTreeKind, RelatedChunkHit } from "@kinqs/brainrouter-types";

export class MemoryEngine {
  public readonly store: IMemoryStore;
  /**
   * ADR-007 Phase 2 (step 3) — the awaited init lifecycle. The constructor can't
   * be async, so it kicks off `#initialize()` and stashes the promise here.
   * Callers (production startup, tests) MUST `await engine.ready` (or
   * `engine.init()`) before the first store-using call: with Postgres the store
   * is genuinely async, so migrations / `initVec` / seed-admin are not done when
   * the constructor returns. Pipelines created in the constructor only *touch*
   * the store on use, which is always after readiness, so they're safe to build
   * eagerly.
   */
  public readonly ready: Promise<void>;
  private capturePipeline: MemoryCapturePipeline;
  private recallPipeline: MemoryRecallPipeline;
  /** MEM-19 — kept to query reranker/judge readiness when picking benchmark modes. */
  private rerankerService!: RerankerService;
  private relevanceJudge!: RelevanceJudgeService;
  private embeddingService!: EmbeddingService; // MEM-VEC — reused for embed-on-import
  private extractionRunner: LLMRunner;
  private synthesisRunner: LLMRunner;
  private securityReviewRunner: LLMRunner;
  private codeReviewRunner: LLMRunner;
  private pentestReviewRunner: LLMRunner;
  private reviewAssignments: Record<"security" | "code" | "pentest", { maxDiffChars?: number; timeoutMs?: number }> = { security: {}, code: {}, pentest: {} };
  private sweeperTimer?: NodeJS.Timeout;
  private activeSessionSweeperTimer?: NodeJS.Timeout;
  private sessionInboxSweeperTimer?: NodeJS.Timeout;
  /** Set by close() so it (and store.close()) run at most once. */
  private closed = false;
  private jobRunner?: MemoryJobRunner;
  /**
   * Reentrancy guard: setInterval doesn't wait for the previous callback to
   * finish before firing the next tick. If a sweep takes longer than the
   * configured interval (very common when LLM calls queue behind the
   * concurrency semaphore), ticks pile up and each one tries to extract
   * the SAME backlog rows. The guard ensures at most one sweep is in flight
   * at any time; later ticks become no-ops while a previous one runs.
   */
  private sweepInProgress = false;

  private personaCache: Map<string, { personaMd: string; cachedAt: number }> = new Map();
  // ADR-014 P-C — team consensus persona cache, keyed by orgId (never mixes with
  // the per-user personaCache above, so `you-in-team-A` ≠ `you-in-team-B`).
  private orgPersonaCache: Map<string, { personaMd: string; cachedAt: number }> = new Map();
  private readonly PERSONA_CACHE_TTL_MS = parseInt(
    process.env.BRAINROUTER_PERSONA_CACHE_TTL_MS ?? String(60 * 60 * 1000), 10
  );

  constructor(store?: IMemoryStore) {
    // ADR-007 Phase 2 (step 3) — Postgres is the only memory store. A test (or
    // an embedder) may inject an IMemoryStore; otherwise we build a
    // PostgresMemoryStore from BRAINROUTER_DATABASE_URL / DATABASE_URL. SQLite is
    // gone, so a connection string is REQUIRED when no store is injected.
    if (store) {
      this.store = store;
    } else {
      const url = pgUrlFromEnv();
      if (!url) {
        throw new Error(
          "[BrainRouter] BRAINROUTER_DATABASE_URL (or DATABASE_URL) is required: " +
            "the memory engine runs on Postgres (SQLite has been removed). " +
            "Set a Postgres connection string, e.g. postgres://user:pass@host:5432/brainrouter",
        );
      }
      this.store = new PostgresMemoryStore(url);
    }

    this.extractionRunner = new ModelLLMRunner(
      process.env.BRAINROUTER_EXTRACTION_MODEL
    );
    this.synthesisRunner = new ModelLLMRunner(
      process.env.BRAINROUTER_SYNTHESIS_MODEL
    );
    this.securityReviewRunner = new ModelLLMRunner();
    this.codeReviewRunner = new ModelLLMRunner();
    this.pentestReviewRunner = new ModelLLMRunner();

    // REFAC-ENGINE-SPLIT (0.4.17) — every env-configured service + pipeline is
    // built in lifecycleOps.buildServices; the engine just wires the results
    // onto its fields (readiness of the reranker/judge/embedder still drives
    // benchmark modes + embed-on-import).
    const svc = lifecycleOps.buildServices(
      this.store,
      this.extractionRunner,
      this.synthesisRunner,
      (orgId, userId) => orgId
        ? this.modelRunner("extraction", orgId)
        : this.scheduledModelRunner(userId, "extraction"),
    );
    this.capturePipeline = svc.capturePipeline;
    this.recallPipeline = svc.recallPipeline;
    this.rerankerService = svc.rerankerService; // MEM-19 — readiness drives benchmark mode selection
    this.embeddingService = svc.embeddingService; // MEM-VEC — embed-on-import reuse
    this.relevanceJudge = svc.relevanceJudge;
    this.relevanceJudge.setRunnerResolver((orgId) => this.modelRunner("judge", orgId));

    // ADR-007 Phase 2 (step 3) — single awaited init chain. With Postgres the
    // store is genuinely async, so migrations + vec init + seed-admin must be
    // awaited before the first store-using call. Callers `await engine.ready`
    // (or `engine.init()`); the stale-vector reembed is kicked off in the
    // background after readiness so it never blocks startup.
    this.ready = this.#initialize();
    // Observe the background init promise so a LATE rejection — e.g. the pool
    // being closed during process / test-suite teardown while `#initialize` is
    // still inside `initVec` ("Cannot use a pool after calling end on the pool")
    // — never escapes as an unhandledRejection that crashes an unrelated test.
    // Callers that explicitly `await engine.ready` (the server bootstrap) still
    // receive and handle the real error; this only defuses the unobserved path.
    void this.ready.catch(() => { /* observed: real awaiters of `ready` still see it */ });

    this.startExtractionSweeper();
    this.startActiveSessionSweeper();
    this.startSessionInboxSweeper();
    this.startJobRunner();
  }

  /** Run the store lifecycle (migrations → initVec → seed-admin) + bg reembed; see engine/lifecycleOps.ts. */
  async #initialize(): Promise<void> {
    await lifecycleOps.initialize(this);
    // ADR-012 — one-time migration: seed the system org's DB providers from any
    // legacy BRAINROUTER_* env (idempotent; skips kinds already DB-configured),
    // then resolve + apply the DB provider configs onto the services. After this,
    // providers are DB-only; the env vars are dead.
    try { await seedProvidersFromEnv(this.providers, systemProviderOrgId()); } catch { /* best-effort */ }
    await this.applyProviderOverrides();
  }

  /**
   * Await the engine's init lifecycle. Production startup and tests should call
   * this (or `await engine.ready`) before the first store-using call. Idempotent
   * — it just awaits the shared `ready` promise.
   */
  public async init(): Promise<void> {
    await this.ready;
  }

  /**
   * Stop all background work (sweepers + job runner) and close the store's
   * connection pool. Idempotent and safe to call before `ready` settles: it
   * first awaits the in-flight init (catching any failure) so we never end the
   * pool mid-`#initialize`. After `close()` the engine must not be reused —
   * callers go through `getMemoryEngine()` / the `memoryEngine` proxy, which
   * lazily reconstructs a fresh instance on next use.
   */
  /**
   * Liveness probe for the status gateway — a trivial round-trip to the backing
   * store. Injected/non-Postgres stores (tests) have no `ping` and are treated as
   * live. Never throws.
   */
  public async ping(): Promise<boolean> {
    const s = this.store as unknown as { ping?: () => Promise<boolean> };
    if (typeof s.ping !== "function") return true;
    try { return await s.ping(); } catch { return false; }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => { /* let init settle; don't close the pool mid-migration */ });
    if (this.sweeperTimer) { clearInterval(this.sweeperTimer); this.sweeperTimer = undefined; }
    if (this.activeSessionSweeperTimer) { clearInterval(this.activeSessionSweeperTimer); this.activeSessionSweeperTimer = undefined; }
    if (this.sessionInboxSweeperTimer) { clearInterval(this.sessionInboxSweeperTimer); this.sessionInboxSweeperTimer = undefined; }
    this.jobRunner?.stop();
    this.jobRunner = undefined;
    await this.store.close();
  }

  /** BRAIN-P1 — start the async job runner that drains out-of-band `memory_jobs`; see engine/lifecycleOps.ts. */
  private startJobRunner() {
    lifecycleOps.startJobRunner(this);
  }

  // 0.4.3 — scheduled-maintenance cadence (own throttle, independent of the
  // much faster drain interval). Do real work at most every 5 min; export the
  // vault ~hourly (every 12th pass) since it rescans records each run.
  private maintenanceLastAt = 0;
  private maintenancePass = 0;
  /** MEM-10b — throttle for the relevance_judge observability heartbeat. */
  private relevanceJudgeLastJobAt = 0;

  /** MEM-10 — auto-enqueue the throttled maintenance depth agents per active user; see engine/maintenanceOps.ts. */
  public enqueueScheduledMaintenance(force = false): Promise<{ enqueued: Record<string, number>; skipped?: boolean }> {
    return maintenanceOps.enqueueScheduledMaintenance(this, force);
  }

  /** MEM-20 tree_sealer auto-trigger — leaf mature scenes + return sealable buckets; see engine/vaultOps.ts. */
  public autobuildSceneTree(userId: string): Promise<{ leafed: number; sealableBucket: string[] | null }> {
    return vaultOps.autobuildSceneTree(this, userId);
  }

  private async ensureSeedAdminUser() {
    return lifecycleOps.ensureSeedAdminUser(this);
  }

  public get capture() {
    return this.capturePipeline.captureTurn.bind(this.capturePipeline);
  }

  public capturePassiveL0(params: {
    userId: string;
    sessionKey: string;
    sessionId?: string;
    role: string;
    content: string;
    timestamp?: number;
    skillTag?: string;
  }) {
    return memoryOps.capturePassiveL0(this, params);
  }

  public async explainRecall(params: Parameters<MemoryRecallPipeline['recall']>[0]) {
    return this.recallPipeline.recall({ ...params, explain: true });
  }

  public get recall() {
    return (params: Parameters<MemoryRecallPipeline['recall']>[0]) => lifecycleOps.recallWithDecorations(this, params);
  }

  public getPendingContradictions(
    userId: string,
    pagination?: CursorPaginationOptions<{ confidence: number; id: string }>,
    statusFilter?: "pending" | "resolved" | "dismissed" | "all"
  ) {
    return this.store.getPendingContradictions(userId, pagination, statusFilter);
  }

  public resolveContradiction(id: string, userId: string, status: 'resolved' | 'dismissed') {
    return this.store.resolveContradiction(id, userId, status);
  }

  public registerSkillHints(skillName: string, hints: string, sourceFile = "") {
    return this.store.upsertSkillHints(skillName, hints, sourceFile);
  }

  public listSkillHints() {
    return this.store.listSkillHints();
  }

  public spikeSkill(userId: string, skillName: string) {
    return spikeSkillActivation({ userId, skillName, store: this.store });
  }

  public async getSkillActivations(userId: string) {
    return memoryOps.getSkillActivations(this, userId);
  }

  public autoScanSkillHints(skillsDirs: string[]) {
    let loaded = 0;
    for (const dir of skillsDirs) {
      if (!fs.existsSync(dir)) continue;
      const found = scanSkillsForHints(dir);
      for (const item of found) {
        const skillName = item.name || path.basename(path.dirname(item.filePath));
        this.store.upsertSkillHints(skillName, item.hints, item.filePath);
        loaded++;
      }
    }
    if (loaded > 0) {
      console.error(`[BrainRouter] Auto-loaded memory_hints for ${loaded} skill(s).`);
    }
  }

  /** On-demand Focus Scene distillation — groups cognitives by scene and summarizes via LLM. */
  public async distillScenes(userId: string) {
    return distillFocusScenes({ userId, store: this.store, llmRunner: this.synthesisRunner });
  }

  /** On-demand Core Identity distillation — cross-session synthesis of persona+instruction cognitives. */
  public async distillPersona(userId: string) {
    const result = await distillCoreIdentity({ userId, store: this.store, llmRunner: this.synthesisRunner });
    if (result.success && result.personaMd) {
      this.personaCache.set(userId, { personaMd: result.personaMd, cachedAt: Date.now() });
    }
    return result;
  }

  /** On-demand Team consensus persona distillation (ADR-014 P-C). */
  public async distillOrgPersona(orgId: string) {
    const result = await distillOrgPersona({ orgId, store: this.orgPersona, llmRunner: this.synthesisRunner });
    if (result.success && result.personaMd) {
      this.orgPersonaCache.set(orgId, { personaMd: result.personaMd, cachedAt: Date.now() });
    }
    return result;
  }

  /**
   * The Team consensus persona (cached), distilling on-demand if none exists yet.
   * Returns null when the team has no shared persona/instruction memories.
   */
  public async getOrgPersona(orgId: string): Promise<{ personaMd: string } | null> {
    const cached = this.orgPersonaCache.get(orgId);
    if (cached && (Date.now() - cached.cachedAt) < this.PERSONA_CACHE_TTL_MS) {
      return { personaMd: cached.personaMd };
    }
    let rec = await this.orgPersona.getOrgIdentity(orgId);
    if (!rec) {
      const distilled = await this.distillOrgPersona(orgId);
      if (distilled.success && distilled.personaMd) return { personaMd: distilled.personaMd };
      return null;
    }
    this.orgPersonaCache.set(orgId, { personaMd: rec.personaMd, cachedAt: Date.now() });
    return { personaMd: rec.personaMd };
  }

  /** Get the current Core Identity for a user, using prompt-level in-memory cache. */
  public async getPersona(userId: string) {
    const cached = this.personaCache.get(userId);
    if (cached && (Date.now() - cached.cachedAt) < this.PERSONA_CACHE_TTL_MS) {
      return { personaMd: cached.personaMd };
    }

    const persona = await this.store.getCoreIdentity(userId);
    if (persona) {
      this.personaCache.set(userId, { personaMd: persona.personaMd, cachedAt: Date.now() });
    }
    return persona;
  }

  /** Get the top N active focus scenes for a user (ordered by heat score). */
  public getTopScenes(userId: string, limit = 3, cursor?: { heatScore: number; id: string }) {
    return this.store.getTopContextualFocus(userId, limit, cursor);
  }

  /** Expose the ability to query the knowledge graph for a user/entity. */
  public async queryGraph(userId: string, entity: string, skillTag?: string, maxHops = 2) {
    const node = await this.store.getGraphNodeByEntity(userId, entity);
    if (!node) return { nodes: [], edges: [] };
    return this.store.getGraphNeighbors(userId, node.id, skillTag, maxHops);
  }

  /**
   * DASH-1 (0.4.4) — graph analytics lenses over the user's GraphRAG store:
   * PageRank centrality (most load-bearing entities), articulation points
   * (broker/bridge entities), a namespace overview (counts by entity type), and
   * an optional shortest connection path between two entities ("how is A related
   * to B"). Pure compute (graph-analytics.ts); read-only.
   */
  public graphAnalytics(
    userId: string,
    opts?: { topN?: number; from?: string; to?: string },
  ): Promise<{
    nodeCount: number;
    edgeCount: number;
    topCentral: Array<{ entity: string; entityType: string; score: number }>;
    bridges: Array<{ entity: string; entityType: string }>;
    namespaces: Record<string, number>;
    path?: { from: string; to: string; found: boolean; entities: string[] };
  }> {
    return memoryOps.graphAnalytics(this, userId, opts);
  }

  /**
   * ADR-010 P1 — the org/membership surface. The backend always runs on
   * `PostgresMemoryStore` (SQLite removed, ADR-007), which implements
   * `TenancyStore` alongside `IMemoryStore`; the shared `IMemoryStore` type has
   * no org concept, so this is the one localized cast that exposes it.
   */
  public get tenancy(): TenancyStore {
    return this.store as unknown as TenancyStore;
  }

  /** ADR-014 P-B2 — email/auth store: SMTP settings, verification tokens, invites. */
  public get emailAuth(): EmailAuthStore {
    return this.store as unknown as EmailAuthStore;
  }

  /** The active embedding dimension (0 if unbuilt) — for the embedder-swap guard. */
  public getEmbeddingDimensions(): number {
    const s = this.store as unknown as { getVecDimensions?: () => number };
    return typeof s.getVecDimensions === "function" ? s.getVecDimensions() : 0;
  }

  /** ADR-014 P-C — team consensus persona store. */
  public get orgPersona(): OrgPersonaStore {
    return this.store as unknown as OrgPersonaStore;
  }

  /** ADR-014 P-D — artifact/memory sharing store. */
  public get sharing(): MemorySharingStore {
    return this.store as unknown as MemorySharingStore;
  }

  /** ADR-014 P-E — projects + per-project access control store. */
  public get projects(): ProjectStore {
    return this.store as unknown as ProjectStore;
  }

  /** ADR-014 P-F — admin console + audit trail store. */
  public get adminConsole(): AdminConsoleStore {
    return this.store as unknown as AdminConsoleStore;
  }

  /** ADR-010 P2 — DB-backed provider configs (see {@link tenancy} for the cast rationale). */
  public get providers(): ProviderStore {
    return this.store as unknown as ProviderStore;
  }

  /** Organization-scoped server-managed model catalog and policy store. */
  public get models(): ModelPolicyStore {
    return this.store as unknown as ModelPolicyStore;
  }

  /** Tenant-scoped remote device identities, rotating sessions, grants, and audit. */
  public get remote(): RemoteAccessStore {
    return this.store as unknown as RemoteAccessStore;
  }

  /** ADR-010 P6 — org-scoped external integrations (GitHub App, …). */
  public get integrations(): IntegrationStore {
    return this.store as unknown as IntegrationStore;
  }

  /** ADR-016 C2 — per-user connectors + sealed OAuth tokens (server-side). */
  public get connectors(): ConnectorStore {
    return this.store as unknown as ConnectorStore;
  }

  /**
   * ADR-010 P2 — the ".env retired" cutover. Resolve the system org's DB provider
   * configs (llm/embedding/reranker/judge) and apply any that exist over the
   * env-built singletons. Applied ONLY when a DB row exists (source==='db'), so an
   * env-only deployment is byte-identical to before. Called after seed on startup
   * and after an admin writes a provider config (so it takes effect without a
   * restart). Best-effort — a DB hiccup leaves the env config in place.
   */
  public async applyProviderOverrides(): Promise<void> {
    const orgId = systemProviderOrgId();
    const store = this.providers;
    try {
      const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
      // Brain agent-models (BRAIN_AGENT_ROLES): per-role model overrides on the
      // shared LLM provider (extraction / synthesis / judge are brain sub-agents).
      const assigns = (await this.emailAuth.getSetting<Record<string, { provider?: string; model?: string; maxDiffChars?: number; timeoutMs?: number }>>(`agentModels:${orgId}`)) ?? {};
      const bind = async (runner: LLMRunner, role: string) => {
        // Managed model when configured, else the org's DB provider (backward-compat).
        await this.configureRunner(runner as ModelLLMRunner, role, orgId, str(assigns[role]?.model));
      };
      await bind(this.extractionRunner, "extraction");
      await bind(this.synthesisRunner, "synthesis");
      await bind(this.securityReviewRunner, "security-review");
      await bind(this.codeReviewRunner, "code-review");
      await bind(this.pentestReviewRunner, "pentest");
      for (const [lens, role] of [["security", "security-review"], ["code", "code-review"], ["pentest", "pentest"]] as const) {
        const assign = assigns[role] ?? {};
        this.reviewAssignments[lens] = {
          ...(typeof assign.maxDiffChars === "number" ? { maxDiffChars: assign.maxDiffChars } : {}),
          ...(typeof assign.timeoutMs === "number" ? { timeoutMs: assign.timeoutMs } : {}),
        };
      }
      modelGateway.configureScoped("llm", true);
      modelGateway.configureScoped("judge", true);
      const emb = await resolveProviderConfig(store, orgId, "embedding");
      if (emb?.source === "db") this.embeddingService.reconfigure({ endpoint: emb.endpoint, apiKey: emb.apiKey, model: emb.model });
      if (emb) modelGateway.configure("embedding", { endpoint: emb.endpoint, apiKey: emb.apiKey, model: emb.model });
      const rer = await resolveProviderConfig(store, orgId, "reranker");
      if (rer?.source === "db") this.rerankerService.reconfigure({ endpoint: rer.endpoint, apiKey: rer.apiKey, model: rer.model });
      if (rer) modelGateway.configure("reranker", { endpoint: rer.endpoint, apiKey: rer.apiKey, model: rer.model });
    } catch {
      /* best-effort — keep the env-built config on any DB error */
    }
  }

  /**
   * Build a job-local review runner for the requesting org. A shared mutable
   * runner would let simultaneous organizations overwrite each other's provider
   * assignment, so only the system-org runners are long-lived; queued reviews get
   * an isolated configured runner.
   */
  public async reviewRunner(lens: "security" | "code" | "pentest", orgId = systemProviderOrgId()): Promise<LLMRunner> {
    return this.modelRunner(lens === "security" ? "security-review" : lens === "code" ? "code-review" : "pentest", orgId);
  }

  /**
   * Bind a runner to the org's model for `role`. Prefers a server-managed model
   * (dispatch via the internal gateway); but if the org has NO `provider_models`
   * policy yet, falls back to dispatching its DB provider config directly — the
   * pre-Task-11 (ADR-012) behavior. Without this, every internal LLM call
   * (reviews, meetings, extraction) hard-fails with "No managed model is
   * configured" for any org that hasn't set up managed models. Throws only when
   * NEITHER a managed model NOR a DB provider exists.
   */
  private async configureRunner(runner: ModelLLMRunner, role: string, orgId: string, assignedModel?: string): Promise<void> {
    try {
      const selection = await resolveScopedModelSelection({ store: this.models, orgId, assignedModel });
      runner.setProviderOverride(null);
      runner.setScopedBinding({
        orgId: selection.orgId,
        servicePrincipalId: selection.servicePrincipalId,
        publicModelId: selection.publicModelId,
        reasoningEffort: selection.reasoningEffort,
      });
    } catch (error) {
      if (!(error instanceof ScopedModelSelectionError)) throw error;
      const provider = await resolveProviderConfig(this.providers, orgId, "llm");
      if (!provider) throw error; // truly nothing configured — surface the real reason
      runner.setScopedBinding(null);
      runner.setProviderOverride({
        endpoint: provider.endpoint, apiKey: provider.apiKey, model: provider.model, wireFormat: provider.wireFormat,
        fallbackModel: typeof provider.extra?.fallbackModel === "string" ? provider.extra.fallbackModel : undefined,
        fallbackEndpoint: typeof provider.extra?.fallbackEndpoint === "string" ? provider.extra.fallbackEndpoint : undefined,
        fallbackApiKey: typeof provider.extra?.fallbackApiKey === "string" ? provider.extra.fallbackApiKey : undefined,
      });
      runner.setModelOverride(assignedModel);
    }
  }

  /** Construct one immutable org-scoped worker runner (managed model, else DB provider). */
  public async modelRunner(role: string, orgId = systemProviderOrgId()): Promise<LLMRunner> {
    const assigns = (await this.emailAuth.getSetting<Record<string, { model?: string }>>(`agentModels:${orgId}`)) ?? {};
    const runner = new ModelLLMRunner();
    await this.configureRunner(runner, role, orgId, typeof assigns[role]?.model === "string" ? assigns[role].model : undefined);
    return runner;
  }

  /** Scheduled user jobs inherit the user's current default organization. */
  public async scheduledModelRunner(userId: string, role = "synthesis"): Promise<LLMRunner> {
    const orgId = await this.tenancy.getDefaultOrgId(userId);
    return this.modelRunner(role, orgId ?? systemProviderOrgId());
  }

  /** Non-secret per-lens execution knobs, loaded in the same org scope as the runner. */
  public async reviewAssignment(lens: "security" | "code" | "pentest", orgId = systemProviderOrgId()): Promise<{ maxDiffChars?: number; timeoutMs?: number }> {
    if (orgId === systemProviderOrgId()) return this.reviewAssignments[lens];
    const assigns = (await this.emailAuth.getSetting<Record<string, { maxDiffChars?: unknown; timeoutMs?: unknown }>>(`agentModels:${orgId}`)) ?? {};
    const assign = assigns[lens === "security" ? "security-review" : lens === "code" ? "code-review" : "pentest"] ?? {};
    return { ...(typeof assign.maxDiffChars === "number" ? { maxDiffChars: assign.maxDiffChars } : {}), ...(typeof assign.timeoutMs === "number" ? { timeoutMs: assign.timeoutMs } : {}) };
  }

  /** Resolve an immutable, org-scoped LLM configuration for an unattended
   * agentic pentest. The key is returned only to the in-process executor and is
   * never written into the job payload or progress stream. */
  public async pentestAgentConfig(orgId: string): Promise<{ provider: string; apiKey: string; model: string; endpoint?: string } | null> {
    const assignments = (await this.emailAuth.getSetting<Record<string, { provider?: string; model?: string }>>(`agentModels:${orgId}`)) ?? {};
    const assignment = assignments.pentest ?? {};
    const record = assignment.provider ? await this.providers.getProviderConfig(assignment.provider) : null;
    const selected = record?.orgId === orgId && assignment.provider ? await this.providers.getResolvedProvider(assignment.provider) : null;
    const resolved = selected ?? await resolveProviderConfig(this.providers, orgId, "llm");
    if (!resolved) return null;
    return {
      provider: record?.providerId ?? "openai-compatible",
      apiKey: resolved.apiKey,
      model: assignment.model?.trim() || resolved.model,
      ...(resolved.endpoint ? { endpoint: resolved.endpoint } : {}),
    };
  }

  public createUser(userId: string, apiKey: string, displayName = "", isAdmin = false): Promise<UserRecord> {
    return this.store.createUser(userId, apiKey, displayName, isAdmin);
  }

  public getUserByApiKey(apiKey: string): Promise<UserRecord | null> {
    return this.store.getUserByApiKey(apiKey);
  }

  public getUserByEmail(email: string): Promise<UserRecord | null> {
    return this.store.getUserByEmail(email);
  }

  public getUserById(userId: string): Promise<UserRecord | null> {
    return this.store.getUserById(userId);
  }

  public updatePassword(userId: string, hash: string): Promise<void> {
    return this.store.updateUserPassword(userId, hash);
  }

  public updateUserEmail(userId: string, email: string): Promise<void> {
    return this.store.updateUserEmail(userId, email);
  }

  public updateUserDisplayName(userId: string, displayName: string): Promise<void> {
    return this.store.updateUserDisplayName(userId, displayName);
  }

  public updateUserStatus(userId: string, status: "active" | "disabled"): Promise<void> {
    return this.store.updateUserStatus(userId, status);
  }

  public updateUserApiKey(userId: string, apiKey: string): Promise<void> {
    return this.store.updateUserApiKey(userId, apiKey);
  }

  public listUsers(pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): Promise<UserRecord[]> {
    return this.store.listUsers(pagination);
  }

  public deleteUser(userId: string): Promise<void> {
    return this.store.deleteUser(userId);
  }

  public listMemories(
    userId: string,
    filters?: MemoryListFilters,
    pagination?: CursorPaginationOptions<{ createdTime: string; recordId: string }>
  ) {
    return this.store.listMemories(userId, filters, pagination);
  }

  public deleteMemory(userId: string, recordId: string) {
    return this.store.archiveCognitiveRecord(userId, recordId);
  }

  public async getMemoryById(userId: string, recordId: string) {
    return memoryOps.getMemoryById(this, userId, recordId);
  }

  public upsertEngineeringMemory(params: {
    userId: string;
    sessionKey?: string;
    sessionId?: string;
    type: MemoryType;
    content: string;
    priority?: number;
    activeSkill?: string;
    confidence?: number;
    sourceKind?: CognitiveRecord["sourceKind"];
    verificationStatus?: CognitiveRecord["verificationStatus"];
    repoPaths?: string[];
    filePaths?: string[];
    commands?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<CognitiveRecord> {
    return memoryOps.upsertEngineeringMemory(this, params);
  }

  /**
   * Ingest verified pentest findings into the org's cognitive memory so future
   * scans and code reviews can recall "we already found X against this target".
   * Routes every record through upsertEngineeringMemory (the redaction + length
   * chokepoint — Bearer/sk-/ghp_/PEM/API_KEY/IPv4 in a PoC are scrubbed), then
   * promotes it to org visibility so the whole org can recall it. Best-effort;
   * findings whose final status is dismissed/disputed/out-of-scope are skipped.
   */
  public async recordPentestFindings(params: {
    orgId: string;
    userId: string;
    target: string;
    reviewId: string;
    findings: Array<{
      id: string; severity: string; summary: string; details?: string;
      file?: string; line?: number; cvss?: number; cvssVector?: string;
      cwe?: string; cve?: string; poc?: string; remediation?: string;
      status?: string; confidence?: number;
    }>;
  }): Promise<number> {
    const skip = new Set(["dismissed", "disputed", "out-of-scope"]);
    let recorded = 0;
    // Bound org-memory writes so a hostile target that steers the agent into
    // emitting a huge finding set cannot amplify into unbounded ingestion.
    for (const f of params.findings.slice(0, 100)) {
      if (f.status && skip.has(f.status)) continue;
      // NOTE: the raw proof-of-concept is deliberately NOT composed into this
      // org-shared record — a captured session cookie / JWT / cloud key inside a
      // PoC would otherwise be promoted org-wide into recall + briefings, and the
      // memory redaction denylist cannot catch every secret shape. The full PoC
      // stays only in the local workspace SARIF (.brainrouter/findings.sarif).
      const content = [
        `SECURITY FINDING (${String(f.severity).toUpperCase()}): ${f.summary}`,
        f.cwe ? `CWE: ${f.cwe}` : "",
        typeof f.cvss === "number" ? `CVSS: ${f.cvss}${f.cvssVector ? ` (${f.cvssVector})` : ""}` : "",
        f.file ? `Location: ${f.file}${f.line ? `:${f.line}` : ""}` : "",
        `Target: ${params.target}`,
        f.details ? `Impact: ${f.details.slice(0, 1200)}` : "",
        f.remediation ? `Remediation: ${f.remediation.slice(0, 800)}` : "",
      ].filter(Boolean).join("\n");
      const rec = await this.upsertEngineeringMemory({
        userId: params.userId,
        type: "bug_finding",
        content,
        priority: f.severity === "critical" ? 95 : f.severity === "high" ? 90 : 75,
        confidence: Math.max(0.5, Math.min(1, (f.confidence ?? 70) / 100)),
        sourceKind: "model_inference",
        verificationStatus: f.poc ? "verified" : "unverified",
        filePaths: f.file ? [f.file] : [],
        metadata: { kind: "pentest-finding", source: "pentest", cwe: f.cwe, cve: f.cve, cvss: f.cvss, severity: f.severity, target: params.target, reviewId: params.reviewId, findingId: f.id },
      });
      await this.sharing.setMemoryVisibility(rec.id, params.userId, params.orgId, "org");
      recorded += 1;
    }
    return recorded;
  }

  /** MEM-32 — record a durable, fingerprint-reinforcing lesson/insight; see lessons/lessonOps.ts. */
  public recordLesson(
    userId: string,
    text: string,
    opts?: { sessionKey?: string; activeSkill?: string; evidence?: string; priority?: number; kind?: string; supersedes?: string | string[] },
  ): Promise<{ recordId: string; reinforced: boolean; confidence: number; corroborations: number; supersededIds: string[] }> {
    return lessonOps.recordLesson(this, userId, text, opts);
  }

  /** LESSON-HYGIENE — deterministically find live lessons that conflict with `text`; see lessons/lessonOps.ts. */
  public findLessonConflicts(userId: string, text: string): Promise<CognitiveRecord[]> {
    return lessonOps.findLessonConflicts(this, userId, text);
  }

  /** LESSON-HYGIENE — conservative staleness sweep (opt-in archive); see lessons/lessonOps.ts. */
  public sweepStaleLessons(
    userId: string,
    opts?: { apply?: boolean; thresholds?: Partial<StalenessThresholds>; nowMs?: number; limit?: number },
  ): Promise<{ candidates: Array<{ recordId: string; reason: string; lastCitedAt: string | null; confidence: number }>; archived: number }> {
    return lessonOps.sweepStaleLessons(this, userId, opts);
  }

  /** B6 `/memory verify` — classify code-anchored records fresh/reanchorable/archivable; see engine/memoryOps.ts. */
  public verifyMemories(
    userId: string,
    opts?: { apply?: boolean; limit?: number },
  ): Promise<{
    total: number;
    fresh: number;
    reanchorable: number;
    archivable: number;
    archived: number;
    sample: Array<{ recordId: string; status: "fresh" | "reanchorable" | "archivable"; filePath: string | null }>;
  }> {
    return memoryOps.verifyMemories(this, userId, opts);
  }

  /** MEM-33 — distill + store a reusable skill (SOP) from a session; see engine/memoryOps.ts. */
  public extractSkillFromSession(
    userId: string,
    opts: {
      sessionSummary: string;
      sessionKey?: string;
      activeSkill?: string;
      llm?: (params: { prompt: string; systemPrompt?: string; timeoutMs?: number }) => Promise<string>;
    },
  ): Promise<{ extracted: boolean; recordId?: string; reinforced?: boolean; skill?: string }> {
    return memoryOps.extractSkillFromSession(this, userId, opts);
  }

  /** MEM-32b `reflect` — synthesize + store cross-memory insights via the synthesis LLM; see engine/memoryOps.ts. */
  public reflect(
    userId: string,
    opts?: { limit?: number; llm?: (params: { prompt: string; systemPrompt?: string; timeoutMs?: number }) => Promise<string> },
  ): Promise<{ reflected: number; insights: string[] }> {
    return memoryOps.reflect(this, userId, opts);
  }

  public getMemoriesByFilePath(userId: string, filePath: string, limit = 20): Promise<CognitiveRecord[]> {
    return this.store.getMemoriesByFilePath(userId, filePath, limit);
  }

  public searchMemoryRecords(userId: string, query: string, limit = 20) {
    return this.store.searchCognitiveFts(userId, query, limit);
  }

  public updateMemory(userId: string, recordId: string, updates: {
    content?: string;
    status?: MemoryStatus;
    confidence?: number;
    verificationStatus?: CognitiveRecord["verificationStatus"];
    note?: string;
  }) {
    return memoryOps.updateMemory(this, userId, recordId, updates);
  }

  public updateMemoryStatus(userId: string, recordId: string, confidence: number, status: MemoryStatus) {
    this.store.updateCognitiveConfidence(userId, recordId, confidence, status);
    return this.getMemoryById(userId, recordId);
  }

  public addEvidence(userId: string, recordId: string, evidence: Omit<MemoryEvidence, "id" | "userId" | "recordId" | "observedAt"> & { id?: string; observedAt?: string }) {
    return memoryOps.addEvidence(this, userId, recordId, evidence);
  }

  public getEvidence(userId: string, recordId: string) {
    return this.store.getEvidenceByRecord(userId, recordId);
  }

  public listEvidence(
    userId: string,
    filters?: EvidenceListFilters,
    pagination?: CursorPaginationOptions<{ observedAt: string; id: string }>
  ) {
    return this.store.listEvidence(userId, filters, pagination);
  }

  public exportMemories(userId: string) {
    return this.store.exportMemories(userId);
  }

  public importMemories(userId: string, data: MemoryImport) {
    return memoryOps.importMemories(this, userId, data);
  }

  public governanceDelete(userId: string, recordId: string, reason: string) {
    return this.store.hardDeleteMemory(userId, recordId, reason);
  }

  /**
   * MEM-11 — governance dry-run: preview which active memories a filter would
   * sweep, with counts + a size proxy + a sample, WITHOUT mutating anything.
   */
  public async governancePlan(userId: string, filters: GovernancePlanFilters): Promise<GovernancePlanResult> {
    const items = await this.store.listMemories(userId, { type: filters.type, archived: false });
    return planGovernance(items, filters, Date.now());
  }

  /**
   * MEM-21 — storage-governance dry-run across the 0.4.3 depth tables (source
   * chunks / documents / tree nodes / vault exports) with per-class reclaim
   * estimates. Read-only; capability-detected so a partial store mock degrades
   * to an empty plan.
   */
  public async governanceStoragePlan(userId: string): Promise<StorageGovernanceResult> {
    const store = this.store as Partial<{ getStorageGovernanceStats(u: string): Promise<StorageGovernanceStats> }>;
    if (typeof store.getStorageGovernanceStats !== "function") {
      return { classes: [], totalEstimatedChars: 0, totalReclaimableChars: 0 };
    }
    return planStorageGovernance(await store.getStorageGovernanceStats(userId));
  }

  // ── Blackboard commit pipeline (MEM-4) ──────────────────────────────────
  // Stage candidates → reconcile (dedup/score) → commit to cognitive records
  // with an audit trail, or reject. The blackboard store methods live on the
  // concrete store, so narrow at runtime (like the source capability).

  private blackboardStore(): {
    stageBlackboardItems(userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]>;
    getBlackboardItem(id: string): Promise<BlackboardItem | null>;
    getBlackboardItems(userId: string, status?: BlackboardStatus): Promise<BlackboardItem[]>;
    updateBlackboardItem(id: string, patch: { status?: BlackboardStatus; score?: number; conflictIds?: string[]; committedRecordId?: string | null }): Promise<void>;
  } | null {
    const s = this.store as any;
    return typeof s.stageBlackboardItems === "function" &&
      typeof s.getBlackboardItems === "function" &&
      typeof s.updateBlackboardItem === "function"
      ? s
      : null;
  }

  /** MEM-4 — stage extracted candidates for review before they become memory. */
  public stageBlackboardCandidates(userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]> {
    return blackboardOps.stageBlackboardCandidates(this, userId, items);
  }

  /** MEM-4 — reconcile all pending items (dedup/score/threshold) and persist the verdicts. */
  public reconcilePendingBlackboard(userId: string): Promise<{ reconciled: number; duplicate: number; rejected: number; items: BlackboardItem[] }> {
    return blackboardOps.reconcilePendingBlackboard(this, userId);
  }

  /** MEM-4 — promote a reconciled item to a cognitive record (with audit), linking its source chunk. */
  public commitBlackboardItem(userId: string, itemId: string): Promise<{ committed: boolean; recordId?: string; reason?: string }> {
    return blackboardOps.commitBlackboardItem(this, userId, itemId);
  }

  /** MEM-4 — drop an item without committing it. */
  public rejectBlackboardItem(userId: string, itemId: string): Promise<boolean> {
    return blackboardOps.rejectBlackboardItem(this, userId, itemId);
  }

  /**
   * BLACKBOARD-REVIEW-UX (0.4.5) — un-drop a candidate that was rejected or
   * deduped (`duplicate`) in error: move it back to `pending` for re-review.
   */
  public restoreBlackboardItem(userId: string, itemId: string): Promise<{ restored: boolean; reason?: string; status?: BlackboardStatus }> {
    return blackboardOps.restoreBlackboardItem(this, userId, itemId);
  }

  /** MEM-4 — list staged items (optionally by status) for review. */
  public reviewBlackboard(userId: string, status?: BlackboardStatus): Promise<BlackboardItem[]> {
    return blackboardOps.reviewBlackboard(this, userId, status);
  }

  // ── Memory tree (MEM-5) ─────────────────────────────────────────────────
  // Generic mechanics only — append a leaf, roll a bucket of children into a
  // summarized parent, and walk/drill. Policy (when to seal, source→topic→
  // global promotion) layers on top; the summarizer is deterministic here and
  // swappable for an LLM later.

  /** MEM-5 — append a leaf (level 0) summarizing some source chunks. */
  public appendTreeLeaf(userId: string, kind: MemoryTreeKind, summaryMd: string, sourceChunkIds: string[] = [], heatScore = 0): Promise<MemoryTreeNode | null> {
    return treeOps.appendTreeLeaf(this, userId, kind, summaryMd, sourceChunkIds, heatScore);
  }

  /** MEM-5 — seal a bucket: roll the given children into a summarized parent. */
  public summarizeBucket(userId: string, childIds: string[], kind: MemoryTreeKind): Promise<MemoryTreeNode | null> {
    return treeOps.summarizeBucket(this, userId, childIds, kind);
  }

  /** BRAIN-P4-T5 — global rollup digest (matures source → topic → global). */
  public rollupGlobalTree(userId: string): Promise<MemoryTreeNode | null> {
    return treeOps.rollupGlobalTree(this, userId);
  }

  /** MEM-5 / MEM-8 — walk the tree: a node + its children, or the roots of a kind. */
  public treeWalk(userId: string, nodeId?: string, kind?: MemoryTreeKind): Promise<{ node: MemoryTreeNode | null; children: MemoryTreeNode[]; roots?: MemoryTreeNode[] }> {
    return treeOps.treeWalk(this, userId, nodeId, kind);
  }

  // ── Vault mirror (MEM-7) ────────────────────────────────────────────────
  /** benchmark_eval job — self-retrieval regression benchmark; see engine/benchOps.ts. */
  public runRetrievalBenchmark(
    userId: string,
    opts?: { sampleSize?: number; baseDir?: string },
  ): Promise<{ summaryPath: string | null; statsByMode: Record<string, ModeStats>; sampled: number; passed: boolean; skippedModes: string[]; latencyMsByMode: Record<string, number> }> {
    return benchOps.runRetrievalBenchmark(this, userId, opts);
  }

  /** ADR-017 D5 — the org's GitHub App creds (config + opened secret) for a webhook installation. */
  public async findGithubAppByInstallation(installationId: string): Promise<{ config: Record<string, unknown>; secret: Record<string, string> } | null> {
    const r = await this.integrations.findIntegrationByInstallation("github_app", installationId);
    return r ? { config: r.config, secret: r.secret } : null;
  }

  /** Manual review jobs may reuse the requester's existing GitHub connector.
   * The sealed credential is resolved only inside the worker and never stored in
   * the job input or returned through an API. */
  public async findGithubAccountAuthorization(userId: string): Promise<{ token: string; apiBase: string } | null> {
    const account = await resolveGithubAccountToken(this.emailAuth, userId);
    return account ? { token: account.accessToken, apiBase: "https://api.github.com" } : null;
  }

  /** GitLab manual-review jobs resolve the requester's sealed OAuth connector
   * only inside the worker. The provider host is fixed by connector config and
   * must be HTTPS; neither it nor the credential is accepted from the job. */
  public async findGitlabAccountAuthorization(userId: string, orgId: string): Promise<{ token: string; apiBase: string; config: Record<string, unknown> } | null> {
    const rows = await this.connectors.listConnectors(userId);
    const row = rows.find((item) => item.orgId === orgId && item.source === "gitlab" && item.hasCredential);
    if (!row) return null;
    const resolved = await this.connectors.getResolvedConnector(row.id);
    const token = resolved?.credential?.accessToken?.trim();
    if (!resolved || !token) return null;
    let host: URL;
    try { host = new URL(typeof resolved.config.hostUrl === "string" && resolved.config.hostUrl.trim() ? resolved.config.hostUrl.trim() : "https://gitlab.com"); }
    catch { return null; }
    if (host.protocol !== "https:" || host.username || host.password) return null;
    if (isSsrfBlockedHost(host)) return null;
    const basePath = host.pathname.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
    return { token, apiBase: `${host.origin}${basePath}/api/v4`, config: resolved.config };
  }

  /** MEM-25 code-recall benchmark over built-in fixtures; see engine/benchOps.ts. */
  public runCodeChunkBenchmark(opts?: { baseDir?: string }): CodeRecallResult & { summaryPath: string | null } {
    return benchOps.runCodeChunkBenchmark(opts);
  }

  /** CODE-SCALE repo-scale find_related retrieval benchmark; see engine/benchOps.ts. */
  public runCodeScaleBenchmark(opts?: {
    baseDir?: string;
    userId?: string;
    k?: number;
    clusters?: number;
    perCluster?: number;
  }): Promise<RetrievalMetrics & { summaryPath: string | null }> {
    return benchOps.runCodeScaleBenchmark(this, opts);
  }

  /** source_chunker job — provenance-safe re-chunk of source docs; see engine/sourceOps.ts. */
  public rechunkSources(userId: string, documentIds: string[]): Promise<{ rechunked: number; skipped: number; chunksWritten: number }> {
    return sourceOps.rechunkSources(this, userId, documentIds);
  }

  /** Provenance-safe transcript retention (prune old unreferenced docs); see engine/sourceOps.ts. */
  public pruneTranscriptSources(userId: string, olderThanDays: number): Promise<{ prunedDocs: number; prunedChunks: number }> {
    return sourceOps.pruneTranscriptSources(this, userId, olderThanDays);
  }

  /** Export active records + tree nodes to a read-only, ledger-idempotent markdown vault; see engine/vaultOps.ts. */
  public exportVault(userId: string, baseDir?: string): Promise<{ dir: string; written: number; unchanged: number; total: number }> {
    return vaultOps.exportVault(this, userId, baseDir);
  }

  /** MEM-3 batch-level provenance — a record's source chunks as excerpts; see engine/sourceOps.ts. */
  public getRecordProvenance(userId: string, recordId: string): Promise<Array<{
    chunkId: string;
    documentId: string;
    excerpt: string;
    filePath: string | null;
    symbol: string | null;
    startLine: number | null;
    endLine: number | null;
  }>> {
    return sourceOps.getRecordProvenance(this, userId, recordId);
  }

  /** MEM-8 recall drill-down — fetch a source chunk + doc + optional ±N neighbours; see engine/sourceOps.ts. */
  public fetchSourceChunk(
    userId: string,
    chunkId: string,
    neighbors = 0,
  ): Promise<{ chunk: SourceChunk; document: SourceDocument | null; neighbors: SourceChunk[] } | null> {
    return sourceOps.fetchSourceChunk(this, userId, chunkId, neighbors);
  }

  /** MEM-29 find_related — exploration-driven cross-file code recall; see engine/sourceOps.ts. */
  public findRelatedChunks(
    userId: string,
    seed: { chunkId?: string; filePath?: string; line?: number },
    opts?: { limit?: number; sameLanguage?: boolean; maxPerFile?: number; includeEdges?: boolean },
  ): Promise<{ found: boolean; seed?: { chunkId: string; filePath: string | null; symbol: string | null }; related: RelatedChunkHit[] }> {
    return sourceOps.findRelatedChunks(this, userId, seed, opts);
  }

  /** MEM-30 incremental code-index freshness (hash-gated re-chunk/revive); see engine/sourceOps.ts. */
  public reindexCodeSource(
    userId: string,
    input: { filePath: string; content: string; language?: string; title?: string; commitCount90d?: number | null; lastCommitDate?: string | null },
  ): Promise<{ status: "fresh" | "reindexed" | "unsupported"; documentId?: string; staleMarked: number; chunks: number }> {
    return sourceOps.reindexCodeSource(this, userId, input);
  }

  public getOperationLog(
    userId: string,
    pagination?: CursorPaginationOptions<{ createdAt: string; id: string }>,
    filters?: OperationLogFilters
  ): Promise<MemoryOperation[]> {
    return this.store.getOperationLog(userId, pagination, filters);
  }

  public getStats(userId: string) {
    return this.store.getMemoryStats(userId);
  }

  public getDiagnostics(userId: string): Promise<DiagnosticsBundle> {
    return memoryOps.getDiagnostics(this, userId);
  }

  private startExtractionSweeper(): void {
    sweepersOps.startExtractionSweeper(this);
  }

  /** FED-S2-T5 — drop stale active_sessions rows; see engine/sweepersOps.ts. */
  private startActiveSessionSweeper(): void {
    sweepersOps.startActiveSessionSweeper(this);
  }

  /** FED-S3 — drop delivered inbox rows older than the threshold; see engine/sweepersOps.ts. */
  private startSessionInboxSweeper(): void {
    sweepersOps.startSessionInboxSweeper(this);
  }

  public sweepUnextractedBacklog() {
    return memoryOps.sweepUnextractedBacklog(this);
  }

  // ============================
  // ACE Feedback Loop
  // ============================

  private readonly ACE_ARCHIVE_THRESHOLD = (() => {
    const v = parseInt(process.env.BRAINROUTER_ACE_ARCHIVE_THRESHOLD ?? "10", 10);
    return isNaN(v) || v <= 0 ? 0 : v;
  })();

  public markCited(userId: string, citedRecordIds: string[], allRecalledRecordIds: string[]) {
    return memoryOps.markCited(this, userId, citedRecordIds, allRecalledRecordIds);
  }

  // ============================
  // Point-in-Time Search (asOf)
  // ============================

  public searchAsOf(userId: string, query: string, asOf: string, limit = 10): Promise<{
    memories: Array<{ recordId: string; content: string; type: string; score: number }>;
    asOf: string;
    count: number;
  }> {
    return memoryOps.searchAsOf(this, userId, query, asOf, limit);
  }
}

// ── Lazy singleton export ───────────────────────────────────────────────────
// Constructing a MemoryEngine opens a Postgres pool and runs `#initialize`
// (migrations + vec init + seed-admin). Doing that EAGERLY at import time meant
// merely importing this module (or any brain tool that re-exports it) started a
// stray pool + background work — wasteful, and the source of teardown races in
// tests. Construction is now deferred to first use: tools call methods on the
// `memoryEngine` proxy, which builds the instance on first property access;
// code paths that never touch it (most tests, which use scratch engines) never
// open a pool. The proxy keeps the `import { memoryEngine }` call-sites (60+)
// unchanged. Vitest suites factory-mock this module, so they never see the proxy.
let _memoryEngine: MemoryEngine | undefined;

/** Get the process-wide memory engine, constructing it on first call. */
export function getMemoryEngine(): MemoryEngine {
  return (_memoryEngine ??= new MemoryEngine());
}

/**
 * Close + drop the process-wide singleton (graceful shutdown / test teardown).
 * No-op when it was never constructed, so tests that don't use it pay nothing.
 * The next `getMemoryEngine()` / proxy access builds a fresh instance.
 */
export async function closeMemoryEngine(): Promise<void> {
  const e = _memoryEngine;
  if (!e) return;
  _memoryEngine = undefined;
  await e.close();
}

export const memoryEngine: MemoryEngine = new Proxy({} as MemoryEngine, {
  get(_t, prop) {
    const e = getMemoryEngine();
    const value = Reflect.get(e, prop, e);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(e) : value;
  },
  set(_t, prop, value) {
    return Reflect.set(getMemoryEngine(), prop, value as never);
  },
  has(_t, prop) {
    return prop in getMemoryEngine();
  },
});
