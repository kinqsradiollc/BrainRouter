"use client";

/**
 * Public system status page (à la status.claude.com). Polls the single gateway's
 * /api/status aggregation and renders each component's health. No auth — a status
 * page must be reachable when the rest of the app is down.
 */
import { useCallback, useEffect, useState } from "react";
import { BASE_URL } from "../../lib/client";

type ComponentStatus = "operational" | "degraded" | "down";
interface StatusComponent { id: string; label: string; status: ComponentStatus; detail?: string; }
interface SystemStatus {
  status: ComponentStatus;
  version: string;
  service: string;
  uptimeSec: number;
  checkedAt: string;
  components: StatusComponent[];
}

const META: Record<ComponentStatus, { color: string; wash: string; label: string; headline: string }> = {
  operational: { color: "#34C28E", wash: "rgba(52,194,142,0.12)", label: "Operational", headline: "All systems operational" },
  degraded: { color: "#D9A441", wash: "rgba(217,164,65,0.14)", label: "Degraded", headline: "Degraded performance" },
  down: { color: "#E5675F", wash: "rgba(229,103,95,0.14)", label: "Down", headline: "Major outage" },
};
const UNREACHABLE: ComponentStatus = "down";

function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function StatusPage() {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [error, setError] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/status`, { cache: "no-store" });
      const json = (await res.json()) as SystemStatus;
      setData(json);
      setError(false);
      setCheckedAt(new Date().toLocaleTimeString());
    } catch {
      setError(true);
      setData(null);
      setCheckedAt(new Date().toLocaleTimeString());
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const overall: ComponentStatus = error ? UNREACHABLE : (data?.status ?? "operational");
  const meta = META[overall];
  const headline = error ? "Cannot reach the gateway" : meta.headline;

  return (
    <div className="status-page">
      <header className="status-head">
        <div className="status-brand">BrainRouter</div>
        <h1 className="status-title">System Status</h1>
      </header>

      <div className="status-banner" style={{ background: meta.wash, borderColor: meta.color }}>
        <span className="status-banner__dot" style={{ background: meta.color, boxShadow: `0 0 12px ${meta.color}` }} />
        <span className="status-banner__text" style={{ color: meta.color }}>{headline}</span>
      </div>

      <div className="status-list">
        {error ? (
          <div className="status-empty">
            The status gateway is not responding. This page auto-retries every 30 seconds.
          </div>
        ) : !data ? (
          <div className="status-empty">Checking components…</div>
        ) : (
          data.components.map((c) => {
            const m = META[c.status];
            return (
              <div key={c.id} className="status-row">
                <div className="status-row__main">
                  <span className="status-row__dot" style={{ background: m.color }} />
                  <span className="status-row__label">{c.label}</span>
                  {c.detail && <span className="status-row__detail">{c.detail}</span>}
                </div>
                <span className="status-row__badge" style={{ color: m.color, background: m.wash }}>{m.label}</span>
              </div>
            );
          })
        )}
      </div>

      <footer className="status-foot">
        {data && (
          <>
            <span>v{data.version}</span>
            <span className="status-foot__dot">·</span>
            <span>service: {data.service}</span>
            <span className="status-foot__dot">·</span>
            <span>uptime {fmtUptime(data.uptimeSec)}</span>
            <span className="status-foot__dot">·</span>
          </>
        )}
        <span>{checkedAt ? `checked ${checkedAt}` : "…"}</span>
      </footer>
    </div>
  );
}
