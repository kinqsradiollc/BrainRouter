/**
 * ARTIFACT-RECORDS (0.4.15) — pure presentation helpers for the Artifacts
 * panel. The CLI owns the store (createArtifact/updateArtifact/listArtifacts,
 * all tested there); this just shapes an ArtifactRecord[] for display so the
 * sorting / counting / label / badge logic is unit-testable without the host.
 */
import type {
  ArtifactRecord, ArtifactKind, ArtifactStatus, ArtifactFormat,
} from '@kinqs/brainrouter-types';

/** Newest-first by createdAt, stable. Pure — never mutates the input array. */
export function sortArtifacts(records: ArtifactRecord[]): ArtifactRecord[] {
  return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Tally of artifacts by lifecycle status, plus a `total`. Every status key is
 *  always present (0 when none) so the panel can render a stable count row. */
export function artifactCounts(
  records: ArtifactRecord[],
): Record<ArtifactStatus, number> & { total: number } {
  const counts = { draft: 0, final: 0, archived: 0, total: 0 } as
    Record<ArtifactStatus, number> & { total: number };
  for (const r of records) {
    counts[r.status] += 1;
    counts.total += 1;
  }
  return counts;
}

/** Count of artifacts still being worked (draft) — the openable-view badge. */
export function draftArtifactCount(records: ArtifactRecord[]): number {
  return records.filter((r) => r.status === 'draft').length;
}

/** Human-readable label for a kind chip ("design-note" → "Design note"). */
export function kindLabel(kind: ArtifactKind): string {
  const words = kind.split('-');
  const first = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return [first, ...words.slice(1)].join(' ');
}

/** Status pill class for the panel (`st-<status>`), mirroring the requirement
 *  panel's status-pill convention so the shared pill styles apply. */
export function statusClass(status: ArtifactStatus): string {
  return `st-${status}`;
}

/** A compact one-line label for a list row: "art_1234 · markdown-report · draft". */
export function artifactSummary(a: ArtifactRecord): string {
  return `${a.id} · ${a.kind} · ${a.status}`;
}

/** Languages that mark a `format: 'code'` artifact as a React component. */
const REACT_LANGUAGES = new Set(['jsx', 'tsx', 'react', 'javascriptreact', 'typescriptreact']);

/**
 * Whether an artifact is a self-contained React component — a `code` artifact
 * whose language is jsx/tsx (the desktop's in-scope stand-in for a dedicated
 * `react` format, which would require a types/core change). Pure.
 */
export function isReactArtifact(a: Pick<ArtifactRecord, 'format' | 'language'>): boolean {
  return a.format === 'code' && !!a.language && REACT_LANGUAGES.has(a.language.toLowerCase());
}

/* ------------------------------------------------ ADR-028 B2 · session scope */

/**
 * The set of sessions the panel is showing.
 *
 * `null` means every session — chosen deliberately over an empty set, which
 * reads as "no sessions" and would render an empty list. A selection you did
 * not make should never look like a result.
 */
export type SessionScope = ReadonlySet<string> | null;

/**
 * The scope a freshly-opened panel starts with.
 *
 * Scoped to the current session, not to everything. Opening onto every artifact
 * you have ever produced hands you a search problem you did not ask for; you
 * start where you are and widen when you mean to.
 */
export function initialSessionScope(currentSessionKey: string | null | undefined): SessionScope {
  return currentSessionKey ? new Set([currentSessionKey]) : null;
}

/** Artifacts belonging to the selected sessions. */
export function filterBySession(
  records: readonly ArtifactRecord[],
  scope: SessionScope,
): ArtifactRecord[] {
  if (!scope) return [...records];
  return records.filter((r) => (r.sessionKey ? scope.has(r.sessionKey) : false));
}

/**
 * Must each row say which session produced it?
 *
 * Yes as soon as more than one is selected. An aggregated list without
 * provenance reintroduces exactly the misattribution the stale-panel bug caused
 * by accident — only now on purpose, which is worse.
 */
export function showsSessionProvenance(scope: SessionScope): boolean {
  return scope === null || scope.size > 1;
}

/** Toggle one session in the scope, keeping "all" and "none" coherent. */
export function toggleSession(
  scope: SessionScope,
  sessionKey: string,
  allSessionKeys: readonly string[],
): SessionScope {
  const current = scope ? new Set(scope) : new Set(allSessionKeys);
  if (current.has(sessionKey)) current.delete(sessionKey);
  else current.add(sessionKey);
  // Deselecting the last one means "all", not "nothing" — an empty list here is
  // a dead end the user has no obvious way out of.
  if (current.size === 0) return null;
  return current.size === allSessionKeys.length ? null : current;
}

/** The distinct sessions represented in a set of artifacts, newest first. */
export function sessionsIn(records: readonly ArtifactRecord[]): string[] {
  const seen = new Set<string>();
  for (const r of sortArtifacts([...records])) {
    if (r.sessionKey) seen.add(r.sessionKey);
  }
  return [...seen];
}

export const ARTIFACT_KIND_OPTIONS: ArtifactKind[] = [
  'design-note', 'sketch', 'html-prototype', 'markdown-report', 'verification-summary', 'review-export', 'other',
];
export const ARTIFACT_STATUS_OPTIONS: ArtifactStatus[] = ['draft', 'final', 'archived'];
export const ARTIFACT_FORMAT_OPTIONS: ArtifactFormat[] = ['markdown', 'html', 'text'];
