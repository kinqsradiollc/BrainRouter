import { SqliteMemoryStore } from "./store/sqlite.js";
import type { CursorPaginationOptions, DiagnosticsBundle, EvidenceListFilters, IMemoryStore, MemoryListFilters, OperationLogFilters } from "@brainrouter/types";
import { MemoryCapturePipeline } from "./capture.js";
import { MemoryRecallPipeline } from "./recall.js";
import { EmbeddingService } from "./store/embedding.js";
import { RerankerService } from "./store/reranker.js";
import { scanSkillsForHints } from "./skill-hints-loader.js";
import { distillFocusScenes } from "./pipeline/contextual-focus-builder.js";
import { distillCoreIdentity } from "./pipeline/identity-distiller.js";
import { spikeSkill as spikeSkillActivation, decayPotential } from "./pipeline/skill-prewarm.js";
import type { LLMRunner, LLMRunParams } from "@brainrouter/types";
import { NeuralSparkEngine } from "./pipeline/neural-spark.js";
import { fetchWithExternalRetry } from "./retry.js";
import { acquireLLMSlot } from "./llm-semaphore.js";
import "dotenv/config";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { CognitiveRecord, MemoryEvidence, MemoryImport, MemoryOperation, MemoryStatus, MemoryType, UserRecord } from "@brainrouter/types";
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

    const doFetch = () => fetchWithExternalRetry(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(timeoutMs),
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
      const choice = data.choices[0];
      // Tolerate both message (standard) and delta (streaming-style) shapes.
      const content = choice?.message?.content ?? choice?.delta?.content;
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
  private extractionRunner: LLMRunner;
  private synthesisRunner: LLMRunner;
  private sweeperTimer?: NodeJS.Timeout;
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
    });

    const rerankerService = new RerankerService({
      endpoint: process.env.BRAINROUTER_RERANKER_ENDPOINT,
      apiKey: process.env.BRAINROUTER_RERANKER_API_KEY,
      model: process.env.BRAINROUTER_RERANKER_MODEL,
      topN: process.env.BRAINROUTER_RERANKER_TOP_N 
        ? parseInt(process.env.BRAINROUTER_RERANKER_TOP_N, 10) 
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
    this.recallPipeline = new MemoryRecallPipeline(this.store, embeddingService, rerankerService);
    this.startExtractionSweeper();
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
