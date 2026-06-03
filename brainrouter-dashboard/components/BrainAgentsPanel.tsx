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
import { useIsMobile } from "../lib/useIsMobile";

function statusColor(status: string): string {
  switch (status) {
    case "done":
      return "#34C28E";
    case "running":
      return "#38bdf8";
    case "pending":
      return "#D9A441";
    case "failed":
      return "#E5675F";
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
  // Phones: stack each agent row so the metrics don't crush the agent name
  // into a one-character-per-line column.
  const isMobile = useIsMobile();

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
        <p style={{ color: "#E5675F", fontSize: "12px", margin: 0 }}>Could not load brain agents: {error}</p>
      )}
      {agents && agents.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0", marginTop: "4px" }}>
          {agents.map((a) => (
            <div
              key={a.id}
              style={{ display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "flex-start" : "center", gap: isMobile ? "4px" : "12px", padding: "8px 0", borderBottom: "1px solid var(--border-dim)", fontSize: "13px" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: statusColor(a.lastJobStatus), flexShrink: 0 }} />
                <span style={{ color: "var(--color-white-frost)", fontWeight: 500, overflowWrap: "anywhere" }}>{a.id}</span>
                <span
                  title={a.modelClass === "none" ? "Deterministic step — no LLM" : `Model class: ${a.modelClass}`}
                  style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.06em", textTransform: "uppercase", color: a.modelClass === "none" ? "var(--text-muted)" : "var(--accent)", background: a.modelClass === "none" ? "var(--surface-overlay)" : "var(--accent-wash)", border: "1px solid var(--border)", borderRadius: "var(--radius-chip)", padding: "1px 6px" }}
                >
                  {a.modelClass === "none" ? "mechanical" : a.modelClass}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 12px", color: "var(--color-stone-text)", fontSize: "12px", whiteSpace: "nowrap", maxWidth: "100%" }}>
                <span>{a.lastJobStatus} · {ageLabel(a.lastJobCompletedAt)}</span>
                <span>{a.successRate24h == null ? "—" : `${Math.round(a.successRate24h * 100)}%`}</span>
                <span style={{ color: a.pendingJobs > 0 ? "#D9A441" : "var(--color-stone-text)" }}>{a.pendingJobs} pending</span>
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
