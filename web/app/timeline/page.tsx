"use client";

import { useMemo, useState } from "react";
import { useOperations } from "@brainrouter/hooks";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { InfiniteScrollSentinel } from "../../components/InfiniteScrollSentinel";
import { PageHeader } from "../../components/PageHeader";

const OP_TYPES = ["all", "recall", "l1_upsert", "memory_update", "archive", "export", "import", "memory_governance_delete", "contradiction_resolve"];

function formatTime(value: string) {
  return value ? new Date(value).toLocaleString() : "Unknown";
}

export default function TimelinePage() {
  const client = useMemo(() => getClient(), []);
  const [operation, setOperation] = useState("all");
  const [sessionKey, setSessionKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const filters = useMemo(() => ({
    limit: 50,
    operation: operation === "all" ? undefined : operation,
    sessionKey: sessionKey.trim() || undefined,
  }), [operation, sessionKey]);
  const { operations, error, refresh, loadMore, hasMore, isFetchingMore, isLoading } = useOperations(client, filters);

  return (
    <AuthGuard>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <PageHeader title="Timeline" description="Chronological memory operations across capture, recall, governance, and import/export activity." />

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          {showAdvanced && (
            <label style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: "240px" }}>
              <span style={{ fontSize: "11px", color: "var(--color-ash-text)", textTransform: "uppercase" }}>Session Key</span>
              <input
                value={sessionKey}
                onChange={(event) => setSessionKey(event.target.value)}
                placeholder="Filter by session"
                style={{ padding: "9px 10px", borderRadius: "6px", border: "1px solid rgba(226,227,233,0.1)", background: "rgba(0,0,0,0.25)", color: "var(--color-silver-text)" }}
              />
            </label>
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
            {showAdvanced ? "Hide Filter" : "Session Filter..."}
          </button>
          <button
            onClick={() => void refresh()}
            disabled={isLoading}
            style={{ marginLeft: "auto", padding: "9px 16px", borderRadius: "9999px", border: "1px solid rgba(226,227,233,0.12)", background: "transparent", color: "var(--color-silver-text)", cursor: isLoading ? "default" : "pointer" }}
          >
            {isLoading ? "Loading" : "Refresh"}
          </button>
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {OP_TYPES.map((item) => (
            <button
              key={item}
              onClick={() => setOperation(item)}
              style={{
                padding: "5px 12px",
                borderRadius: "9999px",
                border: "1px solid rgba(226,227,233,0.12)",
                background: operation === item ? "rgba(174,147,87,0.18)" : "transparent",
                color: operation === item ? "var(--color-pure-white)" : "var(--color-stone-text)",
                cursor: "pointer",
              }}
            >
              {item === "all" ? "All" : item.replace(/_/g, " ")}
            </button>
          ))}
        </div>

        {error && <div style={{ color: "#ef4444", fontSize: "13px" }}>{error}</div>}

        <div className="table-container" style={{ padding: 0, overflow: "hidden" }}>
          {operations.length === 0 && !isLoading ? (
            <EmptyState title="No Operations" description="Memory operations will appear here after capture, recall, or governance activity." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Record</th>
                  <th>Session</th>
                  <th>Actor</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((operationRow) => (
                  <tr key={operationRow.id}>
                    <td style={{ fontWeight: 700 }}>{operationRow.operation}</td>
                    <td style={{ fontFamily: "monospace", color: "var(--color-stone-text)" }}>{operationRow.recordId ?? "none"}</td>
                    <td style={{ fontFamily: "monospace" }}>{operationRow.sessionKey || "none"}</td>
                    <td>{operationRow.actor || "system"}</td>
                    <td>{formatTime(operationRow.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <InfiniteScrollSentinel hasMore={hasMore} isFetchingMore={isFetchingMore} onLoadMore={loadMore} />
        </div>
      </div>
    </AuthGuard>
  );
}
