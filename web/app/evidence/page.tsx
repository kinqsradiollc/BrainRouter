"use client";

import { useMemo, useState } from "react";
import { useEvidence } from "@brainrouter/hooks";
import type { EvidenceKind, L1Record } from "@brainrouter/types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { InfiniteScrollSentinel } from "../../components/InfiniteScrollSentinel";
import { PageHeader } from "../../components/PageHeader";

const EVIDENCE_KINDS: Array<EvidenceKind | "all"> = ["all", "file", "command", "url", "test", "benchmark", "memory", "other"];

export default function EvidencePage() {
  const client = useMemo(() => getClient(), []);
  const [kind, setKind] = useState<EvidenceKind | "all">("all");
  const [recordId, setRecordId] = useState("");
  const [selectedMemory, setSelectedMemory] = useState<L1Record | null>(null);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const filters = useMemo(() => ({
    limit: 50,
    kind,
    recordId: recordId.trim() || undefined,
  }), [kind, recordId]);
  const { evidence, error, refresh, loadMore, hasMore, isFetchingMore, isLoading } = useEvidence(client, filters);

  async function selectRecord(nextRecordId: string) {
    setSelectedError(null);
    setSelectedMemory(null);
    try {
      const response = await client.getMemory(nextRecordId);
      setSelectedMemory(response.memory);
    } catch (e) {
      setSelectedError(String(e));
    }
  }

  return (
    <AuthGuard>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <PageHeader title="Evidence" description="File, command, test, URL, benchmark, and memory references attached to L1 records." />

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: "280px", flex: 1 }}>
            <span style={{ fontSize: "11px", color: "var(--color-ash-text)", textTransform: "uppercase" }}>Record ID</span>
            <input
              value={recordId}
              onChange={(event) => setRecordId(event.target.value)}
              placeholder="Filter by parent memory record"
              style={{ padding: "9px 10px", borderRadius: "6px", border: "1px solid var(--border-med)", background: "var(--overlay-bg)", color: "var(--color-silver-text)" }}
            />
          </label>
          <button
            onClick={() => void refresh()}
            disabled={isLoading}
            style={{ padding: "9px 16px", borderRadius: "9999px", border: "1px solid var(--border-med)", background: "transparent", color: "var(--color-silver-text)", cursor: isLoading ? "default" : "pointer" }}
          >
            {isLoading ? "Loading" : "Refresh"}
          </button>
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {EVIDENCE_KINDS.map((item) => (
            <button
              key={item}
              onClick={() => setKind(item)}
              style={{
                padding: "5px 12px",
                borderRadius: "9999px",
                border: "1px solid var(--border-med)",
                background: kind === item ? "var(--overlay-bg-hover)" : "transparent",
                color: kind === item ? "var(--color-pure-white)" : "var(--color-stone-text)",
                cursor: "pointer",
              }}
            >
              {item === "all" ? "All" : item}
            </button>
          ))}
        </div>

        {error && <div style={{ color: "#ef4444", fontSize: "13px" }}>{error}</div>}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: "18px", alignItems: "start" }}>
          <div className="table-container" style={{ padding: 0, overflow: "hidden" }}>
            {evidence.length === 0 && !isLoading ? (
              <EmptyState title="No Evidence" description="Evidence rows will appear here after references are attached to memories." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Reference</th>
                    <th>Record</th>
                    <th>Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.map((item) => (
                    <tr key={item.id} onClick={() => void selectRecord(item.recordId)} style={{ cursor: "pointer" }}>
                      <td style={{ fontWeight: 700 }}>{item.kind}</td>
                      <td>{item.ref}</td>
                      <td style={{ fontFamily: "monospace", color: "var(--color-stone-text)" }}>{item.recordId}</td>
                      <td>{item.observedAt ? new Date(item.observedAt).toLocaleString() : "Unknown"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <InfiniteScrollSentinel hasMore={hasMore} isFetchingMore={isFetchingMore} onLoadMore={loadMore} />
          </div>

          <aside className="table-container" style={{ padding: "18px", minHeight: "220px" }}>
            <div style={{ fontSize: "12px", color: "var(--color-ash-text)", textTransform: "uppercase", marginBottom: "12px" }}>Parent Memory</div>
            {selectedError ? (
              <div style={{ color: "#ef4444", fontSize: "13px" }}>{selectedError}</div>
            ) : selectedMemory ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ fontSize: "12px", color: "var(--color-golden-accent)", fontWeight: 700 }}>{selectedMemory.type}</div>
                <div style={{ color: "var(--color-pure-white)", lineHeight: 1.55 }}>{selectedMemory.content}</div>
                <div style={{ fontFamily: "monospace", color: "var(--color-stone-text)", fontSize: "12px" }}>{selectedMemory.id}</div>
              </div>
            ) : (
              <div style={{ color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.5 }}>Select an evidence row to inspect its memory.</div>
            )}
          </aside>
        </div>
      </div>
    </AuthGuard>
  );
}
