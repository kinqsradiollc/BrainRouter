"use client";

/**
 * ADR-010 P4 — AI provider admin. Configure the backend's LLM / embeddings /
 * reranker / judge providers (DB-backed, encrypted at rest) — the same setup as
 * desktop/CLI. Admin-only (RBAC: providers:manage). Keys are write-only: the API
 * only ever tells us whether a key is set.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import { AuthGuard } from "../../components/AuthGuard";
import { adminApi, type ProviderConfig, type ProviderInput, type ProviderKind } from "../../lib/adminApi";

const KINDS: { kind: ProviderKind; label: string; hint: string }[] = [
  { kind: "llm", label: "LLM", hint: "Extraction, synthesis, judging" },
  { kind: "embedding", label: "Embeddings", hint: "Vector recall" },
  { kind: "reranker", label: "Reranker", hint: "Cross-encoder rescoring" },
  { kind: "judge", label: "Relevance Judge", hint: "LLM relevance filter (opt-in)" },
];

const EMPTY: ProviderInput = { kind: "llm", providerId: "", label: "", baseUrl: "", apiKey: "", model: "", models: [], isDefault: true, enabled: true };

function ProvidersInner() {
  const router = useRouter();
  const { user } = useAuth();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [secretReady, setSecretReady] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ProviderInput>(EMPTY);
  const [modelsText, setModelsText] = useState("");
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

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const models = modelsText.split(",").map((s) => s.trim()).filter(Boolean);
      await adminApi.createProvider({ ...form, models });
      setForm(EMPTY);
      setModelsText("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create provider");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white">AI Providers</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Configure the backend&apos;s LLM, embeddings, reranker and judge providers. Stored in the database
        (keys encrypted at rest) — no <code>.env</code>. Only admins can change these.
      </p>

      {!secretReady && (
        <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <code>BRAINROUTER_SECRET_KEY</code> is not configured on the server — provider API keys cannot be stored until it is set.
        </div>
      )}
      {error && <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      {KINDS.map(({ kind, label, hint }) => {
        const rows = providers.filter((p) => p.kind === kind);
        return (
          <section key={kind} className="mt-8">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-medium text-white">{label}</h2>
              <span className="text-xs text-neutral-500">{hint}</span>
            </div>
            <div className="mt-2 divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900/50">
              {loading ? (
                <div className="px-4 py-3 text-sm text-neutral-500">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="px-4 py-3 text-sm text-neutral-500">No {label} provider configured.</div>
              ) : rows.map((p) => (
                <div key={p.id} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-white">{p.label || p.providerId || p.model || p.id}</span>
                      {p.isDefault && <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">default</span>}
                      {!p.enabled && <span className="rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-300">disabled</span>}
                      {p.hasKey ? <span className="text-[10px] text-emerald-400">key set</span> : <span className="text-[10px] text-neutral-500">no key</span>}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-neutral-500">{p.baseUrl || "—"} · {p.model || "—"}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!p.isDefault && (
                      <button className="rounded px-2 py-1 text-xs text-indigo-300 hover:bg-neutral-800" onClick={async () => { await adminApi.setDefaultProvider(p.id); await load(); }}>Set default</button>
                    )}
                    <button className="rounded px-2 py-1 text-xs text-red-300 hover:bg-neutral-800" onClick={async () => { await adminApi.deleteProvider(p.id); await load(); }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      <form onSubmit={create} className="mt-10 rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h2 className="text-lg font-medium text-white">Add a provider</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="text-sm text-neutral-300">Kind
            <select className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-white" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ProviderKind })}>
              {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </label>
          <label className="text-sm text-neutral-300">Provider id
            <input className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-white" placeholder="openai" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} />
          </label>
          <label className="text-sm text-neutral-300">Base URL
            <input className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-white" placeholder="https://api.openai.com/v1/chat/completions" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
          <label className="text-sm text-neutral-300">API key
            <input type="password" autoComplete="off" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-white" placeholder="sk-…" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </label>
          <label className="text-sm text-neutral-300">Model
            <input className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-white" placeholder="gpt-4o-mini" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
          <label className="text-sm text-neutral-300">Label
            <input className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-white" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-neutral-300">
          <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Make this the default for its kind
        </label>
        <button type="submit" disabled={saving} className="mt-4 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {saving ? "Saving…" : "Add provider"}
        </button>
      </form>
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
