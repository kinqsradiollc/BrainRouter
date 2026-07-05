/**
 * MEMORY-SEARCH (parity, desktop #668) — pure presentation helpers for the
 * Memory panel. The host owns the brain engine + `memory-search`; this just
 * shapes a RecalledMemory[] for display (sort / score / type label / stale /
 * snippet / counts) so the logic is unit-testable without the host.
 */
import type { RecalledMemory } from '@kinqs/brainrouter-types';

/** Highest relevance first, stable. Pure — never mutates the input array. */
export function sortByScore(records: RecalledMemory[]): RecalledMemory[] {
  return [...records].sort((a, b) => b.score - a.score);
}

/** A 0..1 relevance score as a clamped integer percent, e.g. 0.874 → "87%". */
export function scorePercent(score: number): string {
  const clamped = Math.max(0, Math.min(1, score));
  return `${Math.round(clamped * 100)}%`;
}

/** Humanize a snake_case MemoryType into sentence case: "codebase_fact" → "Codebase fact". */
export function memoryTypeLabel(type: string): string {
  if (!type) return '';
  const spaced = type.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** True when the source this record was derived from has changed since capture. */
export function isStale(record: RecalledMemory): boolean {
  return record.staleVsCode === true;
}

/** Total recalls and how many are stale-vs-code (for the count row). */
export function memoryCounts(records: RecalledMemory[]): { total: number; stale: number } {
  return { total: records.length, stale: records.filter(isStale).length };
}

/** One-line snippet: collapse whitespace, then truncate to `max` chars with an ellipsis. */
export function contentSnippet(content: string, max = 140): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}
