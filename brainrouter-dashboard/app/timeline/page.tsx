"use client";

import { useMemo, useState } from "react";
import { useOperations } from "@kinqs/brainrouter-hooks";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { InfiniteScrollSentinel } from "../../components/InfiniteScrollSentinel";
import { PageHeader } from "../../components/PageHeader";
import { FilterBar } from "../../components/FilterBar";
import { PremiumButton } from "../../components/PremiumButton";

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
        <PageHeader title="Timeline" description="Chronological memory operations across capture, recall, governance, and import/export activity.">
          <PremiumButton size="small" variant="ghost" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? "Hide filter" : "Session filter"}
          </PremiumButton>
          <PremiumButton size="small" variant="ghost" onClick={() => void refresh()} disabled={isLoading}>
            {isLoading ? "Loading…" : "Refresh"}
          </PremiumButton>
        </PageHeader>

        <FilterBar>
          {showAdvanced && (
            <FilterBar.Row>
              <FilterBar.Label text="Session key">
                <input
                  value={sessionKey}
                  onChange={(event) => setSessionKey(event.target.value)}
                  placeholder="Filter by session"
                  className="pill-input"
                  style={{ minWidth: "280px" }}
                />
              </FilterBar.Label>
            </FilterBar.Row>
          )}
          <FilterBar.Row>
            {OP_TYPES.map((item) => (
              <PremiumButton
                key={item}
                size="small"
                variant={operation === item ? "primary" : "ghost"}
                onClick={() => setOperation(item)}
              >
                {item === "all" ? "All" : item.replace(/_/g, " ")}
              </PremiumButton>
            ))}
          </FilterBar.Row>
        </FilterBar>

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
