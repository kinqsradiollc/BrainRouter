/**
 * BRAIN-P1-T2 (0.4.1) — brain-agent registry.
 *
 * Formalises the eight pipeline stages that already run inside the
 * memory engine (today scattered across `pipeline/` with ad-hoc
 * schedulers) as data-driven `BrainAgent` rows. The IDs, modelClass,
 * reads/writes, and dependsOn edges are the contract frozen in
 * `brainrouter-docs/brain-agents.md` (BRAIN-DESIGN-T1) — dashboard /
 * CLI consumers hard-code these IDs, so they must not drift.
 *
 * This module is intentionally pure data (no LLM clients, no sqlite):
 * it is importable from vitest and from the MCP tool layer without
 * pulling `node:sqlite`. Wrapping each agent's `execute(input, job)`
 * onto the live pipeline functions is BRAIN-P1-T3 (a separate slice).
 */

import type { BrainAgent } from "@kinqs/brainrouter-types";

/**
 * Default idempotency key: stable over the job's declared input ids so
 * the scheduler can dedupe two enqueues of the same work while one is
 * still pending/running. Empty string ⇒ no in-flight dedup (the agent
 * is safe to run concurrently / has no natural identity).
 */
function idKeyFromIds(prefix: string, field: string): (input: unknown) => string {
  return (input: unknown) => {
    const ids = (input as Record<string, unknown> | null)?.[field];
    if (!Array.isArray(ids) || ids.length === 0) return "";
    return `${prefix}:${[...ids].map(String).sort().join(",")}`;
  };
}

function idKeyFromUser(prefix: string): (input: unknown) => string {
  return (input: unknown) => {
    const userId = (input as Record<string, unknown> | null)?.userId;
    return typeof userId === "string" && userId ? `${prefix}:${userId}` : "";
  };
}

const cognitiveExtractor: BrainAgent = {
  id: "cognitive_extractor",
  description: "Turns sensory turns into typed cognitive records.",
  inputSchema: { type: "object", properties: { sensoryIds: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object", properties: { recordIds: { type: "array", items: { type: "string" } } } },
  modelClass: "extraction",
  maxAttempts: 3,
  timeoutMs: 90_000,
  batchSize: 8,
  idempotencyKey: idKeyFromIds("extract", "sensoryIds"),
  reads: ["sensory_stream"],
  writes: ["cognitive_records", "cognitive_fts", "embedding_meta"],
  emits: ["MemoryChunkStored"],
  dependsOn: [],
};

const memoryDeduper: BrainAgent = {
  id: "memory_deduper",
  description: "Flags near-duplicate cognitive records before they accumulate.",
  inputSchema: { type: "object", properties: { recordIds: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object", properties: { merged: { type: "array", items: { type: "string" } } } },
  modelClass: "judge",
  maxAttempts: 3,
  timeoutMs: 60_000,
  batchSize: 16,
  idempotencyKey: idKeyFromIds("dedup", "recordIds"),
  reads: ["cognitive_records"],
  writes: ["cognitive_records"],
  emits: [],
  dependsOn: ["cognitive_extractor"],
};

const contradictionChecker: BrainAgent = {
  id: "contradiction_checker",
  description: "Detects records that contradict prior beliefs and logs the conflict.",
  inputSchema: { type: "object", properties: { recordIds: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object", properties: { contradictions: { type: "array" } } },
  modelClass: "judge",
  maxAttempts: 3,
  timeoutMs: 60_000,
  batchSize: 8,
  idempotencyKey: idKeyFromIds("contradiction", "recordIds"),
  reads: ["cognitive_records"],
  writes: ["cognitive_records", "contradictions"],
  emits: [],
  dependsOn: ["cognitive_extractor"],
};

const graphExtractor: BrainAgent = {
  id: "graph_extractor",
  description: "Extracts entities + relations from cognitive records into the graph.",
  inputSchema: { type: "object", properties: { recordIds: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object", properties: { nodes: { type: "number" }, edges: { type: "number" } } },
  modelClass: "extraction",
  maxAttempts: 3,
  timeoutMs: 90_000,
  batchSize: 8,
  idempotencyKey: idKeyFromIds("graph", "recordIds"),
  reads: ["cognitive_records"],
  writes: ["graph_nodes", "graph_edges"],
  emits: [],
  dependsOn: ["cognitive_extractor"],
};

const focusShiftJudge: BrainAgent = {
  id: "focus_shift_judge",
  description: "Decides whether new records shift the active contextual focus.",
  inputSchema: { type: "object", properties: { userId: { type: "string" } } },
  outputSchema: { type: "object", properties: { shift: { type: "boolean" }, confidence: { type: "number" } } },
  modelClass: "judge",
  maxAttempts: 2,
  timeoutMs: 45_000,
  batchSize: 1,
  idempotencyKey: idKeyFromUser("focus_shift"),
  reads: ["cognitive_records"],
  writes: ["contextual_focus"],
  emits: [],
  dependsOn: ["cognitive_extractor"],
};

const focusDistiller: BrainAgent = {
  id: "focus_distiller",
  description: "Summarises a focus scene from its member cognitive records.",
  inputSchema: { type: "object", properties: { userId: { type: "string" } } },
  outputSchema: { type: "object", properties: { sceneNames: { type: "array", items: { type: "string" } } } },
  modelClass: "synthesis",
  maxAttempts: 2,
  timeoutMs: 90_000,
  batchSize: 1,
  idempotencyKey: idKeyFromUser("focus_distill"),
  reads: ["cognitive_records", "contextual_focus"],
  writes: ["contextual_focus"],
  emits: [],
  dependsOn: ["focus_shift_judge"],
};

const identityDistiller: BrainAgent = {
  id: "identity_distiller",
  description: "Distills the user's Core Identity from accumulated records.",
  inputSchema: { type: "object", properties: { userId: { type: "string" } } },
  outputSchema: { type: "object", properties: { personaMd: { type: "string" } } },
  modelClass: "synthesis",
  maxAttempts: 2,
  timeoutMs: 120_000,
  batchSize: 1,
  idempotencyKey: idKeyFromUser("identity_distill"),
  reads: ["cognitive_records"],
  writes: ["core_identity"],
  emits: [],
  dependsOn: ["cognitive_extractor"],
};

const relevanceJudge: BrainAgent = {
  id: "relevance_judge",
  description: "Scores recall candidates for relevance to the active query.",
  inputSchema: { type: "object", properties: { query: { type: "string" }, candidateIds: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object", properties: { kept: { type: "array", items: { type: "string" } } } },
  modelClass: "judge",
  maxAttempts: 1,
  timeoutMs: 30_000,
  batchSize: 20,
  // Recall judging is request-scoped and runs in-line; no in-flight dedup.
  idempotencyKey: () => "",
  reads: ["cognitive_records"],
  writes: [],
  emits: [],
  dependsOn: [],
};

// ── 0.4.3 (MEM-10) — depth-pipeline agents ────────────────────────────────
// Data-driven rows so the scheduler / status / dashboard know these job kinds.
// Execute-wiring onto the live operations (chunker, reconcile, tree, vault,
// benchmark) is a separate slice, mirroring BRAIN-P1-T3.

const sourceChunker: BrainAgent = {
  id: "source_chunker",
  description: "Chunks captured sources (transcripts/files) into retrievable, citable source chunks.",
  inputSchema: { type: "object", properties: { documentIds: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object", properties: { chunkIds: { type: "array", items: { type: "string" } } } },
  modelClass: "none",
  maxAttempts: 3,
  timeoutMs: 60_000,
  batchSize: 16,
  idempotencyKey: idKeyFromIds("chunk", "documentIds"),
  reads: ["source_documents"],
  writes: ["source_chunks"],
  emits: ["MemoryChunkStored"],
  dependsOn: [],
};

const blackboardReconciler: BrainAgent = {
  id: "blackboard_reconciler",
  description: "Dedups/scores staged blackboard candidates before they commit to cognitive records.",
  inputSchema: { type: "object", properties: { userId: { type: "string" } } },
  outputSchema: { type: "object", properties: { reconciled: { type: "number" }, rejected: { type: "number" } } },
  modelClass: "none",
  maxAttempts: 3,
  timeoutMs: 60_000,
  batchSize: 1,
  idempotencyKey: idKeyFromUser("reconcile"),
  reads: ["memory_blackboard_items"],
  writes: ["memory_blackboard_items", "cognitive_records"],
  emits: [],
  dependsOn: [],
};

const treeSealer: BrainAgent = {
  id: "tree_sealer",
  description: "Seals a bucket of memory-tree leaves into a summarized parent node.",
  inputSchema: { type: "object", properties: { childIds: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object", properties: { parentId: { type: "string" } } },
  modelClass: "none",
  maxAttempts: 3,
  timeoutMs: 60_000,
  batchSize: 1,
  idempotencyKey: idKeyFromIds("seal", "childIds"),
  reads: ["memory_tree_nodes"],
  writes: ["memory_tree_nodes"],
  emits: [],
  dependsOn: [],
};

const treeDigest: BrainAgent = {
  id: "tree_digest",
  description: "Re-summarizes a memory-tree parent from its children (LLM digest).",
  inputSchema: { type: "object", properties: { nodeIds: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object", properties: { summarized: { type: "array", items: { type: "string" } } } },
  modelClass: "synthesis",
  maxAttempts: 3,
  timeoutMs: 90_000,
  batchSize: 4,
  idempotencyKey: idKeyFromIds("digest", "nodeIds"),
  reads: ["memory_tree_nodes", "source_chunks"],
  writes: ["memory_tree_nodes"],
  emits: [],
  dependsOn: ["tree_sealer"],
};

const vaultExporter: BrainAgent = {
  id: "vault_exporter",
  description: "Exports records + tree nodes to the read-only markdown vault mirror (idempotent via ledger).",
  inputSchema: { type: "object", properties: { userId: { type: "string" } } },
  outputSchema: { type: "object", properties: { written: { type: "number" }, unchanged: { type: "number" } } },
  modelClass: "none",
  maxAttempts: 2,
  timeoutMs: 120_000,
  batchSize: 1,
  idempotencyKey: idKeyFromUser("vault"),
  reads: ["cognitive_records", "memory_tree_nodes"],
  writes: ["vault_exports"],
  emits: [],
  dependsOn: [],
};

const benchmarkEval: BrainAgent = {
  id: "benchmark_eval",
  description: "Runs the retrieval benchmark harness (FTS/hybrid/rerank/tree/AST) and records scores.",
  inputSchema: { type: "object", properties: { userId: { type: "string" }, dataset: { type: "string" } } },
  outputSchema: { type: "object", properties: { summaryPath: { type: "string" } } },
  modelClass: "none",
  maxAttempts: 1,
  timeoutMs: 300_000,
  batchSize: 1,
  idempotencyKey: idKeyFromUser("bench"),
  reads: ["cognitive_records", "source_chunks"],
  writes: [],
  emits: [],
  dependsOn: [],
};

const BUILT_IN_AGENTS: readonly BrainAgent[] = Object.freeze([
  cognitiveExtractor,
  memoryDeduper,
  contradictionChecker,
  graphExtractor,
  focusShiftJudge,
  focusDistiller,
  identityDistiller,
  relevanceJudge,
  sourceChunker,
  blackboardReconciler,
  treeSealer,
  treeDigest,
  vaultExporter,
  benchmarkEval,
]);

const BY_ID: ReadonlyMap<string, BrainAgent> = new Map(BUILT_IN_AGENTS.map((a) => [a.id, a]));

/** All built-in brain agents, in pipeline order. */
export function listBrainAgents(): BrainAgent[] {
  return [...BUILT_IN_AGENTS];
}

/** Look up a brain agent by its stable id, or `undefined` when unknown. */
export function findBrainAgentById(id: string): BrainAgent | undefined {
  return BY_ID.get(id);
}
