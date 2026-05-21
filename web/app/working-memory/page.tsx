"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useWorkingMemory } from "@brainrouter/hooks";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { motion } from "framer-motion";

export default function WorkingMemoryPage() {
  const client = useMemo(() => getClient(), []);
  const { context, sessions, error, isLoading, loadContext, loadSessions, offload, reset } = useWorkingMemory(client);
  const [sessionKey, setSessionKey] = useState("default");
  const [workspacePath, setWorkspacePath] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [payload, setPayload] = useState("");
  const [title, setTitle] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedSessionVal, setSelectedSessionVal] = useState("default::global");
  const canUseSession = sessionKey.trim().length > 0;

  const requestBase = {
    sessionKey: sessionKey.trim(),
    workspacePath: workspacePath.trim() || undefined,
  };

  useEffect(() => {
    void loadSessions().then((list) => {
      if (list && list.length > 0) {
        const first = list[0];
        const val = `${first.sessionKey}::${first.workspaceId}`;
        setSelectedSessionVal(val);
        setSessionKey(first.sessionKey);
        setWorkspacePath(first.workspaceId);
      }
    }).catch(() => {});
  }, [loadSessions]);

  useEffect(() => {
    if (sessionKey.trim()) {
      void loadContext({
        sessionKey: sessionKey.trim(),
        workspacePath: workspacePath.trim() || undefined,
        nodeId: nodeId.trim() || undefined,
      }).catch(() => {});
    }
  }, [sessionKey, workspacePath, nodeId, loadContext]);

  async function handleLoad() {
    if (!canUseSession) return;
    await loadContext({
      ...requestBase,
      nodeId: nodeId.trim() || undefined,
    });
  }

  async function handleOffload() {
    if (!canUseSession || !payload.trim()) return;
    await offload({
      ...requestBase,
      payload: payload.trim(),
      title: title.trim() || "Dashboard payload",
      kind: "dashboard",
    });
    setPayload("");
  }

  async function handleReset() {
    if (!canUseSession) return;
    await reset(requestBase);
  }

  const handleSessionChange = (value: string) => {
    setSelectedSessionVal(value);
    const [key, wsId] = value.split("::");
    setSessionKey(key);
    setWorkspacePath(wsId);
    setNodeId("");
  };

  return (
    <AuthGuard>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <PageHeader title="Working Memory" description="Short-term session refs, step summaries, and Mermaid task canvas." />

        <div className="table-container" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "14px", color: "var(--color-stone-text)" }}>
              Active Session:
            </span>
            {sessions.length > 0 ? (
              <select
                value={selectedSessionVal}
                onChange={(event) => handleSessionChange(event.target.value)}
                className="premium-select"
              >
                {sessions.map((s) => (
                  <option key={`${s.workspaceId}-${s.sessionKey}`} value={`${s.sessionKey}::${s.workspaceId}`}>
                    {s.sessionKey} (Workspace: {s.workspaceId})
                  </option>
                ))}
                <option value="default::global">default (global)</option>
              </select>
            ) : (
              <strong style={{ color: "var(--color-pure-white)" }}>{sessionKey}</strong>
            )}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                color: "var(--color-golden-accent)",
                fontSize: "13px",
                cursor: "pointer",
                padding: "4px 8px",
              }}
            >
              {showAdvanced ? "Hide Session Config" : "Configure Session"}
            </button>
          </div>

          {showAdvanced && (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "8px", borderTop: "1px solid rgba(226,227,233,0.06)", paddingTop: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                <input value={sessionKey} onChange={(event) => setSessionKey(event.target.value)} placeholder="Session key" style={inputStyle} />
                <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="Workspace path / id" style={inputStyle} />
                <input value={nodeId} onChange={(event) => setNodeId(event.target.value)} placeholder="Ref node ID" style={inputStyle} />
              </div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <button onClick={() => void handleLoad()} disabled={!canUseSession || isLoading} style={buttonStyle}>Load Context</button>
                <button onClick={() => void handleReset()} disabled={!canUseSession} style={buttonStyle}>Reset Session</button>
              </div>
            </div>
          )}

          {error && <div style={{ color: "#ef4444", fontSize: "13px" }}>{error}</div>}
        </div>

        <div className="table-container" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Payload title (optional)" style={inputStyle} />
          <textarea value={payload} onChange={(event) => setPayload(event.target.value)} rows={5} placeholder="Payload to offload" style={{ ...inputStyle, resize: "vertical" }} />
          <button onClick={() => void handleOffload()} disabled={!canUseSession || !payload.trim()} style={buttonStyle}>Offload Payload</button>
        </div>

        {!context ? (
          <EmptyState title="No Working Context Loaded" description="Configure or load a session to inspect short-term working memory state." />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: "18px" }}>
            <section className="table-container" style={{ padding: "18px" }}>
              <h2 style={{ margin: 0, fontSize: "18px" }}>Canvas</h2>
              <pre style={preStyle}>{context.canvas}</pre>
            </section>
            <section className="table-container" style={{ padding: "18px" }}>
              <h2 style={{ margin: 0, fontSize: "18px" }}>State</h2>
              <div style={{ color: "var(--color-stone-text)", fontSize: "13px", marginTop: "10px" }}>
                Pressure: <strong style={{ color: "var(--color-pure-white)" }}>{context.state.pressureLevel}</strong>
              </div>
              <div style={{ color: "var(--color-stone-text)", fontSize: "13px", marginTop: "6px" }}>
                Work dir: <span style={{ fontFamily: "monospace" }}>{context.workDir}</span>
              </div>
              {context.ref && <pre style={preStyle}>{context.ref.content}</pre>}
            </section>
          </div>
        )}

        {context && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h2 className="serif-display" style={{ margin: "24px 0 8px 0", fontSize: "22px" }}>Memory Nodes ({context.steps.length})</h2>
            {context.steps.length === 0 ? (
              <EmptyState
                title="Working memory is clear"
                description="This session's working memory currently contains no offloaded context, references, or steps."
              />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "20px" }}>
                {context.steps.map((step) => {
                  const capacity = context.state.contextWindowTokens || 120000;
                  const pct = Math.min(100, Math.max(0, (step.tokenEstimate / capacity) * 100));
                  return (
                    <PremiumCard
                      key={step.nodeId}
                      level={2}
                      hoverEffect={true}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "12px",
                        padding: "20px"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{
                          fontFamily: "monospace",
                          color: "var(--color-golden-accent)",
                          fontSize: "14px",
                          fontWeight: 600,
                          background: "rgba(204, 145, 102, 0.1)",
                          padding: "2px 8px",
                          borderRadius: "4px"
                        }}>
                          {step.nodeId}
                        </span>
                        <span style={{
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          color: "var(--color-stone-text)",
                          background: "rgba(226, 227, 233, 0.04)",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontWeight: 600
                        }}>
                          {step.kind}
                        </span>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <h4 style={{ margin: 0, fontSize: "16px", color: "var(--color-pure-white)" }}>
                          {step.title}
                        </h4>
                        {context.sessionKey && (
                          <span style={{ fontSize: "12px", color: "var(--color-stone-text)" }}>
                            Scene: <strong style={{ color: "var(--color-silver-text)" }}>{context.sessionKey}</strong>
                          </span>
                        )}
                      </div>

                      <p style={{
                        margin: 0,
                        fontSize: "13px",
                        color: "var(--color-silver-text)",
                        lineHeight: 1.5,
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        textOverflow: "ellipsis"
                      }}>
                        {step.summary || step.title || "No summary provided."}
                      </p>

                      <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid rgba(226, 227, 233, 0.04)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--color-stone-text)", marginBottom: "6px" }}>
                          <span>Priority / Tokens</span>
                          <span style={{ color: "var(--color-golden-accent)", fontWeight: 500 }}>
                            {step.tokenEstimate.toLocaleString()} / {capacity.toLocaleString()} ({pct.toFixed(1)}%)
                          </span>
                        </div>
                        <div style={{ height: "4px", background: "rgba(226, 227, 233, 0.08)", borderRadius: "9999px", overflow: "hidden" }}>
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ type: "spring", stiffness: 80, damping: 15 }}
                            style={{
                              height: "100%",
                              background: pct > 80 ? "#ef4444" : "var(--color-golden-accent)",
                              boxShadow: pct > 80 ? "0 0 6px #ef4444" : "0 0 6px var(--color-golden-accent)"
                            }}
                          />
                        </div>
                      </div>
                    </PremiumCard>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </AuthGuard>
  );
}

const inputStyle: CSSProperties = {
  padding: "9px 10px",
  borderRadius: "6px",
  border: "1px solid rgba(226,227,233,0.1)",
  background: "rgba(0,0,0,0.25)",
  color: "var(--color-silver-text)",
};

const buttonStyle: CSSProperties = {
  padding: "9px 16px",
  borderRadius: "9999px",
  border: "1px solid rgba(226,227,233,0.12)",
  background: "transparent",
  color: "var(--color-silver-text)",
  cursor: "pointer",
};

const preStyle: CSSProperties = {
  marginTop: "12px",
  padding: "12px",
  borderRadius: "8px",
  background: "rgba(0,0,0,0.28)",
  color: "var(--color-silver-text)",
  overflow: "auto",
  fontSize: "12px",
  lineHeight: 1.5,
};
