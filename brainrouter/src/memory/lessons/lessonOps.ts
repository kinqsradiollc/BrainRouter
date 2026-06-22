import { createHash } from "node:crypto";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import {
  deriveConflictKey,
  lessonsConflict,
  isLessonStale,
  normalizeSupersedes,
  DEFAULT_STALENESS,
  type StalenessThresholds,
} from "./lessonHygiene.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.6) — the lesson-domain engine operations, extracted
 * verbatim from MemoryEngine. Each takes the engine instance so it can use the
 * public `store` + `upsertEngineeringMemory` surface; the `MemoryEngine` import
 * is type-only, so there's no runtime cycle. `engine.ts`'s methods are now thin
 * wrappers delegating here. No behavior change.
 */

export function recordLesson(
  engine: MemoryEngine,
  userId: string,
  text: string,
  opts?: { sessionKey?: string; activeSkill?: string; evidence?: string; priority?: number; kind?: string; supersedes?: string | string[] },
): { recordId: string; reinforced: boolean; confidence: number; corroborations: number; supersededIds: string[] } {
  const normalized = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const fingerprint = createHash("sha1").update(normalized).digest("hex");
  const store = engine.store as typeof engine.store & {
    findLessonByFingerprint?: (u: string, f: string) => CognitiveRecord | null;
  };

  const existing = typeof store.findLessonByFingerprint === "function" ? store.findLessonByFingerprint(userId, fingerprint) : null;
  if (existing) {
    const confidence = Math.min(0.99, existing.confidence + (1 - existing.confidence) * 0.25);
    // The corroboration counter lives in metadata (authoritative); a fresh
    // lesson is created at 1, so the next corroboration is 2, etc.
    const prevCorr = Number((existing.metadata as any)?.corroborations ?? existing.citationCount ?? 1);
    const corroborations = prevCorr + 1;
    const nowIso = new Date().toISOString();
    const updated: CognitiveRecord = {
      ...existing,
      confidence,
      citationCount: corroborations,
      lastCitedAt: nowIso,
      updatedTime: nowIso,
      metadata: { ...(existing.metadata ?? {}), fingerprint, corroborations },
    };
    engine.store.upsertCognitive(updated, { skipAudit: true });
    return { recordId: existing.id, reinforced: true, confidence, corroborations, supersededIds: [] };
  }

  // LESSON-HYGIENE — store a deterministic conflict key alongside the
  // fingerprint so `findLessonConflicts` can locate same-subject lessons
  // without an LLM (see lessonHygiene.deriveConflictKey).
  const conflictKey = deriveConflictKey(text);
  const record = engine.upsertEngineeringMemory({
    userId,
    sessionKey: opts?.sessionKey,
    type: "lesson",
    content: text,
    priority: opts?.priority ?? 80,
    activeSkill: opts?.activeSkill,
    sourceKind: "user_instruction",
    metadata: { fingerprint, conflictKey, corroborations: 1, ...(opts?.kind ? { kind: opts.kind } : {}), ...(opts?.evidence ? { evidence: opts.evidence } : {}) },
  });

  // LESSON-HYGIENE — explicit supersede: invalidate each named prior lesson,
  // pointing `superseded_by` at this new record. Best-effort per id so one
  // bad/missing id can't sink the whole call; recall already drops
  // `invalid_at IS NOT NULL`, so a superseded lesson stops surfacing at once.
  const supersededIds: string[] = [];
  for (const oldId of normalizeSupersedes(opts?.supersedes)) {
    if (oldId === record.id) continue;
    try {
      // `invalidateCognitiveRecord` is an UPDATE that silently no-ops on an
      // unknown id, so confirm the record exists first — otherwise we'd
      // report a bogus id as "superseded".
      if (!engine.store.getMemoryById(userId, oldId)) continue;
      engine.store.invalidateCognitiveRecord(userId, oldId, record.id);
      supersededIds.push(oldId);
    } catch {
      /* unknown id — skip, don't fail the record */
    }
  }
  return { recordId: record.id, reinforced: false, confidence: record.confidence, corroborations: 1, supersededIds };
}

export function findLessonConflicts(engine: MemoryEngine, userId: string, text: string): CognitiveRecord[] {
  const key = deriveConflictKey(text);
  if (!key) return [];
  const store = engine.store as typeof engine.store & {
    findLessonsByConflictKey?: (u: string, k: string) => CognitiveRecord[];
  };
  const candidates = typeof store.findLessonsByConflictKey === "function" ? store.findLessonsByConflictKey(userId, key) : [];
  return candidates.filter((c) => lessonsConflict(c.content, text));
}

export function sweepStaleLessons(
  engine: MemoryEngine,
  userId: string,
  opts?: { apply?: boolean; thresholds?: Partial<StalenessThresholds>; nowMs?: number; limit?: number },
): { candidates: Array<{ recordId: string; reason: string; lastCitedAt: string | null; confidence: number }>; archived: number } {
  const store = engine.store as typeof engine.store & {
    listLessonsForHygiene?: (u: string, limit: number) => CognitiveRecord[];
  };
  const lessons = typeof store.listLessonsForHygiene === "function" ? store.listLessonsForHygiene(userId, opts?.limit ?? 1000) : [];
  const thresholds: StalenessThresholds = { ...DEFAULT_STALENESS, ...(opts?.thresholds ?? {}) };
  const nowMs = opts?.nowMs ?? Date.now();
  const candidates = lessons
    .filter((l) => isLessonStale(l, nowMs, thresholds))
    .map((l) => ({
      recordId: l.id,
      reason: `not cited since ${l.lastCitedAt ?? l.createdTime}; confidence ${l.confidence.toFixed(2)}; ${l.citationCount} corroboration(s)`,
      lastCitedAt: l.lastCitedAt ?? null,
      confidence: l.confidence,
    }));
  let archived = 0;
  if (opts?.apply) {
    for (const c of candidates) {
      try {
        engine.store.updateCognitiveConfidence(userId, c.recordId, c.confidence, "archived");
        archived++;
      } catch {
        /* best-effort */
      }
    }
  }
  return { candidates, archived };
}
