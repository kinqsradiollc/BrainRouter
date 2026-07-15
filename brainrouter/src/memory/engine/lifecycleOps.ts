import { randomBytes } from "node:crypto";
import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { MemoryCapturePipeline } from "../capture.js";
import { MemoryRecallPipeline } from "../recall.js";
import { MemoryJobRunner } from "../scheduler/runner.js";
import { EmbeddingService, DEFAULT_EMBEDDING_DIMENSIONS } from "../store/embedding.js";
import { RerankerService } from "../store/reranker.js";
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
  capturePipeline: MemoryCapturePipeline;
  recallPipeline: MemoryRecallPipeline;
}

/**
 * Build every service + pipeline for a fresh engine. ADR-012: the provider
 * CREDENTIALS (endpoint/apiKey/model) are NO LONGER read from env here — the
 * services start UNCONFIGURED and `applyProviderOverrides()` configures them
 * from the system org's DB provider config (after the one-time env→DB seed).
 * Only OPERATIONAL knobs (dimensions/timeouts/concurrency/opt-in flags), which
 * are not credentials, remain env-driven.
 */
export function buildServices(
  store: IMemoryStore,
  extractionRunner: ConstructorParameters<typeof MemoryCapturePipeline>[1],
  synthesisRunner: unknown,
  resolveLlmRunner?: ConstructorParameters<typeof MemoryCapturePipeline>[4],
): EngineServices {
  const embeddingService = new EmbeddingService({
    // No `dimensions` from env — the pgvector width is DB-driven: cognitive_vec
    // adopts the running store's width at boot and the write path re-dimensions
    // it to the live DB embedder's real output length. (See initVec + DEFAULT_EMBEDDING_DIMENSIONS.)
    timeoutMs: process.env.BRAINROUTER_EMBEDDING_TIMEOUT_MS
      ? parseInt(process.env.BRAINROUTER_EMBEDDING_TIMEOUT_MS, 10)
      : undefined,
  });

  const rerankerService = new RerankerService({
    topN: process.env.BRAINROUTER_RERANKER_TOP_N
      ? parseInt(process.env.BRAINROUTER_RERANKER_TOP_N, 10)
      : undefined,
    timeoutMs: process.env.BRAINROUTER_RERANKER_TIMEOUT_MS
      ? parseInt(process.env.BRAINROUTER_RERANKER_TIMEOUT_MS, 10)
      : undefined,
  });

  const capturePipeline = new MemoryCapturePipeline(store, extractionRunner, embeddingService, 1, resolveLlmRunner);
  const recallPipeline = new MemoryRecallPipeline(store, embeddingService, rerankerService);

  return { embeddingService, rerankerService, capturePipeline, recallPipeline };
}

/** Private lifecycle state on the engine, reached via a narrow cast. */
type LifecycleState = {
  store: IMemoryStore;
  embeddingService: EmbeddingService;
  synthesisRunner: unknown;
  jobRunner?: MemoryJobRunner;
  recallPipeline: MemoryRecallPipeline;
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
  // NON-DESTRUCTIVE at boot (allowRebuild:false): adopt the running store's own
  // pgvector width rather than a guessed one, so a stale hint can never drop a
  // populated cognitive_vec. A fresh store starts at DEFAULT_EMBEDDING_DIMENSIONS
  // and the first write re-dimensions it to the live DB embedder's real length.
  await self.store.initVec(DEFAULT_EMBEDDING_DIMENSIONS, { allowRebuild: false });
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
  // ADR-010 P1 — the seeded admin owns a personal org (its default), so the org
  // tier is populated from first boot even before any signup.
  await engine.tenancy.ensurePersonalOrg(seededUserId, "Default Admin");
  console.error(`[BrainRouter] Admin seeded. Email: ${seededEmail}  API key (shown once): ${apiKey}`);
}

/**
 * The `recall` decorator: run the recall pipeline, then splice the user persona
 * into the recall result. Extracted verbatim from the engine's `recall` getter.
 */
export async function recallWithDecorations(engine: MemoryEngine, params: Parameters<MemoryRecallPipeline['recall']>[0]) {
  const self = engine as unknown as LifecycleState;

  // Layer the caller's org's saved recall-quality settings (dashboard → Advanced)
  // UNDER any explicit per-call override (the benchmark's overrides still win).
  // Empty when the org has none set, so this is a no-op for a default org.
  const org = await engine.resolveRecallOverrides(params.filters?.orgId);
  const merged = {
    ...params,
    limitsOverride: { ...org.limitsOverride, ...params.limitsOverride },
    selectionOverride: { ...org.selectionOverride, ...params.selectionOverride },
    rerankBlendAlphaOverride: params.rerankBlendAlphaOverride ?? org.rerankBlendAlphaOverride,
    queryRoutingOverride: params.queryRoutingOverride ?? org.queryRoutingOverride,
  };
  const result = await self.recallPipeline.recall(merged);

  const persona = await self.getPersona(params.userId);
  if (persona) {
    const existing = result.appendSystemContext ?? "";
    result.appendSystemContext = `<user-persona>\n${persona.personaMd}\n</user-persona>\n\n` + existing;
    result.coreIdentitySummary = persona.personaMd;
  }

  return result;
}
