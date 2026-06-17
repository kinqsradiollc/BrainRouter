/**
 * ANNOTATION-RECORDS (0.4.15) — pure presentation helpers for the Annotations
 * panel. The CLI owns the store (createAnnotation/setStatus/listAnnotations,
 * all tested there) and the markdown export; this just shapes an
 * AnnotationRecord[] for display so the sorting / counting / badge logic is
 * unit-testable without the host.
 */
import type {
  AnnotationRecord, AnnotationStatus, AnnotationSeverity, AnnotationTargetKind, AnnotationAnchor,
} from '@kinqs/brainrouter-types';

/** Newest-first by createdAt, stable. Pure — never mutates the input array. */
export function sortAnnotations(records: AnnotationRecord[]): AnnotationRecord[] {
  return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Tally of annotations by lifecycle status, plus a `total`. Every status key
 *  is always present (0 when none) so the panel can render a stable count row. */
export function annotationCounts(
  records: AnnotationRecord[],
): Record<AnnotationStatus, number> & { total: number } {
  const counts = { open: 0, accepted: 0, rejected: 0, resolved: 0, ignored: 0, total: 0 } as
    Record<AnnotationStatus, number> & { total: number };
  for (const r of records) {
    counts[r.status] += 1;
    counts.total += 1;
  }
  return counts;
}

/** Count of annotations still needing attention (open) — the openable-view badge. */
export function openAnnotationCount(records: AnnotationRecord[]): number {
  return records.filter((r) => r.status === 'open').length;
}

/** Severity class for a chip, reusing the panel's `.sev-*` styles. Undefined
 *  severity falls back to `info` (the gentlest, matching the type's default). */
export function severityClass(severity: AnnotationSeverity | undefined): string {
  return severity ?? 'info';
}

/** Status pill class for the panel (`st-<status>`), mirroring the requirement
 *  panel's status-pill convention so the shared pill styles apply. */
export function statusClass(status: AnnotationStatus): string {
  return `st-${status}`;
}

/** Human-readable anchor location: `path:start-end`, `path:line`, `path`,
 *  `line N`, `block`, or empty when the anchor pins nothing locational. */
export function anchorLabel(anchor: AnnotationAnchor | undefined): string {
  if (!anchor) return '';
  if (anchor.filePath) {
    let loc = anchor.filePath;
    if (anchor.startLine !== undefined) {
      loc += `:${anchor.startLine}`;
      if (anchor.endLine !== undefined && anchor.endLine !== anchor.startLine) loc += `-${anchor.endLine}`;
    }
    return loc;
  }
  if (anchor.startLine !== undefined) {
    let loc = `line ${anchor.startLine}`;
    if (anchor.endLine !== undefined && anchor.endLine !== anchor.startLine) loc += `-${anchor.endLine}`;
    return loc;
  }
  if (anchor.block) return `block ${anchor.block}`;
  return '';
}

/** A compact one-line label for a list row: "ann_1234 · review-finding · open". */
export function annotationSummary(a: AnnotationRecord): string {
  return `${a.id} · ${a.type} · ${a.status}`;
}

/** Link totals for the detail view (memory ids today; extensible). */
export function annotationLinkCounts(a: AnnotationRecord): { memory: number; total: number } {
  const memory = a.linkedMemoryIds.length;
  return { memory, total: memory };
}

export const ANNOTATION_STATUS_OPTIONS: AnnotationStatus[] = ['open', 'accepted', 'rejected', 'resolved', 'ignored'];
export const ANNOTATION_SEVERITY_OPTIONS: AnnotationSeverity[] = ['info', 'low', 'medium', 'high'];
export const ANNOTATION_TARGET_KIND_OPTIONS: AnnotationTargetKind[] = [
  'plan', 'requirement', 'artifact', 'markdown', 'html', 'message', 'diff', 'file', 'review-finding',
];
