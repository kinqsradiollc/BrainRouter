/**
 * ADR-061 D5 — every decision is recorded, with its probability.
 *
 * The lesson of #1724–#1727 was not that the runtime lacked evidence; it was
 * that the evidence existed and nothing surfaced it. A session spent an hour
 * looping while `recent-denials.json` held the denial driving it, unread.
 *
 * So the tier writes down what it decided, beside the denials, in the same
 * shape and with the same guarantees: bounded, session-scoped, best-effort, and
 * readable from the session directory rather than from a pasted trace. A wrong
 * decision has to be diagnosable — which consumer asked, what it asked, who
 * answered, what the probability was, which threshold it fell against, and
 * whether the rules floor stood in.
 */

import fs from 'node:fs';
import { getSessionStateFile } from '../storage/store.js';
import type { DecisionAnswer, DecisionKind } from './types.js';

export interface DecisionEntry {
  /** Which loop site asked — `shell`, `recall`, `route`, `checkpoint`. */
  consumer: string;
  /** The question's id within that ask. */
  question: string;
  kind: DecisionKind;
  /** The probability, key, or level that was decided. */
  value: number | string;
  /** How sure the provider was, when it said. */
  confidence?: number;
  /** What the consumer did with it — its own words (`ask`, `allow`, `deny`). */
  outcome?: string;
  /** The threshold the value fell against, when the consumer used one. */
  threshold?: string;
  provider: string;
  latencyMs: number;
  /** Why the rules floor stood in, when it did. */
  fellBack?: string;
  /**
   * ADR-061 D7 — what turned out to be true, when something later said.
   *
   * The other half of a calibration pair. Only a consumer that learns the
   * answer sets it: the shell gate does, because a human approving a command
   * the tier flagged IS the ground truth. Left unset everywhere nothing finds
   * out, which is most places, and an unset entry is counted as unlabelled
   * rather than assumed either way.
   */
  correct?: boolean;
  /** What an advisory provider said, when it was demoted and not acted on (D7). */
  advised?: number | string;
  ts: number;
}

/** Hard cap on how many decisions we keep (both in memory and on disk). */
export const MAX_RECENT_DECISIONS = 100;
const DECISIONS_FILE = 'recent-decisions.json';

const rings = new Map<string, DecisionEntry[]>();

const text = (value: unknown, max: number): string =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function normalize(entry: DecisionEntry): DecisionEntry {
  const value = typeof entry.value === 'number'
    // Three places is all a probability means here, and it keeps the file small.
    ? Math.round(entry.value * 1000) / 1000
    : text(entry.value, 120);
  return {
    consumer: text(entry.consumer, 60) || 'unknown',
    question: text(entry.question, 60) || 'unknown',
    kind: entry.kind,
    value,
    ...(typeof entry.confidence === 'number' ? { confidence: Math.round(entry.confidence * 1000) / 1000 } : {}),
    ...(entry.outcome ? { outcome: text(entry.outcome, 60) } : {}),
    ...(entry.threshold ? { threshold: text(entry.threshold, 60) } : {}),
    provider: text(entry.provider, 40) || 'unknown',
    latencyMs: Number.isFinite(entry.latencyMs) ? Math.max(0, Math.round(entry.latencyMs)) : 0,
    ...(entry.fellBack ? { fellBack: text(entry.fellBack, 300) } : {}),
    ...(typeof entry.correct === 'boolean' ? { correct: entry.correct } : {}),
    ...(entry.advised !== undefined
      ? { advised: typeof entry.advised === 'number' ? Math.round(entry.advised * 1000) / 1000 : text(entry.advised, 120) }
      : {}),
    ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
  };
}

/** Build an entry from what the port returned plus what the consumer did with it. */
export function decisionEntry(
  consumer: string,
  question: string,
  answer: DecisionAnswer,
  extra: { outcome?: string; threshold?: string; correct?: boolean; ts?: number } = {},
): DecisionEntry {
  return normalize({
    consumer,
    question,
    kind: answer.kind,
    value: answer.value,
    ...(typeof answer.confidence === 'number' ? { confidence: answer.confidence } : {}),
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
    ...(extra.threshold ? { threshold: extra.threshold } : {}),
    ...(typeof extra.correct === 'boolean' ? { correct: extra.correct } : {}),
    provider: answer.provider,
    latencyMs: answer.latencyMs,
    ...(answer.fellBack ? { fellBack: answer.fellBack } : {}),
    ...(answer.advised ? { advised: answer.advised.value } : {}),
    ts: extra.ts ?? Date.now(),
  });
}

export function recordDecisionInMemory(key: string, entry: DecisionEntry): DecisionEntry {
  const normalized = normalize(entry);
  const ring = rings.get(key) ?? [];
  ring.push(normalized);
  if (ring.length > MAX_RECENT_DECISIONS) ring.splice(0, ring.length - MAX_RECENT_DECISIONS);
  rings.set(key, ring);
  return normalized;
}

export function getInMemoryDecisions(key: string): DecisionEntry[] {
  return [...(rings.get(key) ?? [])];
}

export function readPersistedDecisions(workspaceRoot: string, sessionKey: string): DecisionEntry[] {
  try {
    const file = getSessionStateFile(workspaceRoot, sessionKey, DECISIONS_FILE);
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e) => e && typeof e === 'object')
      .map((e: DecisionEntry) => normalize(e))
      .slice(-MAX_RECENT_DECISIONS);
  } catch {
    return [];
  }
}

/**
 * Record a decision: in-memory ring plus the persisted list, both bounded.
 * Best-effort — a write failure never breaks the gate that asked.
 */
export function recordDecision(
  workspaceRoot: string,
  sessionKey: string,
  entry: DecisionEntry,
): DecisionEntry {
  const recorded = recordDecisionInMemory(sessionKey, entry);
  try {
    const file = getSessionStateFile(workspaceRoot, sessionKey, DECISIONS_FILE);
    const existing = readPersistedDecisions(workspaceRoot, sessionKey);
    existing.push(recorded);
    fs.writeFileSync(file, JSON.stringify(existing.slice(-MAX_RECENT_DECISIONS), null, 2), 'utf8');
  } catch {
    // Persistence is best-effort; the in-memory ring still has the entry.
  }
  return recorded;
}

/** Persisted ∪ in-memory, de-duplicated, newest first, capped. */
export function listRecentDecisions(
  workspaceRoot: string,
  sessionKey: string,
  limit = 20,
): DecisionEntry[] {
  const merged = [...readPersistedDecisions(workspaceRoot, sessionKey), ...getInMemoryDecisions(sessionKey)];
  const seen = new Set<string>();
  const deduped: DecisionEntry[] = [];
  for (const e of merged) {
    const k = `${e.consumer} ${e.question} ${e.value} ${e.ts}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(e);
  }
  deduped.sort((a, b) => b.ts - a.ts);
  return deduped.slice(0, Math.max(0, limit));
}

/** One line a person can read — the turn path's detail, and `/recent-decisions`. */
export function describeDecision(entry: DecisionEntry): string {
  const value = typeof entry.value === 'number' ? entry.value.toFixed(3) : entry.value;
  const parts = [`${entry.consumer}/${entry.question}: ${value}`];
  if (entry.outcome) parts.push(`→ ${entry.outcome}`);
  if (entry.threshold) parts.push(`(${entry.threshold})`);
  parts.push(`${entry.provider} · ${entry.latencyMs}ms`);
  if (entry.fellBack) parts.push(`· fell back: ${entry.fellBack}`);
  if (entry.advised !== undefined) parts.push(`· advised ${entry.advised} (not used)`);
  if (typeof entry.correct === 'boolean') parts.push(entry.correct ? '· held up' : '· overruled');
  return parts.join(' ');
}
