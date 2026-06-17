/**
 * DESK-5q/5r — the composer's context ring: an arc filled by how full the
 * session's context is RELATIVE to the auto-compact threshold — the point
 * where BrainRouter summarizes old history and the context resets. It grows
 * live as a turn accumulates context and drops after a compaction. A small %
 * readout sits beside it so it's legible even at a glance; the tooltip carries
 * the exact tokens, the compact point, and the model window.
 */
import React from 'react';

export function ContextRing({ usage }: { usage: { used: number; window: number; compactAt: number; limit: number; pct: number } | null }): React.ReactElement {
  const r = 7, circ = 2 * Math.PI * r;
  const pct = usage && usage.limit > 0 ? Math.max(0, Math.min(1, usage.pct)) : 0;
  const tone = pct >= 0.95 ? 'var(--err)' : pct >= 0.75 ? 'var(--warn)' : 'var(--accent)';
  const title = usage && usage.used > 0
    ? `Context ${Math.round(pct * 100)}% — ${usage.used.toLocaleString()} tokens` +
      `\nAuto-compacts above ~${usage.compactAt.toLocaleString()} (old history is summarized, context resets)` +
      (usage.window > 0 ? `\nModel window: ${usage.window.toLocaleString()}` : '')
    : 'Context fill — grows as the chat accumulates, resets when it auto-compacts';
  return (
    <span className="ctx-ring" title={title}>
      <svg width="16" height="16" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2.4" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="2.4" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} transform="rotate(-90 9 9)" />
      </svg>
      {usage && usage.used > 0 ? <span className="ctx-pct">{Math.round(pct * 100)}%</span> : null}
    </span>
  );
}
