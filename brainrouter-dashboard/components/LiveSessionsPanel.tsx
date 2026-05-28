"use client";

import { useMemo } from "react";
import { useActiveSessions } from "@kinqs/brainrouter-hooks";
import type { ActiveSessionRecord } from "@kinqs/brainrouter-types";
import type { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import { PremiumCard } from "./PremiumCard";

/**
 * Federation Stage 2 (FED-S2-T7) — "Live sessions" widget for the
 * Overview page. Polls `/api/sessions` every 10s through
 * `useActiveSessions`. Columns: client kind, workspace, last
 * heartbeat, optional usage snapshot (FED-S2-T8 — opt-in via
 * `includeUsage`).
 */
export function LiveSessionsPanel({
  client,
  includeUsage = true,
}: {
  client: BrainRouterClient;
  includeUsage?: boolean;
}) {
  const { sessions, error, isLoading } = useActiveSessions(client, {
    includeUsage,
  });

  return (
    <PremiumCard
      level={2}
      style={{ display: "flex", flexDirection: "column", gap: "16px" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 className="serif-display" style={{ fontSize: "20px", fontWeight: 500, margin: 0 }}>
          Live sessions
        </h3>
        <span
          style={{
            fontSize: "12px",
            color: "var(--color-golden-accent)",
            border: "1px solid var(--border-hover-accent)",
            borderRadius: "var(--radius-pill)",
            padding: "2px 8px",
            whiteSpace: "nowrap",
          }}
        >
          {isLoading ? "Loading" : `${sessions.length} active`}
        </span>
      </div>
      <p style={{ color: "var(--color-porcelain-text)", fontSize: "14px", margin: 0 }}>
        MCP-aware CLIs currently attached to this user's BrainRouter brain.
        Heartbeats fire every 30 s; the registry sweeps sessions older than
        5 min. Default view is sessions whose last heartbeat landed within
        the last 2 minutes.
      </p>
      {error && (
        <div style={{ color: "var(--color-danger, #c43232)", fontSize: "13px" }}>
          Failed to load sessions: {error}
        </div>
      )}
      {!isLoading && sessions.length === 0 && !error && (
        <div style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>
          No active peers right now. Connect a CLI or a host (Claude Code, Codex,
          Cursor, …) with the same BrainRouter profile to see it appear here.
        </div>
      )}
      {sessions.length > 0 && <SessionTable sessions={sessions} includeUsage={includeUsage} />}
    </PremiumCard>
  );
}

function SessionTable({
  sessions,
  includeUsage,
}: {
  sessions: ActiveSessionRecord[];
  includeUsage: boolean;
}) {
  const now = Date.now();
  const rowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: includeUsage
      ? "minmax(120px, 1fr) minmax(120px, 1fr) 110px 110px 1.5fr"
      : "minmax(120px, 1fr) minmax(120px, 1fr) 110px 1.5fr",
    gap: "12px",
    fontSize: "13px",
    padding: "8px 0",
    borderBottom: "1px solid var(--border-dim)",
    alignItems: "center",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          ...rowStyle,
          color: "var(--color-stone-text)",
          textTransform: "uppercase",
          fontSize: "11px",
          letterSpacing: "0.04em",
        }}
      >
        <span>Client</span>
        <span>Session</span>
        <span>Heartbeat</span>
        {includeUsage && <span>Usage</span>}
        <span>Workspace</span>
      </div>
      {sessions.map((s) => (
        <div key={`${s.userId}:${s.sessionKey}`} style={rowStyle}>
          <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>{s.clientKind}</span>
          <span style={{ color: "var(--color-stone-text)", fontFamily: "ui-monospace, monospace" }}>
            {s.sessionKey.slice(0, 12)}
          </span>
          <span style={{ color: "var(--color-porcelain-text)" }}>
            {formatHeartbeatAge(now, s.lastHeartbeatAt)}
          </span>
          {includeUsage && (
            <span style={{ color: "var(--color-porcelain-text)" }}>
              {formatUsage(s)}
            </span>
          )}
          <span
            style={{
              color: "var(--color-stone-text)",
              fontFamily: "ui-monospace, monospace",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {s.workspaceRoot || "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatHeartbeatAge(nowMs: number, iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const ageMs = nowMs - t;
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / (60 * 60_000))}h ago`;
}

function formatUsage(s: ActiveSessionRecord): string {
  const usage = s.usage;
  if (!usage) return "—";
  const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  const usd = typeof usage.totalUsd === "number" ? `$${usage.totalUsd.toFixed(3)}` : "—";
  return `${tokens.toLocaleString()} / ${usd}`;
}
