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

type HistoryRow = { date: string; critical: number; high: number; medium: number; low: number };
export function AreaChart({ data }: { data: HistoryRow[] }) {
  const width = 640; const height = 230; const pad = 16;
  const values = data.map((r) => r.critical + r.high + r.medium + r.low);
  const max = Math.max(1, ...values);
  const x = (i: number) => pad + (i * (width - pad * 2)) / Math.max(1, data.length - 1);
  const y = (value: number) => height - pad - (value * (height - pad * 2)) / max;
  const points = values.map((value, i) => `${x(i)},${y(value)}`).join(" ");
  const area = values.length ? `${pad},${height - pad} ${points} ${x(values.length - 1)},${height - pad}` : "";
  return <div className="chart"><div className="chart__legend"><Legend color={palette.critical} label="Critical" /><Legend color={palette.high} label="High" /><Legend color={palette.medium} label="Medium" /><Legend color={palette.low} label="Low" /></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Issues over time area chart"><defs><linearGradient id="issue-area" x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--danger)" stopOpacity=".36"/><stop offset="1" stopColor="var(--danger)" stopOpacity="0"/></linearGradient></defs><path d={`M${pad} ${height - pad}H${width - pad}`} className="chart__axis"/><polygon points={area} fill="url(#issue-area)"/><polyline points={points} fill="none" stroke="var(--danger)" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>{values.map((value, i) => <circle key={data[i].date} cx={x(i)} cy={y(value)} r="3" fill="var(--surface-raised)" stroke="var(--danger)" strokeWidth="2"/>)}</svg>{data.length === 0 && <div className="chart__empty">No review activity in this period.</div>}</div>;
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
