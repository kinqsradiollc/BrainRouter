"use client";

/**
 * ADR-054 D3 / ADR-052 §5.3 — the priced per-automation usage view. Names the
 * automation behind any token spike (loop / fleet-job / subagent / interactive)
 * and its cost at the org's CONTRACTED rate. Read-only; backed by
 * GET /api/admin/usage-automation (RBAC providers:manage).
 */
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/adminApi";
import { PremiumCard } from "../../components/PremiumCard";
import { InlineLoading } from "../../components/LoadingSpinner";

interface PricedAutomation {
  automation: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  turns: number;
  model?: string;
  estCostUsd: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function UsageAutomationPanel() {
  const [rows, setRows] = useState<PricedAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authFetch<{ automations: PricedAutomation[] }>("/api/admin/usage-automation");
      setRows(res.automations ?? []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
      <div className="settings-cardhead">
        <div>
          <h3>Usage by automation</h3>
          <div className="settings-hint">
            Tokens and cost per automation (loop, fleet job, sub-agent, interactive), priced at your
            organization&apos;s contracted rate. A runaway automation is identifiable here by name and cost.
          </div>
        </div>
      </div>

      {error && <div className="settings-empty-inline">{error}</div>}
      {loading ? (
        <InlineLoading label="Loading…" />
      ) : rows.length === 0 ? (
        <div className="settings-hint">No usage reported yet. (Enable client telemetry with <code>cli.usageTelemetry</code>.)</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="settings-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Automation</th>
                <th style={{ textAlign: "left" }}>Model</th>
                <th style={{ textAlign: "right" }}>Prompt</th>
                <th style={{ textAlign: "right" }}>Completion</th>
                <th style={{ textAlign: "right" }}>Turns</th>
                <th style={{ textAlign: "right" }}>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.automation}>
                  <td><strong>{r.automation}</strong></td>
                  <td className="settings-hint">{r.model ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>{fmtTokens(r.promptTokens)}</td>
                  <td style={{ textAlign: "right" }}>{fmtTokens(r.completionTokens)}</td>
                  <td style={{ textAlign: "right" }}>{r.turns}</td>
                  <td style={{ textAlign: "right" }}>${r.estCostUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PremiumCard>
  );
}
