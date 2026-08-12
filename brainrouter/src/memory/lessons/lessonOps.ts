import { createHash } from "node:crypto";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { redactSensitiveMemoryText } from "../util/redaction.js";
import { hasLearnedMemoryMetadata } from "../util/learned-record.js";
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

export interface LearnedLessonMetadata {
  schemaVersion: 1;
  itemId: string;
  tier: "evidence" | "instruction";
  origin: "model-inferred" | "human-correction";
  form: "lesson" | "procedure";
  falsifier: string;
  expectation: string;
  status: "active" | "demoted" | "retired" | "reverted";
  statusReason?: string;
  statusChangedAt?: string;
  createdAt: string;
  updatedAt: string;
  provenance: {
    sessionKey: string;
    capturedAt: string;
    checkpoint: "turn-end" | "compaction" | "session-end";
    evidence: string[];
    corroboratingActionIds?: string[];
    sawUntrustedContent: boolean;
    gateReasoning: string;
  };
  outcome: {
    retrievals: number;
    confirmations: number;
    contradictions: number;
    lastRetrievedAt?: string;
    lastConfirmedAt?: string;
    lastContradictedAt?: string;
  };
  skillId?: string;
  allowedTools?: string[];
  memoryLifecycle?: {
    status: "record-pending" | "active" | "archive-pending" | "archived";
    updatedAt: string;
    attempts: number;
    lastError?: string;
  };
}

export interface RecordLessonOptions {
  sessionKey?: string;
  activeSkill?: string;
  evidence?: string;
  priority?: number;
  kind?: string;
  supersedes?: string | string[];
  orgId?: string | null;
  learned?: LearnedLessonMetadata;
}

export async function recordLesson(
  engine: MemoryEngine,
  userId: string,
  text: string,
  opts?: RecordLessonOptions,
): Promise<{ recordId: string; reinforced: boolean; confidence: number; corroborations: number; supersededIds: string[] }> {
  const normalized = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  // ADR-032 pointers are one-to-one lifecycle links. Ordinary lessons retain
  // statement dedup; learned items include their stable item id so reverting
  // one local item cannot archive an unrelated device's shared record.
  const fingerprintInput = opts?.learned?.itemId
    ? `learned:${opts.learned.itemId}\0${normalized}`
    : normalized;
  const fingerprint = createHash("sha1").update(fingerprintInput).digest("hex");
  const orgId = opts?.orgId?.trim() || null;
  const learned = sanitizeLearnedMetadata(opts?.learned);
  const store = engine.store as typeof engine.store & {
    findLessonByFingerprint?: (u: string, f: string, org?: string | null) => Promise<CognitiveRecord | null>;
  };

  const existing = typeof store.findLessonByFingerprint === "function"
    ? await store.findLessonByFingerprint(userId, fingerprint, orgId)
    : null;
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
      metadata: {
        ...(existing.metadata ?? {}), fingerprint, corroborations,
        ...(learned ? { learned } : {}),
      },
    };
    await engine.store.upsertCognitive(updated, { skipAudit: true });
    return { recordId: existing.id, reinforced: true, confidence, corroborations, supersededIds: [] };
  }

  // LESSON-HYGIENE — store a deterministic conflict key alongside the
  // fingerprint so `findLessonConflicts` can locate same-subject lessons
  // without an LLM (see lessonHygiene.deriveConflictKey).
  const conflictKey = deriveConflictKey(text);
  const record = await engine.upsertEngineeringMemory({
    userId,
    orgId,
    sessionKey: opts?.sessionKey,
    type: "lesson",
    content: text,
    priority: opts?.priority ?? 80,
    activeSkill: opts?.activeSkill,
    sourceKind: learned?.origin === "model-inferred" ? "model_inference" : "user_instruction",
    metadata: {
      fingerprint,
      conflictKey,
      corroborations: 1,
      ...(opts?.kind ? { kind: opts.kind.slice(0, 80) } : {}),
      ...(opts?.evidence
        ? { evidence: redactSensitiveMemoryText(opts.evidence.slice(0, 800)) }
        : {}),
      ...(learned ? { learned } : {}),
    },
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
      const prior = await engine.store.getMemoryById(userId, oldId);
      if (!prior || hasLearnedMemoryMetadata(prior)) continue;
      await engine.store.invalidateCognitiveRecord(userId, oldId, record.id);
      supersededIds.push(oldId);
    } catch {
      /* unknown id — skip, don't fail the record */
    }
  }
  return { recordId: record.id, reinforced: false, confidence: record.confidence, corroborations: 1, supersededIds };
}

function sanitizeLearnedMetadata(
  value: LearnedLessonMetadata | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const clean = (text: string, max: number) => redactSensitiveMemoryText(text.slice(0, max));
  return {
    schemaVersion: 1,
    itemId: clean(value.itemId, 200),
    tier: value.tier,
    origin: value.origin,
    form: value.form,
    status: value.status,
    statusReason: value.statusReason ? clean(value.statusReason, 400) : undefined,
    statusChangedAt: value.statusChangedAt ? clean(value.statusChangedAt, 80) : undefined,
    createdAt: clean(value.createdAt, 80),
    updatedAt: clean(value.updatedAt, 80),
    falsifier: clean(value.falsifier, 400),
    expectation: clean(value.expectation, 400),
    provenance: {
      sessionKey: clean(value.provenance.sessionKey, 200),
      capturedAt: clean(value.provenance.capturedAt, 80),
      checkpoint: value.provenance.checkpoint,
      evidence: value.provenance.evidence.slice(0, 6).map((line) => clean(line, 240)),
      corroboratingActionIds: value.provenance.corroboratingActionIds?.slice(0, 8)
        .map((id) => clean(id, 160)),
      sawUntrustedContent: value.provenance.sawUntrustedContent,
      gateReasoning: clean(value.provenance.gateReasoning, 400),
    },
    outcome: {
      retrievals: Math.max(0, Math.floor(value.outcome.retrievals)),
      confirmations: Math.max(0, Math.floor(value.outcome.confirmations)),
      contradictions: Math.max(0, Math.floor(value.outcome.contradictions)),
      lastRetrievedAt: value.outcome.lastRetrievedAt,
      lastConfirmedAt: value.outcome.lastConfirmedAt,
      lastContradictedAt: value.outcome.lastContradictedAt,
    },
    skillId: value.skillId ? clean(value.skillId, 160) : undefined,
    allowedTools: value.allowedTools?.slice(0, 32).map((tool) => clean(tool, 120)),
    memoryLifecycle: value.memoryLifecycle
      ? {
        status: value.memoryLifecycle.status,
        updatedAt: clean(value.memoryLifecycle.updatedAt, 80),
        attempts: Math.max(0, Math.floor(value.memoryLifecycle.attempts)),
        lastError: value.memoryLifecycle.lastError
          ? clean(value.memoryLifecycle.lastError, 240)
          : undefined,
      }
      : undefined,
  };
}

export async function findLessonConflicts(engine: MemoryEngine, userId: string, text: string): Promise<CognitiveRecord[]> {
  const key = deriveConflictKey(text);
  if (!key) return [];
  const store = engine.store as typeof engine.store & {
    findLessonsByConflictKey?: (u: string, k: string) => Promise<CognitiveRecord[]>;
  };
  const candidates = typeof store.findLessonsByConflictKey === "function" ? await store.findLessonsByConflictKey(userId, key) : [];
  return candidates.filter((c) => lessonsConflict(c.content, text));
}

export async function sweepStaleLessons(
  engine: MemoryEngine,
  userId: string,
  opts?: { apply?: boolean; thresholds?: Partial<StalenessThresholds>; nowMs?: number; limit?: number },
): Promise<{ candidates: Array<{ recordId: string; reason: string; lastCitedAt: string | null; confidence: number }>; archived: number }> {
  const store = engine.store as typeof engine.store & {
    listLessonsForHygiene?: (u: string, limit: number) => Promise<CognitiveRecord[]>;
  };
  const lessons = typeof store.listLessonsForHygiene === "function" ? await store.listLessonsForHygiene(userId, opts?.limit ?? 1000) : [];
  const thresholds: StalenessThresholds = { ...DEFAULT_STALENESS, ...(opts?.thresholds ?? {}) };
  const nowMs = opts?.nowMs ?? Date.now();
  const candidates = lessons
    .filter((lesson) => !hasLearnedMemoryMetadata(lesson))
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
        await engine.store.updateCognitiveConfidence(userId, c.recordId, c.confidence, "archived");
        archived++;
      } catch {
        /* best-effort */
      }
    }
  }
  return { candidates, archived };
}
