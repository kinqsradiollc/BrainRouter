import { SqliteMemoryStore } from "./store/sqlite.js";
import type { CursorPaginationOptions, DiagnosticsBundle, EvidenceListFilters, IMemoryStore, MemoryListFilters, OperationLogFilters } from "@kinqs/brainrouter-types";
import { MemoryCapturePipeline } from "./capture.js";
import { MemoryRecallPipeline } from "./recall.js";
import { MemoryJobRunner } from "./scheduler/runner.js";
import { enqueueAgentJob } from "./scheduler/jobs.js";
import { chunkSource } from "./source/chunker.js";
import { chunkCode } from "./source/code-chunker.js";
import { deriveBenchQuery, aggregateRanks } from "./bench/run.js";
import { formatModesSummaryMd, checkThresholds, type ModeStats } from "./bench/regression.js";
import { EmbeddingService } from "./store/embedding.js";
import { RerankerService } from "./store/reranker.js";
import { RelevanceJudgeService } from "./store/relevance-judge.js";
import { scanSkillsForHints } from "./skill-hints-loader.js";
import { distillFocusScenes } from "./pipeline/contextual-focus-builder.js";
import { planGovernance, type GovernancePlanFilters, type GovernancePlanResult } from "./governance-plan.js";
import { reconcileBlackboard } from "./blackboard/reconcile.js";
import { summarizeChildren, aggregateChunkIds, aggregateHeat, parentLevel } from "./tree/tree.js";
import { renderRecordMarkdown, renderTreeNodeMarkdown, vaultHash } from "./vault/render.js";
import { distillCoreIdentity } from "./pipeline/identity-distiller.js";
import { spikeSkill as spikeSkillActivation, decayPotential } from "./pipeline/skill-prewarm.js";
import type { LLMRunner, LLMRunParams } from "@kinqs/brainrouter-types";
import { NeuralSparkEngine } from "./pipeline/neural-spark.js";
import { fetchWithExternalRetry } from "./retry.js";
import { acquireLLMSlot } from "./llm-semaphore.js";
import { extractChatCompletionText, resolveLLMTimeoutMs } from "./llm-response.js";
import "dotenv/config";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { CognitiveRecord, MemoryEvidence, MemoryImport, MemoryOperation, MemoryStatus, MemoryType, SourceChunk, SourceDocument, UserRecord, BlackboardItem, BlackboardItemInput, BlackboardStatus, MemoryTreeNode, MemoryTreeNodeInput, MemoryTreeKind } from "@kinqs/brainrouter-types";
import { hashPassword } from "../api/auth/crypto.js";
import { getMemoryTypeConfig } from "./memory-type-config.js";
import { redactSensitiveMemoryText } from "./redaction.js";

// Configure default path
const defaultDbPath = process.env.BRAINROUTER_MEMORY_DB || path.join(os.homedir(), ".brainrouter", "memory.db");

// Configurable LLM Runner — supports per-task model routing
class ModelLLMRunner implements LLMRunner {
  private readonly modelOverride?: string;

  constructor(modelOverride?: string) {
    this.modelOverride = modelOverride?.trim() || undefined;
  }

  async run({ prompt, systemPrompt, timeoutMs = 120_000, taskId }: LLMRunParams): Promise<string> {
    const endpoint = process.env.BRAINROUTER_LLM_ENDPOINT ?? "https://api.openai.com/v1/chat/completions";
    const apiKey = process.env.BRAINROUTER_LLM_API_KEY;

    if (!apiKey) {
      // Typed sentinel so upstream pipelines can short-circuit cleanly without dumping a stack trace.
      // Callers should check `error.code === "LLM_NOT_CONFIGURED"` and skip extraction silently.
      const err: any = new Error(`[BrainRouter:${taskId}] BRAINROUTER_LLM_API_KEY is not set. Skipping LLM step.`);
      err.code = "LLM_NOT_CONFIGURED";
      throw err;
    }

    const model = this.modelOverride
      ?? (process.env.BRAINROUTER_LLM_MODEL?.trim() || undefined)
      ?? "gpt-4o-mini";

    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const effectiveTimeoutMs = resolveLLMTimeoutMs({
      endpoint,
      requestedMs: timeoutMs,
      envVarNames: taskId === "cognitive-extraction"
        ? ["BRAINROUTER_EXTRACTION_TIMEOUT_MS", "BRAINROUTER_LLM_TIMEOUT_MS"]
        : ["BRAINROUTER_LLM_TIMEOUT_MS"],
    });

    const doFetch = () => fetchWithExternalRetry(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(effectiveTimeoutMs),
    }, {
      label: `[BrainRouter:${taskId}] LLM API`,
    });

    // Acquire a slot from the global LLM semaphore BEFORE issuing the
    // request. On consumer hardware (LM Studio with a single GPU) firing
    // more than ~2 concurrent generations against the same backend causes
    // the model to thrash or auto-unload — see llm-semaphore.ts for the
    // full rationale. Cloud backends (OpenAI / OpenRouter) can lift the cap
    // with BRAINROUTER_LLM_MAX_CONCURRENT=10 (or higher).
    const release = await acquireLLMSlot();
    try {
      let res = await doFetch();

      // LM Studio quirk: if the model has been idle long enough to auto-unload,
      // it returns 400 with `{"error":"Model is unloaded."}` on the first call
      // and then loads the model in the background. The next call usually
      // succeeds. Detect that exact error and retry ONCE after a brief pause
      // so background workers (contradiction check, graph extraction, focus
      // shift detection) don't all fail when the user has been quiet for a bit.
      if (res.status === 400) {
        const errorBody = await res.text();
        if (/model\s+(is\s+)?unloaded|model\s+not\s+loaded|no\s+models?\s+loaded/i.test(errorBody)) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          res = await doFetch();
          if (!res.ok) {
            const retryBody = await res.text();
            throw new Error(
              `[BrainRouter:${taskId}] LLM model "${model}" was unloaded by the server; ` +
              `retry also failed (${res.status} ${res.statusText}). ` +
              `If you're using LM Studio, enable JIT model loading or pin the model as always-loaded. ` +
              `Original error: ${errorBody}. Retry error: ${retryBody}`,
            );
          }
        } else {
          throw new Error(`[BrainRouter:${taskId}] LLM Error (${model}): ${res.status} ${res.statusText} - ${errorBody}`);
        }
      } else if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`[BrainRouter:${taskId}] LLM Error (${model}): ${res.status} ${res.statusText} - ${errorBody}`);
      }

      const data = await res.json() as any;
      // Defensive parsing — see brainrouter/src/agent/agent.ts callOpenAI for the
      // full rationale. The short version: some endpoints return HTTP 200
      // with an `error` envelope or a non-standard schema. Surface the
      // actual response body in the error so a misconfigured model name
      // doesn't crash with "Cannot read properties of undefined".
      if (data && typeof data === "object" && data.error) {
        const errMsg = typeof data.error === "string"
          ? data.error
          : (data.error.message ?? JSON.stringify(data.error).slice(0, 400));
        throw new Error(`[BrainRouter:${taskId}] LLM endpoint returned an error envelope: ${errMsg}`);
      }
      if (!Array.isArray(data?.choices) || data.choices.length === 0) {
        throw new Error(
          `[BrainRouter:${taskId}] LLM endpoint returned no choices for model "${model}". ` +
          `Response body: ${JSON.stringify(data).slice(0, 600)}`,
        );
      }
      // Tolerate standard, streaming-style, and reasoning-model shapes. Some
      // local OpenAI-compatible backends return an empty message.content with
      // useful output in reasoning_content.
      const choice = data.choices[0];
      const content = extractChatCompletionText(data);
      if (typeof content !== "string") {
        throw new Error(
          `[BrainRouter:${taskId}] LLM choice had no usable content. Choice: ${JSON.stringify(choice).slice(0, 600)}`,
        );
      }
      return content;
    } finally {
      // Always release, success or failure, so the queue keeps moving even
      // if an upstream throw bubbles. The semaphore's release is idempotent.
      release();
    }
  }
}

export class MemoryEngine {
  public readonly store: IMemoryStore;
  private capturePipeline: MemoryCapturePipeline;
  private recallPipeline: MemoryRecallPipeline;
  /** MEM-19 — kept to query reranker/judge readiness when picking benchmark modes. */
  private rerankerService!: RerankerService;
  private relevanceJudge!: RelevanceJudgeService;
  private extractionRunner: LLMRunner;
  private synthesisRunner: LLMRunner;
  private sweeperTimer?: NodeJS.Timeout;
  private activeSessionSweeperTimer?: NodeJS.Timeout;
  private sessionInboxSweeperTimer?: NodeJS.Timeout;
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
  
  constructor(storeOrDbPath: IMemoryStore | string = defaultDbPath) {
    if (typeof storeOrDbPath === "string") {
      const dir = path.dirname(storeOrDbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.store = new SqliteMemoryStore(storeOrDbPath);
    } else {
      this.store = storeOrDbPath;
    }
    this.store.init();
    this.ensureSeedAdminUser().catch((err) => {
      console.error("[BrainRouter] Failed to seed admin user:", err instanceof Error ? err.message : err);
    });

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

    // Relevance judge sits behind a flag (off by default) — opt in with
    // BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true. Falls back to the shared
    // BRAINROUTER_LLM_* settings unless explicitly overridden so a single
    // LLM credential covers extraction, synthesis, and judging.
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

    this.store.initVec(embeddingService.getDimensions());
    if (embeddingService.isReady()) {
      void this.store.reembedStaleRecords((text) => embeddingService.embed(text)).then((count) => {
        if (count > 0) {
          console.error(`[BrainRouter] Re-embedded ${count} stale cognitive vector records.`);
        }
      }).catch((err) => {
        console.error("[BrainRouter] Failed to re-embed stale cognitive vector records:", err instanceof Error ? err.message : err);
      });
    }
    
    this.capturePipeline = new MemoryCapturePipeline(this.store, this.extractionRunner, embeddingService, 1);
    this.recallPipeline = new MemoryRecallPipeline(this.store, embeddingService, rerankerService, relevanceJudge);
    this.rerankerService = rerankerService; // MEM-19 — readiness drives benchmark mode selection
    this.relevanceJudge = relevanceJudge;
    this.startExtractionSweeper();
    this.startActiveSessionSweeper();
    this.startSessionInboxSweeper();
    this.startJobRunner();
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
        onTick: () => { this.enqueueScheduledMaintenance(); },
      },
    );
    this.jobRunner.start();
  }

  // 0.4.3 — scheduled-maintenance cadence (own throttle, independent of the
  // much faster drain interval). Do real work at most every 5 min; export the
  // vault ~hourly (every 12th pass) since it rescans records each run.
  private maintenanceLastAt = 0;
  private maintenancePass = 0;

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
  public enqueueScheduledMaintenance(force = false): { enqueued: Record<string, number>; skipped?: boolean } {
    if (process.env.BRAINROUTER_JOB_MAINTENANCE === "off") return { enqueued: {}, skipped: true };
    const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
    const VAULT_MAINTENANCE_EVERY = 12; // ~hourly at the 5-min cadence
    const now = Date.now();
    if (!force && now - this.maintenanceLastAt < MAINTENANCE_INTERVAL_MS) return { enqueued: {}, skipped: true };
    this.maintenanceLastAt = now;
    const pass = this.maintenancePass++;

    const enqueued: Record<string, number> = { blackboard_reconciler: 0, vault_exporter: 0, tree_sealer: 0 };
    const bb = this.blackboardStore();
    let users: { userId: string }[] = [];
    try { users = this.store.listUsers(); } catch { users = []; }
    for (const { userId } of users) {
      if (!userId) continue;
      if (bb && bb.getBlackboardItems(userId, "pending").length > 0) {
        enqueueAgentJob(this.store, "blackboard_reconciler", { userId });
        enqueued.blackboard_reconciler++;
      }
      if (pass % VAULT_MAINTENANCE_EVERY === 0) {
        enqueueAgentJob(this.store, "vault_exporter", { userId });
        enqueued.vault_exporter++;
      }
      // 0.4.3 — grow the scene-tree (leaf per mature scene); when a bucket of
      // unsealed leaves fills, enqueue tree_sealer to seal it into a parent.
      const tree = this.autobuildSceneTree(userId);
      if (tree.sealableBucket) {
        enqueueAgentJob(this.store, "tree_sealer", { userId, childIds: tree.sealableBucket, kind: "global" });
        enqueued.tree_sealer++;
      }
    }
    return { enqueued };
  }

  // 0.4.3 (MEM-10) — scene-tree autobuild thresholds.
  private static readonly TREE_MIN_SCENE_RECORDS = 3; // don't leaf a trivial scene
  private static readonly TREE_LEAF_PER_PASS = 5;     // bound work per maintenance tick
  private static readonly TREE_SEAL_THRESHOLD = 6;    // unsealed scene-leaves → seal

  /**
   * 0.4.3 (MEM-10) — the tree_sealer auto-trigger source. Builds a DURABLE
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
  public autobuildSceneTree(userId: string): { leafed: number; sealableBucket: string[] | null } {
    if (process.env.BRAINROUTER_TREE_AUTOBUILD === "off") return { leafed: 0, sealableBucket: null };
    const store = this.store as any;
    if (
      typeof store.getDistinctScenes !== "function" ||
      typeof store.getSceneLeafKeys !== "function" ||
      typeof store.appendTreeNode !== "function" ||
      typeof store.getUnsealedSceneLeaves !== "function"
    ) {
      return { leafed: 0, sealableBucket: null };
    }

    const leafedKeys = new Set<string>(store.getSceneLeafKeys(userId));
    const scenes = store.getDistinctScenes(userId) as Array<{ sceneName: string; recordCount: number }>;
    let leafed = 0;
    for (const sc of scenes) {
      if (leafed >= MemoryEngine.TREE_LEAF_PER_PASS) break;
      if (!sc.sceneName || sc.recordCount < MemoryEngine.TREE_MIN_SCENE_RECORDS || leafedKeys.has(sc.sceneName)) continue;
      const contents = store.getSceneRecordContents(userId, sc.sceneName, 8) as string[];
      const digest = contents.map((c) => `- ${redactSensitiveMemoryText(c).replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
      store.appendTreeNode(userId, {
        kind: "topic",
        level: 0,
        summaryMd: `Scene: ${sc.sceneName} (${sc.recordCount} records)\n${digest}`,
        sceneKey: sc.sceneName,
      });
      leafed++;
    }

    const unsealed = store.getUnsealedSceneLeaves(userId, MemoryEngine.TREE_SEAL_THRESHOLD) as Array<{ id: string }>;
    const sealableBucket = unsealed.length >= MemoryEngine.TREE_SEAL_THRESHOLD ? unsealed.map((n) => n.id) : null;
    return { leafed, sealableBucket };
  }

  private async ensureSeedAdminUser() {
    const users = this.store.listUsers();
    if (users.length > 0) return;
    const seededUserId = process.env.BRAINROUTER_DEFAULT_ADMIN_USER_ID ?? "admin";
    const seededEmail = process.env.BRAINROUTER_ADMIN_EMAIL ?? "admin";
    const seededPassword = process.env.BRAINROUTER_ADMIN_PASSWORD?.trim();
    const apiKey = `br_${randomBytes(24).toString("hex")}`;
    this.store.createUser(seededUserId, apiKey, "Default Admin", true);
    this.store.updateUserEmail(seededUserId, seededEmail);
    if (seededPassword) {
      const passwordHash = await hashPassword(seededPassword);
      this.store.updateUserPassword(seededUserId, passwordHash);
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
      
      const persona = this.getPersona(params.userId);
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
    pagination?: CursorPaginationOptions<{ confidence: number; id: string }>
  ) {
    return this.store.getPendingContradictions(userId, pagination);
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

  public getSkillActivations(userId: string) {
    const raw = this.store.getSkillActivations(userId);
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
  public getPersona(userId: string) {
    const cached = this.personaCache.get(userId);
    if (cached && (Date.now() - cached.cachedAt) < this.PERSONA_CACHE_TTL_MS) {
      return { personaMd: cached.personaMd };
    }
    
    const persona = this.store.getCoreIdentity(userId);
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
  public queryGraph(userId: string, entity: string, skillTag?: string, maxHops = 2) {
    const node = this.store.getGraphNodeByEntity(userId, entity);
    if (!node) return { nodes: [], edges: [] };
    return this.store.getGraphNeighbors(userId, node.id, skillTag, maxHops);
  }

  public createUser(userId: string, apiKey: string, displayName = "", isAdmin = false): UserRecord {
    return this.store.createUser(userId, apiKey, displayName, isAdmin);
  }

  public getUserByApiKey(apiKey: string): UserRecord | null {
    return this.store.getUserByApiKey(apiKey);
  }

  public getUserByEmail(email: string): UserRecord | null {
    return this.store.getUserByEmail(email);
  }

  public getUserById(userId: string): UserRecord | null {
    return this.store.getUserById(userId);
  }

  public updatePassword(userId: string, hash: string): void {
    this.store.updateUserPassword(userId, hash);
  }

  public updateUserEmail(userId: string, email: string): void {
    this.store.updateUserEmail(userId, email);
  }

  public updateUserDisplayName(userId: string, displayName: string): void {
    this.store.updateUserDisplayName(userId, displayName);
  }

  public updateUserStatus(userId: string, status: "active" | "disabled"): void {
    this.store.updateUserStatus(userId, status);
  }

  public updateUserApiKey(userId: string, apiKey: string): void {
    this.store.updateUserApiKey(userId, apiKey);
  }

  public listUsers(pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): UserRecord[] {
    return this.store.listUsers(pagination);
  }

  public deleteUser(userId: string): void {
    this.store.deleteUser(userId);
  }

  public listMemories(
    userId: string,
    filters?: MemoryListFilters,
    pagination?: CursorPaginationOptions<{ createdTime: string; recordId: string }>
  ) {
    return this.store.listMemories(userId, filters, pagination);
  }

  public deleteMemory(userId: string, recordId: string) {
    this.store.archiveCognitiveRecord(userId, recordId);
  }

  public getMemoryById(userId: string, recordId: string) {
    const memory = this.store.getMemoryById(userId, recordId);
    if (!memory) return null;
    return { memory, evidence: this.store.getEvidenceByRecord(userId, recordId) };
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
  }): CognitiveRecord {
    const now = new Date().toISOString();
    const config = getMemoryTypeConfig(params.type);
    const record: CognitiveRecord = {
      id: `cognitive_manual_${randomUUID()}`,
      userId: params.userId,
      sessionKey: params.sessionKey ?? "",
      sessionId: params.sessionId ?? "",
      content: params.content,
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
    this.store.upsertCognitive(record);
    return record;
  }

  public getMemoriesByFilePath(userId: string, filePath: string, limit = 20): CognitiveRecord[] {
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
    const existing = this.store.getMemoryById(userId, recordId);
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
    this.store.upsertCognitive(updated, { skipAudit: true });
    this.store.insertOperation({
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

  public addEvidence(userId: string, recordId: string, evidence: Omit<MemoryEvidence, "id" | "userId" | "recordId" | "observedAt"> & { id?: string; observedAt?: string }) {
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
    this.store.insertEvidence(ev);
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

  public importMemories(userId: string, data: MemoryImport) {
    return this.store.importMemories(userId, data);
  }

  public governanceDelete(userId: string, recordId: string, reason: string) {
    this.store.hardDeleteMemory(userId, recordId, reason);
  }

  /**
   * MEM-11 — governance dry-run: preview which active memories a filter would
   * sweep, with counts + a size proxy + a sample, WITHOUT mutating anything.
   */
  public governancePlan(userId: string, filters: GovernancePlanFilters): GovernancePlanResult {
    const items = this.store.listMemories(userId, { type: filters.type, archived: false });
    return planGovernance(items, filters, Date.now());
  }

  // ── Blackboard commit pipeline (MEM-4) ──────────────────────────────────
  // Stage candidates → reconcile (dedup/score) → commit to cognitive records
  // with an audit trail, or reject. The blackboard store methods live on the
  // concrete store, so narrow at runtime (like the source capability).

  private blackboardStore(): {
    stageBlackboardItems(userId: string, items: BlackboardItemInput[]): BlackboardItem[];
    getBlackboardItem(id: string): BlackboardItem | null;
    getBlackboardItems(userId: string, status?: BlackboardStatus): BlackboardItem[];
    updateBlackboardItem(id: string, patch: { status?: BlackboardStatus; score?: number; conflictIds?: string[]; committedRecordId?: string | null }): void;
  } | null {
    const s = this.store as any;
    return typeof s.stageBlackboardItems === "function" &&
      typeof s.getBlackboardItems === "function" &&
      typeof s.updateBlackboardItem === "function"
      ? s
      : null;
  }

  /** MEM-4 — stage extracted candidates for review before they become memory. */
  public stageBlackboardCandidates(userId: string, items: BlackboardItemInput[]): BlackboardItem[] {
    const store = this.blackboardStore();
    if (!store) return [];
    // MEM-13 — redact candidate content at the staging boundary, before it
    // persists, so secrets never land in the blackboard.
    const redacted = items.map((i) => ({
      ...i,
      candidate: { ...i.candidate, content: redactSensitiveMemoryText(i.candidate.content) },
    }));
    return store.stageBlackboardItems(userId, redacted);
  }

  /** MEM-4 — reconcile all pending items (dedup/score/threshold) and persist the verdicts. */
  public reconcilePendingBlackboard(userId: string): { reconciled: number; duplicate: number; rejected: number; items: BlackboardItem[] } {
    const store = this.blackboardStore();
    if (!store) return { reconciled: 0, duplicate: 0, rejected: 0, items: [] };
    const decisions = reconcileBlackboard(store.getBlackboardItems(userId, "pending"));
    for (const d of decisions) store.updateBlackboardItem(d.id, { status: d.status, score: d.score, conflictIds: d.conflictIds });
    const count = (st: string) => decisions.filter((d) => d.status === st).length;
    return { reconciled: count("reconciled"), duplicate: count("duplicate"), rejected: count("rejected"), items: store.getBlackboardItems(userId) };
  }

  /** MEM-4 — promote a reconciled item to a cognitive record (with audit), linking its source chunk. */
  public commitBlackboardItem(userId: string, itemId: string): { committed: boolean; recordId?: string; reason?: string } {
    const store = this.blackboardStore();
    if (!store) return { committed: false, reason: "blackboard unavailable" };
    const item = store.getBlackboardItem(itemId);
    if (!item || item.userId !== userId) return { committed: false, reason: "not found" };
    if (item.status === "committed") return { committed: true, recordId: item.committedRecordId ?? undefined };
    if (item.status !== "reconciled") return { committed: false, reason: `status is "${item.status}"; reconcile before committing` };

    const record = this.upsertEngineeringMemory({
      userId,
      type: item.candidate.type,
      content: item.candidate.content,
      priority: item.candidate.priority,
      confidence: item.candidate.confidence,
      metadata: { committedFromBlackboard: item.id, sourceChunkId: item.sourceChunkId },
    });
    store.updateBlackboardItem(item.id, { status: "committed", committedRecordId: record.id });
    if (item.sourceChunkId) {
      const linker = this.store as Partial<{ linkRecordSources(u: string, r: string, ids: string[]): void }>;
      try { linker.linkRecordSources?.(userId, record.id, [item.sourceChunkId]); } catch { /* best-effort */ }
    }
    return { committed: true, recordId: record.id };
  }

  /** MEM-4 — drop an item without committing it. */
  public rejectBlackboardItem(userId: string, itemId: string): boolean {
    const store = this.blackboardStore();
    if (!store) return false;
    const item = store.getBlackboardItem(itemId);
    if (!item || item.userId !== userId) return false;
    store.updateBlackboardItem(itemId, { status: "rejected" });
    return true;
  }

  /** MEM-4 — list staged items (optionally by status) for review. */
  public reviewBlackboard(userId: string, status?: BlackboardStatus): BlackboardItem[] {
    const store = this.blackboardStore();
    return store ? store.getBlackboardItems(userId, status) : [];
  }

  // ── Memory tree (MEM-5) ─────────────────────────────────────────────────
  // Generic mechanics only — append a leaf, roll a bucket of children into a
  // summarized parent, and walk/drill. Policy (when to seal, source→topic→
  // global promotion) layers on top; the summarizer is deterministic here and
  // swappable for an LLM later.

  private treeStore(): {
    appendTreeNode(userId: string, input: MemoryTreeNodeInput): MemoryTreeNode;
    getTreeNode(id: string): MemoryTreeNode | null;
    getTreeChildren(parentId: string): MemoryTreeNode[];
    getTreeRoots(userId: string, kind?: MemoryTreeKind): MemoryTreeNode[];
    setTreeParent(childIds: string[], parentId: string): void;
    sealTreeNode(id: string): void;
  } | null {
    const s = this.store as any;
    return typeof s.appendTreeNode === "function" && typeof s.getTreeRoots === "function" ? s : null;
  }

  /** MEM-5 — append a leaf (level 0) summarizing some source chunks. */
  public appendTreeLeaf(userId: string, kind: MemoryTreeKind, summaryMd: string, sourceChunkIds: string[] = [], heatScore = 0): MemoryTreeNode | null {
    const store = this.treeStore();
    return store ? store.appendTreeNode(userId, { kind, level: 0, summaryMd, sourceChunkIds, heatScore }) : null;
  }

  /** MEM-5 — seal a bucket: roll the given children into a summarized parent. */
  public summarizeBucket(userId: string, childIds: string[], kind: MemoryTreeKind): MemoryTreeNode | null {
    const store = this.treeStore();
    if (!store) return null;
    const children = childIds.map((id) => store.getTreeNode(id)).filter((n): n is MemoryTreeNode => !!n);
    if (children.length === 0) return null;
    const parent = store.appendTreeNode(userId, {
      kind,
      level: parentLevel(children),
      summaryMd: summarizeChildren(children),
      sourceChunkIds: aggregateChunkIds(children),
      heatScore: aggregateHeat(children),
    });
    store.setTreeParent(childIds, parent.id);
    for (const c of children) store.sealTreeNode(c.id);
    return parent;
  }

  /** MEM-5 / MEM-8 — walk the tree: a node + its children, or the roots of a kind. */
  public treeWalk(userId: string, nodeId?: string, kind?: MemoryTreeKind): { node: MemoryTreeNode | null; children: MemoryTreeNode[]; roots?: MemoryTreeNode[] } {
    const store = this.treeStore();
    if (!store) return { node: null, children: [] };
    if (nodeId) {
      const node = store.getTreeNode(nodeId);
      return { node, children: node ? store.getTreeChildren(nodeId) : [] };
    }
    return { node: null, children: [], roots: store.getTreeRoots(userId, kind) };
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
  ): Promise<{ summaryPath: string | null; statsByMode: Record<string, ModeStats>; sampled: number; passed: boolean; skippedModes: string[] }> {
    const sampleSize = Math.max(1, Math.min(opts?.sampleSize ?? 20, 100));
    const sample = this.store.listMemories(userId, { archived: false }).slice(0, sampleSize);
    if (sample.length < 3) {
      return { summaryPath: null, statsByMode: {}, sampled: sample.length, passed: true, skippedModes: [] };
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
    for (const mode of modes) {
      const ranks: number[] = [];
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
    }
    if (skippedModes.length > 0) {
      console.error(`[BrainRouter] benchmark skipped modes: ${skippedModes.join(", ")}`);
    }

    let summaryPath: string | null = null;
    try {
      const dir = opts?.baseDir ?? path.join(os.homedir(), ".brainrouter", "bench", userId);
      fs.mkdirSync(dir, { recursive: true });
      summaryPath = path.join(dir, `bench-${Date.now()}.md`);
      const skippedNote = skippedModes.length > 0 ? `\n_Skipped: ${skippedModes.join("; ")}._\n` : "";
      fs.writeFileSync(summaryPath, formatModesSummaryMd(statsByMode) + skippedNote, "utf8");
    } catch {
      summaryPath = null;
    }
    // Sane regression floor: the lexmmr mode should resurface ≥50% of sampled
    // records within the top 10. A bar for the CI gate, not a hard guarantee.
    const { passed } = checkThresholds(statsByMode, { lexmmr: { recall_any_at_10: 0.5 } });
    return { summaryPath, statsByMode, sampled: sample.length, passed, skippedModes };
  }

  /**
   * 0.4.3 (MEM-10) — source_chunker job: re-chunk source documents with the
   * CURRENT chunker (kind-aware: AST chunker for file/code, text chunker
   * otherwise). PROVENANCE-SAFE — skips any doc whose chunks are already cited
   * by a live memory, because re-chunking mints new chunk ids and would orphan
   * the cognitive_source_links (memory_verify / provenance would break). Text is
   * reassembled from the existing ordered chunks. user-scoped. Returns counts.
   */
  public rechunkSources(userId: string, documentIds: string[]): { rechunked: number; skipped: number; chunksWritten: number } {
    const store = this.store as any;
    if (typeof store.getSourceChunksByDocument !== "function" || typeof store.replaceSourceChunks !== "function") {
      return { rechunked: 0, skipped: 0, chunksWritten: 0 };
    }
    let rechunked = 0;
    let skipped = 0;
    let chunksWritten = 0;
    for (const docId of documentIds) {
      const doc = store.getSourceDocument?.(docId);
      if (!doc || doc.userId !== userId) { skipped++; continue; }          // ownership (MEM-14)
      if (store.isSourceDocumentReferenced(docId)) { skipped++; continue; } // provenance-safe
      const chunks = store.getSourceChunksByDocument(docId) as SourceChunk[];
      if (chunks.length === 0) { skipped++; continue; }
      const text = [...chunks].sort((a, b) => a.ordinal - b.ordinal).map((c) => c.content).join("\n");
      const isCode = doc.kind === "file" || doc.kind === "code";
      const fresh = isCode ? chunkCode(text) : chunkSource(text);
      const written = store.replaceSourceChunks(docId, fresh) as SourceChunk[];
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
  public pruneTranscriptSources(userId: string, olderThanDays: number): { prunedDocs: number; prunedChunks: number } {
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
  public exportVault(userId: string, baseDir?: string): { dir: string; written: number; unchanged: number; total: number } {
    const store = this.store as any;
    if (typeof store.upsertVaultExport !== "function" || typeof store.getVaultExports !== "function") {
      return { dir: "", written: 0, unchanged: 0, total: 0 };
    }
    const dir = baseDir ?? path.join(os.homedir(), ".brainrouter", "vault", userId);
    const ledger = new Map<string, string>(store.getVaultExports(userId).map((e: { path: string; hash: string }) => [e.path, e.hash]));
    let written = 0;
    let unchanged = 0;

    const writeIf = (relPath: string, raw: string, kind: "record" | "tree", refId: string): void => {
      const content = redactSensitiveMemoryText(raw);
      const hash = vaultHash(content);
      if (ledger.get(relPath) === hash) { unchanged++; return; }
      const abs = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      store.upsertVaultExport(userId, { path: relPath, hash, kind, refId });
      written++;
    };

    for (const rec of this.store.listMemories(userId, { archived: false })) {
      writeIf(`records/${rec.recordId}.md`, renderRecordMarkdown(rec), "record", rec.recordId);
    }
    const nodes: MemoryTreeNode[] = typeof store.getAllTreeNodes === "function" ? store.getAllTreeNodes(userId) : [];
    for (const node of nodes) {
      writeIf(`tree/${node.id}.md`, renderTreeNodeMarkdown(node), "tree", node.id);
    }
    return { dir, written, unchanged, total: written + unchanged };
  }

  /**
   * MEM-3 — batch-level provenance: the source chunks a record was distilled
   * from, as compact excerpts (for `memory_verify`). Returns [] when the store
   * lacks the source-link capability or the record cites no sources.
   */
  public getRecordProvenance(userId: string, recordId: string): Array<{
    chunkId: string;
    documentId: string;
    excerpt: string;
    filePath: string | null;
    symbol: string | null;
    startLine: number | null;
    endLine: number | null;
  }> {
    const store = this.store as Partial<{ getRecordSourceChunks(userId: string, id: string): SourceChunk[] }>;
    if (typeof store.getRecordSourceChunks !== "function") return [];
    return store.getRecordSourceChunks(userId, recordId).map((c) => ({
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
  public fetchSourceChunk(
    userId: string,
    chunkId: string,
    neighbors = 0,
  ): { chunk: SourceChunk; document: SourceDocument | null; neighbors: SourceChunk[] } | null {
    const store = this.store as Partial<{
      getSourceChunk(id: string): SourceChunk | null;
      getSourceDocument(id: string): SourceDocument | null;
      getSourceChunksByDocument(documentId: string): SourceChunk[];
    }>;
    if (typeof store.getSourceChunk !== "function") return null;
    const chunk = store.getSourceChunk(chunkId);
    if (!chunk) return null;
    const document =
      typeof store.getSourceDocument === "function" ? store.getSourceDocument(chunk.documentId) : null;
    // Ownership gate: the chunk's parent document must belong to the caller.
    // (source_chunks/source_documents carry user_id per MEM-14.) Without this a
    // user could fetch any chunk by id — cross-tenant leak.
    if (!document || document.userId !== userId) return null;
    let neighborChunks: SourceChunk[] = [];
    if (neighbors > 0 && typeof store.getSourceChunksByDocument === "function") {
      neighborChunks = store
        .getSourceChunksByDocument(chunk.documentId)
        .filter((c) => c.id !== chunk.id && Math.abs(c.ordinal - chunk.ordinal) <= neighbors);
    }
    return { chunk, document, neighbors: neighborChunks };
  }

  public getOperationLog(
    userId: string,
    pagination?: CursorPaginationOptions<{ createdAt: string; id: string }>,
    filters?: OperationLogFilters
  ): MemoryOperation[] {
    return this.store.getOperationLog(userId, pagination, filters);
  }

  public getStats(userId: string) {
    return this.store.getMemoryStats(userId);
  }

  public getDiagnostics(userId: string): DiagnosticsBundle {
    const envKeys = Object.keys(process.env)
      .filter((key) => key.startsWith("BRAINROUTER_") || key.includes("API") || key.includes("SECRET"))
      .sort();
    const recentOperations = this.store.getOperationLog(userId, { limit: 50 });
    const recentErrors = recentOperations
      .filter((op) => /error|degrad|fail/i.test(`${op.operation} ${op.reason} ${JSON.stringify(op.metadata ?? {})}`))
      .slice(0, 10);

    return {
      timestamp: new Date().toISOString(),
      sqliteVersion: this.store.getSqliteVersion(),
      nodeVersion: process.version,
      databaseStats: {
        userStats: this.store.getMemoryStats(userId),
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
      try {
        const removed = this.store.sweepActiveSessions(olderThanMs);
        if (removed > 0) {
          console.error(`[BrainRouter] active_sessions sweeper removed ${removed} stale row(s).`);
        }
      } catch (err) {
        console.error(
          "[BrainRouter] active_sessions sweeper failed:",
          err instanceof Error ? err.message : err,
        );
      }
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
      try {
        const removed = this.store.sweepSessionInbox(olderThanMs);
        if (removed > 0) {
          console.error(`[BrainRouter] session_inbox sweeper removed ${removed} delivered row(s).`);
        }
      } catch (err) {
        console.error(
          "[BrainRouter] session_inbox sweeper failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }, intervalMs);
    this.sessionInboxSweeperTimer.unref?.();
  }

  public async sweepUnextractedBacklog() {
    const olderThanMs = parseInt(process.env.BRAINROUTER_EXTRACTION_SWEEP_MIN_AGE_MS ?? String(2 * 60 * 1000), 10);
    const maxFailures = parseInt(process.env.BRAINROUTER_EXTRACTION_MAX_FAILURES ?? "5", 10);
    const backlog = this.store.sweepUnextractedBacklog({
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

  public markCited(userId: string, citedRecordIds: string[], allRecalledRecordIds: string[]) {
    if (citedRecordIds.length > 0) {
      this.store.markCited(userId, citedRecordIds);
    }

    if (citedRecordIds.length >= 2) {
      try {
        const sparkEngine = new NeuralSparkEngine(this.store);
        sparkEngine.strengthenSpines(userId, citedRecordIds);
      } catch (err: any) {
        console.error("[BrainRouter] Failed to strengthen spines on citation:", err.message);
      }
    }

    const citedSet = new Set(citedRecordIds);
    const nonCited = allRecalledRecordIds.filter(id => !citedSet.has(id));

    if (nonCited.length > 0) {
      const updated = this.store.incrementNeverCited(userId, nonCited);

      if (this.ACE_ARCHIVE_THRESHOLD > 0) {
        for (const { recordId, neverCitedCount } of updated) {
          if (neverCitedCount >= this.ACE_ARCHIVE_THRESHOLD) {
            this.store.archiveCognitiveRecord(userId, recordId);
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

  public searchAsOf(userId: string, query: string, asOf: string, limit = 10): {
    memories: Array<{ recordId: string; content: string; type: string; score: number }>;
    asOf: string;
    count: number;
  } {
    const ts = Date.parse(asOf);
    if (isNaN(ts)) {
      throw new Error(`Invalid asOf timestamp: "${asOf}". Must be a valid ISO 8601 date string.`);
    }

    const results = this.store.searchCognitiveFtsAsOf(userId, query, limit, asOf);
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

// Singleton export
export const memoryEngine = new MemoryEngine();
