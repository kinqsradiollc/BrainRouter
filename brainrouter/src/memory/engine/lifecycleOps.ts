import { randomBytes } from "node:crypto";
import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { MemoryCapturePipeline } from "../capture.js";
import { MemoryRecallPipeline } from "../recall.js";
import { MemoryJobRunner, recordInlineJob } from "../scheduler/runner.js";
import { EmbeddingService } from "../store/embedding.js";
import { RerankerService } from "../store/reranker.js";
import { RelevanceJudgeService } from "../store/relevance-judge.js";
import { hashPassword } from "../../api/auth/crypto.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.17) — the engine's construction / init / shutdown /
 * job-runner / seed-admin / recall-decoration lifecycle helpers, extracted
 * verbatim from MemoryEngine as free functions (type-only import → no runtime
 * cycle). The engine's constructor + lifecycle methods now delegate here; the
 * private fields they populate/read are reached through a narrow cast that
 * mirrors the class's own field types, so semantics are unchanged. No behavior
 * change.
 */

/** The services the constructor wires onto the engine, built once from env. */
export interface EngineServices {
  embeddingService: EmbeddingService;
  rerankerService: RerankerService;
  relevanceJudge: RelevanceJudgeService;
  capturePipeline: MemoryCapturePipeline;
  recallPipeline: MemoryRecallPipeline;
}

/** Build every env-configured service + pipeline for a fresh engine. */
export function buildServices(store: IMemoryStore, extractionRunner: ConstructorParameters<typeof MemoryCapturePipeline>[1], synthesisRunner: unknown): EngineServices {
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

  const capturePipeline = new MemoryCapturePipeline(store, extractionRunner, embeddingService, 1);
  const recallPipeline = new MemoryRecallPipeline(store, embeddingService, rerankerService, relevanceJudge);

  return { embeddingService, rerankerService, relevanceJudge, capturePipeline, recallPipeline };
}

/** Private lifecycle state on the engine, reached via a narrow cast. */
type LifecycleState = {
  store: IMemoryStore;
  embeddingService: EmbeddingService;
  synthesisRunner: unknown;
  jobRunner?: MemoryJobRunner;
  recallPipeline: MemoryRecallPipeline;
  relevanceJudgeLastJobAt: number;
  ensureSeedAdminUser(): Promise<void>;
  enqueueScheduledMaintenance(force?: boolean): Promise<unknown>;
  getPersona(userId: string): Promise<{ personaMd: string } | null>;
};

/**
 * Run the store lifecycle to completion: migrations (`init`) → vector table
 * (`initVec`) → seed-admin. Then kick off the stale-vector reembed in the
 * background (best-effort; never part of the awaited readiness so startup
 * isn't gated on the embedding endpoint). Resolves once the store is ready to
 * serve.
 */
export async function initialize(engine: MemoryEngine): Promise<void> {
  const self = engine as unknown as LifecycleState;
  await self.store.init();
  await self.store.initVec(self.embeddingService.getDimensions());
  await self.ensureSeedAdminUser().catch((err) => {
    console.error("[BrainRouter] Failed to seed admin user:", err instanceof Error ? err.message : err);
  });

  if (self.embeddingService.isReady()) {
    void self.store
      .reembedStaleRecords((text) => self.embeddingService.embed(text))
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
 * BRAIN-P1 (0.4.1) — start the async job runner that drains out-of-band
 * `memory_jobs`. Synthesis distillers use the synthesis runner. The runner's
 * timer is unref'd, so it never holds the process open on its own. Disable with
 * `BRAINROUTER_JOB_RUNNER=off`.
 */
export function startJobRunner(engine: MemoryEngine): void {
  const self = engine as unknown as LifecycleState;
  if (process.env.BRAINROUTER_JOB_RUNNER === "off") return;
  self.jobRunner = new MemoryJobRunner(
    self.store,
    // `engine: this` lets the 0.4.3 depth executors (vault / blackboard /
    // tree) call the capability-detected engine ops. MemoryEngine
    // structurally satisfies JobEngineOps.
    { store: self.store, llmRunner: self.synthesisRunner as any, engine },
    {
      intervalMs: process.env.BRAINROUTER_JOB_RUNNER_INTERVAL_MS
        ? parseInt(process.env.BRAINROUTER_JOB_RUNNER_INTERVAL_MS, 10)
        : undefined,
      // 0.4.3 — auto-schedule the maintenance depth agents (own throttle).
      onTick: async () => { await self.enqueueScheduledMaintenance(); },
    },
  );
  self.jobRunner.start();
}

export async function ensureSeedAdminUser(engine: MemoryEngine): Promise<void> {
  const self = engine as unknown as LifecycleState;
  const users = await self.store.listUsers();
  if (users.length > 0) return;
  const seededUserId = process.env.BRAINROUTER_DEFAULT_ADMIN_USER_ID ?? "admin";
  const seededEmail = process.env.BRAINROUTER_ADMIN_EMAIL ?? "admin";
  const seededPassword = process.env.BRAINROUTER_ADMIN_PASSWORD?.trim();
  const apiKey = `br_${randomBytes(24).toString("hex")}`;
  await self.store.createUser(seededUserId, apiKey, "Default Admin", true);
  await self.store.updateUserEmail(seededUserId, seededEmail);
  if (seededPassword) {
    const passwordHash = await hashPassword(seededPassword);
    await self.store.updateUserPassword(seededUserId, passwordHash);
  }
  console.error(`[BrainRouter] Admin seeded. Email: ${seededEmail}  API key (shown once): ${apiKey}`);
}

/**
 * The `recall` decorator: run the recall pipeline, then (a) record a throttled
 * relevance-judge observability heartbeat when the judge actually ran, and (b)
 * splice the user persona into the recall result. Extracted verbatim from the
 * engine's `recall` getter.
 */
export async function recallWithDecorations(engine: MemoryEngine, params: Parameters<MemoryRecallPipeline['recall']>[0]) {
  const self = engine as unknown as LifecycleState;
  const result = await self.recallPipeline.recall(params);

  // MEM-10b — the relevance judge runs INLINE inside recall (request-scoped),
  // so it never produced a job row → it showed "idle · never". Record a
  // throttled observability heartbeat when the judge actually ran (the
  // recall strategy is tagged "+judge"), so the agent reflects real activity
  // without flooding the job table on every query.
  if (typeof result.recallStrategy === "string" && result.recallStrategy.includes("judge")) {
    const now = Date.now();
    if (now - self.relevanceJudgeLastJobAt > 5 * 60_000) {
      self.relevanceJudgeLastJobAt = now;
      recordInlineJob(
        self.store,
        "relevance_judge",
        { userId: params.userId, source: "recall" },
        { strategy: result.recallStrategy, kept: result.recalledCognitiveMemories?.length ?? 0 },
      );
    }
  }

  const persona = await self.getPersona(params.userId);
  if (persona) {
    const existing = result.appendSystemContext ?? "";
    result.appendSystemContext = `<user-persona>\n${persona.personaMd}\n</user-persona>\n\n` + existing;
    result.coreIdentitySummary = persona.personaMd;
  }

  return result;
}
