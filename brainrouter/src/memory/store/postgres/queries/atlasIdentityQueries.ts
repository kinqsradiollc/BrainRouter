/**
 * Core-identity, Atlas-graph, fleet-snapshot, and scheduler-state SQL —
 * verbatim extraction from `PostgresMemoryStore`.
 */

import type {
  ExtractionStatus,
  SchedulerState,
  StalledExtractionBacklog,
  CoreIdentityRecord,
  AtlasGraph,
  AtlasWorkspaceSummary,
  FleetSnapshotEntry,
} from "@kinqs/brainrouter-types";
import { asNumber } from "../converters.js";
import type { Executor } from "./executor.js";

// ── core identity ─────────────────────────────────────────────────────

export async function upsertCoreIdentity(exec: Executor, record: CoreIdentityRecord): Promise<void> {
  await exec.run(
    `INSERT INTO core_identity (user_id, persona_md, cognitive_count_at_generation, created_time, updated_time)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET
       persona_md=EXCLUDED.persona_md,
       cognitive_count_at_generation=EXCLUDED.cognitive_count_at_generation,
       updated_time=EXCLUDED.updated_time`,
    [record.userId, record.personaMd, record.cognitiveCountAtGeneration, record.createdTime, record.updatedTime],
  );
}

export async function getCoreIdentity(exec: Executor, userId: string): Promise<CoreIdentityRecord | null> {
  const row = await exec.one<any>("SELECT user_id, persona_md, cognitive_count_at_generation, created_time, updated_time FROM core_identity WHERE user_id = $1", [userId]);
  if (!row) return null;
  return {
    userId: row.user_id, personaMd: row.persona_md,
    cognitiveCountAtGeneration: asNumber(row.cognitive_count_at_generation),
    createdTime: row.created_time, updatedTime: row.updated_time,
  };
}

// ── Atlas graph persistence (REMOTE-BRAIN Phase 3) ──────────────────────

export async function putAtlasGraph(exec: Executor, userId: string, workspaceTag: string, graph: AtlasGraph): Promise<void> {
  const nodeCount = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
  await exec.run(
    `INSERT INTO atlas_graphs (user_id, workspace_tag, graph_json, node_count, updated_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, workspace_tag) DO UPDATE SET
       graph_json=EXCLUDED.graph_json,
       node_count=EXCLUDED.node_count,
       updated_at=EXCLUDED.updated_at`,
    [userId, workspaceTag, JSON.stringify(graph), nodeCount, new Date().toISOString()],
  );
}

export async function getAtlasGraph(exec: Executor, userId: string, workspaceTag: string): Promise<AtlasGraph | null> {
  const row = await exec.one<{ graph_json: string }>(
    "SELECT graph_json FROM atlas_graphs WHERE user_id = $1 AND workspace_tag = $2",
    [userId, workspaceTag],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.graph_json) as AtlasGraph;
  } catch {
    return null; // corrupt row — treat as absent rather than throwing
  }
}

export async function listAtlasWorkspaces(exec: Executor, userId: string): Promise<AtlasWorkspaceSummary[]> {
  const rows = await exec.rows<{ workspace_tag: string; node_count: unknown; updated_at: string }>(
    "SELECT workspace_tag, node_count, updated_at FROM atlas_graphs WHERE user_id = $1 ORDER BY updated_at DESC",
    [userId],
  );
  return rows.map((r) => ({
    workspaceTag: r.workspace_tag,
    nodeCount: asNumber(r.node_count),
    updatedAt: r.updated_at,
  }));
}

// HONK-H3.3 — fleet snapshot store-and-serve (mirrors the atlas_graphs pattern).
export async function putFleetSnapshot(exec: Executor, userId: string, host: string, snapshot: unknown, jobCount: number): Promise<void> {
  await exec.run(
    `INSERT INTO fleet_snapshots (user_id, host, snapshot_json, job_count, updated_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, host) DO UPDATE SET
       snapshot_json=EXCLUDED.snapshot_json,
       job_count=EXCLUDED.job_count,
       updated_at=EXCLUDED.updated_at`,
    [userId, host, JSON.stringify(snapshot ?? null), Math.max(0, Math.floor(jobCount) || 0), new Date().toISOString()],
  );
}

export async function getFleetSnapshots(exec: Executor, userId: string): Promise<FleetSnapshotEntry[]> {
  const rows = await exec.rows<{ host: string; snapshot_json: string; job_count: unknown; updated_at: string }>(
    "SELECT host, snapshot_json, job_count, updated_at FROM fleet_snapshots WHERE user_id = $1 ORDER BY updated_at DESC",
    [userId],
  );
  return rows.map((r) => {
    let snapshot: unknown = null;
    try {
      snapshot = JSON.parse(r.snapshot_json);
    } catch {
      snapshot = null; // corrupt row — relay as empty rather than throwing
    }
    return { host: r.host, snapshot, jobCount: asNumber(r.job_count), updatedAt: r.updated_at };
  });
}

export async function getIdentityAndInstructionCognitives(exec: Executor, userId: string, limit = 100): Promise<any[]> {
  return exec.rows(
    "SELECT record_id, content, type, priority, skill_tag, created_time FROM cognitive_records WHERE user_id = $1 AND type IN ('persona','instruction') AND invalid_at IS NULL ORDER BY priority DESC, created_time DESC LIMIT $2",
    [userId, limit],
  );
}

// ── scheduler state ───────────────────────────────────────────────────

export async function getSchedulerState(exec: Executor, userId: string): Promise<SchedulerState> {
  const row = await exec.one<any>(
    "SELECT cognitive_count_since_last_focus, cognitive_count_since_last_identity, total_cognitive_count, extraction_errors, last_error_message, last_error_at FROM scheduler_state WHERE user_id = $1",
    [userId],
  );
  if (!row) {
    return { cognitiveCountSinceLastFocus: 0, cognitiveCountSinceLastIdentity: 0, totalCognitiveCount: 0, extractionErrors: 0, lastErrorMessage: null, lastErrorAt: null };
  }
  return {
    cognitiveCountSinceLastFocus: asNumber(row.cognitive_count_since_last_focus),
    cognitiveCountSinceLastIdentity: asNumber(row.cognitive_count_since_last_identity),
    totalCognitiveCount: asNumber(row.total_cognitive_count),
    extractionErrors: asNumber(row.extraction_errors),
    lastErrorMessage: row.last_error_message ?? null,
    lastErrorAt: row.last_error_at ?? null,
  };
}

export async function incrementSchedulerCognitiveCount(exec: Executor, userId: string, count: number): Promise<void> {
  await exec.run(
    `INSERT INTO scheduler_state (user_id, cognitive_count_since_last_focus, cognitive_count_since_last_identity, total_cognitive_count)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET
       cognitive_count_since_last_focus = scheduler_state.cognitive_count_since_last_focus + EXCLUDED.cognitive_count_since_last_focus,
       cognitive_count_since_last_identity = scheduler_state.cognitive_count_since_last_identity + EXCLUDED.cognitive_count_since_last_identity,
       total_cognitive_count = scheduler_state.total_cognitive_count + EXCLUDED.total_cognitive_count`,
    [userId, count, count, count],
  );
}

export async function resetSchedulerFocusCount(exec: Executor, userId: string): Promise<void> {
  await exec.run("UPDATE scheduler_state SET cognitive_count_since_last_focus = 0 WHERE user_id = $1", [userId]);
}

export async function resetSchedulerIdentityCount(exec: Executor, userId: string): Promise<void> {
  await exec.run("UPDATE scheduler_state SET cognitive_count_since_last_identity = 0 WHERE user_id = $1", [userId]);
}

export async function recordExtractionFailure(exec: Executor, userId: string, message: string): Promise<void> {
  const now = new Date().toISOString();
  await exec.run(
    `INSERT INTO scheduler_state (user_id, extraction_errors, last_error_message, last_error_at)
     VALUES ($1,1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET
       extraction_errors = COALESCE(scheduler_state.extraction_errors, 0) + 1,
       last_error_message = EXCLUDED.last_error_message,
       last_error_at = EXCLUDED.last_error_at`,
    [userId, message.slice(0, 1000), now],
  );
}

export async function resetExtractionFailures(exec: Executor, userId: string): Promise<void> {
  await exec.run(
    `INSERT INTO scheduler_state (user_id, extraction_errors, last_error_message, last_error_at)
     VALUES ($1,0,NULL,NULL)
     ON CONFLICT (user_id) DO UPDATE SET extraction_errors = 0, last_error_message = NULL, last_error_at = NULL`,
    [userId],
  );
}

export async function getExtractionStatus(exec: Executor, userId: string): Promise<ExtractionStatus> {
  const state = await getSchedulerState(exec, userId);
  return {
    extractionErrors: state.extractionErrors,
    lastErrorMessage: state.lastErrorMessage,
    lastErrorAt: state.lastErrorAt,
    syncPaused: state.extractionErrors >= 5,
  };
}

export async function sweepUnextractedBacklog(exec: Executor, options: { olderThanMs: number; minUnextracted?: number; maxFailures?: number; limit?: number }): Promise<StalledExtractionBacklog[]> {
  const cutoff = new Date(Date.now() - options.olderThanMs).toISOString();
  const minUnextracted = options.minUnextracted ?? 1;
  const maxFailures = options.maxFailures ?? 5;
  const limit = options.limit ?? 20;
  const rows = await exec.rows<any>(
    `SELECT
       l0.user_id,
       l0.session_key,
       COALESCE(MAX(l0.session_id), '') AS session_id,
       COUNT(*) AS unextracted_count,
       MAX(l0.recorded_at) AS latest_recorded_at,
       COALESCE(ss.extraction_errors, 0) AS extraction_errors,
       ss.last_error_message
     FROM sensory_stream l0
     LEFT JOIN scheduler_state ss ON ss.user_id = l0.user_id
     WHERE l0.extracted_at IS NULL
     GROUP BY l0.user_id, l0.session_key, ss.extraction_errors, ss.last_error_message
     HAVING COUNT(*) >= $1 AND MAX(l0.recorded_at) <= $2 AND COALESCE(ss.extraction_errors, 0) < $3
     ORDER BY MAX(l0.recorded_at) ASC
     LIMIT $4`,
    [minUnextracted, cutoff, maxFailures, limit],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    sessionKey: row.session_key,
    sessionId: row.session_id ?? "",
    unextractedCount: asNumber(row.unextracted_count),
    latestRecordedAt: row.latest_recorded_at ?? "",
    extractionErrors: asNumber(row.extraction_errors),
    lastErrorMessage: row.last_error_message ?? null,
  }));
}
