/** DESK-5s — one labeled progress bar for the context/usage popover. */
import React from 'react';
import { fmtTokens } from '../lib/format.js';

export function UsageBar({ label, value, total, suffix, tone = 'var(--accent)' }: {
  label: string; value: number; total: number; suffix?: string; tone?: string;
}): React.ReactElement {
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  return (
    <div className="usage-row">
      <div className="usage-row-top">
        <span className="usage-label">{label}</span>
        <span className="usage-val">{total > 0 ? `${fmtTokens(value)} / ${fmtTokens(total)} (${Math.round(pct * 100)}%)` : (suffix ?? '—')}</span>
      </div>
      <div className="usage-track"><span className="usage-fill" style={{ width: `${pct * 100}%`, background: tone }} /></div>
    </div>
  );
}
