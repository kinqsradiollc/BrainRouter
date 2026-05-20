"use client";

import { useMemo, useState } from "react";
import { useHookStatus } from "@brainrouter/hooks";
import type { HostHookSource } from "@brainrouter/types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";

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

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          {SOURCES.map((item) => (
            <button
              key={item}
              onClick={() => setSource(item)}
              style={{
                padding: "5px 12px",
                borderRadius: "9999px",
                border: "1px solid var(--border-med)",
                background: source === item ? "var(--overlay-bg-hover)" : "transparent",
                color: source === item ? "var(--color-pure-white)" : "var(--color-stone-text)",
                cursor: "pointer",
              }}
            >
              {item === "all" ? "All" : item}
            </button>
          ))}
          <button
            onClick={() => setShowRegisterForm(!showRegisterForm)}
            style={{
              marginLeft: "10px",
              padding: "5px 12px",
              borderRadius: "9999px",
              border: "1px solid var(--border-med)",
              background: showRegisterForm ? "var(--overlay-bg)" : "transparent",
              color: "var(--color-silver-text)",
              cursor: "pointer",
              fontSize: "12px"
            }}
          >
            {showRegisterForm ? "Cancel Registration" : "Register Hook..."}
          </button>
          <button onClick={() => void refresh()} disabled={isLoading} style={{ marginLeft: "auto", padding: "5px 14px", borderRadius: "9999px", border: "1px solid var(--border-med)", background: "transparent", color: "var(--color-silver-text)" }}>
            {isLoading ? "Loading" : "Refresh"}
          </button>
        </div>

        {showRegisterForm && (
          <div className="table-container" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
              <input value={sessionKey} onChange={(next) => setSessionKey(next.target.value)} placeholder="Session key" style={inputStyle} />
              <input value={event} onChange={(next) => setEvent(next.target.value)} placeholder="Lifecycle event" style={inputStyle} />
            </div>
            <textarea value={payload} onChange={(next) => setPayload(next.target.value)} rows={5} style={{ ...inputStyle, resize: "vertical" }} />
            <button onClick={() => void handleRegister()} style={buttonStyle}>Register Hook</button>
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

const buttonStyle = {
  width: "fit-content",
  padding: "9px 16px",
  borderRadius: "9999px",
  border: "1px solid var(--border-med)",
  background: "transparent",
  color: "var(--color-silver-text)",
  cursor: "pointer",
};
