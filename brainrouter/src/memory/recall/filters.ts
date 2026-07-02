import type { CognitiveFtsResult, VectorSearchResult } from "@kinqs/brainrouter-types";

/**
 * Optional filters applied to the candidate pool after RRF but before
 * neural-spark propagation and reranking. Filters never *add* records — they
 * narrow what the ranking stage considers, so callers can scope a recall to
 * "feedback memories captured in the last week" without re-implementing the
 * pipeline.
 */
export interface RecallFilters {
  /** Restrict to these memory types (e.g. ["instruction", "feedback"]). */
  types?: string[];
  /** Restrict to records tagged with any of these scene names. */
  scenes?: string[];
  /** ISO timestamp lower bound on created_time. */
  capturedAfter?: string;
  /** ISO timestamp upper bound on created_time. */
  capturedBefore?: string;
  /** Drop records whose stored priority is below this threshold. */
  minPriority?: number;
  /** Restrict to records produced under this skill_tag. */
  skillTag?: string;
  /**
   * Federation Stage 1 (0.4.0) — restrict to records captured in this
   * workspace. NULL-tolerant on both sides: a record with no tag is
   * never filtered out (legacy / pre-migration rows surface in every
   * workspace), and a missing filter likewise surfaces every record.
   * Pass `workspaceTagFromPath(root)` to compute the canonical tag.
   */
  workspaceTag?: string;
  /**
   * AUG-A1 (0.4.1) — restrict to records captured under this Project tag
   * (a `.brainrouter/project.json` name, hashed via `projectTagFromName`).
   * Same NULL-tolerant semantics as `workspaceTag`: untagged records and a
   * missing filter both surface. Used when `scope: 'project'`.
   */
  projectTag?: string;
  /**
   * AUG-A1 — recall scope. `'workspace'` (default) keeps the existing
   * workspace-tag behaviour; `'project'` widens to the active project
   * (filtering by `projectTag` instead of `workspaceTag`).
   */
  scope?: "project" | "workspace";
}

/** SESSION-SCOPED kinds — captured per chat session, never recalled cross-session. */
const SESSION_SCOPED_KINDS = new Set(["artifact", "annotation"]);

/** Read `metadata.kind` from a record's persisted `metadata_json` (best-effort). */
function metadataKind(metadataJson?: string): string | undefined {
  if (!metadataJson) return undefined;
  try {
    const m = JSON.parse(metadataJson) as { kind?: unknown };
    return typeof m?.kind === "string" ? m.kind : undefined;
  } catch {
    return undefined;
  }
}

export function applyFilters<T extends CognitiveFtsResult | VectorSearchResult>(
  records: T[],
  filters?: RecallFilters,
  workspaceTagLookup?: Map<string, string | null>,
  projectTagLookup?: Map<string, string | null>,
  sessionKey?: string,
): T[] {
  const afterMs = filters?.capturedAfter ? new Date(filters.capturedAfter).getTime() : undefined;
  const beforeMs = filters?.capturedBefore ? new Date(filters.capturedBefore).getTime() : undefined;
  const types = filters?.types && filters.types.length > 0 ? new Set(filters.types) : undefined;
  const scenes = filters?.scenes && filters.scenes.length > 0 ? new Set(filters.scenes) : undefined;
  return records.filter((r) => {
    // ARTIFACT-LINK / ANNOTATION-LINK — session-scoped records (artifacts +
    // annotations captured into the cognitive graph) are PRIVATE to the chat
    // session that produced them: they must not surface in another session's
    // recall/briefing. This hard scoping rule runs BEFORE the optional filters
    // (and even when `filters` is absent). All other records stay user-global.
    const kind = metadataKind((r as { metadata_json?: string }).metadata_json);
    if (kind !== undefined && SESSION_SCOPED_KINDS.has(kind)) {
      if (!sessionKey || (r as { session_key?: string }).session_key !== sessionKey) return false;
    }
    if (!filters) return true;
    if (types && !types.has(r.type)) return false;
    if (scenes && (!r.scene_name || !scenes.has(r.scene_name))) return false;
    if (filters.skillTag && r.skill_tag !== filters.skillTag) return false;
    if (filters.minPriority !== undefined && r.priority < filters.minPriority) return false;
    if (afterMs !== undefined || beforeMs !== undefined) {
      const created = r.created_time ? new Date(r.created_time).getTime() : NaN;
      if (Number.isNaN(created)) return false;
      if (afterMs !== undefined && created < afterMs) return false;
      if (beforeMs !== undefined && created > beforeMs) return false;
    }
    if (filters.workspaceTag) {
      // NULL-tolerant on both sides — a record with no captured tag
      // (legacy / pre-migration) surfaces in every workspace, and a
      // missing filter (handled above by `!filters`) likewise surfaces
      // every record. Federation rollout is gradual: as soon as a peer
      // CLI starts tagging new captures, those records get scoped; old
      // ones keep flowing through until they're re-extracted.
      const tag =
        (r as { workspace_tag?: string | null }).workspace_tag ??
        workspaceTagLookup?.get(r.record_id) ??
        null;
      if (tag !== null && tag !== filters.workspaceTag) return false;
    }
    if (filters.scope === "project" && filters.projectTag) {
      // Same NULL-tolerant rule as workspaceTag: untagged records surface
      // under any project so the rollout is gradual.
      const ptag =
        (r as { project_tag?: string | null }).project_tag ??
        projectTagLookup?.get(r.record_id) ??
        null;
      if (ptag !== null && ptag !== filters.projectTag) return false;
    }
    return true;
  });
}
