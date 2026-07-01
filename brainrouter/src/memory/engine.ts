import { PostgresMemoryStore } from "./store/postgres/PostgresMemoryStore.js";
import { pgUrlFromEnv } from "./store/postgres/connection.js";
import type { StalenessThresholds } from "./lessons/lessonHygiene.js";
// REFAC-ENGINE-SPLIT (0.4.6) — lesson-domain ops live in lessons/lessonOps.ts;
// the engine methods below are thin wrappers delegating to them.
import * as lessonOps from "./lessons/lessonOps.js";
import * as blackboardOps from "./blackboard/blackboardOps.js";
import * as treeOps from "./tree/treeOps.js";
import type { CursorPaginationOptions, DiagnosticsBundle, EvidenceListFilters, IMemoryStore, MemoryListFilters, OperationLogFilters } from "@kinqs/brainrouter-types";
import { MemoryCapturePipeline } from "./capture.js";
import { MemoryRecallPipeline } from "./recall.js";
import { MemoryJobRunner, recordInlineJob } from "./scheduler/runner.js";
import { enqueueAgentJob } from "./scheduler/jobs.js";
import { chunkSource } from "./source/chunker.js";
import { chunkCode } from "./source/code-chunker.js";
import { deriveBenchQuery, aggregateRanks } from "./bench/run.js";
import { formatModesSummaryMd, checkThresholds, type ModeStats } from "./bench/regression.js";
import { benchmarkCodeChunking, DEFAULT_CODE_SAMPLES, formatCodeRecallMd, type CodeRecallResult } from "./bench/code-recall.js";
import { computeRetrievalMetrics, withTokenEfficiency, formatCodeScaleMd, type RankedQueryResult, type RetrievalMetrics } from "./bench/code-scale.js";
import { buildCodeScaleFixture } from "./bench/code-scale-fixture.js";
import { readTreePolicy, treeAutobuildEnabled, parentDomain, topicKeyForScene, SCENE_LEAF_DOMAIN } from "./tree/policy.js";
import { EmbeddingService } from "./store/embedding.js";
import { RerankerService } from "./store/reranker.js";
import { RelevanceJudgeService } from "./store/relevance-judge.js";
import { scanSkillsForHints } from "./skills/skill-hints-loader.js";
import { distillFocusScenes } from "./pipeline/contextual-focus-builder.js";
import { planGovernance, planStorageGovernance, type GovernancePlanFilters, type GovernancePlanResult, type StorageGovernanceStats, type StorageGovernanceResult } from "./governance/governance-plan.js";
import { renderRecordMarkdown, renderTreeNodeMarkdown, vaultHash } from "./vault/render.js";
import { distillCoreIdentity } from "./pipeline/identity-distiller.js";
import { spikeSkill as spikeSkillActivation, decayPotential } from "./pipeline/skill-prewarm.js";
import type { LLMRunner } from "@kinqs/brainrouter-types";
import { NeuralSparkEngine } from "./pipeline/neural-spark.js";
import { ModelLLMRunner } from "./llm/modelRunner.js";
import "dotenv/config";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { CognitiveRecord, MemoryEvidence, MemoryImport, MemoryOperation, MemoryStatus, MemoryType, SourceChunk, SourceDocument, UserRecord, BlackboardItem, BlackboardItemInput, BlackboardStatus, MemoryTreeNode, MemoryTreeNodeInput, MemoryTreeKind, RelatedChunkHit, GraphNode, GraphEdge } from "@kinqs/brainrouter-types";
import { extractChunkQueryTerms, languageScopeFor, rankRelatedChunks, extractImportSpecifiers, resolveRelativeImport } from "./recall/code-retrieval.js";
import { buildSkillExtractionPrompt, parseSkillResponse } from "./skills/skill-extract.js";
import { buildReflectPrompt, parseReflectResponse } from "./util/reflect.js";
import { pageRank, articulationPoints, shortestPath, namespaceOverview } from "./graph/graph-analytics.js";
import { hashPassword } from "../api/auth/crypto.js";
import { getMemoryTypeConfig } from "./config/memory-type-config.js";
import { redactSensitiveMemoryText } from "./util/redaction.js";

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
    
    const embeddingService = new EmbeddingService({
      endpoint: process.env.BRAINROUTER_EMBEDDING_ENDPOINT,
      apiKey: process.env.BRAINROUTER_EMBEDDING_API_KEY ?? process.env.BRAINROUTER_LLM_API_KEY,
      model: process.env.BRAINROUTER_EMBEDDING_MODEL,
      dimensions: process.env.BRAINROUTER_EMBEDDING_DIMENSIONS ? parseInt(process.env.BRAINROUTER_EMBEDDING_DIMENSIONS, 10) : undefined,
      timeoutMs: process.env.BRAINROUTER_EMBEDDING_TIMEOUT_MS
        ? parseInt(process.env.BRAINROUTER_EMBEDDING_TIMEOUT_MS, 10)
        : undefined,
    });

    const rerankerService = new RerankerService({
      endpoint: process.env.BRAINROUTER_RERANKER_ENDPOINT,
      apiKey: process.env.BRAINROUTER_RERANKER_API_KEY,
      model: process.env.BRAINROUTER_RERANKER_MODEL,
      topN: process.env.BRAINROUTER_RERANKER_TOP_N
        ? parseInt(process.env.BRAINROUTER_RERANKER_TOP_N, 10)
        : undefined,
      timeoutMs: process.env.BRAINROUTER_RERANKER_TIMEOUT_MS
        ? parseInt(process.env.BRAINROUTER_RERANKER_TIMEOUT_MS, 10)
        : undefined,
    });

    // Relevance judge is opt-in (off by default) — enable with
    // BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true, since it adds a per-query LLM
    // call. Falls back to the shared BRAINROUTER_LLM_* settings unless
    // explicitly overridden so a single LLM credential covers extraction,
    // synthesis, and judging. When enabled it runs INLINE inside recall; the
    // engine records a throttled observability job (see `recall`) so the agent
    // no longer shows "idle · never" while it's actually working.
    const relevanceJudge = new RelevanceJudgeService({
      enabled: process.env.BRAINROUTER_RELEVANCE_JUDGE_ENABLED === "true",
      endpoint: process.env.BRAINROUTER_RELEVANCE_JUDGE_ENDPOINT
        ?? process.env.BRAINROUTER_LLM_ENDPOINT,
      apiKey: process.env.BRAINROUTER_RELEVANCE_JUDGE_API_KEY
        ?? process.env.BRAINROUTER_LLM_API_KEY,
      model: process.env.BRAINROUTER_RELEVANCE_JUDGE_MODEL
        ?? process.env.BRAINROUTER_LLM_MODEL,
      maxCandidates: process.env.BRAINROUTER_RELEVANCE_JUDGE_MAX_CANDIDATES
        ? parseInt(process.env.BRAINROUTER_RELEVANCE_JUDGE_MAX_CANDIDATES, 10)
        : undefined,
      timeoutMs: process.env.BRAINROUTER_RELEVANCE_JUDGE_TIMEOUT_MS
        ? parseInt(process.env.BRAINROUTER_RELEVANCE_JUDGE_TIMEOUT_MS, 10)
        : undefined,
    });

    this.capturePipeline = new MemoryCapturePipeline(this.store, this.extractionRunner, embeddingService, 1);
    this.recallPipeline = new MemoryRecallPipeline(this.store, embeddingService, rerankerService, relevanceJudge);
    this.rerankerService = rerankerService; // MEM-19 — readiness drives benchmark mode selection
    this.embeddingService = embeddingService; // MEM-VEC — embed-on-import reuse
    this.relevanceJudge = relevanceJudge;

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

  /**
   * Run the store lifecycle to completion: migrations (`init`) → vector table
   * (`initVec`) → seed-admin. Then kick off the stale-vector reembed in the
   * background (best-effort; never part of the awaited readiness so startup
   * isn't gated on the embedding endpoint). Resolves once the store is ready to
   * serve.
   */
  async #initialize(): Promise<void> {
    await this.store.init();
    await this.store.initVec(this.embeddingService.getDimensions());
    await this.ensureSeedAdminUser().catch((err) => {
      console.error("[BrainRouter] Failed to seed admin user:", err instanceof Error ? err.message : err);
    });

    if (this.embeddingService.isReady()) {
      void this.store
        .reembedStaleRecords((text) => this.embeddingService.embed(text))
        .then((count) => {
          if (count > 0) {
            console.error(`[BrainRouter] Re-embedded ${count} stale cognitive vector records.`);
          }
        })
        .catch((err) => {
          console.error("[BrainRouter] Failed to re-embed stale cognitive vector records:", err instanceof Error ? err.message : err);
        });
    }
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

  /**
   * BRAIN-P1 (0.4.1) — start the async job runner that drains
   * out-of-band `memory_jobs` (enqueued via `memory_agent_run` /
   * `/brain run`). Synthesis distillers use the synthesis runner. The
   * runner's timer is unref'd, so it never holds the process open on its
   * own. Disable with `BRAINROUTER_JOB_RUNNER=off` (e.g. in tests that
   * drive ticks manually).
   */
  private startJobRunner() {
    if (process.env.BRAINROUTER_JOB_RUNNER === "off") return;
    this.jobRunner = new MemoryJobRunner(
      this.store,
      // `engine: this` lets the 0.4.3 depth executors (vault / blackboard /
      // tree) call the capability-detected engine ops. MemoryEngine
      // structurally satisfies JobEngineOps.
      { store: this.store, llmRunner: this.synthesisRunner, engine: this },
      {
        intervalMs: process.env.BRAINROUTER_JOB_RUNNER_INTERVAL_MS
          ? parseInt(process.env.BRAINROUTER_JOB_RUNNER_INTERVAL_MS, 10)
          : undefined,
        // 0.4.3 — auto-schedule the maintenance depth agents (own throttle).
        onTick: async () => { await this.enqueueScheduledMaintenance(); },
      },
    );
    this.jobRunner.start();
  }

  // 0.4.3 — scheduled-maintenance cadence (own throttle, independent of the
  // much faster drain interval). Do real work at most every 5 min; export the
  // vault ~hourly (every 12th pass) since it rescans records each run.
  private maintenanceLastAt = 0;
  private maintenancePass = 0;
  /** MEM-10b — throttle for the relevance_judge observability heartbeat. */
  private relevanceJudgeLastJobAt = 0;

  /**
   * 0.4.3 (MEM-10) — auto-enqueue the maintenance depth agents. Called
   * best-effort from the job runner's per-tick hook. Per active user:
   *   - `blackboard_reconciler` — only when pending candidates exist
   *     (self-limiting: reconcile+commit drains the queue, so it won't re-fire
   *     until new items stage).
   *   - `vault_exporter` — every ~hour, so the markdown mirror stays fresh
   *     without rescanning records every tick (export is ledger-idempotent).
   * `tree_sealer` is intentionally NOT auto-enqueued: nothing auto-appends tree
   * leaves yet, so there are no full buckets to seal — run it on demand via
   * `memory_agent_run` until auto-leaf-accumulation lands.
   * Disable the whole pass with `BRAINROUTER_JOB_MAINTENANCE=off`. Idempotency
   * keys dedupe in-flight, so re-enqueues are safe. `force` skips the throttle
   * (tests).
   */
  public async enqueueScheduledMaintenance(force = false): Promise<{ enqueued: Record<string, number>; skipped?: boolean }> {
    if (process.env.BRAINROUTER_JOB_MAINTENANCE === "off") return { enqueued: {}, skipped: true };
    const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
    const VAULT_MAINTENANCE_EVERY = 12; // ~hourly at the 5-min cadence
    const BENCH_MAINTENANCE_EVERY = 288; // ~daily at the 5-min cadence
    const benchScheduleEnabled = (process.env.BRAINROUTER_BENCH_SCHEDULE ?? "").trim().toLowerCase() !== "off";
    const now = Date.now();
    if (!force && now - this.maintenanceLastAt < MAINTENANCE_INTERVAL_MS) return { enqueued: {}, skipped: true };
    this.maintenanceLastAt = now;
    const pass = this.maintenancePass++;

    const enqueued: Record<string, number> = { blackboard_reconciler: 0, vault_exporter: 0, tree_sealer: 0 };
    const bb = this.blackboardStore();
    let users: { userId: string }[] = [];
    try { users = await this.store.listUsers(); } catch { users = []; }
    for (const { userId } of users) {
      if (!userId) continue;
      if (bb && (await bb.getBlackboardItems(userId, "pending")).length > 0) {
        await enqueueAgentJob(this.store, "blackboard_reconciler", { userId });
        enqueued.blackboard_reconciler++;
      }
      if (pass % VAULT_MAINTENANCE_EVERY === 0) {
        await enqueueAgentJob(this.store, "vault_exporter", { userId });
        enqueued.vault_exporter++;
      }
      // 0.4.3 — grow the scene-tree (leaf per mature scene); when a bucket of
      // unsealed leaves fills OR settles, enqueue tree_sealer to seal it into a
      // parent. Wrapped so a tree failure can't abort the rest of the pass.
      try {
        const tree = await this.autobuildSceneTree(userId);
        if (tree.sealableBucket) {
          await enqueueAgentJob(this.store, "tree_sealer", { userId, childIds: tree.sealableBucket, kind: parentDomain(SCENE_LEAF_DOMAIN) });
          enqueued.tree_sealer++;
        }
      } catch (err: any) {
        console.error("[BrainRouter] scene-tree autobuild failed:", err?.message ?? err);
      }
      // MEM-10b — periodically run the retrieval benchmark so benchmark_eval
      // isn't permanently idle. Expensive (up to ~5 min) so daily by default,
      // with an early pass for first-run visibility; disable via
      // BRAINROUTER_BENCH_SCHEDULE=off.
      if (benchScheduleEnabled && (pass === 2 || (pass > 0 && pass % BENCH_MAINTENANCE_EVERY === 0))) {
        await enqueueAgentJob(this.store, "benchmark_eval", { userId });
        enqueued.benchmark_eval = (enqueued.benchmark_eval ?? 0) + 1;
      }
      // BRAIN-P4-T5 — roll accumulated global roots into a higher global digest.
      try {
        if (await this.rollupGlobalTree(userId)) enqueued.global_rollup = (enqueued.global_rollup ?? 0) + 1;
      } catch (err: any) {
        console.error("[BrainRouter] global rollup failed:", err?.message ?? err);
      }
    }
    return { enqueued };
  }

  /**
   * 0.4.3 (MEM-10) / MEM-20 (0.4.4) — the tree_sealer auto-trigger source. Builds a DURABLE
   * memory-summary tree over COGNITIVE RECORDS grouped by scene (deliberately
   * NOT over transcripts — those churn and get pruned, which would orphan tree
   * leaves). Appends one level-0 leaf per mature, not-yet-leafed scene (a
   * deterministic, redacted digest of its records — the LLM re-summary is
   * tree_digest's job, deferred), bounded per pass. Once enough unsealed
   * scene-leaves accumulate it returns their ids so the maintenance pass can
   * enqueue tree_sealer to seal them into a `global` parent. Idempotent (one
   * leaf per scene_key); capability-detected; gated by
   * BRAINROUTER_TREE_AUTOBUILD=off.
   */
  public async autobuildSceneTree(userId: string): Promise<{ leafed: number; sealableBucket: string[] | null }> {
    if (!treeAutobuildEnabled()) return { leafed: 0, sealableBucket: null };
    const store = this.store as any;
    if (
      typeof store.getDistinctScenes !== "function" ||
      typeof store.getSceneLeafKeys !== "function" ||
      typeof store.appendTreeNode !== "function" ||
      typeof store.getUnsealedSceneLeaves !== "function"
    ) {
      return { leafed: 0, sealableBucket: null };
    }

    const policy = readTreePolicy();
    const leafedKeys = new Set<string>(await store.getSceneLeafKeys(userId));
    const scenes = (await store.getDistinctScenes(userId)) as Array<{ sceneName: string; recordCount: number }>;
    let leafed = 0;
    for (const sc of scenes) {
      if (leafed >= policy.leafPerPass) break;
      if (!sc.sceneName || sc.recordCount < policy.minSceneRecords || leafedKeys.has(sc.sceneName)) continue;
      const contents = (await store.getSceneRecordContents(userId, sc.sceneName, 8)) as string[];
      const digest = contents.map((c) => `- ${redactSensitiveMemoryText(c).replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
      await store.appendTreeNode(userId, {
        kind: SCENE_LEAF_DOMAIN, // MEM-20 — scene leaves are topic-domain
        level: 0,
        summaryMd: `Topic: ${topicKeyForScene(sc.sceneName)} · Scene: ${sc.sceneName} (${sc.recordCount} records)\n${digest}`,
        sceneKey: sc.sceneName,
      });
      leafed++;
    }

    // Eager seal once a full bucket accumulates; otherwise seal a SETTLED bucket
    // (this pass added no new leaf) down to idleSealFloor — so realistic users
    // with only a handful of mature scenes still get their leaves sealed, and
    // tree_sealer + tree_digest actually run instead of waiting forever for a
    // full bucket of `sealThreshold`.
    const fetchLimit = Math.max(policy.sealThreshold, 24);
    const unsealed = (await store.getUnsealedSceneLeaves(userId, fetchLimit)) as Array<{ id: string }>;
    const eager = unsealed.length >= policy.sealThreshold;
    const settled = leafed === 0 && unsealed.length >= policy.idleSealFloor;
    const sealableBucket = eager || settled ? unsealed.map((n) => n.id) : null;
    return { leafed, sealableBucket };
  }

  private async ensureSeedAdminUser() {
    const users = await this.store.listUsers();
    if (users.length > 0) return;
    const seededUserId = process.env.BRAINROUTER_DEFAULT_ADMIN_USER_ID ?? "admin";
    const seededEmail = process.env.BRAINROUTER_ADMIN_EMAIL ?? "admin";
    const seededPassword = process.env.BRAINROUTER_ADMIN_PASSWORD?.trim();
    const apiKey = `br_${randomBytes(24).toString("hex")}`;
    await this.store.createUser(seededUserId, apiKey, "Default Admin", true);
    await this.store.updateUserEmail(seededUserId, seededEmail);
    if (seededPassword) {
      const passwordHash = await hashPassword(seededPassword);
      await this.store.updateUserPassword(seededUserId, passwordHash);
    }
    console.error(`[BrainRouter] Admin seeded. Email: ${seededEmail}  API key (shown once): ${apiKey}`);
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
    const now = new Date().toISOString();
    const timestamp = params.timestamp ?? Date.now();
    const record = {
      id: `sensory_hook_${params.sessionKey}_${timestamp}_${randomUUID()}`,
      userId: params.userId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId ?? "",
      role: params.role,
      messageText: redactSensitiveMemoryText(params.content),
      recordedAt: now,
      timestamp,
      skillTag: params.skillTag ?? "",
    };
    this.store.upsertSensory(record);
    return record;
  }

  public async explainRecall(params: Parameters<MemoryRecallPipeline['recall']>[0]) {
    return this.recallPipeline.recall({ ...params, explain: true });
  }

  public get recall() {
    return async (params: Parameters<MemoryRecallPipeline['recall']>[0]) => {
      const result = await this.recallPipeline.recall(params);

      // MEM-10b — the relevance judge runs INLINE inside recall (request-scoped),
      // so it never produced a job row → it showed "idle · never". Record a
      // throttled observability heartbeat when the judge actually ran (the
      // recall strategy is tagged "+judge"), so the agent reflects real activity
      // without flooding the job table on every query.
      if (typeof result.recallStrategy === "string" && result.recallStrategy.includes("judge")) {
        const now = Date.now();
        if (now - this.relevanceJudgeLastJobAt > 5 * 60_000) {
          this.relevanceJudgeLastJobAt = now;
          recordInlineJob(
            this.store,
            "relevance_judge",
            { userId: params.userId, source: "recall" },
            { strategy: result.recallStrategy, kept: result.recalledCognitiveMemories?.length ?? 0 },
          );
        }
      }

      const persona = await this.getPersona(params.userId);
      if (persona) {
        const existing = result.appendSystemContext ?? "";
        result.appendSystemContext = `<user-persona>\n${persona.personaMd}\n</user-persona>\n\n` + existing;
        result.coreIdentitySummary = persona.personaMd;
      }

      return result;
    };
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
    this.store.upsertSkillHints(skillName, hints, sourceFile);
  }

  public listSkillHints() {
    return this.store.listSkillHints();
  }

  public spikeSkill(userId: string, skillName: string) {
    return spikeSkillActivation({ userId, skillName, store: this.store });
  }

  public async getSkillActivations(userId: string) {
    const raw = await this.store.getSkillActivations(userId);
    const now = new Date();
    return raw.map(r => ({
      skillName: r.skillName,
      potential: decayPotential({
        potential: r.potential,
        lastDecayTime: r.lastDecayTime,
        now,
      }),
      lastDecayTime: r.lastDecayTime,
    })).sort((a, b) => b.potential - a.potential);
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
  public async graphAnalytics(
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
    const store = this.store as unknown as Partial<{
      getAllGraphNodes(u: string): Promise<GraphNode[]>;
      getAllGraphEdges(u: string): Promise<GraphEdge[]>;
    }>;
    const nodes = typeof store.getAllGraphNodes === "function" ? await store.getAllGraphNodes(userId) : [];
    const edges = typeof store.getAllGraphEdges === "function" ? await store.getAllGraphEdges(userId) : [];
    const nodeIds = nodes.map((n) => n.id);
    const liteEdges = edges.map((e) => ({ from: e.fromNodeId, to: e.toNodeId }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const topN = Math.max(1, Math.min(50, opts?.topN ?? 10));

    const pr = pageRank(nodeIds, liteEdges);
    const topCentral = [...pr.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([id, score]) => ({ entity: byId.get(id)?.entity ?? id, entityType: byId.get(id)?.entityType ?? "unknown", score: Math.round(score * 1e4) / 1e4 }));
    const bridges = articulationPoints(nodeIds, liteEdges)
      .slice(0, topN)
      .map((id) => ({ entity: byId.get(id)?.entity ?? id, entityType: byId.get(id)?.entityType ?? "unknown" }));
    const namespaces = namespaceOverview(nodes);

    let path: { from: string; to: string; found: boolean; entities: string[] } | undefined;
    if (opts?.from && opts?.to) {
      const fromId = nodes.find((n) => n.entity.toLowerCase() === opts.from!.toLowerCase())?.id;
      const toId = nodes.find((n) => n.entity.toLowerCase() === opts.to!.toLowerCase())?.id;
      const ids = fromId && toId ? shortestPath(nodeIds, liteEdges, fromId, toId) : null;
      path = { from: opts.from, to: opts.to, found: !!ids, entities: (ids ?? []).map((id) => byId.get(id)?.entity ?? id) };
    }

    return { nodeCount: nodes.length, edgeCount: edges.length, topCentral, bridges, namespaces, ...(path ? { path } : {}) };
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
    const memory = await this.store.getMemoryById(userId, recordId);
    if (!memory) return null;
    return { memory, evidence: await this.store.getEvidenceByRecord(userId, recordId) };
  }

  public async upsertEngineeringMemory(params: {
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
    const now = new Date().toISOString();
    const config = getMemoryTypeConfig(params.type);
    const record: CognitiveRecord = {
      id: `cognitive_manual_${randomUUID()}`,
      userId: params.userId,
      sessionKey: params.sessionKey ?? "",
      sessionId: params.sessionId ?? "",
      // SECRET-REDACTION + LENGTH-CAP — structured-record captures (requirement
      // / artifact / annotation) land here directly, bypassing the capture-
      // pipeline redaction that memory_capture_turn applies. Cap the length
      // first (bounds a single oversized capture's CPU/storage amplification),
      // then redact secret patterns so no capture path can persist a
      // Bearer/sk-/ghp_/PEM/API_KEY= secret into the cognitive graph (it would
      // otherwise flow into recall + briefings + the LLM prompt). The 64 KB cap
      // is ~16k words — far above any normal record, so behaviour-preserving.
      content: redactSensitiveMemoryText((params.content ?? "").slice(0, 64_000)),
      type: params.type,
      priority: params.priority ?? 75,
      sceneName: params.activeSkill ? `${params.activeSkill} engineering` : "Software engineering memory",
      skillTag: params.activeSkill ?? "",
      halfLifeDays: config.halfLifeDays,
      supersededBy: null,
      invalidAt: null,
      timestampStr: now,
      timestampStart: now,
      timestampEnd: now,
      createdTime: now,
      updatedTime: now,
      metadata: params.metadata ?? {},
      confidence: params.confidence ?? config.defaultConfidence,
      status: "active",
      sourceKind: params.sourceKind ?? "user_instruction",
      verificationStatus: params.verificationStatus ?? "unverified",
      repoPaths: params.repoPaths ?? [],
      filePaths: params.filePaths ?? [],
      commands: params.commands ?? [],
      citationCount: 0,
      lastCitedAt: null,
      neverCitedCount: 0,
      archived: false,
    };
    await this.store.upsertCognitive(record);
    return record;
  }

  /**
   * MEM-32 (0.4.4) — record a durable lesson/insight with corroboration
   * reinforcement. The lesson is fingerprinted (normalized-text hash); a
   * corroborating call to the same lesson does NOT duplicate — it bumps the
   * record's confidence (asymptotically toward 1) and corroboration count
   * instead. New lessons are stored as `lesson` cognitive records, so they flow
   * through normal recall/briefing. Returns whether it reinforced an existing
   * lesson and the resulting confidence.
   */
  public recordLesson(
    userId: string,
    text: string,
    opts?: { sessionKey?: string; activeSkill?: string; evidence?: string; priority?: number; kind?: string; supersedes?: string | string[] },
  ): Promise<{ recordId: string; reinforced: boolean; confidence: number; corroborations: number; supersededIds: string[] }> {
    return lessonOps.recordLesson(this, userId, text, opts);
  }

  /**
   * LESSON-HYGIENE (0.4.5) — deterministically find live lessons that conflict
   * with `text` (same subject, different rule) so a caller can decide whether to
   * pass them as `supersedes`. Pure store lookup by conflict key + a normalized
   * text check; NO LLM. Returns [] when nothing collides — conservative by
   * design (it won't guess at semantic equivalence like npm≠pnpm).
   */
  public findLessonConflicts(userId: string, text: string): Promise<CognitiveRecord[]> {
    return lessonOps.findLessonConflicts(this, userId, text);
  }

  /**
   * LESSON-HYGIENE (0.4.5) — conservative staleness sweep. Returns lessons that
   * are old AND low-confidence AND barely corroborated (see DEFAULT_STALENESS);
   * a useful rule keeps getting cited/corroborated and is never a candidate.
   * Read-only by default — pass `apply:true` to archive the candidates (archived
   * records drop out of recall but stay recoverable; this is expiry, not
   * deletion). `nowMs` is injectable for tests.
   */
  public sweepStaleLessons(
    userId: string,
    opts?: { apply?: boolean; thresholds?: Partial<StalenessThresholds>; nowMs?: number; limit?: number },
  ): Promise<{ candidates: Array<{ recordId: string; reason: string; lastCitedAt: string | null; confidence: number }>; archived: number }> {
    return lessonOps.sweepStaleLessons(this, userId, opts);
  }

  /**
   * B6 (0.4.11) — `/memory verify`: reconcile code-anchored memories against the
   * CURRENT source index. Each anchored record is classified:
   *   - `fresh`        — its source is not stale.
   *   - `reanchorable` — stale, but a fresh document still exists at the file
   *                      (the file CHANGED; a reindex can refresh the anchor).
   *   - `archivable`   — stale AND no fresh document at the file (the source is
   *                      GONE → a confirmed-dead anchor).
   * Read-only by default. `apply` archives the `archivable` records ONLY
   * (recoverable expiry — never the merely-stale ones, which may still be valid).
   * Non-code memories (no source provenance) are ignored.
   */
  public async verifyMemories(
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
    const store = this.store as Partial<{
      getRecordSourceChunks(userId: string, recordId: string): Promise<SourceChunk[]>;
      isRecordSourceStale(userId: string, recordId: string): Promise<boolean>;
      hasFreshSourceDocument(userId: string, uri: string): Promise<boolean>;
      archiveCognitiveRecord(userId: string, recordId: string): Promise<void>;
    }>;
    const result = {
      total: 0, fresh: 0, reanchorable: 0, archivable: 0, archived: 0,
      sample: [] as Array<{ recordId: string; status: "fresh" | "reanchorable" | "archivable"; filePath: string | null }>,
    };
    if (typeof store.getRecordSourceChunks !== "function" || typeof store.isRecordSourceStale !== "function") {
      return result; // store lacks the source-provenance capability
    }
    const limit = Math.max(1, Math.min(5000, opts?.limit ?? 1000));
    const records = (await this.store.listMemories(userId, { archived: false })).slice(0, limit);
    for (const rec of records) {
      const chunks = await store.getRecordSourceChunks(userId, rec.recordId);
      if (!chunks || chunks.length === 0) continue; // not code-anchored
      result.total += 1;
      if (!(await store.isRecordSourceStale(userId, rec.recordId))) {
        result.fresh += 1;
        continue;
      }
      const uris = [...new Set(chunks.map((c) => c.filePath).filter((u): u is string => !!u))];
      // No freshness check available → never archive on uncertainty (re-anchorable).
      let hasFresh = true;
      if (typeof store.hasFreshSourceDocument === "function") {
        hasFresh = false;
        for (const u of uris) {
          if (await store.hasFreshSourceDocument(userId, u)) { hasFresh = true; break; }
        }
      }
      if (hasFresh) {
        result.reanchorable += 1;
        if (result.sample.length < 25) result.sample.push({ recordId: rec.recordId, status: "reanchorable", filePath: uris[0] ?? null });
      } else {
        result.archivable += 1;
        if (opts?.apply && typeof store.archiveCognitiveRecord === "function") {
          await store.archiveCognitiveRecord(userId, rec.recordId);
          result.archived += 1;
        }
        if (result.sample.length < 25) result.sample.push({ recordId: rec.recordId, status: "archivable", filePath: uris[0] ?? null });
      }
    }
    return result;
  }

  /**
   * MEM-33 (0.4.4) — distill a reusable skill (SOP) from a successful session
   * and store it. The LLM gate emits `<no-skill/>` for exploratory/trivial runs
   * (→ nothing stored). A real skill is stored as a durable `lesson` tagged
   * `kind:'skill'`, so it reinforces on re-extraction (MEM-32) and flows through
   * recall. The LLM is injectable for tests; defaults to the synthesis runner.
   */
  public async extractSkillFromSession(
    userId: string,
    opts: {
      sessionSummary: string;
      sessionKey?: string;
      activeSkill?: string;
      llm?: (params: { prompt: string; systemPrompt?: string; timeoutMs?: number }) => Promise<string>;
    },
  ): Promise<{ extracted: boolean; recordId?: string; reinforced?: boolean; skill?: string }> {
    const summary = (opts.sessionSummary ?? "").trim();
    if (summary.length < 20) return { extracted: false };

    const { system, user } = buildSkillExtractionPrompt(summary);
    const run = opts.llm ?? ((p) => this.synthesisRunner.run(p as any));
    let raw: string;
    try {
      raw = await run({ prompt: user, systemPrompt: system, timeoutMs: 60_000 });
    } catch {
      return { extracted: false }; // LLM unavailable → best-effort, store nothing
    }

    const { skill } = parseSkillResponse(raw);
    if (!skill) return { extracted: false };

    const res = await this.recordLesson(userId, skill, {
      sessionKey: opts.sessionKey,
      activeSkill: opts.activeSkill,
      priority: 82,
      kind: "skill",
    });
    return { extracted: true, recordId: res.recordId, reinforced: res.reinforced, skill };
  }

  /**
   * MEM-32b (0.4.4) — `reflect`: synthesize NON-OBVIOUS cross-memory insights
   * (patterns spanning multiple records) via the synthesis LLM and record each
   * as a reinforcing `lesson` (kind:"insight"). `<no-insight/>` → nothing stored.
   * LLM failure is best-effort. The LLM is injectable for tests.
   */
  public async reflect(
    userId: string,
    opts?: { limit?: number; llm?: (params: { prompt: string; systemPrompt?: string; timeoutMs?: number }) => Promise<string> },
  ): Promise<{ reflected: number; insights: string[] }> {
    const records = (await this.store.listMemories(userId, { archived: false })).slice(0, Math.max(3, Math.min(50, opts?.limit ?? 25)));
    if (records.length < 3) return { reflected: 0, insights: [] };

    const { system, user } = buildReflectPrompt(records.map((r) => r.content));
    const run = opts?.llm ?? ((p) => this.synthesisRunner.run(p as any));
    let raw: string;
    try {
      raw = await run({ prompt: user, systemPrompt: system, timeoutMs: 60_000 });
    } catch {
      return { reflected: 0, insights: [] };
    }

    const insights = parseReflectResponse(raw);
    for (const insight of insights) {
      await this.recordLesson(userId, insight, { kind: "insight", priority: 78 });
    }
    return { reflected: insights.length, insights };
  }

  public getMemoriesByFilePath(userId: string, filePath: string, limit = 20): Promise<CognitiveRecord[]> {
    return this.store.getMemoriesByFilePath(userId, filePath, limit);
  }

  public searchMemoryRecords(userId: string, query: string, limit = 20) {
    return this.store.searchCognitiveFts(userId, query, limit);
  }

  public async updateMemory(userId: string, recordId: string, updates: {
    content?: string;
    status?: MemoryStatus;
    confidence?: number;
    verificationStatus?: CognitiveRecord["verificationStatus"];
    note?: string;
  }) {
    const existing = await this.store.getMemoryById(userId, recordId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated: CognitiveRecord = {
      ...existing,
      content: updates.content ?? existing.content,
      status: updates.status ?? existing.status,
      confidence: updates.confidence ?? existing.confidence,
      verificationStatus: updates.verificationStatus ?? existing.verificationStatus,
      updatedTime: now,
      archived: updates.status === "archived" ? true : existing.archived,
      metadata: updates.note
        ? { ...existing.metadata, governanceNote: updates.note, governanceNoteAt: now }
        : existing.metadata,
    };
    await this.store.upsertCognitive(updated, { skipAudit: true });
    await this.store.insertOperation({
      id: randomUUID(),
      userId,
      recordId,
      operation: "memory_update",
      actor: "user",
      sessionKey: existing.sessionKey,
      reason: updates.note ?? "",
      createdAt: now,
      metadata: {
        contentChanged: typeof updates.content === "string",
        status: updates.status,
        confidence: updates.confidence,
        verificationStatus: updates.verificationStatus,
      },
    });
    return this.getMemoryById(userId, recordId);
  }

  public updateMemoryStatus(userId: string, recordId: string, confidence: number, status: MemoryStatus) {
    this.store.updateCognitiveConfidence(userId, recordId, confidence, status);
    return this.getMemoryById(userId, recordId);
  }

  public async addEvidence(userId: string, recordId: string, evidence: Omit<MemoryEvidence, "id" | "userId" | "recordId" | "observedAt"> & { id?: string; observedAt?: string }) {
    const ev: MemoryEvidence = {
      id: evidence.id ?? randomUUID(),
      userId,
      recordId,
      kind: evidence.kind,
      ref: evidence.ref,
      excerpt: evidence.excerpt ?? "",
      observedAt: evidence.observedAt ?? new Date().toISOString(),
      metadata: evidence.metadata ?? {},
    };
    await this.store.insertEvidence(ev);
    return ev;
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

  public async importMemories(userId: string, data: MemoryImport) {
    const result = await this.store.importMemories(userId, data);
    // MEM-VEC (0.4.14) — embed imported records now so they're vector-searchable
    // immediately. Without this, vectors only fill via the background re-embed
    // sweep, which lags far behind a bulk import → vector recall finds nothing
    // (vector ≡ keyword in the benchmark). Opt out with BRAINROUTER_IMPORT_EMBED=0
    // for fast bulk restores (vectors then backfill via the sweep).
    if (result.importedMemories > 0 && process.env.BRAINROUTER_IMPORT_EMBED !== "0" && this.embeddingService.isReady()) {
      try {
        const embedded = await this.store.reembedStaleRecords((text) => this.embeddingService.embed(text));
        if (embedded > 0) console.error(`[BrainRouter] Embedded ${embedded} imported records for vector recall.`);
      } catch (err) {
        console.error("[BrainRouter] embed-on-import failed (vectors backfill via the sweep):", err instanceof Error ? err.message : err);
      }
    }
    return result;
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
  /**
   * 0.4.3 (MEM-9) / MEM-19 (0.4.4) — benchmark_eval job: a self-retrieval
   * regression benchmark over the user's OWN records (no synthetic corpus /
   * labels). Samples records, derives a partial query from each, and runs recall
   * in several MODES (recall configurations), measuring whether the source
   * record resurfaces and at what rank:
   *   - baseline — RRF + priority only (no diversity, reranker, or judge)
   *   - lexmmr   — + local lexical-relevance + MMR-diversity selection
   *   - rerank   — + cross-encoder reranker  (only when one is configured)
   *   - judge    — + LLM relevance judge      (only when enabled)
   * rerank/judge are SKIPPED — and reported in `skippedModes`, not silently
   * equated to baseline — when their service isn't configured. MEM-19 passes
   * each mode's config to recall PER-CALL (`limitsOverride` / `selectionOverride`
   * / `disableReranker` / `disableJudge`) instead of mutating process.env, so
   * runs are deterministic and concurrency-safe (the old env-toggle approach
   * leaked global state across runs). Writes a markdown summary; returns per-mode
   * ModeStats + a pass/fail recall floor. Insufficient (empty) when < 3 records.
   *
   * Scope: this harness scores cognitive-record self-retrieval. Chunk/tree
   * ("AST") retrieval is a separate fixture and is not measured here.
   */
  public async runRetrievalBenchmark(
    userId: string,
    opts?: { sampleSize?: number; baseDir?: string },
  ): Promise<{ summaryPath: string | null; statsByMode: Record<string, ModeStats>; sampled: number; passed: boolean; skippedModes: string[]; latencyMsByMode: Record<string, number> }> {
    const sampleSize = Math.max(1, Math.min(opts?.sampleSize ?? 20, 100));
    const sample = (await this.store.listMemories(userId, { archived: false })).slice(0, sampleSize);
    if (sample.length < 3) {
      return { summaryPath: null, statsByMode: {}, sampled: sample.length, passed: true, skippedModes: [], latencyMsByMode: {} };
    }

    interface BenchMode {
      name: string;
      selection: { diversity: boolean };
      disableReranker: boolean;
      disableJudge: boolean;
    }
    const modes: BenchMode[] = [
      { name: "baseline", selection: { diversity: false }, disableReranker: true, disableJudge: true },
      { name: "lexmmr", selection: { diversity: true }, disableReranker: true, disableJudge: true },
    ];
    const skippedModes: string[] = [];
    // Augmentation modes run only when their service is actually configured —
    // otherwise they'd duplicate baseline and overstate coverage.
    if (this.rerankerService.isReady()) {
      modes.push({ name: "rerank", selection: { diversity: true }, disableReranker: false, disableJudge: true });
    } else {
      skippedModes.push("rerank (no reranker configured)");
    }
    if (this.relevanceJudge.isReady()) {
      modes.push({ name: "judge", selection: { diversity: true }, disableReranker: false, disableJudge: false });
    } else {
      skippedModes.push("judge (relevance judge disabled)");
    }

    const statsByMode: Record<string, ModeStats> = {};
    const latencyMsByMode: Record<string, number> = {}; // MEM-25 — publishable latency
    for (const mode of modes) {
      const ranks: number[] = [];
      const startedAt = Date.now();
      for (const rec of sample) {
        const query = deriveBenchQuery(rec.content);
        if (!query) { ranks.push(-1); continue; }
        const result = await this.recall({
          userId,
          sessionKey: "benchmark",
          query,
          limitsOverride: { topResults: 20 }, // @20 coverage, per-call (no env mutation)
          selectionOverride: mode.selection,
          disableReranker: mode.disableReranker,
          disableJudge: mode.disableJudge,
        });
        const ranked = (result.recalledCognitiveMemories ?? []).map((m) => m.recordId);
        ranks.push(ranked.indexOf(rec.recordId)); // 0-based rank, -1 if not resurfaced
      }
      statsByMode[mode.name] = aggregateRanks(ranks);
      latencyMsByMode[mode.name] = Date.now() - startedAt;
    }
    if (skippedModes.length > 0) {
      console.error(`[BrainRouter] benchmark skipped modes: ${skippedModes.join(", ")}`);
    }

    let summaryPath: string | null = null;
    try {
      const dir = opts?.baseDir ?? path.join(os.homedir(), ".brainrouter", "bench", userId);
      fs.mkdirSync(dir, { recursive: true });
      summaryPath = path.join(dir, `bench-${Date.now()}.md`);
      const latencyNote = `\n_Latency (ms): ${Object.entries(latencyMsByMode).map(([m, ms]) => `${m}=${ms}`).join(", ") || "n/a"}._\n`;
      const skippedNote = skippedModes.length > 0 ? `\n_Skipped: ${skippedModes.join("; ")}._\n` : "";
      fs.writeFileSync(summaryPath, formatModesSummaryMd(statsByMode) + latencyNote + skippedNote, "utf8");
    } catch {
      summaryPath = null;
    }
    // Sane regression floor: the lexmmr mode should resurface ≥50% of sampled
    // records within the top 10. A bar for the CI gate, not a hard guarantee.
    const { passed } = checkThresholds(statsByMode, { lexmmr: { recall_any_at_10: 0.5 } });
    return { summaryPath, statsByMode, sampled: sample.length, passed, skippedModes, latencyMsByMode };
  }

  /**
   * MEM-25 (0.4.4) — code-recall benchmark: scores how well the code chunker
   * (MEM-18 structural + MEM-24 AST adapter) isolates known top-level symbols
   * over built-in TS/Python/Rust fixtures, and publishes the numbers to a
   * markdown file. The "code recall metrics" the competitive review asked for.
   * Pure w.r.t. memory (only writes the numbers file). Read-only.
   */
  public runCodeChunkBenchmark(opts?: { baseDir?: string }): CodeRecallResult & { summaryPath: string | null } {
    const result = benchmarkCodeChunking(DEFAULT_CODE_SAMPLES);
    let summaryPath: string | null = null;
    try {
      const dir = opts?.baseDir ?? path.join(os.homedir(), ".brainrouter", "bench");
      fs.mkdirSync(dir, { recursive: true });
      summaryPath = path.join(dir, `code-recall-${Date.now()}.md`);
      fs.writeFileSync(summaryPath, formatCodeRecallMd(result), "utf8");
    } catch {
      summaryPath = null;
    }
    return { ...result, summaryPath };
  }

  /**
   * CODE-SCALE (0.4.5) — repo-scale find_related retrieval benchmark. Ingests a
   * deterministic labelled fixture, runs find_related per seed, and scores the
   * ranked file list against the gold relevance set (recall@k / precision@k /
   * MRR / nDCG) plus token-efficiency vs. a whole-repo dump. Self-contained: it
   * writes into the engine's own store under a dedicated benchmark user so it
   * doesn't touch real memory.
   */
  public async runCodeScaleBenchmark(opts?: {
    baseDir?: string;
    userId?: string;
    k?: number;
    clusters?: number;
    perCluster?: number;
  }): Promise<RetrievalMetrics & { summaryPath: string | null }> {
    const userId = opts?.userId ?? "__codescale_bench__";
    const k = opts?.k ?? 10;
    const fixture = buildCodeScaleFixture({ clusters: opts?.clusters, perCluster: opts?.perCluster });

    // Ingest the whole fixture into the code index.
    let repoTokens = 0;
    for (const f of fixture.files) {
      await this.reindexCodeSource(userId, { filePath: f.filePath, content: f.content, language: f.language });
      repoTokens += Math.ceil(f.content.length / 4); // ~4 chars/token proxy
    }

    // Run find_related per seed, collapse hits to unique files in rank order.
    const results: RankedQueryResult[] = [];
    for (const q of fixture.queries) {
      // Seed at the first exported function body (line 5 in the fixture
      // layout); find_related resolves the seed chunk by file:line.
      const res = await this.findRelatedChunks(userId, { filePath: q.seed, line: 5 }, { limit: Math.max(k * 3, 30), includeEdges: true });
      const seen = new Set<string>();
      const ranked: string[] = [];
      let returnedTokens = 0;
      for (const hit of res.related) {
        const fp = hit.chunk.filePath;
        if (!fp || fp === q.seed) continue; // exclude the seed file itself
        returnedTokens += hit.chunk.tokenCount ?? 0;
        if (!seen.has(fp)) { seen.add(fp); ranked.push(fp); }
      }
      results.push({ query: q.seed, relevant: q.relevant, ranked, returnedTokens });
    }

    const metrics = withTokenEfficiency(
      computeRetrievalMetrics(results, k),
      fixture.queries.length ? repoTokens : 0,
    );

    let summaryPath: string | null = null;
    try {
      const dir = opts?.baseDir ?? path.join(os.homedir(), ".brainrouter", "bench");
      fs.mkdirSync(dir, { recursive: true });
      summaryPath = path.join(dir, `code-scale-${Date.now()}.md`);
      fs.writeFileSync(summaryPath, formatCodeScaleMd(metrics), "utf8");
    } catch {
      summaryPath = null;
    }
    return { ...metrics, summaryPath };
  }

  /**
   * 0.4.3 (MEM-10) — source_chunker job: re-chunk source documents with the
   * CURRENT chunker (kind-aware: AST chunker for file/code, text chunker
   * otherwise). PROVENANCE-SAFE — skips any doc whose chunks are already cited
   * by a live memory, because re-chunking mints new chunk ids and would orphan
   * the cognitive_source_links (memory_verify / provenance would break). Text is
   * reassembled from the existing ordered chunks. user-scoped. Returns counts.
   */
  public async rechunkSources(userId: string, documentIds: string[]): Promise<{ rechunked: number; skipped: number; chunksWritten: number }> {
    const store = this.store as any;
    if (typeof store.getSourceChunksByDocument !== "function" || typeof store.replaceSourceChunks !== "function") {
      return { rechunked: 0, skipped: 0, chunksWritten: 0 };
    }
    let rechunked = 0;
    let skipped = 0;
    let chunksWritten = 0;
    for (const docId of documentIds) {
      const doc = await store.getSourceDocument?.(docId);
      if (!doc || doc.userId !== userId) { skipped++; continue; }          // ownership (MEM-14)
      if (await store.isSourceDocumentReferenced(docId)) { skipped++; continue; } // provenance-safe
      const chunks = (await store.getSourceChunksByDocument(docId)) as SourceChunk[];
      if (chunks.length === 0) { skipped++; continue; }
      const text = [...chunks].sort((a, b) => a.ordinal - b.ordinal).map((c) => c.content).join("\n");
      const isCode = doc.kind === "file" || doc.kind === "code";
      const fresh = isCode ? chunkCode(text) : chunkSource(text);
      const written = (await store.replaceSourceChunks(docId, fresh)) as SourceChunk[];
      rechunked++;
      chunksWritten += written.length;
    }
    return { rechunked, skipped, chunksWritten };
  }

  /**
   * 0.4.3 — provenance-safe transcript retention. Delete `transcript` source
   * documents older than `olderThanDays` whose chunks are NOT referenced by a
   * live memory (so provenance drill-down never breaks). Capability-detected —
   * the prune lives on SqliteMemoryStore, not IMemoryStore. Returns counts.
   */
  public async pruneTranscriptSources(userId: string, olderThanDays: number): Promise<{ prunedDocs: number; prunedChunks: number }> {
    const store = this.store as any;
    if (typeof store.pruneTranscriptSources !== "function") {
      return { prunedDocs: 0, prunedChunks: 0 };
    }
    const days = Number.isFinite(olderThanDays) && olderThanDays >= 0 ? olderThanDays : 30;
    const beforeIso = new Date(Date.now() - days * 86_400_000).toISOString();
    return store.pruneTranscriptSources(userId, beforeIso);
  }

  /**
   * Export active records + tree nodes to a read-only markdown vault. The DB
   * stays authoritative; a hash ledger makes re-export idempotent (only changed
   * files are rewritten). Content is redacted before it lands (MEM-13's vault
   * boundary).
   */
  public async exportVault(userId: string, baseDir?: string): Promise<{ dir: string; written: number; unchanged: number; total: number }> {
    const store = this.store as any;
    if (typeof store.upsertVaultExport !== "function" || typeof store.getVaultExports !== "function") {
      return { dir: "", written: 0, unchanged: 0, total: 0 };
    }
    const dir = baseDir ?? path.join(os.homedir(), ".brainrouter", "vault", userId);
    const ledger = new Map<string, string>(((await store.getVaultExports(userId)) as Array<{ path: string; hash: string }>).map((e) => [e.path, e.hash]));
    let written = 0;
    let unchanged = 0;

    const writeIf = async (relPath: string, raw: string, kind: "record" | "tree", refId: string): Promise<void> => {
      const content = redactSensitiveMemoryText(raw);
      const hash = vaultHash(content);
      if (ledger.get(relPath) === hash) { unchanged++; return; }
      const abs = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      await store.upsertVaultExport(userId, { path: relPath, hash, kind, refId });
      written++;
    };

    for (const rec of await this.store.listMemories(userId, { archived: false })) {
      await writeIf(`records/${rec.recordId}.md`, renderRecordMarkdown(rec), "record", rec.recordId);
    }
    const nodes: MemoryTreeNode[] = typeof store.getAllTreeNodes === "function" ? await store.getAllTreeNodes(userId) : [];
    for (const node of nodes) {
      await writeIf(`tree/${node.id}.md`, renderTreeNodeMarkdown(node), "tree", node.id);
    }
    return { dir, written, unchanged, total: written + unchanged };
  }

  /**
   * MEM-3 — batch-level provenance: the source chunks a record was distilled
   * from, as compact excerpts (for `memory_verify`). Returns [] when the store
   * lacks the source-link capability or the record cites no sources.
   */
  public async getRecordProvenance(userId: string, recordId: string): Promise<Array<{
    chunkId: string;
    documentId: string;
    excerpt: string;
    filePath: string | null;
    symbol: string | null;
    startLine: number | null;
    endLine: number | null;
  }>> {
    const store = this.store as Partial<{ getRecordSourceChunks(userId: string, id: string): Promise<SourceChunk[]> }>;
    if (typeof store.getRecordSourceChunks !== "function") return [];
    return (await store.getRecordSourceChunks(userId, recordId)).map((c) => ({
      chunkId: c.id,
      documentId: c.documentId,
      excerpt: c.content.length > 280 ? `${c.content.slice(0, 280)}…` : c.content,
      filePath: c.filePath,
      symbol: c.symbol,
      startLine: c.startLine,
      endLine: c.endLine,
    }));
  }

  /**
   * MEM-8 — recall drill-down: fetch one source chunk by id (full content)
   * plus its parent document and, optionally, ±N neighbouring chunks for
   * context. Pairs with the excerpts returned by `memory_verify` / provenance.
   * Returns null when the store lacks the source capability or the id is
   * unknown.
   */
  public async fetchSourceChunk(
    userId: string,
    chunkId: string,
    neighbors = 0,
  ): Promise<{ chunk: SourceChunk; document: SourceDocument | null; neighbors: SourceChunk[] } | null> {
    const store = this.store as Partial<{
      getSourceChunk(id: string): Promise<SourceChunk | null>;
      getSourceDocument(id: string): Promise<SourceDocument | null>;
      getSourceChunksByDocument(documentId: string): Promise<SourceChunk[]>;
    }>;
    if (typeof store.getSourceChunk !== "function") return null;
    const chunk = await store.getSourceChunk(chunkId);
    if (!chunk) return null;
    const document =
      typeof store.getSourceDocument === "function" ? await store.getSourceDocument(chunk.documentId) : null;
    // Ownership gate: the chunk's parent document must belong to the caller.
    // (source_chunks/source_documents carry user_id per MEM-14.) Without this a
    // user could fetch any chunk by id — cross-tenant leak.
    if (!document || document.userId !== userId) return null;
    let neighborChunks: SourceChunk[] = [];
    if (neighbors > 0 && typeof store.getSourceChunksByDocument === "function") {
      neighborChunks = (await store
        .getSourceChunksByDocument(chunk.documentId))
        .filter((c) => c.id !== chunk.id && Math.abs(c.ordinal - chunk.ordinal) <= neighbors);
    }
    return { chunk, document, neighbors: neighborChunks };
  }

  /**
   * MEM-29 (0.4.4) — `find_related`: exploration-driven code recall. Seed from a
   * chunk id or a `file:line`, then retrieve the nearest code-chunk neighbours by
   * symbol/identifier overlap over the chunk FTS — language-scoped, seed
   * excluded. Unlike `fetchSourceChunk` (positional ±N within one document), this
   * crosses files to surface callers/callees/similar definitions. Read-only;
   * returns `found:false` when the store lacks the capability or the seed is
   * unknown / not owned by the caller. Ranking (MEM-26/27) lives in
   * `rankRelatedChunks` so the scoring stays pure + testable.
   */
  public async findRelatedChunks(
    userId: string,
    seed: { chunkId?: string; filePath?: string; line?: number },
    opts?: { limit?: number; sameLanguage?: boolean; maxPerFile?: number; includeEdges?: boolean },
  ): Promise<{ found: boolean; seed?: { chunkId: string; filePath: string | null; symbol: string | null }; related: RelatedChunkHit[] }> {
    const store = this.store as Partial<{
      getSourceChunk(id: string): Promise<SourceChunk | null>;
      getSourceChunkByFileLine(userId: string, filePath: string, line: number): Promise<SourceChunk | null>;
      searchSourceChunksFts(
        userId: string,
        query: string,
        limit: number,
        opts?: { excludeChunkId?: string; excludeDocumentId?: string; filePathLike?: string[] },
      ): Promise<Array<SourceChunk & { ftsRank: number }>>;
      getSourceDocument(id: string): Promise<SourceDocument | null>;
      getCodeEdgeNeighbors(userId: string, chunkId: string, direction: "callees" | "callers"): Promise<SourceChunk[]>;
      getSourceChunksByDocument(documentId: string): Promise<SourceChunk[]>;
      findImportedDocument(userId: string, candidateBase: string): Promise<SourceDocument | null>;
    }>;
    if (typeof store.searchSourceChunksFts !== "function") return { found: false, related: [] };

    // Resolve the seed chunk (by id, or by file:line span).
    let seedChunk: SourceChunk | null = null;
    if (seed.chunkId && typeof store.getSourceChunk === "function") {
      seedChunk = await store.getSourceChunk(seed.chunkId);
    } else if (seed.filePath && typeof seed.line === "number" && typeof store.getSourceChunkByFileLine === "function") {
      seedChunk = await store.getSourceChunkByFileLine(userId, seed.filePath, seed.line);
    }
    if (!seedChunk) return { found: false, related: [] };

    // Ownership gate — mirror fetchSourceChunk: the seed's parent document must
    // belong to the caller (the FTS search is already user-scoped for results).
    const doc = typeof store.getSourceDocument === "function" ? await store.getSourceDocument(seedChunk.documentId) : null;
    if (!doc || doc.userId !== userId) return { found: false, related: [] };

    const limit = Math.max(1, Math.min(50, opts?.limit ?? 10));
    const seedInfo = { chunkId: seedChunk.id, filePath: seedChunk.filePath, symbol: seedChunk.symbol };

    // MEM-28 — structural neighbours lead: the seed's direct callees/callers
    // (intra-file symbol edges) are authoritatively related regardless of
    // lexical overlap or language scope (they're in the same file), so they're
    // surfaced even when the seed has no extractable query terms.
    const edgeHits: RelatedChunkHit[] = [];
    if (opts?.includeEdges !== false && typeof store.getCodeEdgeNeighbors === "function") {
      for (const c of await store.getCodeEdgeNeighbors(userId, seedChunk.id, "callees")) {
        edgeHits.push({ chunk: c, score: 0.97, reason: "graph:callee" });
      }
      for (const c of await store.getCodeEdgeNeighbors(userId, seedChunk.id, "callers")) {
        edgeHits.push({ chunk: c, score: 0.95, reason: "graph:caller" });
      }
    }

    // MEM-28b — cross-file import edges: resolve the seed FILE's relative imports
    // to indexed documents and surface a lead chunk from each (a callee often
    // lives in an imported file). Resolved lazily here (order-independent).
    const importHits: RelatedChunkHit[] = [];
    if (
      opts?.includeEdges !== false && doc.uri &&
      typeof store.getSourceChunksByDocument === "function" &&
      typeof store.findImportedDocument === "function"
    ) {
      const fileChunks = await store.getSourceChunksByDocument(seedChunk.documentId);
      const specifiers = extractImportSpecifiers(fileChunks.map((c) => c.content).join("\n"));
      const seenDocs = new Set<string>([seedChunk.documentId]);
      let added = 0;
      for (const spec of specifiers) {
        if (added >= 5) break;
        const base = resolveRelativeImport(doc.uri, spec);
        if (!base) continue;
        const importedDoc = await store.findImportedDocument(userId, base);
        if (!importedDoc || seenDocs.has(importedDoc.id)) continue;
        seenDocs.add(importedDoc.id);
        const chunks = await store.getSourceChunksByDocument(importedDoc.id);
        const lead = chunks.find((c) => c.symbol) ?? chunks[0];
        if (lead) { importHits.push({ chunk: lead, score: 0.9, reason: "graph:import" }); added++; }
      }
    }

    // Lexical neighbours (symbol/identifier overlap), code-reranked (MEM-26/27).
    const query = extractChunkQueryTerms(seedChunk);
    const scope = opts?.sameLanguage === false ? [] : languageScopeFor(seedChunk.filePath);
    const lexical = query
      ? rankRelatedChunks(
          seedChunk,
          await store.searchSourceChunksFts(userId, query, limit, { excludeChunkId: seedChunk.id, filePathLike: scope.length ? scope : undefined }),
          limit,
          { maxPerFile: opts?.maxPerFile },
        )
      : [];

    // Merge: structural edges first, then lexical; dedupe by chunk id (an edge
    // entry wins over a lexical one for the same chunk), exclude the seed, cap.
    const merged: RelatedChunkHit[] = [];
    const seen = new Set<string>([seedChunk.id]);
    for (const h of [...edgeHits, ...importHits, ...lexical]) {
      if (seen.has(h.chunk.id)) continue;
      seen.add(h.chunk.id);
      merged.push(h);
      if (merged.length >= limit) break;
    }

    return { found: true, seed: seedInfo, related: merged };
  }

  /**
   * MEM-30 (0.4.4) — incremental code-index freshness. Re-index a code file by
   * content hash: a no-op when the indexed content is unchanged; on drift the
   * prior document(s) for that path are marked stale (kept for provenance,
   * excluded from `find_related`) and the fresh content is re-chunked. Reverting
   * to an exact prior version revives that document instead of duplicating.
   * Callers can cheaply gate this with a size/mtime stat before passing content.
   */
  public async reindexCodeSource(
    userId: string,
    input: { filePath: string; content: string; language?: string; title?: string; commitCount90d?: number | null; lastCommitDate?: string | null },
  ): Promise<{ status: "fresh" | "reindexed" | "unsupported"; documentId?: string; staleMarked: number; chunks: number }> {
    const store = this.store as Partial<{
      lookupDocumentByPathHash(userId: string, uri: string, hash: string): Promise<{ id: string; stale: boolean } | null>;
      markSourceDocumentsStaleByPath(userId: string, uri: string): Promise<number>;
      reviveSourceDocument(documentId: string): Promise<void>;
      createSourceDocument(input: any): Promise<SourceDocument>;
      addSourceChunks(documentId: string, chunks: any[]): Promise<SourceChunk[]>;
      setSourceDocumentChurn(documentId: string, commitCount90d: number | null, lastCommitDate: string | null): Promise<void>;
    }>;
    // B7 (MEM-CHURN) — stamp the captured churn signal onto whichever document
    // this reindex resolves to (fresh / revived / new). NULL when not provided.
    const stampChurn = (documentId: string) =>
      store.setSourceDocumentChurn?.(documentId, input.commitCount90d ?? null, input.lastCommitDate ?? null);
    if (
      typeof store.lookupDocumentByPathHash !== "function" ||
      typeof store.createSourceDocument !== "function" ||
      typeof store.addSourceChunks !== "function"
    ) {
      return { status: "unsupported", staleMarked: 0, chunks: 0 };
    }

    const hash = createHash("sha1").update(input.content ?? "").digest("hex");
    const existing = await store.lookupDocumentByPathHash(userId, input.filePath, hash);
    if (existing && !existing.stale) {
      await stampChurn(existing.id); // churn can change even when content doesn't
      return { status: "fresh", documentId: existing.id, staleMarked: 0, chunks: 0 };
    }

    const staleMarked = (await store.markSourceDocumentsStaleByPath?.(userId, input.filePath)) ?? 0;

    // Revert case — this exact content was indexed before (now staled). Revive
    // it rather than duplicate; its chunks + edges are still intact.
    if (existing) {
      await store.reviveSourceDocument?.(existing.id);
      await stampChurn(existing.id);
      return { status: "reindexed", documentId: existing.id, staleMarked, chunks: 0 };
    }

    const doc = await store.createSourceDocument({
      userId,
      workspaceTag: null,
      kind: "file",
      uri: input.filePath,
      hash,
      title: input.title ?? input.filePath,
    });
    const stored = await store.addSourceChunks(doc.id, chunkCode(input.content ?? "", { filePath: input.filePath, language: input.language }));
    await stampChurn(doc.id);
    return { status: "reindexed", documentId: doc.id, staleMarked, chunks: stored.length };
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

  public async getDiagnostics(userId: string): Promise<DiagnosticsBundle> {
    const envKeys = Object.keys(process.env)
      .filter((key) => key.startsWith("BRAINROUTER_") || key.includes("API") || key.includes("SECRET"))
      .sort();
    const recentOperations = await this.store.getOperationLog(userId, { limit: 50 });
    const recentErrors = recentOperations
      .filter((op) => /error|degrad|fail/i.test(`${op.operation} ${op.reason} ${JSON.stringify(op.metadata ?? {})}`))
      .slice(0, 10);

    return {
      timestamp: new Date().toISOString(),
      sqliteVersion: await this.store.getSqliteVersion(),
      nodeVersion: process.version,
      databaseStats: {
        userStats: await this.store.getMemoryStats(userId),
      },
      envKeys,
      recentErrors,
    };
  }

  private startExtractionSweeper(): void {
    if (process.env.BRAINROUTER_DISABLE_EXTRACTION_SWEEPER === "true") {
      return;
    }

    const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
    // Floor at 30s — a user typo of `100` (intended seconds, actually ms)
    // would otherwise fire the sweeper 10x/second, each tick hammering the
    // LLM backend with extraction calls for the entire backlog. With a
    // local LM Studio that's an instant model-unload + flood of 400s.
    // 30s is a conservative floor that still feels responsive while keeping
    // backend load sane on consumer hardware.
    const MIN_INTERVAL_MS = 30 * 1000;

    const raw = parseInt(process.env.BRAINROUTER_EXTRACTION_SWEEP_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS), 10);
    if (!Number.isFinite(raw) || raw <= 0) {
      return;
    }
    let intervalMs = raw;
    if (intervalMs < MIN_INTERVAL_MS) {
      console.error(
        `[BrainRouter] BRAINROUTER_EXTRACTION_SWEEP_INTERVAL_MS=${raw} is below the ${MIN_INTERVAL_MS}ms floor ` +
        `(value is in MILLISECONDS, not seconds). Clamping to ${MIN_INTERVAL_MS}ms. ` +
        `Use a value like 60000 (1 min) or 300000 (5 min) for local backends.`,
      );
      intervalMs = MIN_INTERVAL_MS;
    }

    this.sweeperTimer = setInterval(() => {
      if (this.sweepInProgress) {
        // Previous tick still running (likely waiting on the LLM semaphore).
        // Skip this tick instead of stacking a second invocation.
        return;
      }
      this.sweepInProgress = true;
      this.sweepUnextractedBacklog()
        .catch((err) => {
          console.error(
            "[BrainRouter] Extraction backlog sweeper failed:",
            err instanceof Error ? err.message : err,
          );
        })
        .finally(() => {
          this.sweepInProgress = false;
        });
    }, intervalMs);
    this.sweeperTimer.unref?.();
  }

  /**
   * Federation Stage 2 (FED-S2-T5) — drop stale active_sessions rows.
   * Runs alongside the extraction sweeper so we don't add yet another
   * timer; cadence is configurable via `BRAINROUTER_SESSION_SWEEP_*`.
   *
   * Defaults: tick every minute, drop rows whose `lastHeartbeatAt` is
   * older than 5 minutes. The 5-minute floor matches the spec: clients
   * heartbeat at 30s, so 5 minutes is "10 missed beats" — enough margin
   * for transient network blips without leaving ghost sessions in the
   * registry indefinitely.
   */
  private startActiveSessionSweeper(): void {
    if (process.env.BRAINROUTER_DISABLE_SESSION_SWEEPER === "true") return;

    const DEFAULT_INTERVAL_MS = 60 * 1000; // 1 minute
    const MIN_INTERVAL_MS = 10 * 1000;
    const raw = parseInt(
      process.env.BRAINROUTER_SESSION_SWEEP_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
      10,
    );
    if (!Number.isFinite(raw) || raw <= 0) return;
    const intervalMs = Math.max(raw, MIN_INTERVAL_MS);

    const olderThanMs = parseInt(
      process.env.BRAINROUTER_SESSION_SWEEP_MAX_AGE_MS ?? String(5 * 60 * 1000),
      10,
    );

    this.activeSessionSweeperTimer = setInterval(() => {
      void (async () => {
        try {
          const removed = await this.store.sweepActiveSessions(olderThanMs);
          if (removed > 0) {
            console.error(`[BrainRouter] active_sessions sweeper removed ${removed} stale row(s).`);
          }
        } catch (err) {
          console.error(
            "[BrainRouter] active_sessions sweeper failed:",
            err instanceof Error ? err.message : err,
          );
        }
      })();
    }, intervalMs);
    this.activeSessionSweeperTimer.unref?.();
  }

  /**
   * Federation Stage 3 (FED-S3) — drop delivered inbox rows older
   * than the threshold. Undelivered rows are NEVER swept: that would
   * silently drop messages whose recipient was offline at send time.
   *
   * Cadence: 5 min by default (delivered rows don't change shape so
   * a tight cadence has no payoff). Threshold: 1 hour — long enough
   * that a CLI checking its inbox after a brief restart still sees
   * yesterday's "delivered" trail, short enough to keep the table
   * from growing unbounded under a chatty broadcast load.
   */
  private startSessionInboxSweeper(): void {
    if (process.env.BRAINROUTER_DISABLE_INBOX_SWEEPER === "true") return;
    const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
    const MIN_INTERVAL_MS = 30 * 1000;
    const raw = parseInt(
      process.env.BRAINROUTER_INBOX_SWEEP_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
      10,
    );
    if (!Number.isFinite(raw) || raw <= 0) return;
    const intervalMs = Math.max(raw, MIN_INTERVAL_MS);
    const olderThanMs = parseInt(
      process.env.BRAINROUTER_INBOX_SWEEP_MAX_AGE_MS ?? String(60 * 60 * 1000),
      10,
    );
    this.sessionInboxSweeperTimer = setInterval(() => {
      void (async () => {
        try {
          const removed = await this.store.sweepSessionInbox(olderThanMs);
          if (removed > 0) {
            console.error(`[BrainRouter] session_inbox sweeper removed ${removed} delivered row(s).`);
          }
        } catch (err) {
          console.error(
            "[BrainRouter] session_inbox sweeper failed:",
            err instanceof Error ? err.message : err,
          );
        }
      })();
    }, intervalMs);
    this.sessionInboxSweeperTimer.unref?.();
  }

  public async sweepUnextractedBacklog() {
    const olderThanMs = parseInt(process.env.BRAINROUTER_EXTRACTION_SWEEP_MIN_AGE_MS ?? String(2 * 60 * 1000), 10);
    const maxFailures = parseInt(process.env.BRAINROUTER_EXTRACTION_MAX_FAILURES ?? "5", 10);
    const backlog = await this.store.sweepUnextractedBacklog({
      olderThanMs: Number.isFinite(olderThanMs) ? olderThanMs : 2 * 60 * 1000,
      maxFailures: Number.isFinite(maxFailures) ? maxFailures : 5,
      minUnextracted: 1,
      limit: 20,
    });

    let processed = 0;
    let extracted = 0;
    for (const item of backlog) {
      const result = await this.capturePipeline.processBacklog({
        userId: item.userId,
        sessionKey: item.sessionKey,
        sessionId: item.sessionId,
      });
      if (result.triggered) {
        processed += 1;
        extracted += result.extractedCount;
      }
    }

    return { candidates: backlog.length, processed, extracted };
  }

  // ============================
  // ACE Feedback Loop
  // ============================

  private readonly ACE_ARCHIVE_THRESHOLD = (() => {
    const v = parseInt(process.env.BRAINROUTER_ACE_ARCHIVE_THRESHOLD ?? "10", 10);
    return isNaN(v) || v <= 0 ? 0 : v;
  })();

  public async markCited(userId: string, citedRecordIds: string[], allRecalledRecordIds: string[]) {
    if (citedRecordIds.length > 0) {
      await this.store.markCited(userId, citedRecordIds);
    }

    if (citedRecordIds.length >= 2) {
      try {
        const sparkEngine = new NeuralSparkEngine(this.store);
        await sparkEngine.strengthenSpines(userId, citedRecordIds);
      } catch (err: any) {
        console.error("[BrainRouter] Failed to strengthen spines on citation:", err.message);
      }
    }

    const citedSet = new Set(citedRecordIds);
    const nonCited = allRecalledRecordIds.filter(id => !citedSet.has(id));

    if (nonCited.length > 0) {
      const updated = await this.store.incrementNeverCited(userId, nonCited);

      if (this.ACE_ARCHIVE_THRESHOLD > 0) {
        for (const { recordId, neverCitedCount } of updated) {
          if (neverCitedCount >= this.ACE_ARCHIVE_THRESHOLD) {
            await this.store.archiveCognitiveRecord(userId, recordId);
            console.error(`[BrainRouter] ACE: Auto-archived memory ${recordId} (never_cited_count=${neverCitedCount})`);
          }
        }
      }
    }

    return {
      cited: citedRecordIds.length,
      nonCited: nonCited.length,
      archiveThreshold: this.ACE_ARCHIVE_THRESHOLD,
    };
  }

  // ============================
  // Point-in-Time Search (asOf)
  // ============================

  public async searchAsOf(userId: string, query: string, asOf: string, limit = 10): Promise<{
    memories: Array<{ recordId: string; content: string; type: string; score: number }>;
    asOf: string;
    count: number;
  }> {
    const ts = Date.parse(asOf);
    if (isNaN(ts)) {
      throw new Error(`Invalid asOf timestamp: "${asOf}". Must be a valid ISO 8601 date string.`);
    }

    const results = await this.store.searchCognitiveFtsAsOf(userId, query, limit, asOf);
    return {
      memories: results.map(r => ({
        recordId: r.record_id,
        content: r.content,
        type: r.type,
        score: r.score,
      })),
      asOf,
      count: results.length,
    };
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
