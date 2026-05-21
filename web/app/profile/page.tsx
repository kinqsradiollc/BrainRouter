"use client";

import { useEffect, useState } from "react";
import { getClient, BASE_URL } from "../../lib/client";
import { getApiKey, setApiKey } from "../../lib/client-auth";
import { useAuth } from "../../components/AuthProvider";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumModal } from "../../components/PremiumModal";
import { motion } from "framer-motion";
import { MeResponse } from "@brainrouter/types";

function maskKey(key: string) {
  if (!key) return "";
  if (key.length < 12) return key;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function highlightJson(json: string) {
  if (!json) return [];
  const regex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let keyCounter = 0;
  
  while ((match = regex.exec(json)) !== null) {
    const matchIndex = match.index;
    const matchText = match[0];
    if (matchIndex > lastIndex) {
      parts.push(json.substring(lastIndex, matchIndex));
    }
    if (/^"/.test(matchText)) {
      if (/:$/.test(matchText)) {
        const keyText = matchText.slice(0, -1);
        parts.push(
          <span key={`key-${keyCounter++}`} style={{ color: "#d8be7c", fontWeight: 600 }}>{keyText}</span>
        );
        parts.push(":");
      } else {
        parts.push(
          <span key={`str-${keyCounter++}`} style={{ color: "#34d399" }}>{matchText}</span>
        );
      }
    } else if (/true|false/.test(matchText)) {
      parts.push(
        <span key={`bool-${keyCounter++}`} style={{ color: "#f43f5e", fontWeight: "bold" }}>{matchText}</span>
      );
    } else if (/null/.test(matchText)) {
      parts.push(
        <span key={`null-${keyCounter++}`} style={{ color: "#9ca3af", fontStyle: "italic" }}>{matchText}</span>
      );
    } else {
      parts.push(
        <span key={`num-${keyCounter++}`} style={{ color: "#60a5fa" }}>{matchText}</span>
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < json.length) {
    parts.push(json.substring(lastIndex));
  }
  return parts;
}

export default function ProfilePage() {
  const { logout } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [cachedApiKey, setCachedApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"http" | "stdio">("http");
  const [displayName, setDisplayName] = useState("");
  const [confirmRotate, setConfirmRotate] = useState(false);

  async function load() {
    setCachedApiKey(getApiKey());
    try {
      const client = getClient();
      const data = await client.me();
      setMe(data);
      setDisplayName(data.displayName || "");
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function generateOrRotate() {
    try {
      const client = getClient();
      const data = await client.rotateApiKey();
      setApiKey(data.apiKey);
      setCachedApiKey(data.apiKey);
      setMe((prev) => (prev ? { ...prev, apiKey: data.apiKey } : prev));
      setReveal(true);
      setMsg(cachedApiKey ? "Your old API key has been revoked and replaced successfully." : "Your new MCP API key has been generated successfully.");
    } catch (e) {
      console.error(e);
    }
  }

  async function saveDisplayName() {
    if (!displayName.trim()) return;
    const client = getClient();
    await client.updateMe({ displayName: displayName.trim() });
    setMe((prev) => prev ? { ...prev, displayName: displayName.trim() } : prev);
    setMsg("Display name updated.");
  }

  async function copyKey() {
    if (!cachedApiKey) return;
    await navigator.clipboard.writeText(cachedApiKey);
    setApiKey(cachedApiKey);
    setMsg("API key copied to clipboard and saved locally for MCP sessions.");
  }

  return (
    <AuthGuard>
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ display: "flex", flexDirection: "column", gap: "28px", maxWidth: "800px" }}
      >
        {/* Editorial Header */}
        <PageHeader 
          title="Profile Settings" 
          description="Manage your personal workspace settings and local daemon connection keys." 
        />

        {loading ? (
          <div style={{ color: "var(--color-stone-text)", padding: "40px 0" }}>Loading user details...</div>
        ) : !me ? (
          <div style={{ color: "var(--color-stone-text)", padding: "40px 0" }}>Failed to retrieve session. Please sign in again.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            
            {/* Identity Card */}
            <PremiumCard level={1} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, fontWeight: 500, color: "var(--color-pure-white)" }}>
                    {me.displayName || me.userId}
                  </h3>
                  <p style={{ color: "var(--color-stone-text)", fontSize: "13px", margin: "4px 0 0 0" }}>
                    ID: <code>{me.userId}</code>
                  </p>
                </div>
                <span className={me.isAdmin ? "badge-gold" : "badge"} style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
                  {me.isAdmin ? "Administrator" : "Standard Workspace"}
                </span>
              </div>
              <div style={{ fontSize: "14px", borderTop: "1px solid rgba(226,227,233,0.04)", paddingTop: "14px", display: "grid", gap: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--color-stone-text)" }}>Email Address</span>
                  <span style={{ color: "var(--color-white-frost)" }}>{me.email}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--color-stone-text)" }}>Vault Created</span>
                  <span style={{ color: "var(--color-white-frost)" }}>{new Date(me.createdAt).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" })}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", borderTop: "1px solid rgba(226,227,233,0.04)", paddingTop: "14px" }}>
                <input
                  className="pill-input"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Display name"
                  style={{ flex: "1 1 240px" }}
                />
                <PremiumButton variant="ghost" onClick={saveDisplayName}>
                  Save Display Name
                </PremiumButton>
              </div>
            </PremiumCard>

            {/* API Key Panel */}
            <PremiumCard level={2} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <h3 className="serif-display" style={{ fontSize: "20px", margin: 0, fontWeight: 500 }}>
                Model Context Protocol API Key
              </h3>
              <p style={{ color: "var(--color-stone-text)", fontSize: "13px", marginTop: "6px", lineHeight: 1.5 }}>
                Use this API key to configure local desktop clients (e.g. Claude Desktop, Cursor) to connect to your BrainRouter memory core. Keep this credential extremely secure.
              </p>

              <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
                {cachedApiKey ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center", background: "rgba(0,0,0,0.2)", padding: "12px 16px", borderRadius: "var(--radius-md)", border: "1px solid rgba(226,227,233,0.06)" }}>
                      <code style={{ flex: 1, wordBreak: "break-all", color: "var(--color-pure-white)", fontSize: "14px", letterSpacing: "0.03em" }}>
                        {reveal ? cachedApiKey : maskKey(cachedApiKey)}
                      </code>
                    </div>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      <PremiumButton 
                        variant="ghost" 
                        style={{ padding: "8px 18px", fontSize: "13px" }}
                        onClick={() => setReveal((v) => !v)}
                      >
                        {reveal ? "Hide Secret" : "Reveal Key"}
                      </PremiumButton>
                      <PremiumButton 
                        variant="ghost" 
                        style={{ padding: "8px 18px", fontSize: "13px" }}
                        onClick={copyKey}
                      >
                        Copy to Clipboard
                      </PremiumButton>
                      <PremiumButton 
                        variant="primary" 
                        style={{ padding: "8px 18px", fontSize: "13px" }}
                        onClick={() => setConfirmRotate(true)}
                      >
                        Rotate API Key
                      </PremiumButton>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "14px", alignItems: "flex-start" }}>
                    <p style={{ margin: 0, color: "var(--color-stone-text)", fontSize: "14px" }}>
                      No active API key is currently saved. Generate one to authenticate local instances.
                    </p>
                    <PremiumButton 
                      variant="primary" 
                      style={{ padding: "10px 22px", fontSize: "13px", fontWeight: 600 }}
                      onClick={() => setConfirmRotate(true)}
                    >
                      Generate API Key
                    </PremiumButton>
                  </div>
                )}

                {msg && (
                  <motion.p 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    style={{ color: "var(--color-golden-accent)", margin: 0, fontSize: "13px", fontWeight: 500 }}
                  >
                    {msg}
                  </motion.p>
                )}
              </div>
            </PremiumCard>

            {/* Model Context Protocol Client Integration Guide */}
            {cachedApiKey && (
              <PremiumCard level={3} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
                  <h3 className="serif-display" style={{ fontSize: "20px", margin: 0, fontWeight: 500, color: "var(--color-pure-white)" }}>
                    💡 Client Integration Config Generator
                  </h3>
                  
                  {/* Dynamic Tab Switchers */}
                  <div style={{ display: "flex", background: "rgba(0,0,0,0.25)", border: "1px solid rgba(226,227,233,0.06)", borderRadius: "var(--radius-pill)", padding: "2px" }}>
                    <button
                      onClick={() => setActiveTab("http")}
                      style={{
                        padding: "6px 14px",
                        fontSize: "12px",
                        fontWeight: 600,
                        borderRadius: "var(--radius-pill)",
                        cursor: "pointer",
                        border: "none",
                        outline: "none",
                        transition: "all 0.2s ease",
                        background: activeTab === "http" ? "rgba(174, 147, 87, 0.2)" : "transparent",
                        color: activeTab === "http" ? "var(--color-golden-accent)" : "var(--color-stone-text)"
                      }}
                    >
                      HTTP / SSE (Daemon)
                    </button>
                    <button
                      onClick={() => setActiveTab("stdio")}
                      style={{
                        padding: "6px 14px",
                        fontSize: "12px",
                        fontWeight: 600,
                        borderRadius: "var(--radius-pill)",
                        cursor: "pointer",
                        border: "none",
                        outline: "none",
                        transition: "all 0.2s ease",
                        background: activeTab === "stdio" ? "rgba(174, 147, 87, 0.2)" : "transparent",
                        color: activeTab === "stdio" ? "var(--color-golden-accent)" : "var(--color-stone-text)"
                      }}
                    >
                      Stdio (Local Process)
                    </button>
                  </div>
                </div>

                <p style={{ color: "var(--color-stone-text)", fontSize: "13px", margin: 0, lineHeight: 1.5 }}>
                  {activeTab === "http" ? (
                    <>
                      Exposes the BrainRouter MCP server over a high-performance HTTP/SSE daemon (<b>recommended</b>). Keep the daemon running in the background and connect cleanly from any environment without local node processes.
                    </>
                  ) : (
                    <>
                      Spawns the MCP server as a local node process managed by the desktop client. Resolves paths dynamically on your local filesystem.
                    </>
                  )}
                </p>

                {/* Pre-formatted configuration block */}
                <div style={{ position: "relative" }}>
                  <pre style={{
                    margin: 0,
                    padding: "16px 16px 40px 16px",
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid rgba(226, 227, 233, 0.08)",
                    borderRadius: "var(--radius-md)",
                    overflowX: "auto",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: "13px",
                    color: "var(--color-porcelain-text)",
                    lineHeight: 1.6
                  }}>
                    {highlightJson(
                      activeTab === "http" 
                        ? JSON.stringify({
                            mcpServers: {
                              brainrouter: {
                                type: "sse",
                                url: `${BASE_URL}/mcp`,
                                serverURL: `${BASE_URL}/mcp`,
                                headers: {
                                  Authorization: `Bearer ${reveal ? cachedApiKey : maskKey(cachedApiKey)}`
                                }
                              }
                            }
                          }, null, 2)
                        : JSON.stringify({
                            mcpServers: {
                              brainrouter: {
                                command: "node",
                                args: [me.mcpPath || "/path/to/BrainRouter/mcp/dist/index.js"],
                                env: {
                                  BRAINROUTER_API_KEY: reveal ? cachedApiKey : maskKey(cachedApiKey)
                                }
                              }
                            }
                          }, null, 2)
                    )}
                  </pre>
                  
                  {/* Floating Action Button for copying the entire JSON */}
                  <div style={{ position: "absolute", bottom: "12px", right: "12px" }}>
                    <PremiumButton
                      variant="ghost"
                      style={{ padding: "4px 10px", fontSize: "11px", height: "26px" }}
                      onClick={async () => {
                        const configJson = activeTab === "http"
                          ? JSON.stringify({
                              mcpServers: {
                                brainrouter: {
                                  type: "sse",
                                  url: `${BASE_URL}/mcp`,
                                  serverURL: `${BASE_URL}/mcp`,
                                  headers: {
                                    Authorization: `Bearer ${cachedApiKey}`
                                  }
                                }
                              }
                            }, null, 2)
                          : JSON.stringify({
                              mcpServers: {
                                brainrouter: {
                                  command: "node",
                                  args: [me.mcpPath || "/path/to/BrainRouter/mcp/dist/index.js"],
                                  env: {
                                    BRAINROUTER_API_KEY: cachedApiKey
                                  }
                                }
                              }
                            }, null, 2);
                        await navigator.clipboard.writeText(configJson);
                        setMsg(`MCP Server ${activeTab === "http" ? "HTTP/SSE" : "Stdio"} configuration copied successfully!`);
                      }}
                    >
                      Copy Configuration JSON
                    </PremiumButton>
                  </div>
                </div>
                
                {/* Filepath helper tip */}
                <div style={{ fontSize: "12px", display: "flex", gap: "6px", alignItems: "center", color: "var(--color-ash-text)", marginTop: "4px" }}>
                  <span style={{ color: "var(--color-golden-accent)", fontWeight: 600 }}>Tip:</span>
                  <span>Claude Desktop Config location: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></span>
                </div>
              </PremiumCard>
            )}

            {/* Logout Panel */}
            <div style={{ marginTop: "12px", borderTop: "1px solid rgba(226,227,233,0.05)", paddingTop: "24px" }}>
              <PremiumButton 
                variant="danger" 
                style={{ padding: "10px 24px", fontSize: "13px", fontWeight: 600 }}
                onClick={logout}
              >
                Sign Out from Console
              </PremiumButton>
            </div>

            <PremiumModal isOpen={confirmRotate} onClose={() => setConfirmRotate(false)} title="Rotate API Key">
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <p style={{ margin: 0, color: "var(--color-stone-text)", fontSize: "14px", lineHeight: 1.5 }}>
                  This will invalidate your current API key and replace it with a new key.
                </p>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                  <PremiumButton variant="ghost" onClick={() => setConfirmRotate(false)}>Cancel</PremiumButton>
                  <PremiumButton
                    variant="primary"
                    onClick={async () => {
                      setConfirmRotate(false);
                      await generateOrRotate();
                    }}
                  >
                    Rotate Key
                  </PremiumButton>
                </div>
              </div>
            </PremiumModal>

          </div>
        )}
      </motion.div>
    </AuthGuard>
  );
}
