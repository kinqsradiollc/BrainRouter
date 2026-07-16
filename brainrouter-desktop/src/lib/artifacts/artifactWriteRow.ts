/**
 * ARTIFACT-INLINE (F2) — pure parser for the `artifact_write` tool result. The
 * agent's `artifact_write` tool returns a deterministic summary string (there is
 * no structured `artifact-event` for the AGENT path — that event only fires for
 * desktop/CLI-initiated actions), so the inline chat card + the auto-open/focus
 * signal both derive their fields from that string here. Kept pure + separate so
 * the id/title/format/kind/version extraction is unit-testable without the host.
 *
 * The two shapes produced by core (`executeLocalTool.impl.ts` artifact_write):
 *   create → `Created artifact <id> (v1, <kind>, <format>): <title>. Update it later with artifact_write(...)`
 *   update → `Updated artifact <id> → v<n> (<kind>, <format>): <title>`
 */

/** Structured view of an `artifact_write` result — the inline card's data. */
export interface ArtifactWriteInfo {
  id: string;
  title: string;
  /** Artifact kind, e.g. "markdown-report" / "html-prototype". */
  kind: string;
  /** Render format, e.g. "markdown" / "html" / "svg" / "code". */
  format: string;
  /** Version after the write (1 on create). */
  version: number;
  action: 'created' | 'updated';
}

const CREATE_RE = /^Created artifact (\S+) \(v(\d+), ([^,]+), ([^)]+)\): ([\s\S]+?)\. Update it later with artifact_write/;
const UPDATE_RE = /^Updated artifact (\S+) → v(\d+) \(([^,]+), ([^)]+)\): ([\s\S]+)$/;

/**
 * Parse an `artifact_write` tool summary into its structured fields, or null if
 * the string isn't a recognized create/update result (so callers no-op safely).
 */
export function parseArtifactWriteSummary(summary: string | undefined): ArtifactWriteInfo | null {
  if (!summary) return null;
  const created = CREATE_RE.exec(summary);
  if (created) {
    return {
      id: created[1],
      version: Number(created[2]),
      kind: created[3].trim(),
      format: created[4].trim(),
      title: created[5].trim(),
      action: 'created',
    };
  }
  const updated = UPDATE_RE.exec(summary);
  if (updated) {
    return {
      id: updated[1],
      version: Number(updated[2]),
      kind: updated[3].trim(),
      format: updated[4].trim(),
      title: updated[5].trim(),
      action: 'updated',
    };
  }
  return null;
}

/** One-line descriptor for the inline card sub-title ("Created · markdown-report · v1"). */
export function artifactWriteLine(info: Pick<ArtifactWriteInfo, 'action' | 'kind' | 'version'>): string {
  const verb = info.action === 'created' ? 'Created' : 'Updated';
  const parts = [verb];
  if (info.kind) parts.push(info.kind);
  if (info.version) parts.push(`v${info.version}`);
  return parts.join(' · ');
}
