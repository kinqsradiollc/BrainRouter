/**
 * Models settings panel — provider setup (endpoint-driven key probing +
 * multi-select model allowlist), the default-provider picker, per-provider wire
 * format, and per-sub-agent model routing. Extracted from settings.tsx with its
 * own local state so the composed shell stays thin; render is unchanged.
 */
import React, { useRef, useState } from 'react';
import { ProviderIcon } from '../components/ProviderIcon.js';
import { Row, ChoiceControl, ComboInput } from './controls.js';
import { WireFormatSelect } from './controls.js';
import {
  SUBAGENT_ROLES,
  SUBAGENT_ROLE_LABELS,
  normalizeProviderId,
  normalizeWireFormatOverrides,
  type ChoiceOption,
  type ConfigSnapshot,
  type WireFormatOverride,
} from './types.js';

export function ModelsSection({ snapshot, knobs, setKnob, refreshSnapshot, api }: {
  snapshot: ConfigSnapshot | null;
  knobs: Record<string, unknown>;
  setKnob: (key: string, value: unknown) => void;
  refreshSnapshot: () => void;
  api: {
    open: boolean;
    section: string;
    onAction: (id: string, name: string, args?: Record<string, unknown>) => void;
    endpointModels: string[];
    providerModels: Record<string, string[]>;
    probedModels: string[];
    probeLoading: boolean;
    probeError: string;
    onProbe: (args: { endpoint: string; apiKey: string; provider: string; apiVersion: string }) => void;
    onProbeReset: () => void;
  };
}): React.ReactElement {
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [provDraft, setProvDraft] = useState<{ name: string; provider: string; endpoint: string; apiKey: string; model: string; apiVersion: string }>({ name: '', provider: 'openai', endpoint: '', apiKey: '', model: '', apiVersion: '' });
  const [roleDraft, setRoleDraft] = useState<Record<string, { provider: string; model: string }>>({});
  // WS12 — provider configure modal + delete confirmation.
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState<string | null>(null);
  // Sub-tab within the Models panel: 'providers' (default) | 'subagents'. Keeps
  // per-role sub-agent routing tucked away so the main view stays provider-focused.
  const [modelsTab, setModelsTab] = useState<'providers' | 'subagents'>('providers');
  // §multi-select-models — the checked allowlist in the setup dialog (ordered).
  // On a probe it's reconciled to the freshly-fetched list (keeping prior picks
  // that still exist); on Connect it's sent as `models[]`.
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  // Search/filter text for the model checklist (filters the fetched list).
  const [modelFilter, setModelFilter] = useState('');
  // De-dups probe calls: blur + button + a re-render shouldn't re-fire the same
  // endpoint+key. Holds the last-probed signature.
  const lastProbeRef = useRef<string>('');
  /** WS12 — open the configure modal: edit an existing provider, prefill from a
   *  catalog id, or a blank custom provider. §multi-select-models: preload the
   *  saved allowlist (when editing) and clear any prior probe result. */
  const openProviderModal = (init?: { name?: string; provider?: string; endpoint?: string | null; model?: string; models?: string[]; apiVersion?: string | null; editing?: string }): void => {
    setEditingProvider(init?.editing ?? null);
    setProvDraft({ name: init?.name ?? '', provider: init?.provider ?? 'openai', endpoint: init?.endpoint ?? '', apiKey: '', model: init?.model ?? '', apiVersion: init?.apiVersion ?? '' });
    setSelectedModels(init?.models ?? []);
    setModelFilter('');
    lastProbeRef.current = '';
    api.onProbeReset();
    setProvModalOpen(true);
  };
  /** §multi-select-models — fire a draft-key probe (dedups identical calls).
   *  Endpoint resolves from the draft or the catalog entry for the provider id. */
  const runProbe = (): void => {
    const endpoint = (provDraft.endpoint || snapshot?.providerCatalog?.find((c) => c.id === provDraft.provider)?.endpoint || '').trim();
    const sig = `${endpoint} ${provDraft.apiKey} ${provDraft.apiVersion}`;
    if (sig === lastProbeRef.current && (api.probedModels.length || api.probeError)) return;
    lastProbeRef.current = sig;
    api.onProbe({ endpoint, apiKey: provDraft.apiKey, provider: provDraft.provider, apiVersion: provDraft.apiVersion });
  };
  // §multi-select-models — when a probe returns a model set, reconcile the
  // checked list: keep prior picks that still exist; if none carried over (a
  // first probe), default-select all (the Onyx "make all available" default).
  React.useEffect(() => {
    if (!provModalOpen || !api.probedModels.length) return;
    setSelectedModels((cur) => {
      const kept = cur.filter((m) => api.probedModels.includes(m));
      return kept.length ? kept : api.probedModels;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.probedModels]);

  // §endpoint-driven-models — every OpenAI-compatible endpoint exposes GET
  // /models, so when a model-picker section opens we (re)load the active
  // endpoint's models AND each named provider's, and the pickers below render
  // them as in-app suggestions. No model name is ever hand-written.
  const providerNames = (snapshot?.providers ?? []).map((p) => p.name).join(',');
  React.useEffect(() => {
    if (!api.open || api.section !== 'models') return;
    api.onAction('q-models', 'list-models');
    for (const name of providerNames ? providerNames.split(',') : []) api.onAction('q-models', 'list-models', { provider: name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.open, api.section, providerNames]);
  // The /models list backing a role's picker: the active endpoint for
  // main/inherit, else the named provider's own list.
  const modelsForProvider = (provider: string): string[] =>
    (!provider || provider === '(main)' || provider === 'inherit') ? api.endpointModels : (api.providerModels[provider] ?? []);

  const providerCatalog = snapshot?.providerCatalog ?? [];
  const savedProviders = snapshot?.providers ?? [];
  const defaultProvider = snapshot?.defaultProviderName ?? '';
  const currentDefault = defaultProvider
    ? savedProviders.find((p) => p.name === defaultProvider)
    : null;
  const defaultModelMatches = snapshot?.defaultProviderModelMatches !== false;
  const defaultProviderDesc = currentDefault
    ? `${currentDefault.provider} · ${defaultModelMatches ? currentDefault.model : `${snapshot?.model ?? currentDefault.model} (current model)`}`
    : snapshot?.model
      ? `Current default is ${snapshot.model}. Save it as a Provider below to manage it here.`
      : 'Add a provider below, then select it here.';
  const overrideRaw = normalizeWireFormatOverrides(knobs.providerRequestFormat);
  const updateWireFormat = (id: string, next: WireFormatOverride | null): void => {
    const providerId = normalizeProviderId(id);
    if (!providerId) return;
    const m: Record<string, WireFormatOverride> = { ...overrideRaw };
    if (next === null) delete m[providerId];
    else m[providerId] = next;
    setKnob('providerRequestFormat', Object.keys(m).length === 0 ? null : m);
  };
  const savedByProvider = new Map<string, typeof savedProviders>();
  for (const provider of savedProviders) {
    const id = normalizeProviderId(provider.provider || provider.name);
    if (!id) continue;
    const rows = savedByProvider.get(id) ?? [];
    rows.push(provider);
    savedByProvider.set(id, rows);
  }
  const catalogById = new Map(providerCatalog.map((p) => [normalizeProviderId(p.id), p] as const));
  const providerFormatRows: Array<{ id: string; label: string; endpoint?: string; saved: typeof savedProviders }> = [];
  const seenProviderFormatRows = new Set<string>();
  const addProviderFormatRow = (rawId: string, fallbackLabel?: string): void => {
    const id = normalizeProviderId(rawId);
    if (!id || seenProviderFormatRows.has(id)) return;
    seenProviderFormatRows.add(id);
    const catalog = catalogById.get(id);
    providerFormatRows.push({
      id,
      label: catalog?.label ?? fallbackLabel ?? id,
      endpoint: catalog?.endpoint,
      saved: savedByProvider.get(id) ?? [],
    });
  };
  for (const provider of providerCatalog) addProviderFormatRow(provider.id, provider.label);
  for (const id of savedByProvider.keys()) addProviderFormatRow(id);
  return (
    <>
      <div className="set-h">Models</div>
      <div className="set-desc" style={{ marginBottom: 6 }}>Configure provider endpoints, choose the default model, and set provider-level request routing.</div>

      {/* Sub-tabs: provider setup vs. per-sub-agent model routing. */}
      <div style={{ display: 'flex', gap: 4, margin: '4px 0 14px', borderBottom: '1px solid var(--border)' }}>
        {([['providers', 'Providers'], ['subagents', 'Sub-agent models']] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setModelsTab(key)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 10px', fontSize: 13, fontWeight: 600,
              color: modelsTab === key ? 'var(--text)' : 'var(--text-faint)',
              borderBottom: modelsTab === key ? '2px solid var(--accent)' : '2px solid transparent', marginBottom: -1 }}>{label}</button>
        ))}
      </div>

      {modelsTab === 'providers' ? (
      <>
      <div className="set-h2">Default model &amp; provider</div>
      <Row title="Provider" desc={defaultProviderDesc}>
        <ChoiceControl value={defaultProvider} placeholder={savedProviders.length ? 'Select provider' : 'No providers yet'}
          options={savedProviders.map((p) => ({ value: p.name, label: p.name, detail: `${p.provider} · ${p.model}` }))}
          onChange={(name) => { api.onAction('a-setdefault', 'action:set-default-provider', { name }); setTimeout(refreshSnapshot, 80); }} />
      </Row>

      <div className="set-h2">Set up a provider</div>
      <div className="set-desc" style={{ marginBottom: 8 }}>Pick one — the dialog pre-fills the endpoint, then enter your key to pull the models it unlocks.</div>
      <div className="provider-gallery" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(252px, 1fr))' }}>
        {providerCatalog.length === 0 ? <div className="empty">No providers in the catalog.</div> : null}
        {providerCatalog.map((c) => {
          const configured = savedProviders.some((p) => p.provider === c.id);
          const host = c.endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'custom endpoint';
          const isGenericCustom = c.id === 'openai-compatible';
          return (
            <button key={c.id} type="button" className="provider-card" title={`Set up ${c.label}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, textAlign: 'left' }}
              onClick={() => openProviderModal({ name: isGenericCustom ? '' : c.id, provider: isGenericCustom ? '' : c.id, endpoint: isGenericCustom ? '' : c.endpoint })}>
              <ProviderIcon id={c.id} size={28} title={c.label} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span className="pc-name" style={{ fontWeight: 600 }}>{c.label}</span>
                <span className="pc-host" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{host}</span>
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: configured ? 'var(--ok)' : 'var(--accent)' }}>
                {configured ? '✓ Configured' : 'Connect'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="set-h2">Your providers</div>
      {savedProviders.length === 0 ? <div className="empty">None yet — pick one above, or add a custom provider.</div> : null}
      {savedProviders.length ? (
        <div className="provider-gallery" style={{ gridTemplateColumns: '1fr', gap: 8 }}>
          {[...savedProviders].sort((a, b) => (a.name === defaultProvider ? -1 : b.name === defaultProvider ? 1 : 0)).map((p) => (
            <div key={p.name} className="provider-card saved" style={{ flexDirection: 'row', alignItems: 'center', gap: 11, textAlign: 'left' }}>
              <ProviderIcon id={p.provider} size={28} title={p.provider} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
                <span className="pc-name" style={{ fontWeight: 600 }}>{p.name}{p.name === defaultProvider ? <span className="pc-tag default" style={{ marginLeft: 6 }}>Default</span> : null}</span>
                <span className="pc-host" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.model}{p.models && p.models.length ? ` · ${p.models.length} models` : ''}</span>
              </span>
              <span className="pc-actions" style={{ marginLeft: 'auto', flexWrap: 'nowrap', flex: '0 0 auto' }}>
                {p.name !== defaultProvider ? <button className="btn" title="Make this the default model" onClick={() => { api.onAction('a-setdefault', 'action:set-default-provider', { name: p.name }); setTimeout(refreshSnapshot, 80); }}>Set default</button> : null}
                <button className="btn" onClick={() => openProviderModal({ editing: p.name, name: p.name, provider: p.provider, endpoint: p.endpoint ?? '', model: p.model, models: p.models ?? [], apiVersion: p.apiVersion ?? '' })}>Configure</button>
                <button className="btn danger" title="Remove this provider" onClick={() => setConfirmDeleteProvider(p.name)}>Remove</button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <button className="btn" style={{ marginTop: 4 }} onClick={() => openProviderModal({ provider: '' })}>+ Add custom provider</button>

      {provModalOpen ? (() => {
        const cat = providerCatalog.find((c) => c.id === provDraft.provider);
        const headerLabel = cat?.label ?? (editingProvider ?? (provDraft.provider || 'provider'));
        const catalogLocal = !!cat?.local;
        const resolvedEndpoint = provDraft.endpoint || cat?.endpoint || '';
        // Custom / user-supplied-endpoint providers (OpenAI-compatible, Azure,
        // or an unknown id) get the richer Onyx-style fields incl. API Version.
        const isCustomLike = !cat || !cat.endpoint;
        // Onyx-style header: title + one-line subtitle describing the setup.
        const headerTitle = editingProvider ? `Configure ${editingProvider}` : cat ? `Connect ${headerLabel}` : 'Add a custom provider';
        const headerSubtitle = editingProvider
          ? 'Update its key, endpoint, and which models are available.'
          : cat
            ? `Connect to ${headerLabel}, then choose which models to make available.`
            : 'Point at any OpenAI-compatible endpoint, then choose your models.';
        // The single default ∈ the checked set (UI mirror of the host's
        // normalizeProviderModels); free-text when nothing was probed.
        const defaultModel = selectedModels.length
          ? (selectedModels.includes(provDraft.model) ? provDraft.model : selectedModels[0])
          : provDraft.model;
        // Search-filtered model list + master-checkbox state (operates on
        // the currently-visible/filtered models).
        const q = modelFilter.trim().toLowerCase();
        const filteredModels = q ? api.probedModels.filter((m) => m.toLowerCase().includes(q)) : api.probedModels;
        const allFilteredChecked = filteredModels.length > 0 && filteredModels.every((m) => selectedModels.includes(m));
        const someFilteredChecked = filteredModels.some((m) => selectedModels.includes(m));
        const toggleAllFiltered = (): void => setSelectedModels((cur) => allFilteredChecked
          ? cur.filter((m) => !filteredModels.includes(m))
          : [...new Set([...cur, ...filteredModels])]);
        const canConnect = !!provDraft.name.trim() && (selectedModels.length > 0 || !!provDraft.model.trim());
        return (
          <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) { setProvModalOpen(false); api.onProbeReset(); } }}>
            <div className="dialog" style={{ width: 520, maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="dialog-title" style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 'none' }}>
                <ProviderIcon id={provDraft.provider || 'openai-compatible'} size={30} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span>{headerTitle}</span>
                  <span className="set-desc" style={{ margin: 0, fontWeight: 400 }}>{headerSubtitle}</span>
                </span>
              </div>
              <div className="mcp-add" style={{ gap: 5, flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {/* §onyx-dialog — labeled sections (API key → display name →
                    provider/endpoint for custom → models), each with helper text. */}
                <div className="set-h2" style={{ marginTop: 2 }}>API key{editingProvider ? <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> (blank = keep current)</span> : null}</div>
                <input className="ctl" type="password" placeholder={editingProvider ? 'Paste a new key, or leave blank' : `Paste your ${cat ? headerLabel : 'provider'} API key`}
                  value={provDraft.apiKey}
                  onChange={(e) => setProvDraft((d) => ({ ...d, apiKey: e.target.value }))}
                  onBlur={() => { if (provDraft.apiKey.trim() || catalogLocal) runProbe(); }} />
                <div className="set-desc" style={{ margin: 0 }}>Paste your key to access this provider's models. Local servers can leave it blank.</div>

                <div className="set-h2">Display name</div>
                <input className="ctl" placeholder="e.g. openai, my-groq" disabled={!!editingProvider} value={provDraft.name} onChange={(e) => setProvDraft((d) => ({ ...d, name: e.target.value }))} />
                <div className="set-desc" style={{ margin: 0 }}>Used to identify this provider in the app.</div>

                {isCustomLike ? (
                  <>
                    <div className="set-h2">Provider &amp; endpoint</div>
                    <ChoiceControl value={providerCatalog.some((c) => c.id === provDraft.provider) ? provDraft.provider : '__custom__'}
                      options={[...providerCatalog.map((c) => ({ value: c.id, label: c.label, detail: c.local ? 'local' : undefined })), { value: '__custom__', label: 'Custom…' }]}
                      onChange={(id) => {
                        // Provider switch ⇒ endpoint/key context changed: drop any probe result.
                        lastProbeRef.current = ''; setSelectedModels([]); api.onProbeReset();
                        if (id === '__custom__') setProvDraft((d) => ({ ...d, provider: '', endpoint: '' }));
                        else setProvDraft((d) => ({ ...d, provider: id, endpoint: providerCatalog.find((c) => c.id === id)?.endpoint ?? d.endpoint }));
                      }} />
                    {providerCatalog.some((c) => c.id === provDraft.provider) ? null : (
                      <input className="ctl" placeholder="provider id (openai, groq, …)" value={provDraft.provider} onChange={(e) => setProvDraft((d) => ({ ...d, provider: e.target.value }))} />
                    )}
                    <input className="ctl" placeholder="API base URL, e.g. https://<resource>.openai.azure.com/openai/v1"
                      value={resolvedEndpoint}
                      onChange={(e) => { lastProbeRef.current = ''; setProvDraft((d) => ({ ...d, endpoint: e.target.value })); }} />
                    <input className="ctl" placeholder="API version (optional — e.g. 2024-02-01 for Azure)"
                      value={provDraft.apiVersion}
                      onChange={(e) => { lastProbeRef.current = ''; setProvDraft((d) => ({ ...d, apiVersion: e.target.value })); }} />
                    <div className="set-desc" style={{ margin: 0 }}>The OpenAI-compatible base URL. API version is only needed for Azure-style endpoints.</div>
                  </>
                ) : null}

                {/* §multi-select-models — Models section: fetch the key's models,
                    search/select which to make available; free-text fallback when
                    a probe returns nothing (Azure/Anthropic compat, offline). */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                  <div className="set-h2" style={{ margin: 0 }}>Models</div>
                  <button className="btn primary-ghost" style={{ flex: '0 0 auto' }} disabled={api.probeLoading} onClick={runProbe}>{api.probeLoading ? 'Fetching…' : 'Fetch models'}</button>
                </div>
                <div className="set-desc" style={{ margin: 0 }}>
                  {api.probeLoading ? 'Fetching the models your key unlocks…'
                    : api.probedModels.length ? `Select models to make available — ${selectedModels.length} of ${api.probedModels.length} selected.`
                    : (api.probeError === 'http-401' || api.probeError === 'http-403') ? 'API key rejected — check the key.'
                    : api.probeError === 'http-404' ? 'Endpoint not found — check the base URL.'
                    : api.probeError === 'unreachable' ? "Couldn't reach the endpoint — check the URL / network."
                    : api.probeError && api.probeError.startsWith('http-') ? `Endpoint error ${api.probeError.replace('http-', '')} — check the endpoint.`
                    : api.probeError === 'no-models' ? 'No models returned — check the key/endpoint, or type a default below.'
                    : 'Enter your key above, then fetch the models it unlocks.'}
                </div>
                {api.probedModels.length ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input className="ctl" style={{ flex: 1 }} placeholder={`Search ${api.probedModels.length} models…`} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flex: '0 0 auto' }}>
                        <input type="checkbox" checked={allFilteredChecked}
                          ref={(el) => { if (el) el.indeterminate = someFilteredChecked && !allFilteredChecked; }}
                          onChange={toggleAllFiltered} />
                        <span>{allFilteredChecked ? 'Deselect all' : 'Select all'}{modelFilter.trim() ? ` (${filteredModels.length})` : ''}</span>
                      </label>
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5, padding: 1 }}>
                      {filteredModels.length === 0 ? <div className="set-desc" style={{ margin: 0, padding: '6px 2px' }}>No models match “{modelFilter}”.</div> : null}
                      {filteredModels.map((m) => {
                        const checked = selectedModels.includes(m);
                        return (
                          <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                            border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`, background: checked ? 'var(--accent-soft)' : 'var(--input)' }}>
                            <input type="checkbox" checked={checked} onChange={() => setSelectedModels((cur) => cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m])} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="mcp-add-row" style={{ alignItems: 'center', marginTop: 2 }}>
                      <span className="set-desc" style={{ margin: 0, flex: '0 0 auto' }}>Default model</span>
                      <ChoiceControl value={defaultModel}
                        options={selectedModels.map((m) => ({ value: m, label: m }))}
                        onChange={(m) => setProvDraft((d) => ({ ...d, model: m }))} />
                    </div>
                  </>
                ) : (
                  <>
                    <input className="ctl" placeholder="default model (type one, or fetch above)" list="ws12-provider-models" value={provDraft.model} onChange={(e) => setProvDraft((d) => ({ ...d, model: e.target.value }))} />
                    <datalist id="ws12-provider-models">
                      {(editingProvider ? (api.providerModels[editingProvider] ?? []) : api.endpointModels).map((m) => <option key={m} value={m} />)}
                    </datalist>
                  </>
                )}

                {!canConnect ? (
                  <div className="set-desc" style={{ margin: '2px 0 0', color: 'var(--warn)' }}>
                    {!provDraft.name.trim() ? 'Enter a display name to connect.' : 'Pick at least one model — or type a default — to connect.'}
                  </div>
                ) : null}
                <div className="set-actions" style={{ marginTop: 6 }}>
                  <button className="btn" onClick={() => { setProvModalOpen(false); api.onProbeReset(); }}>Cancel</button>
                  <button className="btn primary" disabled={!canConnect}
                    onClick={() => {
                      const catalogEndpoint = cat?.endpoint ?? '';
                      api.onAction('a-setprov', 'action:set-provider', {
                        name: (editingProvider ?? provDraft.name).trim(),
                        provider: provDraft.provider.trim(),
                        endpoint: (provDraft.endpoint || catalogEndpoint).trim(),
                        model: defaultModel.trim(),
                        apiKey: provDraft.apiKey.trim(),
                        models: selectedModels,
                        apiVersion: provDraft.apiVersion.trim(),
                      });
                      setProvModalOpen(false);
                      setEditingProvider(null);
                      setProvDraft({ name: '', provider: 'openai', endpoint: '', apiKey: '', model: '', apiVersion: '' });
                      setSelectedModels([]);
                      api.onProbeReset();
                      setTimeout(refreshSnapshot, 80);
                    }}>{editingProvider ? 'Save provider' : 'Connect'}</button>
                </div>
              </div>
            </div>
          </div>
        );
      })() : null}

      {confirmDeleteProvider ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteProvider(null); }}>
          <div className="dialog dangerous" style={{ width: 380 }}>
            <div className="dialog-title">Remove “{confirmDeleteProvider}”?</div>
            <div className="set-desc" style={{ marginBottom: 12 }}>Deletes the saved provider and its stored key. Sub-agents routed to it fall back to the main default provider.</div>
            <div className="set-actions">
              <button className="btn" onClick={() => setConfirmDeleteProvider(null)}>Cancel</button>
              <button className="btn primary" onClick={() => { api.onAction('a-rmprov', 'action:remove-provider', { name: confirmDeleteProvider }); setConfirmDeleteProvider(null); setTimeout(refreshSnapshot, 80); }}>Remove</button>
            </div>
          </div>
        </div>
      ) : null}

      {(() => {
        if (providerFormatRows.length === 0) return null;
        return (
          <div className="wire-format-section">
            <div className="set-h2">Wire format (per provider)</div>
            <div className="set-desc" style={{ marginBottom: 8 }}>Default follows BrainRouter's provider contract. Responses uses <code>/v1/responses</code> when the selected model can use it.</div>
            <div className="wire-format-grid">
            {providerFormatRows.map((p) => {
              const cur = overrideRaw[p.id] ?? null;
              const target = cur === 'responses'
                ? '/v1/responses'
                : cur === 'chat-completions'
                  ? '/v1/chat/completions'
                  : 'built-in routing';
              const savedNames = p.saved.map((s) => s.name).join(', ');
              const host = p.endpoint ? p.endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
              return (
                <div className="wire-format-row" key={p.id}>
                  <div className="wire-format-main">
                    <div className="wire-format-title">
                      <span>{p.label}</span>
                      <code>{p.id}</code>
                    </div>
                    <div className="wire-format-meta">
                      <span>{target}</span>
                      {host ? <span>{host}</span> : null}
                      {savedNames ? <span>saved as {savedNames}</span> : null}
                    </div>
                  </div>
                  <div className="wire-format-control">
                    <WireFormatSelect value={cur} onChange={(v) => updateWireFormat(p.id, v)} />
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        );
      })()}
      </>
      ) : (
      <>
      <div className="set-h2">Sub-agent models</div>
      <div className="set-desc" style={{ marginBottom: 6 }}>Optional routing for spawned agents. Leave roles unset to follow the main default provider. The fallback row only applies to sub-agents without a role-specific override.</div>
      {SUBAGENT_ROLES.map((role) => {
        const cur = snapshot?.agentModels?.find((a) => a.role === role);
        const fallback = role === 'default' ? null : snapshot?.agentModels?.find((a) => a.role === 'default');
        const curSel = !cur ? 'inherit' : (cur.provider ?? '(main)');
        const d = roleDraft[role] ?? { provider: curSel, model: cur?.model ?? '' };
        const providerOptions: ChoiceOption[] = [
          { value: 'inherit', label: role === 'default' ? 'follow main default' : 'inherit' },
          { value: '(main)', label: 'main provider', detail: snapshot?.model },
          ...(snapshot?.providers ?? []).map((p) => ({ value: p.name, label: p.name, detail: p.model })),
        ];
        const setD = (patch: Partial<{ provider: string; model: string }>): void => setRoleDraft((r) => ({ ...r, [role]: { ...d, ...patch } }));
        const roleModels = modelsForProvider(d.provider);
        const curText = cur ? `${cur.provider ?? '(main)'} · ${cur.model ?? 'provider default'}` : '';
        const isRedundantFallback = role === 'default' && !!cur && (
          (cur.provider === defaultProvider && (!cur.model || cur.model === currentDefault?.model)) ||
          (!cur.provider && (!cur.model || cur.model === snapshot?.model))
        );
        const desc = cur
          ? (role === 'default'
              ? (isRedundantFallback ? `same as main default; clear it so sub-agents follow future default changes` : `fallback currently overrides unconfigured sub-agents: ${curText}`)
              : `currently: ${curText}`)
          : (role === 'default'
              ? 'unset; unconfigured sub-agents follow the main default provider'
              : (fallback ? `inherits fallback: ${fallback.provider ?? '(main)'} · ${fallback.model ?? 'provider default'}` : 'inherits the main default provider'));
        return (
          <Row key={role} title={SUBAGENT_ROLE_LABELS[role]} desc={desc}>
            <ChoiceControl value={d.provider} options={providerOptions} onChange={(v) => setD({ provider: v, model: '' })} />
            <ComboInput style={{ width: 150 }} disabled={d.provider === 'inherit'}
              placeholder={d.provider === 'inherit' ? '—' : (roleModels.length ? 'model (blank = default)' : '/models…')}
              options={roleModels} value={d.model} onChange={(model) => setD({ model })} />
            <button className="btn" onClick={() => {
              const provider = d.provider === 'inherit' || d.provider === '(main)' ? '' : d.provider;
              const model = d.provider === 'inherit' ? '' : d.model.trim();
              api.onAction('a-setrole', 'action:set-agent-model', { role, provider, model });
              setRoleDraft((r) => { const n = { ...r }; delete n[role]; return n; });
              refreshSnapshot();
            }}>{d.provider === 'inherit' ? 'Clear' : 'Save'}</button>
          </Row>
        );
      })}
      </>
      )}
    </>
  );
}
