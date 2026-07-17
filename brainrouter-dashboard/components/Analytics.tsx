"use client";

import type { CSSProperties, ReactNode } from "react";

const palette = { critical: "var(--danger)", high: "var(--heat-hot)", medium: "var(--warn)", low: "#5A9BDB", approved: "var(--ok)", commented: "var(--warn)", changesRequested: "var(--danger)" } as const;

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "danger" | "info" }) {
  return <span className={`analytics-badge analytics-badge--${tone}`}>{children}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const key = severity.toLowerCase() as keyof typeof palette;
  return <span className="analytics-badge analytics-badge--severity" style={{ "--badge-color": palette[key] ?? "var(--text-muted)" } as CSSProperties}>{severity}</span>;
}

export function MetricTile({ label, value, delta, trend = "up", hint }: { label: string; value: string | number; delta?: string; trend?: "up" | "down" | "flat"; hint?: string }) {
  const icon = trend === "up" ? "↗" : trend === "down" ? "↘" : "–";
  return <section className="metric-tile"><span>{label}</span><strong>{value}</strong><div className={`metric-tile__delta metric-tile__delta--${trend}`}>{delta && <>{icon} {delta}</>}<small>{hint}</small></div></section>;
}

type HistoryRow = { date: string; critical: number; high: number; medium: number; low: number; open?: number; fixed?: number };
const SEVERITY_SERIES = ["critical", "high", "medium", "low"] as const;

/** "Jul 3" label for a yyyy-mm-dd history key (UTC — matches the server buckets). */
function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) ? date : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Shared plot frame: y gridlines with integer labels + up to four x date labels. */
function ChartFrame({ width, height, pad, max, data, x }: { width: number; height: number; pad: { t: number; r: number; b: number; l: number }; max: number; data: HistoryRow[]; x: (i: number) => number }) {
  const innerH = height - pad.t - pad.b;
  const ticks = [...new Set([0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f)))].filter((v) => v > 0);
  const labelIdx = data.length <= 4
    ? data.map((_, i) => i)
    : [0, Math.round((data.length - 1) / 3), Math.round(((data.length - 1) * 2) / 3), data.length - 1];
  return <>
    {ticks.map((value) => {
      const ty = pad.t + innerH - (value * innerH) / max;
      return <g key={value}><line x1={pad.l} x2={width - pad.r} y1={ty} y2={ty} stroke="var(--border-dim)" strokeDasharray="3 5" /><text x={pad.l - 6} y={ty + 3} textAnchor="end" className="chart__tick">{value}</text></g>;
    })}
    <path d={`M${pad.l} ${height - pad.b}H${width - pad.r}`} className="chart__axis" />
    {[...new Set(labelIdx)].map((i) => data[i] && (
      <text key={data[i].date} x={x(i)} y={height - pad.b + 14} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} className="chart__tick">{dayLabel(data[i].date)}</text>
    ))}
  </>;
}

/** Issues discovered over time, stacked by severity — each legend entry is a real series. */
export function AreaChart({ data }: { data: HistoryRow[] }) {
  const width = 640; const height = 230; const pad = { t: 10, r: 8, b: 24, l: 30 };
  const innerW = width - pad.l - pad.r; const innerH = height - pad.t - pad.b;
  const totals = data.map((r) => r.critical + r.high + r.medium + r.low);
  const max = Math.max(1, ...totals);
  const x = (i: number) => pad.l + (data.length <= 1 ? innerW / 2 : (i * innerW) / (data.length - 1));
  const y = (value: number) => pad.t + innerH - (value * innerH) / max;
  // Stack bottom-up: critical sits on the axis, low on top; each band is the
  // region between the previous cumulative series and this one.
  const cumulative: number[][] = [data.map(() => 0)];
  for (const key of SEVERITY_SERIES) cumulative.push(data.map((row, i) => cumulative[cumulative.length - 1][i] + row[key]));
  const bandPath = (lower: number[], upper: number[]) => data.length === 0 ? "" :
    `M${x(0)} ${y(upper[0])}` + upper.map((v, i) => `L${x(i)} ${y(v)}`).join("") +
    [...lower].reverse().map((v, i) => `L${x(data.length - 1 - i)} ${y(v)}`).join("") + "Z";
  const hasData = totals.some((v) => v > 0);
  return <div className="chart">
    <div className="chart__legend"><Legend color={palette.critical} label="Critical" /><Legend color={palette.high} label="High" /><Legend color={palette.medium} label="Medium" /><Legend color={palette.low} label="Low" /></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Issues discovered over time by severity">
      <ChartFrame width={width} height={height} pad={pad} max={max} data={data} x={x} />
      {SEVERITY_SERIES.map((key, s) => (
        <g key={key}>
          <path d={bandPath(cumulative[s], cumulative[s + 1])} fill={palette[key]} opacity="0.22" />
          <polyline points={cumulative[s + 1].map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={palette[key]} strokeWidth="1.6" vectorEffect="non-scaling-stroke" opacity={hasData ? 0.9 : 0.4} />
        </g>
      ))}
      {data.length <= 45 && data.map((row, i) => totals[i] > 0 && (
        <circle key={row.date} cx={x(i)} cy={y(totals[i])} r="3" fill="var(--surface-raised)" stroke="var(--danger)" strokeWidth="1.8">
          <title>{`${dayLabel(row.date)} — ${SEVERITY_SERIES.filter((k) => row[k] > 0).map((k) => `${row[k]} ${k}`).join(", ") || "no issues"}`}</title>
        </circle>
      ))}
    </svg>
    {(data.length === 0 || !hasData) && <div className="chart__empty">No issues discovered in this period.</div>}
  </div>;
}

/** Cumulative still-open vs fixed findings across the period — two real series. */
export function OpenFixedChart({ data }: { data: HistoryRow[] }) {
  const width = 640; const height = 230; const pad = { t: 10, r: 8, b: 24, l: 30 };
  const innerW = width - pad.l - pad.r; const innerH = height - pad.t - pad.b;
  const open: number[] = []; const fixed: number[] = [];
  let openSum = 0; let fixedSum = 0;
  for (const row of data) { openSum += row.open ?? 0; fixedSum += row.fixed ?? 0; open.push(openSum); fixed.push(fixedSum); }
  const max = Math.max(1, openSum, fixedSum);
  const x = (i: number) => pad.l + (data.length <= 1 ? innerW / 2 : (i * innerW) / (data.length - 1));
  const y = (value: number) => pad.t + innerH - (value * innerH) / max;
  const line = (series: number[]) => series.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = (series: number[]) => data.length === 0 ? "" : `${x(0)},${y(0)} ${line(series)} ${x(data.length - 1)},${y(0)}`;
  const hasData = openSum > 0 || fixedSum > 0;
  return <div className="chart">
    <div className="chart__legend"><Legend color="var(--danger)" label={`Open ${openSum}`} /><Legend color="var(--ok)" label={`Fixed ${fixedSum}`} /></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cumulative open versus fixed findings">
      <ChartFrame width={width} height={height} pad={pad} max={max} data={data} x={x} />
      <polygon points={area(open)} fill="var(--danger)" opacity="0.14" />
      <polygon points={area(fixed)} fill="var(--ok)" opacity="0.14" />
      <polyline points={line(open)} fill="none" stroke="var(--danger)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polyline points={line(fixed)} fill="none" stroke="var(--ok)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
    {(data.length === 0 || !hasData) && <div className="chart__empty">No findings recorded in this period.</div>}
  </div>;
}

export function Donut({ values }: { values: Record<string, number> }) {
  const rows = Object.entries(values).filter(([, value]) => value > 0); const total = Object.values(values).reduce((a, b) => a + b, 0);
  let offset = 0;
  return <div className="donut"><svg viewBox="0 0 42 42" role="img" aria-label={`${total} open issues`}><circle className="donut__track" cx="21" cy="21" r="15.9155" fill="none" strokeWidth="4"/>{rows.map(([key, value]) => { const dash = total ? value / total * 100 : 0; const segment = <circle key={key} cx="21" cy="21" r="15.9155" fill="none" stroke={palette[key as keyof typeof palette] ?? "var(--text-muted)"} strokeWidth="4" strokeDasharray={`${dash} ${100 - dash}`} strokeDashoffset={-offset} transform="rotate(-90 21 21)"/>; offset += dash; return segment; })}</svg><div className="donut__center"><strong>{total}</strong><span>Open</span></div><div className="donut__legend">{Object.entries(values).filter(([, value]) => value > 0).map(([key, value]) => <Legend key={key} color={palette[key as keyof typeof palette] ?? "var(--text-muted)"} label={`${key} ${value}`} />)}</div></div>;
}

export function StackedBar({ values }: { values: Record<string, number> }) {
  const total = Math.max(1, Object.values(values).reduce((a, b) => a + b, 0));
  return <div className="stacked"><div className="stacked__bar">{Object.entries(values).map(([key, value]) => <span key={key} style={{ width: `${value / total * 100}%`, background: palette[key as keyof typeof palette] ?? "var(--text-muted)" }} title={`${key}: ${value}`} />)}</div><div className="chart__legend">{Object.entries(values).map(([key, value]) => <Legend key={key} color={palette[key as keyof typeof palette] ?? "var(--text-muted)"} label={`${key.replace(/([A-Z])/g, " $1")} ${value}`} />)}</div></div>;
}

export function LineChart({ points }: { points: number[] }) {
  const width = 360; const height = 120; const max = Math.max(1, ...points); const x = (i: number) => 8 + i * (width - 16) / Math.max(1, points.length - 1); const y = (n: number) => height - 8 - n * (height - 16) / max;
  return <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Findings addressed rate"><polyline points={points.map((n, i) => `${x(i)},${y(n)}`).join(" ")} fill="none" stroke="var(--accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/></svg>;
}

export function DataTable({ children, headers }: { headers: string[]; children: ReactNode }) {
  return <div className="analytics-table-wrap"><table className="analytics-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function Legend({ color, label }: { color: string; label: string }) { return <span className="chart__legend-item"><i style={{ background: color }} />{label}</span>; }
