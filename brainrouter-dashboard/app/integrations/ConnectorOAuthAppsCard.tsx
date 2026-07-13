"use client";

/**
 * ADR-016 — per-source connector OAuth apps. As connectors move server-side (GitLab,
 * Slack, Google Drive, Gmail, Notion, Linear), each source needs ONE org-level OAuth app
 * (client_id + sealed client_secret) — exactly like the GitHub OAuth App — before any
 * signed-in user can "Connect" it. Global/org admin only; secrets are write-only.
 */
import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi } from "../../lib/adminApi";
import { GithubOAuthAppCard } from "./GithubOAuthAppCard";

interface AppStatus {
  source: string; configured: boolean; hasSecret: boolean;
  clientId: string; scopes: string; defaultScopes: string; usesPkce: boolean;
}

// Human labels + where to register the OAuth app for each source.
const SOURCE_META: Record<string, { name: string; where: string }> = {
  gitlab: { name: "GitLab", where: "GitLab → Preferences → Applications" },
  slack: { name: "Slack", where: "api.slack.com → Your Apps → OAuth & Permissions" },
  "google-drive": { name: "Google Drive", where: "Google Cloud Console → APIs & Services → Credentials" },
  gmail: { name: "Gmail", where: "Google Cloud Console → APIs & Services → Credentials" },
  notion: { name: "Notion", where: "notion.so/my-integrations (public OAuth integration)" },
  linear: { name: "Linear", where: "linear.app → Settings → API → OAuth applications" },
};

function SourceForm({ app, orgId, onSaved }: { app: AppStatus; orgId?: string; onSaved: () => void }): React.ReactElement {
  const [clientId, setClientId] = useState(app.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(app.scopes || app.defaultScopes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const meta = SOURCE_META[app.source] ?? { name: app.source, where: "the provider's developer settings" };
  // PKCE sources don't strictly need a client secret; classic ones do.
  const status = app.configured ? (app.hasSecret || app.usesPkce ? "ready" : "no secret") : "not set";

  const save = useCallback(async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setError(""); setSaved(false);
    try {
      await adminApi.setConnectorOAuthApp(app.source, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        scopes: scopes.trim() || undefined,
      }, orgId);
      setClientSecret(""); setSaved(true); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
    finally { setSaving(false); }
  }, [app.source, clientId, clientSecret, scopes, orgId, onSaved]);

  return (
    <form onSubmit={save} style={{ padding: "12px 0", borderTop: "1px solid var(--border-dim, rgba(255,255,255,0.06))" }}>
      <div className="settings-cardhead" style={{ marginBottom: 8 }}>
        <div><span className="settings-row__title">{meta.name}</span> <span className="settings-hint">— register at {meta.where}</span></div>
        <span className={status === "ready" ? "settings-flag-ok" : "settings-flag-muted"}>{status}</span>
      </div>
      <div className="settings-grid">
        <label className="settings-label">Client ID
          <input className="settings-input" placeholder="the OAuth app's client id" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label className="settings-label">Client secret {app.hasSecret && <span className="settings-hint">(stored — blank keeps it)</span>} {app.usesPkce && <span className="settings-hint">(optional — PKCE)</span>}
          <input className="settings-input" type="password" autoComplete="off" placeholder={app.hasSecret ? "•••••••• (kept)" : app.usesPkce ? "optional for this provider" : "the OAuth app's client secret"} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
        </label>
        <label className="settings-label settings-col-2">Scopes <span className="settings-hint">(space-separated; blank uses the defaults)</span>
          <input className="settings-input" placeholder={app.defaultScopes || "provider default scopes"} value={scopes} onChange={(e) => setScopes(e.target.value)} />
        </label>
        <div className="settings-label settings-col-2">
          <span className="settings-hint">Redirect / callback URL to register: <code>{`<your server>/api/connectors/${app.source}/oauth/callback`}</code></span>
        </div>
      </div>
      {error && <div className="settings-note settings-note--error" style={{ marginTop: 8 }}>{error}</div>}
      {saved && <div className="settings-note" style={{ marginTop: 8 }}>Saved — signed-in users can now Connect {meta.name}.</div>}
      <div style={{ marginTop: 12 }}>
        <PremiumButton type="submit" variant="primary" disabled={saving || !clientId.trim()}>{saving ? "Saving…" : "Save OAuth App"}</PremiumButton>
      </div>
    </form>
  );
}

export function ConnectorOAuthAppsCard({ orgId }: { orgId?: string }): React.ReactElement | null {
  const [apps, setApps] = useState<AppStatus[]>([]);
  const [activeSource, setActiveSource] = useState("github");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoaded(false);
    setError("");
    try {
      const r = await adminApi.getConnectorOAuthApps(orgId);
      const nextApps = (r.apps ?? []).filter((a) => a.source !== "github");
      setApps(nextApps);
      setActiveSource((current) => current === "github" || nextApps.some((app) => app.source === current) ? current : "github");
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoaded(true); }
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);

  const providers = ["github", ...apps.map((app) => app.source)];
  const moveProvider = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % providers.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + providers.length) % providers.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = providers.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = providers[nextIndex];
    setActiveSource(next);
    requestAnimationFrame(() => document.getElementById(`oauth-provider-tab-${next}`)?.focus());
  };

  if (!loaded && !error) return null;

  return (
    <PremiumCard level={2} style={{ marginTop: "var(--spacing-16)" }}>
      <div className="settings-cardhead">
        <div>
          <h3>Connector OAuth apps <span className="settings-hint">— shared sign-in for every connected source</span></h3>
          <div className="settings-hint">GitHub and every other provider live in one place. Credentials stay server-side; signed-in users only approve the account they want to connect.</div>
        </div>
      </div>
      {error && <div className="settings-note settings-note--error">{error}</div>}
      <div className="settings-provider-tabs" role="tablist" aria-label="OAuth provider">
        <button type="button" role="tab" id="oauth-provider-tab-github" aria-controls="oauth-provider-panel-github" aria-selected={activeSource === "github"} tabIndex={activeSource === "github" ? 0 : -1} className={activeSource === "github" ? "active" : ""} onKeyDown={(event) => moveProvider(event, 0)} onClick={() => setActiveSource("github")}>
          <span className="provider-status-dot" /> GitHub
        </button>
        {apps.map((app) => (
          <button
            key={app.source}
            type="button"
            role="tab"
            id={`oauth-provider-tab-${app.source}`}
            aria-controls={`oauth-provider-panel-${app.source}`}
            aria-selected={activeSource === app.source}
            tabIndex={activeSource === app.source ? 0 : -1}
            className={activeSource === app.source ? "active" : ""}
            onKeyDown={(event) => moveProvider(event, providers.indexOf(app.source))}
            onClick={() => setActiveSource(app.source)}
          >
            <span className={app.configured ? "provider-status-dot ready" : "provider-status-dot"} />
            {SOURCE_META[app.source]?.name ?? app.source}
          </button>
        ))}
      </div>
      <div id={`oauth-provider-panel-${activeSource}`} role="tabpanel" aria-labelledby={`oauth-provider-tab-${activeSource}`}>
        {activeSource === "github" && <GithubOAuthAppCard embedded />}
        {apps.filter((app) => app.source === activeSource).map((app) => <SourceForm key={`${orgId ?? "default"}-${app.source}`} app={app} orgId={orgId} onSaved={load} />)}
        {apps.length === 0 && activeSource !== "github" && (
          <div className="settings-empty-inline">No OAuth connector definitions were returned by the server.</div>
        )}
      </div>
    </PremiumCard>
  );
}
