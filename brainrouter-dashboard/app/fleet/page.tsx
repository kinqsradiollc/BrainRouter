"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";

// HONK-H3.3 — the fleet console reads client-pushed snapshots (one per host).
// The fleet runs client-side (`brainrouter fleet drain --push`); the brain
// stores the snapshot, and this page renders queue depth + recent PRs.

interface FleetJob {
  id: string;
  workspaceRoot: string;
  status?: string;
  output?: { prUrl?: string; prNumber?: number };
}

interface FleetSnapshot {
  total: number;
  byStatus: { pending: number; running: number; done: number; failed: number; cancelled: number };
  running: FleetJob[];
  recent: FleetJob[];
}

interface HostEntry {
  host: string;
  snapshot: FleetSnapshot | null;
  jobCount: number;
  updatedAt: string;
}

const EMPTY_COUNTS = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };

export default function FleetPage() {
  const client = useMemo(() => getClient(), []);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await client.getFleetSnapshots();
      setHosts(((res?.hosts as HostEntry[] | undefined) ?? []));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  // Poll so a running `fleet drain --push` shows up live.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <AuthGuard>
      <PageHeader title="Fleet" description="Background multi-repo migration hosts pushing live queue snapshots (brainrouter fleet drain --push)." />

      {error && <p style={{ color: "var(--danger, #c0392b)" }}>Couldn’t load fleet snapshots: {error}</p>}

      {!loading && hosts.length === 0 && !error && (
        <div className="card" style={{ padding: "1.5rem", marginTop: "1rem" }}>
          <p style={{ fontWeight: 600, marginBottom: ".25rem" }}>No fleet hosts yet.</p>
          <p style={{ opacity: 0.7 }}>
            Run <code>brainrouter fleet drain --push</code> (or <code>brainrouter fleet push</code>) on a host to surface its
            queue here.
          </p>
        </div>
      )}

      <div style={{ display: "grid", gap: "1rem", marginTop: "1rem" }}>
        {hosts.map((h) => {
          const s = h.snapshot ?? { total: h.jobCount, byStatus: EMPTY_COUNTS, running: [], recent: [] };
          const c = s.byStatus ?? EMPTY_COUNTS;
          return (
            <div key={h.host} className="card" style={{ padding: "1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem" }}>
                <h3 style={{ margin: 0 }}>{h.host}</h3>
                <span style={{ opacity: 0.6, fontSize: ".85rem" }}>updated {new Date(h.updatedAt).toLocaleString()}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", margin: ".75rem 0", fontVariantNumeric: "tabular-nums" }}>
                <span>{s.total ?? 0} jobs</span>
                <span>pending {c.pending}</span>
                <span>running {c.running}</span>
                <span>done {c.done}</span>
                <span>failed {c.failed}</span>
                <span>cancelled {c.cancelled}</span>
              </div>

              {s.running?.length > 0 && (
                <div style={{ marginTop: ".5rem" }}>
                  <strong style={{ fontSize: ".85rem", opacity: 0.7 }}>In flight</strong>
                  <ul style={{ margin: ".25rem 0 0", paddingLeft: "1.1rem" }}>
                    {s.running.map((j) => (
                      <li key={j.id}><code>{j.id}</code> — {j.workspaceRoot}</li>
                    ))}
                  </ul>
                </div>
              )}

              {s.recent?.length > 0 && (
                <div style={{ marginTop: ".5rem" }}>
                  <strong style={{ fontSize: ".85rem", opacity: 0.7 }}>Recent</strong>
                  <ul style={{ margin: ".25rem 0 0", paddingLeft: "1.1rem" }}>
                    {s.recent.map((j) => (
                      <li key={j.id}>
                        <span style={{ opacity: 0.7 }}>{j.status}</span> {j.workspaceRoot}
                        {j.output?.prUrl && (
                          <>
                            {" → "}
                            <a href={j.output.prUrl} target="_blank" rel="noreferrer">PR #{j.output.prNumber ?? "?"}</a>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AuthGuard>
  );
}
