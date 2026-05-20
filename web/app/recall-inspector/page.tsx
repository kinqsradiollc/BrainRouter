"use client";

import { useMemo, useState } from "react";
import { useRecallInspector } from "@brainrouter/hooks";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";

export default function RecallInspectorPage() {
  const client = useMemo(() => getClient(), []);
  const { result, error, isLoading, explain } = useRecallInspector(client);
  const [query, setQuery] = useState("");
  const [activeSkill, setActiveSkill] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const memories = result?.recalledCognitiveMemories ?? [];
  const explanation = result?.recallExplanation;

  async function runExplain() {
    if (!query.trim()) return;
    await explain({
      query: query.trim(),
      activeSkill: activeSkill.trim() || undefined,
    });
  }

  return (
    <AuthGuard>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <PageHeader title="Recall Inspector" description="Explain-mode recall with retrieval counts, intent boosts, reranker status, and final memory scores." />

        <div className="table-container" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            rows={4}
            placeholder="Recall query"
            style={{ width: "100%", padding: "12px", borderRadius: "8px", border: "1px solid rgba(226,227,233,0.1)", background: "rgba(0,0,0,0.25)", color: "var(--color-pure-white)", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            {showAdvanced && (
              <input
                value={activeSkill}
                onChange={(event) => setActiveSkill(event.target.value)}
                placeholder="Active skill filter"
                style={{ flex: "1 1 260px", padding: "9px 10px", borderRadius: "6px", border: "1px solid rgba(226,227,233,0.1)", background: "rgba(0,0,0,0.25)", color: "var(--color-silver-text)" }}
              />
            )}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-stone-text)",
                fontSize: "12px",
                cursor: "pointer",
                padding: "4px 8px",
              }}
            >
              {showAdvanced ? "Hide Options" : "Advanced Filters..."}
            </button>
            <button
              onClick={() => void runExplain()}
              disabled={isLoading || !query.trim()}
              style={{ marginLeft: "auto", padding: "9px 18px", borderRadius: "9999px", border: "1px solid rgba(174,147,87,0.4)", background: "rgba(174,147,87,0.18)", color: "var(--color-pure-white)", cursor: isLoading || !query.trim() ? "default" : "pointer" }}
            >
              {isLoading ? "Running" : "Explain"}
            </button>
          </div>
          {error && <div style={{ color: "#ef4444", fontSize: "13px" }}>{error}</div>}
        </div>

        {explanation && (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
              {[
                ["FTS hits", explanation.ftsHits],
                ["Vector hits", explanation.vecHits],
                ["File hits", explanation.filePathHits],
                ["Intent", explanation.intentDetected],
                ["Reranker", explanation.rerankerUsed ? "on" : "off"],
                ["Duration", `${explanation.durationMs}ms`],
              ].map(([label, value]) => (
                <div key={label} className="card" style={{ padding: "14px" }}>
                  <div style={{ color: "var(--color-ash-text)", fontSize: "11px", textTransform: "uppercase" }}>{label}</div>
                  <div style={{ color: "var(--color-pure-white)", fontSize: "18px", marginTop: "6px", fontWeight: 700 }}>{value}</div>
                </div>
              ))}
            </div>

            {explanation.sparkedNodes && explanation.sparkedNodes.length > 0 && (
              <div className="card" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-ash-text)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  🧠 Neural Spark Spreading Activation Trace
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {explanation.sparkedNodes.map((node: any) => (
                    <div
                      key={node.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "6px 12px",
                        borderRadius: "6px",
                        background: node.fired ? "rgba(129, 140, 248, 0.12)" : "rgba(255, 255, 255, 0.03)",
                        border: node.fired ? "1px solid rgba(129, 140, 248, 0.3)" : "1px solid rgba(255, 255, 255, 0.08)",
                      }}
                    >
                      <span
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: node.fired ? "var(--color-golden-accent)" : "var(--color-stone-text)",
                          boxShadow: node.fired ? "0 0 8px var(--color-golden-accent)" : "none",
                        }}
                      />
                      <span style={{ fontSize: "12px", fontWeight: 600, color: node.fired ? "var(--color-pure-white)" : "var(--color-silver-text)" }}>
                        {node.id}
                      </span>
                      <span style={{ fontSize: "10px", fontFamily: "monospace", color: "var(--color-ash-text)" }}>
                        {node.potential.toFixed(2)}V
                      </span>
                      {node.fired && (
                        <span style={{ fontSize: "8px", padding: "1px 4px", borderRadius: "3px", background: "rgba(217, 119, 6, 0.2)", color: "var(--color-golden-accent)", fontWeight: "bold" }}>
                          FIRED
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="table-container" style={{ padding: 0, overflow: "hidden" }}>
          {memories.length === 0 ? (
            <EmptyState title="No Recall Results" description="Run an explain query to inspect ranked memories." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Score</th>
                  <th>Content</th>
                  <th>Record</th>
                </tr>
              </thead>
              <tbody>
                {memories.map((memory) => (
                  <tr key={memory.recordId}>
                    <td style={{ fontWeight: 700 }}>{memory.type}</td>
                    <td>{memory.score.toFixed(3)}</td>
                    <td>{memory.content}</td>
                    <td style={{ fontFamily: "monospace", color: "var(--color-stone-text)" }}>{memory.recordId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AuthGuard>
  );
}
