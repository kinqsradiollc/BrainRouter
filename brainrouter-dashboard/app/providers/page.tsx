"use client";

/**
 * ADR-010 P4 — AI provider admin, modeled on the desktop/CLI Models settings.
 * Providers tab: a catalog gallery → a setup MODAL that pre-fills the endpoint,
 * fetches the models the key unlocks, and lets you tick an allowlist + mark ONE
 * ★ preferred (the default) — no manual model typing. Subagents tab: route the
 * brain's workers (extraction / synthesis / judge) to models on the LLM provider.
 * Admin-only (RBAC: providers:manage). Keys are write-only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type ProviderConfig, type ProviderKind } from "../../lib/adminApi";

// Judge is NOT a provider kind — it's a brain sub-agent (Subagents tab). The
// configurable provider kinds are the LLM + the two vector stages.
const KINDS: { kind: ProviderKind; label: string; hint: string }[] = [
  { kind: "llm", label: "LLM", hint: "Extraction, synthesis & judging" },
  { kind: "embedding", label: "Embeddings", hint: "Vector recall" },
  { kind: "reranker", label: "Reranker", hint: "Cross-encoder rescoring" },
];
const REASONING = ["", "low", "medium", "high", "xhigh"];

// Brain sub-agent roles (packages/core BRAIN_AGENT_ROLES) — the list arrives from
// the backend; these are the labels. Each picks a model on the LLM provider.
const ROLE_LABELS: Record<string, string> = { extraction: "Extraction", synthesis: "Synthesis", judge: "Relevance judge" };
const ROLE_DESC: Record<string, string> = {
  extraction: "Distills memories from each turn.",
  synthesis: "Identity distillation, digests & summaries.",
  judge: "Filters retrieved memories for real relevance.",
};
type AgentAssign = { provider?: string; model?: string };

interface CatalogEntry { id: string; label: string; endpoint: string; local: boolean; defaultModels?: string[] }
interface Draft {
  kind: ProviderKind; providerId: string; label: string; baseUrl: string; apiKey: string;
  model: string; apiVersion: string; wireFormat: string; reasoningEffort: string;
  isDefault: boolean; enabled: boolean;
}
const EMPTY_DRAFT: Draft = {
  kind: "llm", providerId: "", label: "", baseUrl: "", apiKey: "", model: "",
  apiVersion: "", wireFormat: "", reasoningEffort: "", isDefault: true, enabled: true,
};

const ICON_GRADIENTS = [["#34C28E", "#1E9C74"], ["#5B8DEF", "#3B6FD4"], ["#B57BEE", "#8A4FD8"], ["#E8925A", "#D46E38"], ["#4FB3C4", "#2E8FA0"], ["#E5675F", "#C7463E"]];
function providerGradient(id: string): string {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const [a, b] = ICON_GRADIENTS[h % ICON_GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}
const monogram = (s: string) => (s || "?").trim().slice(0, 2).toUpperCase();
const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "custom endpoint";

function ProvidersInner() {
  const router = useRouter();
  const { user } = useAuth();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [secretReady, setSecretReady] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"providers" | "subagents">("providers");
  const [galleryKind, setGalleryKind] = useState<ProviderKind>("llm");

  // Modal state.
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [probed, setProbed] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [saving, setSaving] = useState(false);

  // Subagents state.
  const [roles, setRoles] = useState<string[]>([]);
  const [assignments, setAssignments] = useState<Record<string, AgentAssign>>({});
  const [savingAgents, setSavingAgents] = useState(false);
  const [agentMsg, setAgentMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.listProviders();
      setProviders(res.providers ?? []);
      setSecretReady(res.secretStorageReady);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load providers"); }
    finally { setLoading(false); }
  }, []);

  const loadCatalog = useCallback(async (kind: string) => {
    try { const cat = await adminApi.providerCatalog(kind); setCatalog(cat.providers ?? []); } catch { /* optional */ }
  }, []);
  const loadAux = useCallback(async () => {
    try { const res = await adminApi.getAgentModels(); setRoles(res.roles ?? []); setAssignments(res.assignments ?? {}); } catch { /* optional */ }
  }, []);

  useEffect(() => { void load(); void loadAux(); }, [load, loadAux]);
  useEffect(() => { void loadCatalog(galleryKind); }, [galleryKind, loadCatalog]);
  useEffect(() => { if (user && !user.isAdmin) router.replace("/overview"); }, [router, user]);

  function openCatalog(c: CatalogEntry) {
    setEditingId(null);
    const custom = c.id === "openai-compatible";
    setDraft({ ...EMPTY_DRAFT, kind: galleryKind, providerId: custom ? "" : c.id, label: custom ? "" : c.label, baseUrl: custom ? "" : c.endpoint });
    // Seed known models for vendors whose endpoint has no live /models (rerank vendors),
    // so the picker is populated without a fetch. A successful Fetch replaces them.
    const seed = c.defaultModels ?? [];
    setProbed(seed); setSelected(seed); setModelFilter(""); setProbeError(""); setOpen(true);
  }
  function openCustom() {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT, kind: galleryKind });
    setProbed([]); setSelected([]); setModelFilter(""); setProbeError(""); setOpen(true);
  }
  function openEdit(p: ProviderConfig) {
    setEditingId(p.id);
    setDraft({
      kind: p.kind, providerId: p.providerId, label: p.label, baseUrl: p.baseUrl, apiKey: "",
      model: p.model, apiVersion: "", wireFormat: p.wireFormat ?? "", reasoningEffort: p.reasoningEffort ?? "",
      isDefault: p.isDefault, enabled: p.enabled,
    });
    const models = p.models ?? [];
    setProbed(models); setSelected(models); setModelFilter(""); setProbeError(""); setOpen(true);
  }
  function closeModal() { setOpen(false); setProbeError(""); }

  async function fetchModels() {
    if (!draft.baseUrl.trim()) { setProbeError("Enter a Base URL first."); return; }
    setProbing(true); setProbeError("");
    try {
      const res = await adminApi.probeModels(draft.baseUrl.trim(), draft.apiKey.trim(), draft.kind);
      if (!res.ok || !res.models?.length) {
        setProbeError(draft.kind === "llm"
          ? (res.error || "No models returned — check the key/endpoint.")
          : "This provider doesn't list models — pick a suggested one, or type the model name below.");
        return;
      }
      const ids = res.models.map((m) => m.id);
      setProbed(ids); setSelected(ids);
      if (!draft.model.trim() || !ids.includes(draft.model)) setDraft((d) => ({ ...d, model: ids[0] }));
    } catch (e) { setProbeError(e instanceof Error ? e.message : "Failed to fetch models"); }
    finally { setProbing(false); }
  }

  const filtered = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    return q ? probed.filter((m) => m.toLowerCase().includes(q)) : probed;
  }, [probed, modelFilter]);
  const allChecked = filtered.length > 0 && filtered.every((m) => selected.includes(m));
  const canSave = !!draft.label.trim() && !!draft.baseUrl.trim() && (selected.length > 0 || !!draft.model.trim());

  async function saveProvider() {
    setSaving(true);
    try {
      const models = probed.length > 0 && selected.length === probed.length ? [] : selected;
      const model = draft.model.trim() || selected[0] || "";

      // Guard: swapping to a DIFFERENT-dimension embedder rebuilds cognitive_vec and
      // drops every existing embedding (they must be re-embedded). Confirm first.
      if (draft.kind === "embedding" && model) {
        const dim = await adminApi.probeEmbeddingDim(draft.baseUrl.trim(), draft.apiKey.trim(), model);
        if (dim.ok && dim.dimensions && dim.currentDimensions > 0 && dim.dimensions !== dim.currentDimensions) {
          const ok = window.confirm(
            `This embedding model produces ${dim.dimensions}-dimensional vectors, but your memory store is ${dim.currentDimensions}-dimensional.\n\n` +
            `Saving will REBUILD the vector table and DROP all existing embeddings — every memory must be re-embedded before it's searchable again.\n\nContinue?`,
          );
          if (!ok) { setSaving(false); return; }
        }
      }
      const body: any = {
        kind: draft.kind, providerId: draft.providerId || undefined, label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(), model, models, wireFormat: draft.wireFormat || undefined,
        reasoningEffort: draft.reasoningEffort || undefined, isDefault: draft.isDefault, enabled: draft.enabled,
        ...(draft.apiVersion.trim() ? { extra: { apiVersion: draft.apiVersion.trim() } } : {}),
      };
      if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim();
      if (editingId) await adminApi.updateProvider(editingId, body);
      else await adminApi.createProvider(body);
      setOpen(false); await load();
    } catch (e) { setProbeError(e instanceof Error ? e.message : "Failed to save provider"); }
    finally { setSaving(false); }
  }

  async function removeProvider(id: string) {
    try { await adminApi.deleteProvider(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to delete provider"); }
  }
  async function makeDefault(id: string) {
    try { await adminApi.setDefaultProvider(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to set default"); }
  }

  async function saveAgentModels() {
    setSavingAgents(true); setAgentMsg("");
    try { const res = await adminApi.setAgentModels(assignments); setAssignments(res.assignments ?? {}); setAgentMsg("Saved."); }
    catch (e) { setAgentMsg(e instanceof Error ? e.message : "Failed to save"); }
    finally { setSavingAgents(false); }
  }

  const configuredIds = new Set(providers.map((p) => p.providerId));

  return (
    <div className="settings-page">
      <PageHeader title="AI Providers" description="Connect the providers the desktop/CLI supports, fetch the models each key unlocks, and route the brain's workers — stored encrypted in the database, no .env." />

      {!secretReady && <div className="settings-note settings-note--warn"><code>BRAINROUTER_SECRET_KEY</code> is not set on the server — provider keys cannot be stored until it is.</div>}
      {error && <div className="settings-note settings-note--error">{error}</div>}

      <div className="models-tabs" role="tablist">
        <button type="button" className={`models-tab ${tab === "providers" ? "models-tab--active" : ""}`} onClick={() => setTab("providers")}>Providers</button>
        <button type="button" className={`models-tab ${tab === "subagents" ? "models-tab--active" : ""}`} onClick={() => setTab("subagents")}>Subagents</button>
      </div>

      {tab === "providers" && (
        <>
          {/* Catalog gallery — pick a kind, then a provider; the dialog pre-fills the endpoint. */}
          <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
            <div className="settings-cardhead">
              <div><h3>Set up a provider</h3><div className="settings-hint">Pick a kind + a provider — the dialog pre-fills the endpoint, then enter your key to pull the models it unlocks.</div></div>
              <div className="models-tabs" role="tablist">
                {KINDS.map((k) => (
                  <button key={k.kind} type="button" className={`models-tab ${galleryKind === k.kind ? "models-tab--active" : ""}`} onClick={() => setGalleryKind(k.kind)}>{k.label}</button>
                ))}
              </div>
            </div>
            <div className="prov-gallery">
              {catalog.length === 0 ? <div className="settings-empty-inline">Loading the provider catalog…</div> : catalog.map((c) => {
                const done = configuredIds.has(c.id);
                return (
                  <button key={c.id} type="button" className="prov-card" onClick={() => openCatalog(c)} title={`Set up ${c.label}`}>
                    <span className="prov-icon" style={{ background: providerGradient(c.id) }} aria-hidden>{monogram(c.label)}</span>
                    <span className="prov-meta">
                      <span className="prov-name">{c.label}</span>
                      <span className="prov-host">{hostOf(c.endpoint)}</span>
                    </span>
                    <span className={`prov-status ${done ? "prov-status--ok" : ""}`}>{done ? "✓ Configured" : "Connect"}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: "var(--spacing-12)" }}>
              <PremiumButton variant="ghost" size="small" onClick={openCustom}>+ Add custom provider</PremiumButton>
            </div>
          </PremiumCard>

          {/* Your providers */}
          <div className="settings-stack">
            {KINDS.map(({ kind, label, hint }) => {
              const rows = providers.filter((p) => p.kind === kind);
              return (
                <PremiumCard key={kind} level={2}>
                  <div className="settings-cardhead">
                    <div><h3>{label}</h3><div className="settings-hint">{hint}</div></div>
                    <span className="settings-badge settings-badge--muted">{rows.length} configured</span>
                  </div>
                  {loading ? <div className="settings-empty-inline">Loading…</div>
                    : rows.length === 0 ? <div className="settings-empty-inline">No {label} provider yet — pick one above.</div>
                      : rows.map((p) => (
                        <div key={p.id} className="org-member">
                          <span className="prov-icon prov-icon--sm" style={{ background: providerGradient(p.providerId || p.label) }} aria-hidden>{monogram(p.label || p.providerId)}</span>
                          <div className="org-member__id" style={{ whiteSpace: "normal" }}>
                            <strong>{p.label || p.providerId}</strong>
                            {p.isDefault && <span className="settings-badge settings-badge--default" style={{ marginLeft: 6 }}>default</span>}
                            <div className="settings-hint">{p.model || "—"}{p.models?.length ? ` · ${p.models.length} models` : ""}</div>
                          </div>
                          <div className="settings-actions">
                            {!p.isDefault && <PremiumButton size="small" variant="ghost" onClick={() => makeDefault(p.id)}>Make default</PremiumButton>}
                            <PremiumButton size="small" variant="text" onClick={() => openEdit(p)}>Configure</PremiumButton>
                            <button className="org-iconbtn" title="Remove" aria-label={`Remove ${p.label}`} onClick={() => removeProvider(p.id)}>✕</button>
                          </div>
                        </div>
                      ))}
                </PremiumCard>
              );
            })}
          </div>
        </>
      )}

      {tab === "subagents" && (() => {
        const llmProvider = providers.find((p) => p.kind === "llm" && p.isDefault) ?? providers.find((p) => p.kind === "llm");
        const modelOpts = llmProvider ? Array.from(new Set([llmProvider.model, ...(llmProvider.models ?? [])].filter(Boolean))) : [];
        return (
          <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
            <div className="settings-cardhead"><div><h3>Brain worker models</h3><div className="settings-hint">Route the brain&apos;s cognitive workers to different models on your LLM provider — the same routing mechanism as the desktop/CLI agent.</div></div></div>
            {!llmProvider ? <div className="settings-empty-inline">Configure an LLM provider first (Providers tab).</div>
              : roles.length === 0 ? <div className="settings-empty-inline">Loading roles…</div>
                : roles.map((role) => {
                  const a = assignments[role] ?? {};
                  const set = (patch: AgentAssign) => setAssignments((m) => ({ ...m, [role]: { ...m[role], ...patch } }));
                  return (
                    <div key={role} className="org-member">
                      <div className="org-member__id" style={{ whiteSpace: "normal" }}><strong>{ROLE_LABELS[role] ?? role}</strong><div className="settings-hint">{ROLE_DESC[role] ?? ""}</div></div>
                      {modelOpts.length > 0 ? (
                        <select className="settings-select org-rolepick" style={{ minWidth: "13rem" }} value={a.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })} aria-label={`Model for ${role}`}>
                          <option value="">Default ({llmProvider.model || "provider default"})</option>
                          {modelOpts.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      ) : (
                        <input className="settings-input org-rolepick" style={{ width: "13rem" }} placeholder="model (optional)" value={a.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })} />
                      )}
                    </div>
                  );
                })}
            <div style={{ marginTop: "var(--spacing-16)", display: "flex", alignItems: "center", gap: "var(--spacing-12)" }}>
              <PremiumButton variant="primary" disabled={savingAgents || !llmProvider} onClick={saveAgentModels}>{savingAgents ? "Saving…" : "Save brain models"}</PremiumButton>
              {agentMsg && <span className="settings-hint">{agentMsg}</span>}
            </div>
          </PremiumCard>
        );
      })()}

      {open && typeof document !== "undefined" && createPortal((
        <div className="prov-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="prov-dialog" role="dialog" aria-modal>
            <div className="prov-dialog__head">
              <span className="prov-icon" style={{ background: providerGradient(draft.providerId || "openai-compatible") }} aria-hidden>{monogram(draft.label || draft.providerId || "?")}</span>
              <div>
                <h3 style={{ margin: 0 }}>{editingId ? `Configure ${draft.label}` : draft.providerId ? `Connect ${draft.label || draft.providerId}` : "Add a custom provider"}</h3>
                <div className="settings-hint">{editingId ? "Update its key, models, and routing." : "Enter your key, then fetch the models it unlocks."}</div>
              </div>
              <button className="org-iconbtn" onClick={closeModal} aria-label="Close" style={{ marginLeft: "auto" }}>✕</button>
            </div>

            <div className="prov-dialog__body">
              <label className="settings-label">Kind
                <select className="settings-select" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ProviderKind })} disabled={!!editingId}>
                  {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </label>
              <label className="settings-label">Display name
                <input className="settings-input" placeholder="e.g. OpenAI, my-groq" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              </label>
              <label className="settings-label">Base URL <span className="settings-hint">(the /v1 base)</span>
                <input className="settings-input" placeholder="https://api.openai.com/v1" value={draft.baseUrl} onChange={(e) => { setProbed([]); setSelected([]); setDraft({ ...draft, baseUrl: e.target.value }); }} />
              </label>
              <label className="settings-label">API key {editingId && <span className="settings-hint">(blank = keep current)</span>}
                <input className="settings-input" type="password" autoComplete="off" placeholder={editingId ? "leave blank to keep" : "sk-…"} value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
              </label>
              <label className="settings-label">API version <span className="settings-hint">(optional — Azure)</span>
                <input className="settings-input" placeholder="2024-02-01" value={draft.apiVersion} onChange={(e) => setDraft({ ...draft, apiVersion: e.target.value })} />
              </label>

              {/* Models — fetch + multi-select + ★ preferred (the default). */}
              <div className="settings-label" style={{ marginTop: "var(--spacing-8)" }}>
                <div className="flex items-center justify-between" style={{ marginBottom: "var(--spacing-4)" }}>
                  <span>Models <span className="settings-hint">— the models this key unlocks</span></span>
                  <button type="button" className="settings-action settings-action--accent" disabled={probing || !draft.baseUrl.trim()} onClick={fetchModels}>{probing ? "Fetching…" : probed.length ? "Re-fetch" : "Fetch models"}</button>
                </div>
                {probeError && <div className="settings-hint" style={{ color: "var(--danger)" }}>{probeError}</div>}
                {probed.length > 0 ? (
                  <>
                    <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
                      <input className="settings-input" style={{ marginTop: 0, flex: 1 }} placeholder={`Search ${probed.length} models…`} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} />
                      <label className="settings-check" style={{ fontSize: 12 }}>
                        <input type="checkbox" checked={allChecked} onChange={() => setSelected((cur) => allChecked ? cur.filter((m) => !filtered.includes(m)) : [...new Set([...cur, ...filtered])])} />
                        {allChecked ? "Deselect all" : "Select all"}
                      </label>
                    </div>
                    <div className="prov-modellist">
                      {filtered.length === 0 ? <div className="settings-hint" style={{ padding: 8 }}>No models match “{modelFilter}”.</div> : filtered.map((m) => {
                        const checked = selected.includes(m);
                        const isDefault = checked && m === draft.model;
                        return (
                          <div key={m} className={`prov-modelrow ${checked ? "prov-modelrow--sel" : ""}`}>
                            <label className="settings-check" style={{ flex: 1, minWidth: 0 }}>
                              <input type="checkbox" checked={checked} onChange={() => setSelected((cur) => cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m])} />
                              <span className="truncate">{m}</span>
                            </label>
                            {checked && (isDefault
                              ? <span className="settings-badge settings-badge--default">★ Preferred</span>
                              : <button type="button" className="settings-action settings-action--accent" onClick={() => setDraft((d) => ({ ...d, model: m }))}>Set preferred</button>)}
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <input className="settings-input" placeholder="preferred model (or Fetch above)" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
                )}
              </div>

              {/* Wire format + reasoning effort are chat-only — hidden for embedding/reranker,
                  whose request shape is fixed (POST /embeddings or /rerank). */}
              {draft.kind === "llm" && (
                <div className="settings-grid">
                  <label className="settings-label">Wire format
                    <select className="settings-select" value={draft.wireFormat} onChange={(e) => setDraft({ ...draft, wireFormat: e.target.value })}>
                      <option value="">Auto (chat-completions)</option>
                      <option value="chat-completions">chat-completions</option>
                      <option value="responses">responses</option>
                    </select>
                  </label>
                  <label className="settings-label">Reasoning effort
                    <select className="settings-select" value={draft.reasoningEffort} onChange={(e) => setDraft({ ...draft, reasoningEffort: e.target.value })}>
                      {REASONING.map((r) => <option key={r} value={r}>{r || "—"}</option>)}
                    </select>
                  </label>
                </div>
              )}
              <div className="settings-checks">
                <label className="settings-check"><input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} /> Default for its kind</label>
                <label className="settings-check"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Enabled</label>
              </div>
            </div>

            <div className="prov-dialog__foot">
              <PremiumButton variant="text" onClick={closeModal}>Cancel</PremiumButton>
              <PremiumButton variant="primary" disabled={!canSave || saving} onClick={saveProvider}>{saving ? "Saving…" : editingId ? "Save changes" : "Connect"}</PremiumButton>
            </div>
          </div>
        </div>
      ), document.body)}
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
