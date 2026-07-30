"use client";

/**
 * ADR-010 P6 — Integrations admin. Configure the org's own GitHub App bot,
 * DB-backed + encrypted at rest. Admin-only (RBAC: triggers:manage). The App
 * private key + webhook secret are write-only. Uses the app's premium blocks.
 */
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "../../components/AuthProvider";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type IntegrationConfig, type IntegrationInput, type OrgSummary } from "../../lib/adminApi";
import { ConnectorOAuthAppsCard } from "./ConnectorOAuthAppsCard";
import { ConnectorRows } from "./ConnectorRows";
import { InlineLoading } from "../../components/LoadingSpinner";

interface FormState {
  appId: string;
  appSlug: string;
  installationId: string;
  apiBase: string;
  privateKey: string;
  webhookSecret: string;
  enabled: boolean;
}
const EMPTY: FormState = { appId: "", appSlug: "", installationId: "", apiBase: "", privateKey: "", webhookSecret: "", enabled: true };
const str = (v: unknown): string => (typeof v === "string" ? v : "");
type IntegrationPanel = "connections" | "oauth" | "github";

const ALL_PANELS: Array<{ id: IntegrationPanel; label: string; description: string }> = [
  { id: "connections", label: "Connections", description: "Sources and repositories" },
  { id: "oauth", label: "OAuth apps", description: "Shared provider credentials" },
  { id: "github", label: "GitHub App", description: "Bot identity and webhooks" },
];

function IntegrationsInner() {
  // Per-section RBAC (ADR-017 D6): the deployment-level GitHub App credentials are
  // global-admin-only; everyone else connects + links repos through the shared App.
  const { user } = useAuth();
  const [items, setItems] = useState<IntegrationConfig[]>([]);
  const [secretReady, setSecretReady] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pemFileName, setPemFileName] = useState("");
  const [panel, setPanel] = useState<IntegrationPanel>("connections");
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrg, setActiveOrg] = useState("");
  const [orgsLoaded, setOrgsLoaded] = useState(false);

  useEffect(() => {
    setOrgsLoaded(false);
    const query = new URLSearchParams(window.location.search);
    const requestedPanel = query.get("panel");
    if (ALL_PANELS.some((candidate) => candidate.id === requestedPanel)) setPanel(requestedPanel as IntegrationPanel);
    const requestedOrg = query.get("orgId") ?? "";
    const orgRequest = user?.isAdmin
      ? Promise.all([adminApi.listOrgs(), adminApi.listAllOrgs()]).then(([memberships, all]) => {
        const membershipById = new Map((memberships.orgs ?? []).map((org) => [org.orgId, org]));
        return all.orgs.map((org) => membershipById.get(org.orgId) ?? {
          orgId: org.orgId,
          name: org.name,
          slug: org.slug,
          plan: org.plan,
          role: "system-admin",
          capabilities: ["triggers:manage"],
          isDefault: false,
        });
      })
      : adminApi.listOrgs().then(({ orgs: memberships = [] }) => memberships);
    void orgRequest.then((nextOrgs) => {
      setOrgs(nextOrgs);
      const selected = nextOrgs.find((org) => org.orgId === requestedOrg)
        ?? nextOrgs.find((org) => org.isDefault)
        ?? nextOrgs[0];
      setActiveOrg(selected?.orgId ?? "");
    }).catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load organizations"))
      .finally(() => setOrgsLoaded(true));
  }, [user?.isAdmin]);

  const activeMembership = orgs.find((org) => org.orgId === activeOrg);
  const canManageShared = Boolean(user?.isAdmin || activeMembership?.capabilities.includes("triggers:manage"));
  const panels = useMemo(() => canManageShared ? ALL_PANELS : ALL_PANELS.filter((item) => item.id === "connections"), [canManageShared]);

  useEffect(() => {
    if (orgsLoaded && !panels.some((item) => item.id === panel)) {
      setPanel("connections");
      const url = new URL(window.location.href);
      url.searchParams.set("panel", "connections");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [orgsLoaded, panel, panels]);

  // Read the downloaded .pem entirely in the browser and drop it into the field —
  // the key goes file → browser → (on save) encrypted storage, never elsewhere.
  function onPickPem(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setForm((f) => ({ ...f, privateKey: String(reader.result ?? "") })); setPemFileName(file.name); };
    reader.readAsText(file);
    e.target.value = "";
  }

  const load = useCallback(async () => {
    if (!orgsLoaded) return;
    if (!canManageShared) {
      setItems([]);
      setSecretReady(true);
      setError("");
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await adminApi.listIntegrations(activeOrg || undefined);
      setItems(res.integrations ?? []);
      setSecretReady(res.secretStorageReady);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, [activeOrg, canManageShared, orgsLoaded]);

  useEffect(() => { void load(); }, [load]);

  function replaceSelection(nextPanel: IntegrationPanel, nextOrg = activeOrg) {
    const url = new URL(window.location.href);
    url.searchParams.set("panel", nextPanel);
    if (nextOrg) url.searchParams.set("orgId", nextOrg); else url.searchParams.delete("orgId");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function selectPanel(nextPanel: IntegrationPanel) {
    setPanel(nextPanel);
    replaceSelection(nextPanel);
  }

  function movePanel(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % panels.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + panels.length) % panels.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = panels.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = panels[nextIndex];
    selectPanel(next.id);
    requestAnimationFrame(() => document.getElementById(`integration-tab-${next.id}`)?.focus());
  }

  const repositoriesHref = useMemo(() => activeOrg
    ? `/integrations/github?org=${encodeURIComponent(activeOrg)}`
    : "/integrations/github", [activeOrg]);

  function resetForm() { setForm(EMPTY); setEditingId(null); setPemFileName(""); }

  function startEdit(it: IntegrationConfig) {
    setEditingId(it.id);
    setForm({ appId: str(it.config.appId), appSlug: str(it.config.appSlug), installationId: str(it.config.installationId), apiBase: str(it.config.apiBase), privateKey: "", webhookSecret: "", enabled: it.enabled });
    setError("");
    selectPanel("github");
    requestAnimationFrame(() => document.getElementById("github-app-form")?.focus());
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const config: Record<string, unknown> = { appId: form.appId.trim(), appSlug: form.appSlug.trim(), installationId: form.installationId.trim(), apiBase: form.apiBase.trim() };
      const secret: Record<string, string> = {};
      if (form.privateKey.trim()) secret.privateKey = form.privateKey;
      if (form.webhookSecret.trim()) secret.webhookSecret = form.webhookSecret;
      const body: IntegrationInput = { kind: "github_app", enabled: form.enabled, config, ...(Object.keys(secret).length ? { secret } : {}) };
      if (editingId) await adminApi.updateIntegration(editingId, body, activeOrg || undefined);
      else await adminApi.createIntegration(body, activeOrg || undefined);
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save integration");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-page">
      <PageHeader title="Integrations" description="Connect repositories and knowledge sources without stacking every credential form on one page." />

      <div className="integration-org-scope">
        <div><span>Active organization</span><p>Connections and provider registrations use this organization. The shared GitHub OAuth app remains deployment-wide.</p></div>
        <select className="settings-select" aria-label="Active organization" value={activeOrg} onChange={(event) => { const nextOrg = event.target.value; resetForm(); setActiveOrg(nextOrg); replaceSelection(panel, nextOrg); }}>
          {orgs.length === 0 && <option value="">Personal workspace</option>}
          {orgs.map((org) => <option key={org.orgId} value={org.orgId}>{org.name}</option>)}
        </select>
      </div>

      <div className="settings-section-tabs" role="tablist" aria-label="Integration settings sections">
        {panels.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`integration-tab-${item.id}`}
            aria-controls={`integration-panel-${item.id}`}
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

      {canManageShared && !secretReady && (
        <div className="settings-note settings-note--warn">
          <code>BRAINROUTER_SECRET_KEY</code> is not configured on the server — integration secrets cannot be stored until it is set.
        </div>
      )}
      {error && <div className="settings-note settings-note--error">{error}</div>}

      {panel === "connections" && (
        <div id="integration-panel-connections" role="tabpanel" aria-labelledby="integration-tab-connections" className="settings-panel-stage integration-panel-stage">
          {canManageShared && <PremiumCard level={2}>
            <div className="settings-cardhead">
              <div><h3>GitHub repositories</h3><div className="settings-hint">Link the repositories the shared GitHub App can access.</div></div>
              <Link href={repositoriesHref}><PremiumButton size="small" variant="ghost">Manage repositories →</PremiumButton></Link>
            </div>
          </PremiumCard>}
          <ConnectorRows orgId={activeOrg || undefined} />
        </div>
      )}

      {canManageShared && panel === "oauth" && (
        <div id="integration-panel-oauth" role="tabpanel" aria-labelledby="integration-tab-oauth" className="settings-panel-stage integration-panel-stage">
          <ConnectorOAuthAppsCard orgId={activeOrg || undefined} showGithub={Boolean(user?.isAdmin)} />
        </div>
      )}

      {canManageShared && panel === "github" && (
        <div id="integration-panel-github" role="tabpanel" aria-labelledby="integration-tab-github" className="settings-panel-stage integration-panel-stage">
          <PremiumCard level={2}>
          <div className="settings-cardhead">
            <div>
              <h3>GitHub App</h3>
              <div className="settings-hint">One bot identity per org for webhook verify + PR post-back.</div>
            </div>
            <span className="settings-badge settings-badge--muted">{items.length} configured</span>
          </div>
          {loading ? (
            <InlineLoading label="Loading…" />
          ) : items.length === 0 ? (
            <div className="settings-empty-inline">No GitHub App configured yet — add one below.</div>
          ) : (
            <div>
              {items.map((it) => (
                <div key={it.id} className="settings-item">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="settings-row__title truncate">App {str(it.config.appId) || "(no id)"}</span>
                      {!it.enabled && <span className="settings-badge settings-badge--muted">disabled</span>}
                      {it.hasSecret ? <span className="settings-flag-ok">secret set</span> : <span className="settings-flag-muted">no secret</span>}
                    </div>
                    <div className="settings-row__sub truncate">installation {str(it.config.installationId) || "—"} · {str(it.config.apiBase) || "api.github.com"}</div>
                  </div>
                  <div className="settings-actions">
                    <PremiumButton size="small" variant="text" onClick={() => startEdit(it)}>Edit</PremiumButton>
                    <PremiumButton size="small" variant="danger" onClick={async () => { if (confirm("Delete this GitHub App integration?")) { await adminApi.deleteIntegration(it.id, activeOrg || undefined); await load(); } }}>Delete</PremiumButton>
                  </div>
                </div>
              ))}
            </div>
          )}
          </PremiumCard>

          <PremiumCard level={2}>
        <form id="github-app-form" tabIndex={-1} onSubmit={save}>
          <div className="settings-cardhead">
            <h3>{editingId ? "Edit GitHub App" : "Add a GitHub App"}</h3>
            {editingId && <PremiumButton size="small" variant="text" onClick={resetForm}>Cancel</PremiumButton>}
          </div>
          <div className="settings-grid">
            <label className="settings-label">App ID
              <input className="settings-input" placeholder="123456" value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} />
            </label>
            <label className="settings-label">Installation ID <span className="settings-hint">(optional — auto-detected after you install)</span>
              <input className="settings-input" placeholder="auto-detected" value={form.installationId} onChange={(e) => setForm({ ...form, installationId: e.target.value })} />
            </label>
            <label className="settings-label settings-col-2">App slug <span className="settings-hint">(from the App URL — enables the Install / Configure repos links)</span>
              <input className="settings-input" placeholder="brainrouter-memory-your-org" value={form.appSlug} onChange={(e) => setForm({ ...form, appSlug: e.target.value })} />
            </label>
            <label className="settings-label settings-col-2">API base <span className="settings-hint">(optional — GitHub Enterprise)</span>
              <input className="settings-input" placeholder="https://api.github.com" value={form.apiBase} onChange={(e) => setForm({ ...form, apiBase: e.target.value })} />
            </label>
            <div className="settings-label settings-col-2">
              <span>Private key (PEM) <span className="settings-hint">— load the <code>.pem</code> you downloaded, or paste it; it never leaves your browser until you save</span></span>
              <div className="flex flex-wrap items-center gap-2" style={{ margin: "6px 0" }}>
                <input id="pem-file-input" type="file" accept=".pem,.key,application/x-pem-file,text/plain" style={{ display: "none" }} onChange={onPickPem} />
                <PremiumButton type="button" size="small" variant="ghost" onClick={() => document.getElementById("pem-file-input")?.click()}>Load .pem file…</PremiumButton>
                {pemFileName && <span className="settings-flag-ok">Loaded {pemFileName}</span>}
              </div>
              <textarea aria-label="Private key (PEM)" autoComplete="off" className="settings-textarea" rows={3} placeholder={editingId ? "leave blank to keep the stored key" : "-----BEGIN RSA PRIVATE KEY-----"} value={form.privateKey} onChange={(e) => setForm({ ...form, privateKey: e.target.value })} />
            </div>
            <label className="settings-label settings-col-2">Webhook secret
              <input type="password" autoComplete="off" className="settings-input" placeholder={editingId ? "leave blank to keep the stored secret" : "whsec_…"} value={form.webhookSecret} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} />
            </label>
          </div>
          <div className="settings-checks">
            <label className="settings-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
          </div>
          <div style={{ marginTop: "var(--spacing-16)" }}>
            <PremiumButton type="submit" variant="primary" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Add GitHub App"}</PremiumButton>
          </div>
        </form>
          </PremiumCard>
        </div>
      )}
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <AuthGuard>
      <IntegrationsInner />
    </AuthGuard>
  );
}
