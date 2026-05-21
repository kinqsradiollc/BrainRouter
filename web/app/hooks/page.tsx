"use client";

import { useMemo, useState } from "react";
import { useHookStatus } from "@brainrouter/hooks";
import type { HostHookSource } from "@brainrouter/types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
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
        <PageHeader title="Hooks" description="Registered passive host integrations and lifecycle event status." />

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", width: "100%" }}>
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
          <PremiumButton
            size="small"
            variant="ghost"
            onClick={() => setShowRegisterForm(!showRegisterForm)}
            style={{ marginLeft: "10px" }}
          >
            {showRegisterForm ? "Cancel Registration" : "Register Hook..."}
          </PremiumButton>
          <PremiumButton 
            size="small"
            variant="ghost"
            onClick={() => void refresh()} 
            disabled={isLoading} 
            style={{ marginLeft: "auto" }}
          >
            {isLoading ? "Loading" : "Refresh"}
          </PremiumButton>
        </div>

        {showRegisterForm && (
          <div className="table-container" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
              <input value={sessionKey} onChange={(next) => setSessionKey(next.target.value)} placeholder="Session key" style={inputStyle} />
              <input value={event} onChange={(next) => setEvent(next.target.value)} placeholder="Lifecycle event" style={inputStyle} />
            </div>
            <textarea value={payload} onChange={(next) => setPayload(next.target.value)} rows={5} style={{ ...inputStyle, resize: "vertical" }} />
            <PremiumButton 
              size="small" 
              variant="primary" 
              onClick={() => void handleRegister()}
              style={{ width: "fit-content" }}
            >
              Register Hook
            </PremiumButton>
            {error && <div style={{ color: "#ef4444", fontSize: "13px" }}>{error}</div>}
          </div>
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
