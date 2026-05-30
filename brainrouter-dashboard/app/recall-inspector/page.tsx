"use client";

import { useMemo, useState } from "react";
import { useRecallInspector } from "@kinqs/brainrouter-hooks";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { FilterBar } from "../../components/FilterBar";

export default function RecallInspectorPage() {
  const client = useMemo(() => getClient(), []);
  const { result, error, isLoading, explain } = useRecallInspector(client);
  const [query, setQuery] = useState("");
  const [activeSkill, setActiveSkill] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const memories = Array.isArray(result?.recalledCognitiveMemories) ? result.recalledCognitiveMemories : [];
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
        <PageHeader title="Recall Inspector" description="Explain-mode recall with retrieval counts, intent boosts, reranker status, and final memory scores.">
          <button onClick={() => setShowAdvanced(!showAdvanced)} className="pill-btn pill-btn-ghost">
            {showAdvanced ? "Hide advanced" : "Advanced filters"}
          </button>
        </PageHeader>

        <FilterBar>
          <FilterBar.Label text="Recall query">
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              rows={3}
              placeholder="What should the model recall?"
              className="pill-input"
              style={{ width: "100%", resize: "vertical", borderRadius: "10px", padding: "12px 16px" }}
            />
          </FilterBar.Label>
          {showAdvanced && (
            <FilterBar.Label text="Active skill filter">
              <input
                value={activeSkill}
                onChange={(event) => setActiveSkill(event.target.value)}
                placeholder="Restrict recall to a specific skill"
                className="pill-input"
              />
            </FilterBar.Label>
          )}
          <FilterBar.Row align="end">
            <button onClick={() => void runExplain()} disabled={isLoading || !query.trim()} className="pill-btn">
              {isLoading ? "Running…" : "Explain recall"}
            </button>
          </FilterBar.Row>
          {error && <div style={{ color: "#ef4444", fontSize: "13px" }}>{error}</div>}
        </FilterBar>

        {explanation && (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
              {[
                ["FTS hits", explanation.ftsHits],
                ["Vector hits", explanation.vecHits],
                ["File hits", explanation.filePathHits],
                ["Intent", explanation.intentDetected],
                ["Reranker", explanation.rerankerUsed ? "on" : "off"],
                // 0.4.3 — which selection stage chose the final top-K: the
                // cross-encoder (key set), the local lexical+MMR diversity pass
                // (default, no key), or plain composite score (diversity off).
                ["Selection", explanation.rerankerUsed ? "reranker" : explanation.diversityApplied ? "lexical + MMR" : "score-only"],
                ["Duration", `${explanation.durationMs}ms`],
              ].map(([label, value]) => (
                <div key={label} className="card" style={{ padding: "14px" }}>
                  <div style={{ color: "var(--color-ash-text)", fontSize: "11px", textTransform: "uppercase" }}>{label}</div>
                  <div style={{ color: "var(--color-pure-white)", fontSize: "18px", marginTop: "6px", fontWeight: 700 }}>{value}</div>
                </div>
              ))}
            </div>

            {Array.isArray(explanation.sparkedNodes) && explanation.sparkedNodes.length > 0 && (
              <div className="card" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-ash-text)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  🧠 Neural Spark Spreading Activation Trace
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))",
                    gap: "8px",
                  }}
                >
                  {explanation.sparkedNodes.map((node: any, index: number) => {
                    const label = node.preview || node.id;
                    const hoverTitle = [node.id, node.sceneName, node.type].filter(Boolean).join("\n");
                    return (
                      <div
                        key={node.id ? `${node.id}-${index}` : index}
                        title={hoverTitle}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          padding: "6px 10px",
                          borderRadius: "9999px",
                          background: node.fired ? "rgba(204, 145, 102, 0.08)" : "var(--color-pewter-accent)",
                          border: node.fired ? "1px solid var(--color-golden-accent)" : "1px solid var(--border-dim)",
                          minWidth: 0,
                          fontSize: "12px",
                        }}
                      >
                        <span
                          style={{
                            width: "6px",
                            height: "6px",
                            borderRadius: "50%",
                            background: node.fired ? "var(--color-golden-accent)" : "var(--color-stone-text)",
                            boxShadow: node.fired ? "0 0 6px var(--color-golden-accent)" : "none",
                            flexShrink: 0,
                          }}
                        />
                        {node.type && (
                          <span
                            style={{
                              fontSize: "9px",
                              padding: "1px 6px",
                              borderRadius: "9999px",
                              background: "var(--color-slate-gray)",
                              color: "var(--color-silver-text)",
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                              fontWeight: 600,
                              flexShrink: 0,
                            }}
                          >
                            {node.type}
                          </span>
                        )}
                        <span
                          style={{
                            color: node.fired ? "var(--color-pure-white)" : "var(--color-white-frost)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {label}
                        </span>
                        <span style={{ fontSize: "10px", fontFamily: "monospace", color: "var(--color-silver-text)", flexShrink: 0 }}>
                          {(node.potential ?? 0).toFixed(2)}V
                        </span>
                      </div>
                    );
                  })}
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
                    <td>{(memory.score ?? 0).toFixed(3)}</td>
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
