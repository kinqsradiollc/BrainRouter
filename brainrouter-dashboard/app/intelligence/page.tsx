"use client";

// DASH-1b — Graph Intelligence view. Four analytics lenses over the cognitive
// graph (memory_graph_analytics / GET /api/graph/analytics): PageRank
// centrality, broker/bridge entities, namespace overview, and a shortest
// connection path between two entities ("how is A related to B").

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { GraphAnalytics } from "@kinqs/brainrouter-types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";

const stone = "var(--color-stone-text)";
const frost = "var(--color-white-frost)";
const gold = "var(--color-golden-accent)";

function Tile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <span style={{ color: gold, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase" }}>{title}</span>
      {children}
    </div>
  );
}

export default function IntelligencePage() {
  const client = useMemo(() => getClient(), []);
  const [data, setData] = useState<GraphAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [path, setPath] = useState<GraphAnalytics["path"] | null>(null);

  useEffect(() => {
    client
      .getGraphAnalytics({ topN: 12 })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  const findPath = async () => {
    if (!from.trim() || !to.trim()) return;
    try {
      const r = await client.getGraphAnalytics({ from: from.trim(), to: to.trim(), topN: 1 });
      setPath(r.path ?? { from, to, found: false, entities: [] });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const maxScore = data?.topCentral?.[0]?.score ?? 1;

  return (
    <AuthGuard>
      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
        <PageHeader
          title="Graph Intelligence"
          description="Analytics over the cognitive graph — which entities are most central, which bridge separate clusters, how the namespace breaks down, and how any two entities connect."
        />
        {error && <p style={{ color: "#fca5a5", fontSize: "13px" }}>Could not load analytics: {error}</p>}
        {!data && !error && <p style={{ color: stone, fontSize: "13px" }}>Loading…</p>}
        {data && data.nodeCount === 0 && (
          <p style={{ color: stone, fontSize: "13px" }}>The graph is empty — it grows as memories are captured and entities are linked.</p>
        )}

        {data && data.nodeCount > 0 && (
          <>
            <p style={{ color: stone, fontSize: "12px", margin: 0 }}>{data.nodeCount} entities · {data.edgeCount} relations</p>

            <Tile title="Most central (PageRank)">
              {data.topCentral.map((c) => (
                <div key={c.entity} style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "13px" }}>
                    <span style={{ color: frost, overflowWrap: "anywhere" }}>{c.entity} <span style={{ color: stone, fontSize: "11px" }}>· {c.entityType}</span></span>
                    <span style={{ color: stone, fontSize: "11px", whiteSpace: "nowrap" }}>{c.score.toFixed(3)}</span>
                  </div>
                  <div style={{ height: "4px", background: "var(--color-border, #2a2a2a)", borderRadius: "2px" }}>
                    <div style={{ height: "100%", width: `${Math.round((c.score / maxScore) * 100)}%`, background: gold, borderRadius: "2px" }} />
                  </div>
                </div>
              ))}
            </Tile>

            <Tile title="Broker / bridge entities">
              {data.bridges.length === 0 ? (
                <p style={{ color: stone, fontSize: "12px", margin: 0 }}>No articulation points — the graph has no single-entity bridges.</p>
              ) : (
                data.bridges.map((b) => (
                  <span key={b.entity} style={{ color: frost, fontSize: "13px" }}>
                    {b.entity} <span style={{ color: stone, fontSize: "11px" }}>· {b.entityType}</span>
                  </span>
                ))
              )}
            </Tile>

            <Tile title="Namespace overview">
              {Object.entries(data.namespaces).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                <div key={type} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                  <span style={{ color: frost }}>{type}</span>
                  <span style={{ color: stone }}>{count}</span>
                </div>
              ))}
            </Tile>

            <Tile title="Shortest connection path">
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="from entity"
                  style={{ flex: 1, minWidth: "120px", background: "var(--color-bg-input, #111)", color: frost, border: "1px solid var(--color-border, #2a2a2a)", borderRadius: "6px", padding: "6px 10px", fontSize: "13px" }} />
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="to entity"
                  style={{ flex: 1, minWidth: "120px", background: "var(--color-bg-input, #111)", color: frost, border: "1px solid var(--color-border, #2a2a2a)", borderRadius: "6px", padding: "6px 10px", fontSize: "13px" }} />
                <button onClick={findPath}
                  style={{ background: gold, color: "#1a1a1a", border: "none", borderRadius: "6px", padding: "6px 14px", fontSize: "13px", cursor: "pointer" }}>Find path</button>
              </div>
              {path && (
                <p style={{ color: path.found ? frost : stone, fontSize: "13px", margin: 0, overflowWrap: "anywhere" }}>
                  {path.found ? path.entities.join("  →  ") : `No connection found between “${path.from}” and “${path.to}”.`}
                </p>
              )}
            </Tile>
          </>
        )}
      </motion.div>
    </AuthGuard>
  );
}
