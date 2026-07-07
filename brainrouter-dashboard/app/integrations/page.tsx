"use client";

/**
 * ADR-010 P6 — Integrations admin. Configure the org's own GitHub App bot,
 * DB-backed + encrypted at rest. Admin-only (RBAC: triggers:manage). The App
 * private key + webhook secret are write-only. Uses the app's premium blocks.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type IntegrationConfig, type IntegrationInput } from "../../lib/adminApi";

interface FormState {
  appId: string;
  installationId: string;
  apiBase: string;
  privateKey: string;
  webhookSecret: string;
  enabled: boolean;
}
const EMPTY: FormState = { appId: "", installationId: "", apiBase: "", privateKey: "", webhookSecret: "", enabled: true };
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function IntegrationsInner() {
  const router = useRouter();
  const { user } = useAuth();
  const [items, setItems] = useState<IntegrationConfig[]>([]);
  const [secretReady, setSecretReady] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.listIntegrations();
      setItems(res.integrations ?? []);
      setSecretReady(res.secretStorageReady);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (user && !user.isAdmin) router.replace("/overview"); }, [router, user]);

  function resetForm() { setForm(EMPTY); setEditingId(null); }

  function startEdit(it: IntegrationConfig) {
    setEditingId(it.id);
    setForm({ appId: str(it.config.appId), installationId: str(it.config.installationId), apiBase: str(it.config.apiBase), privateKey: "", webhookSecret: "", enabled: it.enabled });
    setError("");
    if (typeof window !== "undefined") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const config: Record<string, unknown> = { appId: form.appId.trim(), installationId: form.installationId.trim(), apiBase: form.apiBase.trim() };
      const secret: Record<string, string> = {};
      if (form.privateKey.trim()) secret.privateKey = form.privateKey;
      if (form.webhookSecret.trim()) secret.webhookSecret = form.webhookSecret;
      const body: IntegrationInput = { kind: "github_app", enabled: form.enabled, config, ...(Object.keys(secret).length ? { secret } : {}) };
      if (editingId) await adminApi.updateIntegration(editingId, body);
      else await adminApi.createIntegration(body);
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
      <PageHeader title="Integrations" description="Configure the org's GitHub App bot — the single identity that verifies incoming webhooks and posts back on @mention triggers. Secrets are stored encrypted and never shown again." />

      {!secretReady && (
        <div className="settings-note settings-note--warn">
          <code>BRAINROUTER_SECRET_KEY</code> is not configured on the server — integration secrets cannot be stored until it is set.
        </div>
      )}
      {error && <div className="settings-note settings-note--error">{error}</div>}

      <div className="settings-stack">
        <PremiumCard level={2}>
          <div className="settings-cardhead">
            <div>
              <h3>GitHub App</h3>
              <div className="settings-hint">One bot identity per org for webhook verify + PR post-back.</div>
            </div>
            <span className="settings-badge settings-badge--muted">{items.length} configured</span>
          </div>
          {loading ? (
            <div className="settings-empty-inline">Loading…</div>
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
                    <PremiumButton size="small" variant="danger" onClick={async () => { if (confirm("Delete this GitHub App integration?")) { await adminApi.deleteIntegration(it.id); await load(); } }}>Delete</PremiumButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </PremiumCard>
      </div>

      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
        <form onSubmit={save}>
          <div className="settings-cardhead">
            <h3>{editingId ? "Edit GitHub App" : "Add a GitHub App"}</h3>
            {editingId && <PremiumButton size="small" variant="text" onClick={resetForm}>Cancel</PremiumButton>}
          </div>
          <div className="settings-grid">
            <label className="settings-label">App ID
              <input className="settings-input" placeholder="123456" value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} />
            </label>
            <label className="settings-label">Installation ID <span className="settings-hint">(optional)</span>
              <input className="settings-input" placeholder="auto-resolved if blank" value={form.installationId} onChange={(e) => setForm({ ...form, installationId: e.target.value })} />
            </label>
            <label className="settings-label settings-col-2">API base <span className="settings-hint">(optional — GitHub Enterprise)</span>
              <input className="settings-input" placeholder="https://api.github.com" value={form.apiBase} onChange={(e) => setForm({ ...form, apiBase: e.target.value })} />
            </label>
            <label className="settings-label settings-col-2">Private key (PEM)
              <textarea autoComplete="off" className="settings-textarea" rows={3} placeholder={editingId ? "leave blank to keep the stored key" : "-----BEGIN RSA PRIVATE KEY-----"} value={form.privateKey} onChange={(e) => setForm({ ...form, privateKey: e.target.value })} />
            </label>
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
  );
}

export default function IntegrationsPage() {
  return (
    <AuthGuard>
      <IntegrationsInner />
    </AuthGuard>
  );
}
