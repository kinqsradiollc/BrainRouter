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

export const ARTIFACT_KIND_OPTIONS: ArtifactKind[] = [
  'design-note', 'sketch', 'html-prototype', 'markdown-report', 'verification-summary', 'review-export', 'other',
];
export const ARTIFACT_STATUS_OPTIONS: ArtifactStatus[] = ['draft', 'final', 'archived'];
export const ARTIFACT_FORMAT_OPTIONS: ArtifactFormat[] = ['markdown', 'html', 'text'];
