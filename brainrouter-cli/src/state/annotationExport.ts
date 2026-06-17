/**
 * ANNOTATION-RECORDS (0.4.15) — pure markdown export.
 *
 * `annotationsToMarkdown` turns a set of annotation records into an
 * agent-readable feedback document: grouped by target (kind + file/target id),
 * each annotation rendering its anchor location, status/severity, body, and any
 * suggested code in a fenced block. The output is meant to be dropped straight
 * back into the active chat session so the model can act on the feedback.
 *
 * This module is pure (no I/O, no clock) so it is trivially unit-tested.
 */
import type { AnnotationRecord, AnnotationAnchor } from '@kinqs/brainrouter-types';

/**
 * Render annotations as grouped markdown feedback. Records are grouped by a
 * stable key (target kind + file or target id), groups sorted alphabetically,
 * and annotations within a group sorted newest-first. Returns a "no
 * annotations" line when the list is empty so the caller always has something
 * to show.
 */
export function annotationsToMarkdown(records: AnnotationRecord[]): string {
  if (records.length === 0) {
    return '# Annotations\n\n_No annotations to export._\n';
  }

  const groups = new Map<string, AnnotationRecord[]>();
  for (const rec of records) {
    const key = groupLabel(rec);
    const bucket = groups.get(key);
    if (bucket) bucket.push(rec);
    else groups.set(key, [rec]);
  }

  const lines: string[] = ['# Annotations', ''];
  const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of sortedKeys) {
    lines.push(`## ${key}`, '');
    const bucket = groups
      .get(key)!
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const rec of bucket) {
      lines.push(...renderAnnotation(rec));
    }
  }
  return lines.join('\n');
}

/** The group heading for a record: `<kind> · <file>` / `<kind> · <targetId>` /
 *  just `<kind>` when neither an anchored file nor a target id is present. */
function groupLabel(rec: AnnotationRecord): string {
  const file = rec.anchor?.filePath;
  if (file) return `${rec.type} · ${file}`;
  if (rec.targetId) return `${rec.type} · ${rec.targetId}`;
  return rec.type;
}

function renderAnnotation(rec: AnnotationRecord): string[] {
  const meta: string[] = [`status: ${rec.status}`];
  if (rec.severity) meta.push(`severity: ${rec.severity}`);
  const location = anchorLocation(rec.anchor);
  if (location) meta.push(`at: ${location}`);
  if (rec.author) meta.push(`by: ${rec.author}`);

  const out: string[] = [`- **${rec.id}** (${meta.join(', ')})`];
  for (const bodyLine of rec.body.split('\n')) {
    out.push(`  ${bodyLine}`);
  }
  if (rec.anchor?.selectedText) {
    out.push('', '  > ' + rec.anchor.selectedText.split('\n').join('\n  > '));
  }
  if (rec.suggestedText) {
    out.push('', '  Suggested:', '', '  ```', ...rec.suggestedText.split('\n').map((l) => `  ${l}`), '  ```');
  }
  out.push('');
  return out;
}

/** Human-readable anchor location: `path:start-end`, `path:line`, `path`,
 *  `block`, or empty when the anchor pins nothing locational. */
function anchorLocation(anchor: AnnotationAnchor | undefined): string {
  if (!anchor) return '';
  const parts: string[] = [];
  if (anchor.filePath) {
    let loc = anchor.filePath;
    if (anchor.startLine !== undefined) {
      loc += `:${anchor.startLine}`;
      if (anchor.endLine !== undefined && anchor.endLine !== anchor.startLine) {
        loc += `-${anchor.endLine}`;
      }
    }
    parts.push(loc);
  } else if (anchor.startLine !== undefined) {
    let loc = `line ${anchor.startLine}`;
    if (anchor.endLine !== undefined && anchor.endLine !== anchor.startLine) {
      loc += `-${anchor.endLine}`;
    }
    parts.push(loc);
  }
  if (anchor.block) parts.push(`block ${anchor.block}`);
  return parts.join(' · ');
}
