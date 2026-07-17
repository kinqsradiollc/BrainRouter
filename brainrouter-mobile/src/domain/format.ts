/**
 * Pure formatting + small presentation helpers extracted from App.tsx: relative
 * times, durations, compact token counts, the workflow status→class map, the
 * tool-summary file sniffer, and the generic result formatter + file download.
 */

/** Pull a workspace-relative path out of a tool summary ("Edited src/x.ts +3 -1"). */
export function fileFromSummary(tool: string, summary: string): string | undefined {
  if (!/edit|write|patch|apply/i.test(tool)) return undefined;
  const m = summary.match(/[\w./-]+\.[\w]+/);
  return m?.[0];
}

export function fmtAge(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtRel(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtElapsed(iso?: string): string {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
};

/** Status → the dot/badge modifier class shared by phases + agents. */
export const wfStatusClass = (status: string): string => {
  if (status === 'completed' || status === 'done') return 'done';
  if (status === 'running' || status === 'pending') return 'run';
  if (status === 'failed') return 'fail';
  if (status === 'partial' || status === 'interrupted' || status === 'stale') return 'warn';
  return '';
};

/** Compact token count: 1234 → "1.2k", 1_000_000 → "1.0M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmt(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result) && result.every((x) => typeof x === 'string')) return result.join('\n');
  return JSON.stringify(result, null, 2);
}

// NOTE (mobile port): the desktop `download()` used the DOM (document/Blob/URL)
// to trigger a browser download. It is intentionally omitted here — on mobile
// this is replaced by an RN share/save flow (technical-doc.md §6, format.ts).
