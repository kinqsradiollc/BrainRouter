import { randomUUID } from "node:crypto";
import type {
  CognitiveRecord,
  MemoryEvidence,
  MemoryImport,
  MemoryStatus,
  MemoryType,
  SourceChunk,
  DiagnosticsBundle,
  GraphNode,
  GraphEdge,
} from "@kinqs/brainrouter-types";
import type { LLMRunner } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import type { MemoryCapturePipeline } from "../capture.js";
import type { EmbeddingService } from "../store/embedding.js";
import { getMemoryTypeConfig } from "../config/memory-type-config.js";
import { redactSensitiveMemoryText } from "../util/redaction.js";
import { buildSkillExtractionPrompt, parseSkillResponse } from "../skills/skill-extract.js";
import { buildReflectPrompt, parseReflectResponse } from "../util/reflect.js";
import { decayPotential } from "../pipeline/skill-prewarm.js";
import { NeuralSparkEngine } from "../pipeline/neural-spark.js";
import { pageRank, articulationPoints, shortestPath, namespaceOverview } from "../graph/graph-analytics.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.17) — the cognitive-record write / verify / synthesis
 * / analytics engine operations, extracted verbatim from MemoryEngine as free
 * functions taking the engine instance (type-only import → no runtime cycle).
 * A couple reach the engine's private LLM runner / embedding service / capture
 * pipeline through a narrow cast; everything else uses the public `store` +
 * method surface. `engine.ts`'s methods are now thin wrappers delegating here.
 * No behavior change.
 */

/** Private engine internals the write/synthesis paths need, via a narrow cast. */
type EngineInternals = {
  synthesisRunner: LLMRunner;
  embeddingService: EmbeddingService;
  capturePipeline: MemoryCapturePipeline;
  ACE_ARCHIVE_THRESHOLD: number;
};

export function capturePassiveL0(engine: MemoryEngine, params: {
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
  engine.store.upsertSensory(record);
  return record;
}

export async function getSkillActivations(engine: MemoryEngine, userId: string) {
  const raw = await engine.store.getSkillActivations(userId);
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

export async function graphAnalytics(
  engine: MemoryEngine,
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
  const store = engine.store as unknown as Partial<{
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

export async function getMemoryById(engine: MemoryEngine, userId: string, recordId: string) {
  const memory = await engine.store.getMemoryById(userId, recordId);
  if (!memory) return null;
  return { memory, evidence: await engine.store.getEvidenceByRecord(userId, recordId) };
}

export async function upsertEngineeringMemory(engine: MemoryEngine, params: {
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
  await engine.store.upsertCognitive(record);
  return record;
}

export async function verifyMemories(
  engine: MemoryEngine,
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
  const store = engine.store as Partial<{
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
  const records = (await engine.store.listMemories(userId, { archived: false })).slice(0, limit);
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

export async function extractSkillFromSession(
  engine: MemoryEngine,
  userId: string,
  opts: {
    sessionSummary: string;
    sessionKey?: string;
    activeSkill?: string;
    llm?: (params: { prompt: string; systemPrompt?: string; timeoutMs?: number }) => Promise<string>;
  },
): Promise<{ extracted: boolean; recordId?: string; reinforced?: boolean; skill?: string }> {
  const self = engine as unknown as EngineInternals;
  const summary = (opts.sessionSummary ?? "").trim();
  if (summary.length < 20) return { extracted: false };

  const { system, user } = buildSkillExtractionPrompt(summary);
  const run = opts.llm ?? ((p) => self.synthesisRunner.run(p as any));
  let raw: string;
  try {
    raw = await run({ prompt: user, systemPrompt: system, timeoutMs: 60_000 });
  } catch {
    return { extracted: false }; // LLM unavailable → best-effort, store nothing
  }

  const { skill } = parseSkillResponse(raw);
  if (!skill) return { extracted: false };

  const res = await engine.recordLesson(userId, skill, {
    sessionKey: opts.sessionKey,
    activeSkill: opts.activeSkill,
    priority: 82,
    kind: "skill",
  });
  return { extracted: true, recordId: res.recordId, reinforced: res.reinforced, skill };
}

export async function reflect(
  engine: MemoryEngine,
  userId: string,
  opts?: { limit?: number; llm?: (params: { prompt: string; systemPrompt?: string; timeoutMs?: number }) => Promise<string> },
): Promise<{ reflected: number; insights: string[] }> {
  const self = engine as unknown as EngineInternals;
  const records = (await engine.store.listMemories(userId, { archived: false })).slice(0, Math.max(3, Math.min(50, opts?.limit ?? 25)));
  if (records.length < 3) return { reflected: 0, insights: [] };

  const { system, user } = buildReflectPrompt(records.map((r) => r.content));
  const run = opts?.llm ?? ((p) => self.synthesisRunner.run(p as any));
  let raw: string;
  try {
    raw = await run({ prompt: user, systemPrompt: system, timeoutMs: 60_000 });
  } catch {
    return { reflected: 0, insights: [] };
  }

  const insights = parseReflectResponse(raw);
  for (const insight of insights) {
    await engine.recordLesson(userId, insight, { kind: "insight", priority: 78 });
  }
  return { reflected: insights.length, insights };
}

export async function updateMemory(engine: MemoryEngine, userId: string, recordId: string, updates: {
  content?: string;
  status?: MemoryStatus;
  confidence?: number;
  verificationStatus?: CognitiveRecord["verificationStatus"];
  note?: string;
}) {
  const existing = await engine.store.getMemoryById(userId, recordId);
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
  await engine.store.upsertCognitive(updated, { skipAudit: true });
  await engine.store.insertOperation({
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
  return engine.getMemoryById(userId, recordId);
}

export async function addEvidence(engine: MemoryEngine, userId: string, recordId: string, evidence: Omit<MemoryEvidence, "id" | "userId" | "recordId" | "observedAt"> & { id?: string; observedAt?: string }) {
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
  await engine.store.insertEvidence(ev);
  return ev;
}

export async function importMemories(engine: MemoryEngine, userId: string, data: MemoryImport) {
  const self = engine as unknown as EngineInternals;
  const result = await engine.store.importMemories(userId, data);
  // MEM-VEC (0.4.14) — embed imported records now so they're vector-searchable
  // immediately. Without this, vectors only fill via the background re-embed
  // sweep, which lags far behind a bulk import → vector recall finds nothing
  // (vector ≡ keyword in the benchmark). Opt out with BRAINROUTER_IMPORT_EMBED=0
  // for fast bulk restores (vectors then backfill via the sweep).
  if (result.importedMemories > 0 && process.env.BRAINROUTER_IMPORT_EMBED !== "0" && self.embeddingService.isReady()) {
    try {
      const embedded = await engine.store.reembedStaleRecords((text) => self.embeddingService.embed(text));
      if (embedded > 0) console.error(`[BrainRouter] Embedded ${embedded} imported records for vector recall.`);
    } catch (err) {
      console.error("[BrainRouter] embed-on-import failed (vectors backfill via the sweep):", err instanceof Error ? err.message : err);
    }
  }
  return result;
}

export async function getDiagnostics(engine: MemoryEngine, userId: string): Promise<DiagnosticsBundle> {
  const envKeys = Object.keys(process.env)
    .filter((key) => key.startsWith("BRAINROUTER_") || key.includes("API") || key.includes("SECRET"))
    .sort();
  const recentOperations = await engine.store.getOperationLog(userId, { limit: 50 });
  const recentErrors = recentOperations
    .filter((op) => /error|degrad|fail/i.test(`${op.operation} ${op.reason} ${JSON.stringify(op.metadata ?? {})}`))
    .slice(0, 10);

  return {
    timestamp: new Date().toISOString(),
    sqliteVersion: await engine.store.getSqliteVersion(),
    nodeVersion: process.version,
    databaseStats: {
      userStats: await engine.store.getMemoryStats(userId),
    },
    envKeys,
    recentErrors,
  };
}

export async function sweepUnextractedBacklog(engine: MemoryEngine) {
  const self = engine as unknown as EngineInternals;
  const olderThanMs = parseInt(process.env.BRAINROUTER_EXTRACTION_SWEEP_MIN_AGE_MS ?? String(2 * 60 * 1000), 10);
  const maxFailures = parseInt(process.env.BRAINROUTER_EXTRACTION_MAX_FAILURES ?? "5", 10);
  const backlog = await engine.store.sweepUnextractedBacklog({
    olderThanMs: Number.isFinite(olderThanMs) ? olderThanMs : 2 * 60 * 1000,
    maxFailures: Number.isFinite(maxFailures) ? maxFailures : 5,
    minUnextracted: 1,
    limit: 20,
  });

  let processed = 0;
  let extracted = 0;
  for (const item of backlog) {
    const result = await self.capturePipeline.processBacklog({
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

export async function markCited(engine: MemoryEngine, userId: string, citedRecordIds: string[], allRecalledRecordIds: string[]) {
  const ACE_ARCHIVE_THRESHOLD = (engine as unknown as EngineInternals).ACE_ARCHIVE_THRESHOLD;
  if (citedRecordIds.length > 0) {
    await engine.store.markCited(userId, citedRecordIds);
  }

  if (citedRecordIds.length >= 2) {
    try {
      const sparkEngine = new NeuralSparkEngine(engine.store);
      await sparkEngine.strengthenSpines(userId, citedRecordIds);
    } catch (err: any) {
      console.error("[BrainRouter] Failed to strengthen spines on citation:", err.message);
    }
  }

  const citedSet = new Set(citedRecordIds);
  const nonCited = allRecalledRecordIds.filter(id => !citedSet.has(id));

  if (nonCited.length > 0) {
    const updated = await engine.store.incrementNeverCited(userId, nonCited);

    if (ACE_ARCHIVE_THRESHOLD > 0) {
      for (const { recordId, neverCitedCount } of updated) {
        if (neverCitedCount >= ACE_ARCHIVE_THRESHOLD) {
          await engine.store.archiveCognitiveRecord(userId, recordId);
          console.error(`[BrainRouter] ACE: Auto-archived memory ${recordId} (never_cited_count=${neverCitedCount})`);
        }
      }
    }
  }

  return {
    cited: citedRecordIds.length,
    nonCited: nonCited.length,
    archiveThreshold: ACE_ARCHIVE_THRESHOLD,
  };
}

export async function searchAsOf(engine: MemoryEngine, userId: string, query: string, asOf: string, limit = 10): Promise<{
  memories: Array<{ recordId: string; content: string; type: string; score: number }>;
  asOf: string;
  count: number;
}> {
  const ts = Date.parse(asOf);
  if (isNaN(ts)) {
    throw new Error(`Invalid asOf timestamp: "${asOf}". Must be a valid ISO 8601 date string.`);
  }

  const results = await engine.store.searchCognitiveFtsAsOf(userId, query, limit, asOf);
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
