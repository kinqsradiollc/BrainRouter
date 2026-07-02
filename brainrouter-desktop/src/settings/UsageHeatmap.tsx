import React from 'react';
import type { UsageHistory } from './types.js';

/** GitHub-contributions-style grid: one square per UTC day, columns are weeks
 *  (aligned on weekday), brightness scales with that day's token volume. Themed
 *  via the accent var + opacity so it tracks any palette. */
export function UsageHeatmap({ hist }: { hist: UsageHistory }): JSX.Element {
  const days = hist.days;
  if (!days.length) return <pre className="usage-pre">No usage recorded yet.</pre>;
  const tok = (d: { promptTokens: number; completionTokens: number }) => d.promptTokens + d.completionTokens;
  const max = Math.max(1, ...days.map(tok));
  const level = (n: number) => (n <= 0 ? 0 : n >= max * 0.75 ? 4 : n >= max * 0.5 ? 3 : n >= max * 0.25 ? 2 : 1);
  const weekday = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay(); // 0=Sun
  const cols: Array<Array<(typeof days)[number] | null>> = [];
  let cur: Array<(typeof days)[number] | null> = [];
  for (let i = 0; i < weekday(days[0].day); i++) cur.push(null); // pad first column to its weekday
  for (const d of days) {
    cur.push(d);
    if (cur.length === 7) { cols.push(cur); cur = []; }
  }
  if (cur.length) { while (cur.length < 7) cur.push(null); cols.push(cur); }
  return (
    <div className="usage-heatmap" style={{ display: 'flex', gap: 3, overflowX: 'auto', padding: '4px 0' }}>
      {cols.map((col, ci) => (
        <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {col.map((d, ri) =>
            d ? (
              <div
                key={ri}
                title={`${d.day}: ${tok(d).toLocaleString()} tokens · ${d.turns} turns · ${d.calls} req`}
                style={{ width: 11, height: 11, borderRadius: 2, background: 'var(--accent)', opacity: level(tok(d)) === 0 ? 0.07 : 0.2 + 0.2 * level(tok(d)) }}
              />
            ) : (
              <div key={ri} style={{ width: 11, height: 11 }} />
            ),
          )}
        </div>
      ))}
    </div>
  );
}
