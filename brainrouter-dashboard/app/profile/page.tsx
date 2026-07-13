"use client";

import { type KeyboardEvent, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { MeResponse } from "@kinqs/brainrouter-types";
import { getClient, BASE_URL } from "../../lib/client";
import { getApiKey, setApiKey } from "../../lib/client-auth";
import { useAuth } from "../../components/AuthProvider";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumModal } from "../../components/PremiumModal";

type ProfilePanel = "account" | "api" | "clients";
type ClientTransport = "http" | "stdio";

const PROFILE_PANELS: Array<{ id: ProfilePanel; label: string; description: string }> = [
  { id: "account", label: "Account", description: "Identity and session" },
  { id: "api", label: "API access", description: "Keys and authentication" },
  { id: "clients", label: "Client setup", description: "Desktop and MCP clients" },
];

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
    if (match.index > lastIndex) parts.push(json.substring(lastIndex, match.index));
    const value = match[0];
    if (/^"/.test(value)) {
      const isKey = /:$/.test(value);
      parts.push(<span key={`json-${keyCounter++}`} className={isKey ? "profile-json-key" : "profile-json-string"}>{isKey ? value.slice(0, -1) : value}</span>);
      if (isKey) parts.push(":");
    } else if (/true|false/.test(value)) {
      parts.push(<span key={`json-${keyCounter++}`} className="profile-json-boolean">{value}</span>);
    } else if (/null/.test(value)) {
      parts.push(<span key={`json-${keyCounter++}`} className="profile-json-null">{value}</span>);
    } else {
      parts.push(<span key={`json-${keyCounter++}`} className="profile-json-number">{value}</span>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < json.length) parts.push(json.substring(lastIndex));
  return parts;
}

function clientConfig(transport: ClientTransport, apiKey: string, mcpPath?: string) {
  return transport === "http"
    ? {
        mcpServers: {
          brainrouter: {
            type: "sse",
            url: `${BASE_URL}/mcp`,
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        },
      }
    : {
        mcpServers: {
          brainrouter: {
            command: "node",
            args: [mcpPath || "/path/to/BrainRouter/brainrouter/dist/index.js"],
            env: { BRAINROUTER_API_KEY: apiKey },
          },
        },
      };
}

export default function ProfilePage() {
  const { logout } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [cachedApiKey, setCachedApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState<ProfilePanel>("account");
  const [transport, setTransport] = useState<ClientTransport>("http");
  const [displayName, setDisplayName] = useState("");
  const [confirmRotate, setConfirmRotate] = useState(false);

  useEffect(() => {
    async function load() {
      setCachedApiKey(getApiKey());
      try {
        const data = await getClient().me();
        setMe(data);
        setDisplayName(data.displayName || "");
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  async function generateOrRotate() {
    try {
      const data = await getClient().rotateApiKey();
      setApiKey(data.apiKey);
      setCachedApiKey(data.apiKey);
      setMe((previous) => previous ? { ...previous, apiKey: data.apiKey } : previous);
      setReveal(true);
      setMessage(cachedApiKey ? "The old API key was revoked and replaced." : "A new API key is ready.");
    } catch (error) {
      console.error(error);
      setMessage("We could not update the API key. Try again.");
    }
  }

  async function saveDisplayName() {
    if (!displayName.trim()) return;
    await getClient().updateMe({ displayName: displayName.trim() });
    setMe((previous) => previous ? { ...previous, displayName: displayName.trim() } : previous);
    setMessage("Display name updated.");
  }

  async function copyKey() {
    if (!cachedApiKey) return;
    await navigator.clipboard.writeText(cachedApiKey);
    setApiKey(cachedApiKey);
    setMessage("API key copied and saved for local MCP sessions.");
  }

  async function copyConfiguration() {
    if (!me || !cachedApiKey) return;
    await navigator.clipboard.writeText(JSON.stringify(clientConfig(transport, cachedApiKey, me.mcpPath), null, 2));
    setMessage("Client configuration copied.");
  }

  function selectPanel(next: ProfilePanel) {
    setPanel(next);
    setMessage("");
  }

  function movePanel(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % PROFILE_PANELS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + PROFILE_PANELS.length) % PROFILE_PANELS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = PROFILE_PANELS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = PROFILE_PANELS[nextIndex];
    selectPanel(next.id);
    requestAnimationFrame(() => document.getElementById(`profile-tab-${next.id}`)?.focus());
  }

  return (
    <AuthGuard>
      <motion.div className="settings-page profile-settings" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <PageHeader title="Settings" description="Personal account, API access, and client setup—one focused section at a time." />

        <div className="settings-section-tabs" role="tablist" aria-label="Profile settings sections">
          {PROFILE_PANELS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`profile-tab-${item.id}`}
              aria-controls={`profile-panel-${item.id}`}
              aria-selected={panel === item.id}
              tabIndex={panel === item.id ? 0 : -1}
              className={`settings-section-tab${panel === item.id ? " active" : ""}`}
              onKeyDown={(event) => movePanel(event, index)}
              onClick={() => selectPanel(item.id)}
            >
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>

        {message && <div className="settings-note profile-message" role="status">{message}</div>}

        <div key={panel} id={`profile-panel-${panel}`} role="tabpanel" aria-labelledby={`profile-tab-${panel}`} className="settings-panel-stage">
          {loading ? (
            <div className="settings-panel-loading">Loading user details…</div>
          ) : !me ? (
            <div className="settings-panel-loading">We could not retrieve this session. Sign in again.</div>
          ) : (
            <>
            {panel === "account" && (
              <PremiumCard level={1} className="profile-panel-card">
                <div className="settings-cardhead profile-cardhead">
                  <div>
                    <span className="settings-eyebrow">Account</span>
                    <h2>{me.displayName || me.userId}</h2>
                    <div className="settings-hint">User ID <code>{me.userId}</code></div>
                  </div>
                  <span className="settings-badge settings-badge--muted">{me.isAdmin ? "Administrator" : "Member"}</span>
                </div>

                <dl className="profile-facts">
                  <div><dt>Email</dt><dd>{me.email}</dd></div>
                  <div><dt>Workspace created</dt><dd>{new Date(me.createdAt).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" })}</dd></div>
                </dl>

                <div className="profile-edit-row">
                  <label className="settings-label" htmlFor="display-name">Display name</label>
                  <div>
                    <input id="display-name" className="settings-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Display name" />
                    <PremiumButton variant="ghost" onClick={saveDisplayName}>Save</PremiumButton>
                  </div>
                </div>

                <div className="profile-danger-row">
                  <div><strong>Current session</strong><span>Sign out of this browser and clear the active dashboard session.</span></div>
                  <PremiumButton variant="danger" onClick={logout}>Sign out</PremiumButton>
                </div>
              </PremiumCard>
            )}

            {panel === "api" && (
              <PremiumCard level={2} className="profile-panel-card">
                <div className="settings-cardhead profile-cardhead">
                  <div>
                    <span className="settings-eyebrow">API access</span>
                    <h2>BrainRouter API key</h2>
                    <div className="settings-hint">Authenticate local desktop clients, tools, and MCP sessions. Store this key as a secret.</div>
                  </div>
                </div>

                {cachedApiKey ? (
                  <div className="profile-key-block">
                    <code>{reveal ? cachedApiKey : maskKey(cachedApiKey)}</code>
                    <div className="profile-key-actions">
                      <PremiumButton variant="ghost" onClick={() => setReveal((value) => !value)}>{reveal ? "Hide key" : "Reveal key"}</PremiumButton>
                      <PremiumButton variant="ghost" onClick={copyKey}>Copy</PremiumButton>
                      <PremiumButton variant="primary" onClick={() => setConfirmRotate(true)}>Rotate key</PremiumButton>
                    </div>
                  </div>
                ) : (
                  <div className="profile-empty-panel">
                    <div><strong>No API key saved</strong><span>Generate a key before connecting local tools or desktop clients.</span></div>
                    <PremiumButton variant="primary" onClick={() => setConfirmRotate(true)}>Generate key</PremiumButton>
                  </div>
                )}
              </PremiumCard>
            )}

            {panel === "clients" && (
              cachedApiKey ? (
                <PremiumCard level={3} className="profile-panel-card">
                  <div className="settings-cardhead profile-cardhead">
                    <div>
                      <span className="settings-eyebrow">Client setup</span>
                      <h2>Configuration generator</h2>
                      <div className="settings-hint">Choose one transport. The preview stays masked until you reveal the key in API access.</div>
                    </div>
                    <div className="settings-inline-tabs" role="group" aria-label="MCP transport">
                      <button type="button" aria-pressed={transport === "http"} className={transport === "http" ? "active" : ""} onClick={() => setTransport("http")}>HTTP / SSE</button>
                      <button type="button" aria-pressed={transport === "stdio"} className={transport === "stdio" ? "active" : ""} onClick={() => setTransport("stdio")}>Stdio</button>
                    </div>
                  </div>

                  <p className="profile-transport-copy">
                    {transport === "http"
                      ? "Connect to the running BrainRouter daemon from any supported client. This is the recommended setup."
                      : "Let the client spawn a local BrainRouter process from this machine."}
                  </p>
                  <div className="profile-code-block">
                    <pre>{highlightJson(JSON.stringify(clientConfig(transport, reveal ? cachedApiKey : maskKey(cachedApiKey), me.mcpPath), null, 2))}</pre>
                    <PremiumButton variant="ghost" size="small" onClick={copyConfiguration}>Copy JSON</PremiumButton>
                  </div>
                  <div className="settings-hint">Claude Desktop config: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></div>
                </PremiumCard>
              ) : (
                <PremiumCard level={2} className="profile-panel-card profile-empty-panel">
                  <div><strong>Create an API key first</strong><span>Client configuration requires an API key from the API access section.</span></div>
                  <PremiumButton variant="primary" onClick={() => selectPanel("api")}>Open API access</PremiumButton>
                </PremiumCard>
              )
            )}
            </>
          )}
        </div>

        <PremiumModal isOpen={confirmRotate} onClose={() => setConfirmRotate(false)} title={cachedApiKey ? "Rotate API key" : "Generate API key"}>
          <div className="profile-confirm">
            <p>{cachedApiKey ? "This invalidates the current key and replaces it with a new one." : "This creates a new key for local tools and MCP clients."}</p>
            <div>
              <PremiumButton variant="ghost" onClick={() => setConfirmRotate(false)}>Cancel</PremiumButton>
              <PremiumButton variant="primary" onClick={async () => { setConfirmRotate(false); await generateOrRotate(); }}>
                {cachedApiKey ? "Rotate key" : "Generate key"}
              </PremiumButton>
            </div>
          </div>
        </PremiumModal>
      </motion.div>
    </AuthGuard>
  );
}
