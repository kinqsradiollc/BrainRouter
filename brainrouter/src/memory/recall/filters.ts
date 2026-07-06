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
  /**
   * ADR-010 P5 — the caller's organization. When set, a record belonging to a
   * DIFFERENT org is dropped (hard cross-org isolation); within the caller's org
   * another member's record is only visible when shared (`visibility='org'`).
   * NULL-tolerant: an untagged (legacy) record always surfaces. Unset = no org
   * scoping (backward compatible).
   */
  orgId?: string;
  /** ADR-010 P5 — the caller's user id, paired with {@link orgId} to allow the
   *  caller's own records plus org-shared ones. */
  callerUserId?: string;
}

/**
 * ADR-010 P5 — org isolation + visibility rule. Pure + unit-tested. Returns
 * `false` to DROP a record from a caller acting in `orgId` (as `callerUserId`).
 * NULL-tolerant on the record's org so the rollout is gradual (untagged records
 * surface everywhere), and a hard boundary across orgs.
 */
export function orgVisibilityAllows(
  rec: { org_id?: string | null; visibility?: string | null; user_id?: string | null },
  orgId: string | undefined,
  callerUserId: string | undefined,
): boolean {
  if (!orgId) return true; // no org scoping requested
  const recOrg = rec.org_id ?? null;
  if (recOrg === null) return true; // untagged (legacy) — surfaces everywhere
  if (recOrg !== orgId) return false; // hard cross-org isolation
  // Same org: the caller's own records always; another member's only when shared.
  const owner = rec.user_id ?? null;
  if (callerUserId && owner && owner !== callerUserId) {
    return (rec.visibility ?? "private") === "org";
  }
  return true;
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
    // ADR-010 P5 — org isolation + visibility (hard cross-org boundary,
    // NULL-tolerant on untagged records). Runs before the optional filters.
    if (filters.orgId && !orgVisibilityAllows(r as { org_id?: string | null; visibility?: string | null; user_id?: string | null }, filters.orgId, filters.callerUserId)) return false;
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
