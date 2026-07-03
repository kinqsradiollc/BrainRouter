/**
 * Track view — T4b layouts: spreadsheet · calendar · gantt. Split out of
 * TrackView.tsx byte-for-byte; no behavior change.
 */
import React, { useState } from 'react';
import type { TrackProject, WorkItem } from '@kinqs/brainrouter-types';
import { Icon } from '../../../icons.js';
import { TYPE_ICON } from '../shared/types.js';
import { fmtDate, isoToLocalDate } from '../shared/helpers.js';

export function SpreadsheetView({ items, states, onOpen }: { items: WorkItem[]; states: TrackProject['workflowStates']; onOpen: (w: WorkItem) => void }): React.ReactElement {
  const stateName = (id: string): string => states.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="track-sheet-wrap">
      <table className="track-sheet">
        <thead><tr>
          <th>Key</th><th>Type</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignees</th><th>Labels</th><th>Pts</th><th>Start</th><th>Target</th>
        </tr></thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id} onClick={() => onOpen(w)}>
              <td className="mono">{w.key}</td>
              <td><Icon name={TYPE_ICON[w.type]} size={12} /> {w.type}</td>
              <td className="track-sheet-title">{w.title}</td>
              <td><span className={`track-cat track-cat-${w.statusCategory}`} /> {stateName(w.status)}</td>
              <td><span className={`track-pri pri-${w.priority}`} /> {w.priority}</td>
              <td>{w.assignees.join(', ') || '—'}</td>
              <td>{w.labels.join(', ') || '—'}</td>
              <td>{w.storyPoints ?? '—'}</td>
              <td>{fmtDate(w.startDate)}</td>
              <td>{fmtDate(w.targetDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 ? <div className="track-empty">No items.</div> : null}
    </div>
  );
}

export function CalendarView({ items, onOpen }: { items: WorkItem[]; onOpen: (w: WorkItem) => void }): React.ReactElement {
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const first = new Date(month.y, month.m, 1);
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const byDay = new Map<number, WorkItem[]>();
  const unscheduled: WorkItem[] = [];
  for (const w of items) {
    if (!w.targetDate) { unscheduled.push(w); continue; }
    const d = isoToLocalDate(w.targetDate);
    if (d.getFullYear() === month.y && d.getMonth() === month.m) {
      if (!byDay.has(d.getDate())) byDay.set(d.getDate(), []);
      byDay.get(d.getDate())!.push(w);
    }
  }
  const cells: Array<number | null> = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const prev = (): void => setMonth((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
  const next = (): void => setMonth((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));
  const today = new Date();
  const isToday = (d: number): boolean => d === today.getDate() && month.m === today.getMonth() && month.y === today.getFullYear();
  return (
    <div className="track-cal">
      <div className="track-cal-head">
        <button className="track-cal-nav" onClick={prev} title="Previous month"><Icon name="arrow-left" size={14} /></button>
        <span className="track-cal-month">{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="track-cal-nav" onClick={next} title="Next month"><Icon name="arrow-right" size={14} /></button>
      </div>
      <div className="track-cal-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="track-cal-dow">{d}</div>)}
        {cells.map((d, i) => (
          <div key={i} className={`track-cal-cell${d === null ? ' empty' : ''}${d && isToday(d) ? ' today' : ''}`}>
            {d !== null ? (
              <>
                <span className="track-cal-num">{d}</span>
                {(byDay.get(d) ?? []).map((w) => (
                  <button key={w.id} className={`track-cal-item pri-${w.priority}`} title={`${w.key} · ${w.title}`} onClick={() => onOpen(w)}>{w.key} {w.title}</button>
                ))}
              </>
            ) : null}
          </div>
        ))}
      </div>
      {unscheduled.length ? (
        <div className="track-cal-unsched">
          <span className="track-cal-unsched-label">No target date ({unscheduled.length})</span>
          {unscheduled.slice(0, 12).map((w) => <button key={w.id} className="track-cal-item" onClick={() => onOpen(w)}>{w.key} {w.title}</button>)}
        </div>
      ) : null}
    </div>
  );
}

export function GanttView({ items, onOpen }: { items: WorkItem[]; onOpen: (w: WorkItem) => void }): React.ReactElement {
  const toTime = (iso?: string): number => (iso ? isoToLocalDate(iso).getTime() : NaN);
  // Keep only items with at least one PARSEABLE date. A truthy-but-malformed
  // date string yields NaN, and a single NaN would poison Math.min/max and
  // blank the entire chart — so filter to finite times, not just truthiness.
  const dated = items.filter((w) => Number.isFinite(toTime(w.startDate)) || Number.isFinite(toTime(w.targetDate)));
  if (!dated.length) return <div className="track-empty">No items with a start or target date. Set dates to see a timeline.</div>;
  const times = dated.flatMap((w) => [w.startDate, w.targetDate].map(toTime)).filter(Number.isFinite);
  let min = Math.min(...times);
  let max = Math.max(...times);
  if (max === min) max = min + 7 * 864e5;
  // Pad the range so bars at the extremes aren't flush against the edges.
  const pad = (max - min) * 0.04;
  min -= pad; max += pad;
  const span = max - min;
  const pct = (t: number): number => ((t - min) / span) * 100;
  // Each row's start/end, coerced so one missing/bad date falls back to the other.
  const rowSpan = (w: WorkItem): { s: number; e: number } => {
    let s = toTime(w.startDate); let e = toTime(w.targetDate);
    if (!Number.isFinite(s)) s = e;
    if (!Number.isFinite(e)) e = s;
    return { s, e };
  };
  const rows = [...dated].sort((a, b) => rowSpan(a).s - rowSpan(b).s);
  // Five evenly-spaced scale ticks — they line up with the 25%-band gridlines
  // drawn behind every row so the timeline reads as a grid, not floating bars.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + f * span);
  // Normalize "now" to today's LOCAL midnight so it lines up with the bar
  // times (also local midnights). Comparing a wall-clock `now` against a
  // midnight-derived `max` hid the marker for most of the day whenever today
  // was the latest date on the chart.
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
  const now = todayMid.getTime();
  const todayPct = now >= min && now <= max ? pct(now) : null;
  const tickLabel = (t: number): string => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="track-gantt">
      <div className="track-gantt-scale">
        <div className="track-gantt-scale-spacer" />
        <div className="track-gantt-scale-track">
          {ticks.map((t, i) => (
            <span key={i} className="track-gantt-tick" style={{ left: `${pct(t)}%` }}>{tickLabel(t)}</span>
          ))}
          {todayPct !== null ? <span className="track-gantt-tick today" style={{ left: `${todayPct}%` }}>Today</span> : null}
        </div>
      </div>
      <div className="track-gantt-rows">
        {rows.map((w) => {
          const { s, e } = rowSpan(w);
          const left = pct(Math.min(s, e));
          const width = Math.max(2.5, pct(Math.max(s, e)) - left);
          return (
            <div key={w.id} className="track-gantt-row" onClick={() => onOpen(w)}>
              <div className="track-gantt-label"><span className="mono">{w.key}</span> {w.title}</div>
              <div className="track-gantt-track">
                {todayPct !== null ? <div className="track-gantt-today" style={{ left: `${todayPct}%` }} /> : null}
                <div className={`track-gantt-bar track-cat-${w.statusCategory}`} style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${w.key} · ${fmtDate(w.startDate)} → ${fmtDate(w.targetDate)}`}>
                  <span className="track-gantt-bar-label">{w.title}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
