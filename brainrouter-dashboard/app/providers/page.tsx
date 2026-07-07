"use client";

/**
 * ADR-010 P4 — AI provider admin. Configure the backend's LLM / embeddings /
 * reranker / judge providers (DB-backed, encrypted at rest) — the same setup as
 * desktop/CLI. Admin-only (RBAC: providers:manage). Keys are write-only.
 * Uses the app's premium building blocks (PageHeader / PremiumCard / PremiumButton).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type ProviderConfig, type ProviderInput, type ProviderKind } from "../../lib/adminApi";

const KINDS: { kind: ProviderKind; label: string; hint: string }[] = [
  { kind: "llm", label: "LLM", hint: "Extraction, synthesis, judging" },
  { kind: "embedding", label: "Embeddings", hint: "Vector recall" },
  { kind: "reranker", label: "Reranker", hint: "Cross-encoder rescoring" },
  { kind: "judge", label: "Relevance Judge", hint: "LLM relevance filter (opt-in)" },
];

const EMPTY: ProviderInput = { kind: "llm", providerId: "", label: "", baseUrl: "", apiKey: "", model: "", models: [], wireFormat: "", reasoningEffort: "", isDefault: true, enabled: true };
const REASONING = ["", "low", "medium", "high", "xhigh"];

function ProvidersInner() {
  const router = useRouter();
  const { user } = useAuth();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [secretReady, setSecretReady] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ProviderInput>(EMPTY);
  const [modelsText, setModelsText] = useState("");
  const [extraText, setExtraText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.listProviders();
      setProviders(res.providers ?? []);
      setSecretReady(res.secretStorageReady);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (user && !user.isAdmin) router.replace("/overview"); }, [router, user]);

  function resetForm() { setForm(EMPTY); setModelsText(""); setExtraText(""); setEditingId(null); }

  function startEdit(p: ProviderConfig) {
    setEditingId(p.id);
    setForm({ kind: p.kind, providerId: p.providerId, label: p.label, baseUrl: p.baseUrl, apiKey: "", model: p.model, wireFormat: p.wireFormat, reasoningEffort: p.reasoningEffort, enabled: p.enabled, isDefault: p.isDefault });
    setModelsText((p.models ?? []).join(", "));
    setExtraText("");
    setError("");
    if (typeof window !== "undefined") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const models = modelsText.split(",").map((s) => s.trim()).filter(Boolean);
      let extra: Record<string, unknown> | undefined;
      if (extraText.trim()) {
        try { extra = JSON.parse(extraText) as Record<string, unknown>; }
        catch { throw new Error("Advanced (extra) must be valid JSON"); }
      }
      const body: ProviderInput = { ...form, models, ...(extra ? { extra } : {}) };
      if (editingId) {
        if (!body.apiKey) delete body.apiKey; // blank key on edit = keep the stored one
        await adminApi.updateProvider(editingId, body);
      } else {
        await adminApi.createProvider(body);
      }
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-page">
      <PageHeader title="AI Providers" description="Configure the backend's LLM, embeddings, reranker and judge providers — stored encrypted in the database, no .env. Admins only." />

      {!secretReady && (
        <div className="settings-note settings-note--warn">
          <code>BRAINROUTER_SECRET_KEY</code> is not configured on the server — provider API keys cannot be stored until it is set.
        </div>
      )}
      {error && <div className="settings-note settings-note--error">{error}</div>}

      <div className="settings-stack">
        {KINDS.map(({ kind, label, hint }) => {
          const rows = providers.filter((p) => p.kind === kind);
          return (
            <PremiumCard key={kind} level={2}>
              <div className="settings-cardhead">
                <div>
                  <h3>{label}</h3>
                  <div className="settings-hint">{hint}</div>
                </div>
                <span className="settings-badge settings-badge--muted">{rows.length} configured</span>
              </div>
              {loading ? (
                <div className="settings-empty-inline">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="settings-empty-inline">No {label} provider yet — add one below.</div>
              ) : (
                <div>
                  {rows.map((p) => (
                    <div key={p.id} className="settings-item">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="settings-row__title truncate">{p.label || p.providerId || p.model || p.id}</span>
                          {p.isDefault && <span className="settings-badge settings-badge--default">default</span>}
                          {!p.enabled && <span className="settings-badge settings-badge--muted">disabled</span>}
                          {p.hasKey ? <span className="settings-flag-ok">key set</span> : <span className="settings-flag-muted">no key</span>}
                        </div>
                        <div className="settings-row__sub truncate">{p.baseUrl || "—"} · {p.model || "—"}</div>
                      </div>
                      <div className="settings-actions">
                        {!p.isDefault && <PremiumButton size="small" variant="ghost" onClick={async () => { await adminApi.setDefaultProvider(p.id); await load(); }}>Set default</PremiumButton>}
                        <PremiumButton size="small" variant="text" onClick={() => startEdit(p)}>Edit</PremiumButton>
                        <PremiumButton size="small" variant="danger" onClick={async () => { if (confirm(`Delete this ${label} provider?`)) { await adminApi.deleteProvider(p.id); await load(); } }}>Delete</PremiumButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </PremiumCard>
          );
        })}
      </div>

      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
        <form onSubmit={save}>
          <div className="settings-cardhead">
            <h3>{editingId ? "Edit provider" : "Add a provider"}</h3>
            {editingId && <PremiumButton size="small" variant="text" onClick={resetForm}>Cancel</PremiumButton>}
          </div>
          <div className="settings-grid">
            <label className="settings-label">Kind
              <select className="settings-select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ProviderKind })}>
                {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
              </select>
            </label>
            <label className="settings-label">Provider id
              <input className="settings-input" placeholder="openai" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} />
            </label>
            <label className="settings-label">Base URL <span className="settings-hint">(the /v1 base — the wire format picks the path)</span>
              <input className="settings-input" placeholder="https://api.openai.com/v1" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            </label>
            <label className="settings-label">API key
              <input type="password" autoComplete="off" className="settings-input" placeholder={editingId ? "leave blank to keep current key" : "sk-…"} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
            </label>
            <label className="settings-label">Model
              <input className="settings-input" placeholder="gpt-4o-mini" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </label>
            <label className="settings-label">Label
              <input className="settings-input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </label>
            <label className="settings-label settings-col-2">Models <span className="settings-hint">(comma-separated; the models this key unlocks)</span>
              <input className="settings-input" placeholder="gpt-4o-mini, gpt-4o" value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
            </label>
            <label className="settings-label">Wire format <span className="settings-hint">(how to talk to the API)</span>
              <select className="settings-select" value={form.wireFormat} onChange={(e) => setForm({ ...form, wireFormat: e.target.value })}>
                <option value="">Auto (chat-completions)</option>
                <option value="chat-completions">chat-completions (/chat/completions)</option>
                <option value="responses">responses (/responses)</option>
              </select>
            </label>
            <label className="settings-label">Reasoning effort <span className="settings-hint">(optional)</span>
              <select className="settings-select" value={form.reasoningEffort} onChange={(e) => setForm({ ...form, reasoningEffort: e.target.value })}>
                {REASONING.map((r) => <option key={r} value={r}>{r || "—"}</option>)}
              </select>
            </label>
            <label className="settings-label settings-col-2">Advanced <span className="settings-hint">(optional JSON — provider-specific extra config)</span>
              <textarea className="settings-textarea" rows={2} placeholder='{"apiVersion":"2024-02-01"}' value={extraText} onChange={(e) => setExtraText(e.target.value)} />
            </label>
          </div>
          <div className="settings-checks">
            <label className="settings-check"><input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Default for its kind</label>
            <label className="settings-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
          </div>
          <div style={{ marginTop: "var(--spacing-16)" }}>
            <PremiumButton type="submit" variant="primary" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Add provider"}</PremiumButton>
          </div>
        </form>
      </PremiumCard>
    </div>
  );
}

export default function ProvidersPage() {
  return (
    <AuthGuard>
      <ProvidersInner />
    </AuthGuard>
  );
}
