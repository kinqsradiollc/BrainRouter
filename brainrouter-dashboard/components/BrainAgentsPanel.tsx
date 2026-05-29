"use client";

/**
 * BRAIN-P1-T5 (0.4.1) — Brain Agents health card.
 *
 * Polls `GET /api/brain/agents` (the same BrainAgentStatus[] the
 * `memory_agent_status` MCP tool returns) and renders each pipeline
 * agent's last status, 24h success rate, and pending-job count. Safe to
 * poll on a ~10s interval (read-only).
 */

import { useEffect, useState } from "react";
import type { BrainAgentStatus } from "@kinqs/brainrouter-types";
import { BASE_URL } from "../lib/client";
import { getApiKey, getJwt } from "../lib/client-auth";
import { PremiumCard } from "./PremiumCard";

function statusColor(status: string): string {
  switch (status) {
    case "done":
      return "#10b981";
    case "running":
      return "#38bdf8";
    case "pending":
      return "#eab308";
    case "failed":
      return "#ef4444";
    case "cancelled":
      return "var(--color-stone-text)";
    default:
      return "var(--color-stone-text)"; // idle
  }
}

function ageLabel(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function BrainAgentsPanel() {
  const [agents, setAgents] = useState<BrainAgentStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const token = getJwt() || getApiKey();
        const res = await fetch(`${BASE_URL}/api/brain/agents`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (alive) {
          setAgents(Array.isArray(body.agents) ? body.agents : []);
          setError(null);
        }
      } catch (e: any) {
        if (alive) setError(e?.message ?? "failed to load");
      }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <PremiumCard level={2} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 className="serif-display" style={{ fontSize: "20px", fontWeight: 500, margin: 0 }}>
          Brain Agents
        </h3>
        <span style={{ fontSize: "12px", color: "var(--color-golden-accent)", border: "1px solid var(--border-hover-accent)", borderRadius: "var(--radius-pill)", padding: "2px 8px" }}>
          {agents ? `${agents.length} agents` : error ? "unavailable" : "loading"}
        </span>
      </div>
      <p style={{ color: "var(--color-stone-text)", fontSize: "12px", lineHeight: 1.5, margin: 0 }}>
        The memory pipeline stages as observable jobs — last run, 24h success rate, and pending work. (BRAIN-P1)
      </p>
      {error && (
        <p style={{ color: "#fca5a5", fontSize: "12px", margin: 0 }}>Could not load brain agents: {error}</p>
      )}
      {agents && agents.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0", marginTop: "4px" }}>
          {agents.map((a) => (
            <div
              key={a.id}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "8px 0", borderBottom: "1px solid var(--border-dim)", fontSize: "13px" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: statusColor(a.lastJobStatus), flexShrink: 0 }} />
                <span style={{ color: "var(--color-white-frost)", fontWeight: 500, overflowWrap: "anywhere" }}>{a.id}</span>
                <span style={{ color: "var(--color-stone-text)", fontSize: "11px" }}>{a.modelClass}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", color: "var(--color-stone-text)", fontSize: "12px", whiteSpace: "nowrap" }}>
                <span>{a.lastJobStatus} · {ageLabel(a.lastJobCompletedAt)}</span>
                <span>{a.successRate24h == null ? "—" : `${Math.round(a.successRate24h * 100)}%`}</span>
                <span style={{ color: a.pendingJobs > 0 ? "#eab308" : "var(--color-stone-text)" }}>{a.pendingJobs} pending</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {agents && agents.length === 0 && !error && (
        <p style={{ color: "var(--color-stone-text)", fontSize: "13px", margin: 0 }}>No brain agents reported.</p>
      )}
    </PremiumCard>
  );
}
