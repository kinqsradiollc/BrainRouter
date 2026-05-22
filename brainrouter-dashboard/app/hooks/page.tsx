"use client";

import { useMemo, useState } from "react";
import { useHookStatus } from "@kinqs/brainrouter-hooks";
import type { HostHookSource } from "@kinqs/brainrouter-types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { FilterBar } from "../../components/FilterBar";
import { PremiumButton } from "../../components/PremiumButton";

const SOURCES: Array<HostHookSource | "all"> = ["all", "claude-code", "codex", "generic-mcp"];

export default function HooksPage() {
  const client = useMemo(() => getClient(), []);
  const [source, setSource] = useState<HostHookSource | "all">("all");
  const [sessionKey, setSessionKey] = useState("");
  const [event, setEvent] = useState("");
  const [payload, setPayload] = useState("{\n  \"tool_name\": \"Bash\"\n}");
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const params = useMemo(() => ({ source: source === "all" ? undefined : source }), [source]);
  const { hooks, error, isLoading, refresh, register } = useHookStatus(client, params);

  async function handleRegister() {
    const parsedPayload = payload.trim() ? JSON.parse(payload) as Record<string, unknown> : undefined;
    await register({
      source: source === "all" ? "generic-mcp" : source,
      events: event.trim() ? [event.trim()] : undefined,
      sessionKey: sessionKey.trim() || undefined,
      event: event.trim() || undefined,
      payload: parsedPayload,
    });
  }

  return (
    <AuthGuard>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <PageHeader title="Hooks" description="Registered passive host integrations and lifecycle event status.">
          <PremiumButton size="small" variant="ghost" onClick={() => setShowRegisterForm(!showRegisterForm)}>
            {showRegisterForm ? "Cancel" : "Register hook"}
          </PremiumButton>
          <PremiumButton size="small" variant="ghost" onClick={() => void refresh()} disabled={isLoading}>
            {isLoading ? "Loading…" : "Refresh"}
          </PremiumButton>
        </PageHeader>

        <FilterBar card={false}>
          <FilterBar.Row>
            {SOURCES.map((item) => (
              <PremiumButton
                key={item}
                size="small"
                variant={source === item ? "primary" : "ghost"}
                onClick={() => setSource(item)}
              >
                {item === "all" ? "All" : item}
              </PremiumButton>
            ))}
          </FilterBar.Row>
        </FilterBar>

        {showRegisterForm && (
          <FilterBar>
            <FilterBar.Row gap={12}>
              <FilterBar.Label text="Session key">
                <input value={sessionKey} onChange={(next) => setSessionKey(next.target.value)} placeholder="brainrouter-cli:/path" className="pill-input" style={{ minWidth: "240px" }} />
              </FilterBar.Label>
              <FilterBar.Label text="Lifecycle event">
                <input value={event} onChange={(next) => setEvent(next.target.value)} placeholder="e.g. session.start" className="pill-input" style={{ minWidth: "240px" }} />
              </FilterBar.Label>
            </FilterBar.Row>
            <FilterBar.Label text="Payload (JSON or text)">
              <textarea value={payload} onChange={(next) => setPayload(next.target.value)} rows={5} className="pill-input" style={{ resize: "vertical", borderRadius: "10px", padding: "12px 16px" }} />
            </FilterBar.Label>
            <FilterBar.Row align="end">
              <PremiumButton size="small" variant="primary" onClick={() => void handleRegister()}>
                Register hook
              </PremiumButton>
            </FilterBar.Row>
            {error && <div style={{ color: "#ef4444", fontSize: "13px" }}>{error}</div>}
          </FilterBar>
        )}

        <div className="table-container" style={{ padding: 0, overflow: "hidden" }}>
          {hooks.length === 0 && !isLoading ? (
            <EmptyState title="No Hooks Registered" description="Host integration status appears here after registration or lifecycle events." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Session</th>
                  <th>Events</th>
                  <th>Last Event</th>
                  <th>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {hooks.map((hook) => (
                  <tr key={hook.id}>
                    <td style={{ fontWeight: 700 }}>{hook.source}</td>
                    <td style={{ fontFamily: "monospace" }}>{hook.sessionKey ?? "global"}</td>
                    <td>{hook.events.join(", ") || "none"}</td>
                    <td>{hook.lastEvent ?? "none"}</td>
                    <td>{hook.lastSeenAt ? new Date(hook.lastSeenAt).toLocaleString() : "Never"}</td>
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

const inputStyle = {
  padding: "9px 10px",
  borderRadius: "6px",
  border: "1px solid var(--border-med)",
  background: "var(--overlay-bg)",
  color: "var(--color-silver-text)",
};
