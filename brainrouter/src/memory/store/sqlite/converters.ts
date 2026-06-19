/**
 * ADR-004 Phase 3 — pure row→record converters + SQL/JSON helpers.
 *
 * Extracted verbatim from `sqlite.ts`: these are dependency-free functions
 * (no `this`, no DB handle) that every capability module in `store/sqlite/`
 * shares to map raw SQLite rows into the typed `@kinqs/brainrouter-types`
 * records. Keeping them here lets the per-domain sub-stores import them without
 * re-exporting through the god-file.
 */

import type {
  ActiveSessionRecord,
  ActiveSessionUsage,
  CognitiveRecord,
  MemoryEvidence,
  MemoryJobRecord,
  MemoryJobStatus,
  MemoryOperation,
  SessionInboxKind,
  SessionInboxRecord,
} from "@kinqs/brainrouter-types";

// A minimal BM25 search ranking helper (for simple text split)
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

export function buildFtsQuery(raw: string): string | null {
  // Simple Unicode regex split for English + general tokens
  const tokens = raw
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((t) => t.trim())
    .filter(Boolean) ?? [];

  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function cognitiveRowToRecord(row: any): CognitiveRecord {
  return {
    id: row.record_id,
    userId: row.user_id,
    sessionKey: row.session_key ?? "",
    sessionId: row.session_id ?? "",
    content: row.content,
    type: row.type || "episodic",
    priority: row.priority ?? 50,
    sceneName: row.scene_name ?? "",
    skillTag: row.skill_tag ?? "",
    halfLifeDays: row.half_life_days ?? null,
    supersededBy: row.superseded_by ?? null,
    invalidAt: row.invalid_at ?? null,
    timestampStr: row.timestamp_str ?? "",
    timestampStart: row.timestamp_start ?? "",
    timestampEnd: row.timestamp_end ?? "",
    createdTime: row.created_time ?? "",
    updatedTime: row.updated_time ?? "",
    metadata: parseJsonObject(row.metadata_json),
    confidence: typeof row.confidence === "number" ? row.confidence : 0.65,
    status: row.status ?? (row.archived ? "archived" : "active"),
    sourceKind: row.source_kind ?? "",
    verificationStatus: row.verification_status ?? "",
    repoPaths: parseJsonArray(row.repo_paths_json),
    filePaths: parseJsonArray(row.file_paths_json),
    commands: parseJsonArray(row.commands_json),
    citationCount: row.citation_count ?? 0,
    lastCitedAt: row.last_cited_at ?? null,
    neverCitedCount: row.never_cited_count ?? 0,
    archived: Boolean(row.archived),
    workspaceTag: row.workspace_tag ?? null,
    projectTag: row.project_tag ?? null,
  };
}

export function evidenceRowToRecord(row: any): MemoryEvidence {
  return {
    id: row.id,
    userId: row.user_id,
    recordId: row.record_id,
    kind: row.kind,
    ref: row.ref,
    excerpt: row.excerpt ?? "",
    observedAt: row.observed_at ?? "",
    metadata: parseJsonObject(row.metadata_json),
  };
}

export function activeSessionRowToRecord(row: any, includeUsage: boolean): ActiveSessionRecord {
  let usage: ActiveSessionUsage | null | undefined;
  if (includeUsage && row.usage_json) {
    try {
      usage = JSON.parse(row.usage_json);
    } catch {
      usage = null;
    }
  } else if (!includeUsage) {
    usage = undefined;
  } else {
    usage = null;
  }
  return {
    sessionKey: row.session_key,
    userId: row.user_id,
    clientKind: row.client_kind ?? "http-unknown",
    workspaceRoot: row.workspace_root ?? "",
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    metadata: parseJsonObject(row.metadata_json),
    ...(usage !== undefined ? { usage } : {}),
  };
}

export function inboxRowToRecord(row: {
  id: string;
  user_id: string;
  from_session_key: string;
  to_session_key: string;
  kind: string;
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
}): SessionInboxRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed;
    }
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    userId: row.user_id,
    fromSessionKey: row.from_session_key,
    toSessionKey: row.to_session_key,
    kind: row.kind as SessionInboxKind,
    payload,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function jobRowToRecord(row: {
  id: string;
  kind: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  parent_job_id: string | null;
  input_json: string;
  output_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}): MemoryJobRecord {
  const parse = (raw: string | null): unknown => {
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as MemoryJobStatus,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    lockedAt: row.locked_at,
    parentJobId: row.parent_job_id,
    input: parse(row.input_json),
    output: parse(row.output_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function operationRowToRecord(row: any): MemoryOperation {
  return {
    id: row.id,
    userId: row.user_id,
    recordId: row.record_id ?? null,
    operation: row.operation,
    actor: row.actor ?? "",
    sessionKey: row.session_key ?? "",
    reason: row.reason ?? "",
    createdAt: row.created_at ?? "",
    metadata: parseJsonObject(row.metadata_json),
  };
}
