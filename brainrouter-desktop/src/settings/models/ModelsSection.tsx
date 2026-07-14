/**
 * Models settings panel — provider setup (endpoint-driven key probing +
 * multi-select model allowlist), the default-provider picker, per-provider wire
 * format, and per-sub-agent model routing. Extracted from settings.tsx with its
 * own local state so the composed shell stays thin; render is unchanged.
 */
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProviderIcon } from '../../components/model/ProviderIcon.js';
import { Row, Toggle, ChoiceControl, ComboInput } from '../shared/controls.js';
import { WireFormatSelect } from '../shared/controls.js';
import { LlmProfilesCard } from './LlmProfilesCard.js';
import { RoutingChainEditor, routerCatalogChoiceOptions } from './RoutingChainEditor.js';
import { MODEL_TABS, nextModelTabIndex, type ModelTab } from './modelTabs.js';
import {
  SUBAGENT_ROLES,
  SUBAGENT_ROLE_LABELS,
  normalizeProviderId,
  normalizeWireFormatOverrides,
  type ChoiceOption,
  type ConfigSnapshot,
  type WireFormatOverride,
} from '../shared/types.js';

export function ModelsSection({ snapshot, knobs, setKnob, setPath, refreshSnapshot, api }: {
  snapshot: ConfigSnapshot | null;
  knobs: Record<string, unknown>;
  setKnob: (key: string, value: unknown) => void;
  setPath: (path: string, value: unknown) => void;
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
  const [provDraft, setProvDraft] = useState<{ name: string; provider: string; endpoint: string; apiKey: string; model: string; apiVersion: string; free: boolean; passthroughUnknown: boolean }>({
    name: '',
    provider: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    apiVersion: '',
    free: false,
    passthroughUnknown: false,
  });
  const [roleDraft, setRoleDraft] = useState<Record<string, { request: string }>>({});
  // WS12 — provider configure modal + delete confirmation.
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState<string | null>(null);
  const [modelsTab, setModelsTab] = useState<ModelTab>('managed');
  const rootRef = useRef<HTMLDivElement>(null);
  // §multi-select-models — the checked allowlist in the setup dialog (ordered).
  // On a probe it's reconciled to the freshly-fetched list (keeping prior picks
  // that still exist); on Connect it's sent as `models[]`.
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  // Search/filter text for the model checklist (filters the fetched list).
  const [modelFilter, setModelFilter] = useState('');
  const [routerKeyDraft, setRouterKeyDraft] = useState('');
  // De-dups probe calls: blur + button + a re-render shouldn't re-fire the same
  // endpoint+key. Holds the last-probed signature.
  const lastProbeRef = useRef<string>('');
  /** WS12 — open the configure modal: edit an existing provider, prefill from a
   *  catalog id, or a blank custom provider. §multi-select-models: preload the
   *  saved allowlist (when editing) and clear any prior probe result. */
  const openProviderModal = (init?: { name?: string; provider?: string; endpoint?: string | null; model?: string; models?: string[]; apiVersion?: string | null; free?: boolean; passthroughUnknown?: boolean; editing?: string }): void => {
    setEditingProvider(init?.editing ?? null);
    setProvDraft({
      name: init?.name ?? '',
      provider: init?.provider ?? 'openai',
      endpoint: init?.endpoint ?? '',
      apiKey: '',
      model: init?.model ?? '',
      apiVersion: init?.apiVersion ?? '',
      free: init?.free === true,
      passthroughUnknown: init?.passthroughUnknown === true,
    });
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
  const providerCatalog = snapshot?.providerCatalog ?? [];
  const savedProviders = snapshot?.providers ?? [];
  const defaultProvider = snapshot?.defaultProviderName ?? '';
  const routerCatalog = snapshot?.routerCatalog;
  const routerKnobs = (knobs.router && typeof knobs.router === 'object' ? knobs.router : {}) as Record<string, unknown>;
  const routerServe = snapshot?.routerServe;
  const routerServeEnabled = routerKnobs.serve === true;
  const routerServeKeySet = snapshot?.routerSecretsSet?.serveKey === true;
  // The gateway key is OPTIONAL on a loopback bind (local dev); a non-loopback
  // host MUST carry one — an open network port with no auth is never safe. This
  // mirrors the CLI/host guards in serveCommand.ts / routerServe.ts.
  const routerServeHost = String(routerKnobs.serveHost ?? '127.0.0.1').trim() || '127.0.0.1';
  const routerServeLoopback = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i.test(routerServeHost);
  const routerServeKeyRequired = !routerServeLoopback;
  const routerServeCanStart = routerServeEnabled && (routerServeKeySet || !routerServeKeyRequired);
  const setRouterPath = (path: string, value: unknown): void => {
    api.onAction('a-router-path', 'action:set-cli-path', { path: `router.${path}`, value });
    setTimeout(refreshSnapshot, 80);
  };
  const routerServeAction = (name: string): void => {
    api.onAction('a-router-serve', name, {});
    setTimeout(refreshSnapshot, 250);
  };
  const routerRoleOptions = React.useMemo(() => ([
    { value: 'inherit', label: 'Inherit main', detail: 'primary chain' },
    ...routerCatalogChoiceOptions(routerCatalog),
  ]), [routerCatalog]);
  const roleRequestFor = (provider?: string | null, model?: string | null): string => {
    const cleanProvider = (provider ?? '').trim();
    const cleanModel = (model ?? '').trim();
    if (!cleanProvider && !cleanModel) return 'inherit';
    if (cleanProvider) return `${cleanProvider}/${cleanModel || savedProviders.find((p) => p.name === cleanProvider)?.model || ''}`.replace(/\/$/, '');
    return cleanModel || 'inherit';
  };
  const assignmentForRequest = (request: string): { provider: string; model: string } => {
    const value = request.trim();
    if (!value || value === 'inherit' || value === 'auto') return { provider: '', model: '' };
    const slash = value.indexOf('/');
    if (slash > 0) {
      const provider = value.slice(0, slash);
      if (savedProviders.some((p) => p.name === provider)) return { provider, model: value.slice(slash + 1) };
    }
    return { provider: '', model: value };
  };
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
  const selectModelsTab = (tab: ModelTab): void => {
    setModelsTab(tab);
    setProvModalOpen(false);
    setConfirmDeleteProvider(null);
    requestAnimationFrame(() => {
      const scroller = rootRef.current?.closest('.set-body') as HTMLElement | null;
      if (scroller) scroller.scrollTop = 0;
    });
  };
  const onModelsTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextModelTabIndex(index, event.key);
    if (next === null) return;
    event.preventDefault();
    selectModelsTab(MODEL_TABS[next][0]);
    requestAnimationFrame(() => {
      rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-tab]')[next]?.focus();
    });
  };
  const accountModels = snapshot?.accountModels;
  return (
    <div className="models-section" ref={rootRef}>
      <div className="set-h">Models</div>
      <div className="set-desc set-desc--mb6">Use managed account models, connect personal providers, or tune routing without one long settings page.</div>

      <div className="models-subtabs" role="tablist" aria-label="Model settings">
        {MODEL_TABS.map(([key, label], index) => (
          <button key={key} type="button" role="tab" data-model-tab
            id={`models-tab-${key}`} aria-controls={`models-panel-${key}`} aria-selected={modelsTab === key}
            tabIndex={modelsTab === key ? 0 : -1}
            className={`models-subtab${modelsTab === key ? ' active' : ''}`}
            onKeyDown={(event) => onModelsTabKeyDown(event, index)}
            onClick={() => selectModelsTab(key)}>{label}</button>
        ))}
      </div>

      {modelsTab === 'managed' ? (
        <div id="models-panel-managed" role="tabpanel" aria-labelledby="models-tab-managed">
          <div className="set-h2">BrainRouter managed models</div>
          <div className="set-desc set-desc--mb8">Read-only models provided by your BrainRouter account. Availability and reasoning choices refresh automatically from the server.</div>
          {!accountModels?.signedIn ? (
            <div className="managed-model-state">Sign in to BrainRouter to use managed models.</div>
          ) : accountModels.models.length === 0 ? (
            <div className="managed-model-state">{accountModels.error ?? 'No managed models are available for this account.'}</div>
          ) : (
            <div className="managed-model-list">
              {accountModels.models.map((model) => (
                <div className="managed-model-row" key={model.id}>
                  <span className="managed-provider-mark" aria-hidden="true">BR</span>
                  <span className="managed-model-main">
                    <span className="managed-model-title">{model.label}<code>{model.id}</code></span>
                    <span className="managed-model-meta">
                      {model.reasoning ? model.reasoning.allowed.map((effort) => effort.label).join(' · ') : 'No reasoning control'}
                    </span>
                  </span>
                  <span className="pc-tag default no-shrink">Managed</span>
                </div>
              ))}
            </div>
          )}
          {accountModels?.stale ? <div className="set-desc set-desc--warn set-desc--mt2">Showing the last known catalog. {accountModels.error}</div> : null}
          {accountModels?.refreshedAt ? <div className="set-desc set-desc--mt2">Updated {new Date(accountModels.refreshedAt).toLocaleTimeString()} · revision {accountModels.revision}</div> : null}
        </div>
      ) : null}

      {modelsTab === 'personal' ? (
      <div id="models-panel-personal" role="tabpanel" aria-labelledby="models-tab-personal">
      {/* 1. Set up a provider — the primary path leads (moved above routing/gateway). */}
      <div className="set-h2">Set up a provider</div>
      <div className="set-desc set-desc--mb8">Pick one — the dialog pre-fills the endpoint, then enter your key to pull the models it unlocks.</div>
      <div className="provider-gallery provider-gallery--tiles">
        {providerCatalog.length === 0 ? <div className="empty">No providers in the catalog.</div> : null}
        {providerCatalog.map((c) => {
          const configured = savedProviders.some((p) => p.provider === c.id);
          const host = c.endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'custom endpoint';
          const isGenericCustom = c.id === 'openai-compatible';
          return (
            <button key={c.id} type="button" className="provider-card provider-card--row" title={`Set up ${c.label}`}
              onClick={() => openProviderModal({ name: isGenericCustom ? '' : c.id, provider: isGenericCustom ? '' : c.id, endpoint: isGenericCustom ? '' : c.endpoint })}>
              <ProviderIcon id={c.id} size={28} title={c.label} />
              <span className="stack-tight">
                <span className="pc-name">{c.label}</span>
                <span className="pc-host truncate">{host}</span>
              </span>
              <span className={`pc-status ${configured ? 'pc-status--ok' : 'pc-status--connect'}`}>
                {configured ? '✓ Configured' : 'Connect'}
              </span>
            </button>
          );
        })}
      </div>

      {/* 2. Your providers — the saved list, directly under the catalog. */}
      <div className="set-h2">Your providers</div>
      {savedProviders.length === 0 ? <div className="empty">None yet — pick one above, or add a custom provider.</div> : null}
      {savedProviders.length ? (
        <div className="provider-gallery provider-gallery--list">
          {[...savedProviders].sort((a, b) => (a.name === defaultProvider ? -1 : b.name === defaultProvider ? 1 : 0)).map((p) => {
            const routeSlug = `${p.name}/${p.model}`;
            const primaryChain = routerCatalog?.primaryChain ?? [];
            const isPrimary = primaryChain[0] === routeSlug || p.name === defaultProvider;
            return (
              <div key={p.name} className="provider-card saved provider-card--row">
                <ProviderIcon id={p.provider} size={28} title={p.provider} />
                <span className="stack-tight flex-1">
                  <span className="pc-name">{p.name}{isPrimary ? <span className="pc-tag default no-shrink">Primary</span> : null}</span>
                  <span className="pc-host truncate">{p.model}{p.models && p.models.length ? ` · ${p.models.length} models` : ''}</span>
                </span>
                <span className="pc-actions no-shrink" style={{ marginLeft: 'auto', flexWrap: 'nowrap' }}>
                  {!isPrimary ? <button className="btn" title="Make this provider the primary route" onClick={() => {
                    setRouterPath('chain', [routeSlug, ...primaryChain.filter((entry) => entry !== routeSlug)]);
                    api.onAction('a-setdefault', 'action:set-default-provider', { name: p.name });
                    setTimeout(refreshSnapshot, 80);
                  }}>Set primary</button> : null}
                  <button className="btn" onClick={() => openProviderModal({
                    editing: p.name,
                    name: p.name,
                    provider: p.provider,
                    endpoint: p.endpoint ?? '',
                    model: p.model,
                    models: p.models ?? [],
                    apiVersion: p.apiVersion ?? '',
                    free: p.free === true,
                    passthroughUnknown: p.passthroughUnknown === true,
                  })}>Configure</button>
                  <button className="btn danger" title="Remove this provider" onClick={() => setConfirmDeleteProvider(p.name)}>Remove</button>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      <button className="btn btn--start" onClick={() => openProviderModal({ provider: '' })}>+ Add custom provider</button>
      </div>
      ) : null}

      {modelsTab === 'routing' ? (
      <div id="models-panel-routing" role="tabpanel" aria-labelledby="models-tab-routing">
      {/* 3. Routing — how the configured providers are chained (demoted below setup). */}
      <RoutingChainEditor
        catalog={routerCatalog}
        status={snapshot?.routerStatus}
        providers={savedProviders}
        routerKnobs={routerKnobs}
        baseModel={snapshot?.model}
        setRouterPath={setRouterPath}
      />

      {/* 4. Gateway — serve the router as an OpenAI-compatible endpoint (advanced). */}
      <div className="set-h2">Gateway</div>
      <div className="provider-card saved rc-panel">
        <div className="row-between">
          <span style={{ fontWeight: 650 }}>OpenAI-compatible gateway {routerServe?.running ? <span className="badge native">running</span> : <span className="badge cli">stopped</span>}</span>
          {routerServe?.running
            ? <button className="btn danger" onClick={() => routerServeAction('action:router-serve-stop')}>Stop</button>
            : <button className="btn" disabled={!routerServeCanStart} title={!routerServeEnabled ? 'Turn on gateway serving first' : routerServeKeyRequired && !routerServeKeySet ? 'Set a gateway key first (required off-loopback)' : undefined} onClick={() => routerServeAction('action:router-serve-start')}>Start</button>}
        </div>
        <div className="set-desc set-desc--flush">
          {routerServe?.running && routerServe.url
            ? <>URL <code>{routerServe.url}</code>{routerServe.startedAt ? <> · since {new Date(routerServe.startedAt).toLocaleTimeString()}</> : null}</>
            : <>Local gateway is stopped.{routerServe?.lastError ? <> <span className="set-desc--warn">{routerServe.lastError}</span></> : null}</>}
        </div>
        {routerServe?.url ? (
          <button className="btn btn--start" onClick={() => { void navigator.clipboard?.writeText(routerServe.url ?? ''); }}>Copy URL</button>
        ) : null}
        <Row title="Enable gateway serving">
          <Toggle on={routerServeEnabled} onChange={(v) => setRouterPath('serve', v)} />
        </Row>
        <div className="field-grid field-grid--hostport">
          <input className="ctl" defaultValue={String(routerKnobs.serveHost ?? '127.0.0.1')} placeholder="127.0.0.1" onBlur={(e) => setRouterPath('serveHost', e.target.value.trim() || null)} />
          <input className="ctl" type="number" min={1} max={65535} defaultValue={String(routerKnobs.servePort ?? 8790)} placeholder="8790" onBlur={(e) => setRouterPath('servePort', Number(e.target.value) || null)} />
        </div>
        <div className="field-grid field-grid--key">
          <input className="ctl" type="password" placeholder={routerServeKeySet ? 'Gateway key configured' : routerServeKeyRequired ? 'Gateway bearer key (required)' : 'Gateway bearer key (optional)'} value={routerKeyDraft} onChange={(e) => setRouterKeyDraft(e.target.value)} />
          <button className="btn" disabled={!routerKeyDraft.trim()} onClick={() => { setRouterPath('serveKey', routerKeyDraft.trim()); setRouterKeyDraft(''); }}>Set key</button>
          <button className="btn danger" disabled={!routerServeKeySet} onClick={() => setRouterPath('serveKey', null)}>Clear</button>
        </div>
        <div className="set-desc set-desc--flush">
          {routerServeLoopback
            ? <>Bound to loopback (<code>{routerServeHost}</code>) — a bearer key is optional. Clients send <code>Authorization: Bearer …</code> only if a key is set.</>
            : <>Bound to <code>{routerServeHost}</code> — a bearer key is <strong>required</strong> because the port is reachable off-machine.</>}
        </div>
      </div>
      </div>
      ) : null}

      {modelsTab === 'personal' && provModalOpen ? (() => {
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
          ? 'Update its key, endpoint, pass-through cache, and routing behavior.'
          : cat
            ? `Connect to ${headerLabel}, then fetch the models this key unlocks.`
            : 'Point at any OpenAI-compatible endpoint, then fetch its models.';
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
        // Portal to <body>: the Settings modal's popIn `transform` would make this
        // fixed overlay resolve against — and get clipped by — the settings box.
        return createPortal((
          <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) { setProvModalOpen(false); api.onProbeReset(); } }}>
            <div className="dialog dialog--form">
              <div className="dialog-title dialog-title--stack" style={{ flex: 'none' }}>
                <ProviderIcon id={provDraft.provider || 'openai-compatible'} size={30} />
                <span className="stack-tight">
                  <span>{headerTitle}</span>
                  <span className="set-desc set-desc--flush hint-inline">{headerSubtitle}</span>
                </span>
              </div>
              <div className="mcp-add" style={{ gap: 5, flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {/* §onyx-dialog — labeled sections (API key → display name →
                    provider/endpoint for custom → models), each with helper text. */}
                <div className="set-h2 set-h2--flush">API key{editingProvider ? <span className="hint-inline"> (blank = keep current)</span> : null}</div>
                <input className="ctl" type="password" placeholder={editingProvider ? 'Paste a new key, or leave blank' : `Paste your ${cat ? headerLabel : 'provider'} API key`}
                  value={provDraft.apiKey}
                  onChange={(e) => setProvDraft((d) => ({ ...d, apiKey: e.target.value }))}
                  onBlur={() => { if (provDraft.apiKey.trim() || catalogLocal) runProbe(); }} />
                <div className="set-desc set-desc--flush">Paste your key to access this provider's models. Local servers can leave it blank.</div>

                <div className="set-h2">Display name</div>
                <input className="ctl" placeholder="e.g. openai, my-groq" disabled={!!editingProvider} value={provDraft.name} onChange={(e) => setProvDraft((d) => ({ ...d, name: e.target.value }))} />
                <div className="set-desc set-desc--flush">Used to identify this provider in the app.</div>

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
                    <div className="set-desc set-desc--flush">The OpenAI-compatible base URL. API version is only needed for Azure-style endpoints.</div>
                  </>
                ) : null}

                <div className="set-h2">Routing behavior</div>
                <label className="check-row">
                  <input type="checkbox" checked={provDraft.free || catalogLocal}
                    disabled={catalogLocal}
                    onChange={(e) => setProvDraft((d) => ({ ...d, free: e.target.checked }))} />
                  <span>Prefer for free-first routing{catalogLocal ? ' (local provider)' : ''}</span>
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={provDraft.passthroughUnknown}
                    onChange={(e) => setProvDraft((d) => ({ ...d, passthroughUnknown: e.target.checked }))} />
                  <span>Use as catch-all gateway for unknown model names</span>
                </label>
                <div className="set-desc set-desc--flush">Catch-all is intended for gateway providers that accept vendor-prefixed model ids even when they were not returned by Fetch.</div>

                {/* §multi-select-models — one clear step: Fetch the endpoint's
                    models, tick the ones to make available, and mark ONE as this
                    provider's default (the ★). Free-text fallback when a probe
                    returns nothing (Azure/Anthropic compat, offline). */}
                <div className="row-between">
                  <div className="set-h2 set-h2--flush">Models</div>
                  <button className="btn primary-ghost no-shrink" disabled={api.probeLoading} onClick={runProbe}>
                    {api.probeLoading ? 'Fetching…' : api.probedModels.length ? 'Re-fetch' : 'Fetch models'}
                  </button>
                </div>
                <div className="set-desc set-desc--flush">
                  {api.probeLoading ? 'Fetching the models your key unlocks…'
                    : api.probedModels.length ? <>{selectedModels.length === api.probedModels.length ? 'All fetched models are available to the router.' : <>Limiting this provider to <b>{selectedModels.length}</b> of {api.probedModels.length} fetched models.</>} Mark one as <b>preferred</b> (★).</>
                    : (api.probeError === 'http-401' || api.probeError === 'http-403') ? 'API key rejected — check the key.'
                    : api.probeError === 'http-404' ? 'Endpoint not found — check the base URL.'
                    : api.probeError === 'unreachable' ? "Couldn't reach the endpoint — check the URL / network."
                    : api.probeError && api.probeError.startsWith('http-') ? `Endpoint error ${api.probeError.replace('http-', '')} — check the endpoint.`
                    : api.probeError === 'no-models' ? 'No models returned — check the key/endpoint, or type a preferred model below.'
                    : 'Enter your key above, then Fetch to load the models it unlocks.'}
                </div>
                {api.probedModels.length ? (
                  <>
                    <div className="row-between">
                      <input className="ctl flex-1" placeholder={`Search ${api.probedModels.length} models…`} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} />
                      <label className="check-row no-shrink" style={{ fontSize: 12.5, fontWeight: 600 }}>
                        <input type="checkbox" checked={allFilteredChecked}
                          ref={(el) => { if (el) el.indeterminate = someFilteredChecked && !allFilteredChecked; }}
                          onChange={toggleAllFiltered} />
                        <span>{allFilteredChecked ? 'Deselect all' : 'Select all'}{modelFilter.trim() ? ` (${filteredModels.length})` : ''}</span>
                      </label>
                    </div>
                    <div className="scroll-list">
                      {filteredModels.length === 0 ? <div className="set-desc set-desc--flush">No models match “{modelFilter}”.</div> : null}
                      {filteredModels.map((m) => {
                        const checked = selectedModels.includes(m);
                        const isDefault = checked && m === defaultModel;
                        return (
                          <div key={m} className={`list-row-card${checked ? ' selected' : ''}${isDefault ? ' default' : ''}`}>
                            <label className="check-row flex-1">
                              <input type="checkbox" checked={checked} onChange={() => setSelectedModels((cur) => cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m])} />
                              <span className="truncate">{m}</span>
                            </label>
                            {checked ? (isDefault
                              ? <span className="pc-tag default no-shrink">★ Preferred</span>
                              : <button type="button" className="btn btn--chip no-shrink" title="Use as this provider's preferred model" onClick={() => setProvDraft((d) => ({ ...d, model: m }))}>Set preferred</button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <div className="set-desc set-desc--mt2">When every fetched model is selected, no model limit is saved. Uncheck models only when you want this provider to expose a smaller set.</div>
                  </>
                ) : (
                  <>
                    <input className="ctl" placeholder="preferred model (type one, or Fetch above)" list="ws12-provider-models" value={provDraft.model} onChange={(e) => setProvDraft((d) => ({ ...d, model: e.target.value }))} />
                    <datalist id="ws12-provider-models">
                      {(editingProvider ? (api.providerModels[editingProvider] ?? []) : api.endpointModels).map((m) => <option key={m} value={m} />)}
                    </datalist>
                  </>
                )}

                {!canConnect ? (
                  <div className="set-desc set-desc--mt2 set-desc--warn">
                    {!provDraft.name.trim() ? 'Enter a display name to connect.' : 'Pick at least one model — or type a preferred model — to connect.'}
                  </div>
                ) : null}
                <div className="set-actions">
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
                        models: api.probedModels.length > 0 && selectedModels.length === api.probedModels.length ? [] : selectedModels,
                        cachedModels: api.probedModels,
                        apiVersion: provDraft.apiVersion.trim(),
                        free: provDraft.free || catalogLocal,
                        passthroughUnknown: provDraft.passthroughUnknown,
                      });
                      setProvModalOpen(false);
                      setEditingProvider(null);
                      setProvDraft({ name: '', provider: 'openai', endpoint: '', apiKey: '', model: '', apiVersion: '', free: false, passthroughUnknown: false });
                      setSelectedModels([]);
                      api.onProbeReset();
                      setTimeout(refreshSnapshot, 80);
                    }}>{editingProvider ? 'Save provider' : 'Connect'}</button>
                </div>
              </div>
            </div>
          </div>
        ), document.body);
      })() : null}

      {modelsTab === 'personal' && confirmDeleteProvider ? createPortal((
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteProvider(null); }}>
          <div className="dialog dangerous dialog--narrow">
            <div className="dialog-title">Remove “{confirmDeleteProvider}”?</div>
            <div className="set-desc set-desc--mb12">Deletes the saved provider and its stored key. Sub-agents routed to it fall back to the main primary route.</div>
            <div className="set-actions">
              <button className="btn" onClick={() => setConfirmDeleteProvider(null)}>Cancel</button>
              <button className="btn primary" onClick={() => { api.onAction('a-rmprov', 'action:remove-provider', { name: confirmDeleteProvider }); setConfirmDeleteProvider(null); setTimeout(refreshSnapshot, 80); }}>Remove</button>
            </div>
          </div>
        </div>
      ), document.body) : null}

      {modelsTab === 'routing' ? (() => {
        if (providerFormatRows.length === 0) return null;
        return (
          <div className="wire-format-section">
            <div className="set-h2">Wire format (per provider)</div>
            <div className="set-desc set-desc--mb8">Automatic follows BrainRouter's provider contract. Responses uses <code>/v1/responses</code> when the selected model can use it.</div>
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
      })() : null}

      {modelsTab === 'profiles' ? (
      <div id="models-panel-profiles" role="tabpanel" aria-labelledby="models-tab-profiles">
      <LlmProfilesCard
        profiles={(knobs.llmProfiles ?? {}) as Record<string, { model?: string; endpoint?: string; reasoningEffort?: string; fast?: boolean }>}
        active={String(knobs.activeLlmProfile ?? '')}
        endpointModels={api.endpointModels}
        routerCatalog={routerCatalog}
        setPath={setPath}
      />
      </div>
      ) : null}

      {modelsTab === 'subagents' ? (
      <div id="models-panel-subagents" role="tabpanel" aria-labelledby="models-tab-subagents">
      <div className="set-h2">Sub-agent models</div>
      <div className="set-desc set-desc--mb6">Optional routing for spawned agents. Leave roles unset to inherit the main primary route. Pick a bare model to let the router choose a provider, or pick provider/model to pin one.</div>
      {SUBAGENT_ROLES.map((role) => {
        const cur = snapshot?.agentModels?.find((a) => a.role === role);
        const fallback = role === 'default' ? null : snapshot?.agentModels?.find((a) => a.role === 'default');
        const curRequest = roleRequestFor(cur?.provider, cur?.model);
        const d = roleDraft[role] ?? { request: curRequest };
        const setD = (request: string): void => setRoleDraft((r) => ({ ...r, [role]: { request } }));
        const options = routerRoleOptions.some((option) => option.value === d.request)
          ? routerRoleOptions
          : [{ value: d.request, label: d.request, detail: 'provider removed or model unavailable' }, ...routerRoleOptions];
        const curText = cur ? roleRequestFor(cur.provider, cur.model) : '';
        const isRedundantFallback = role === 'default' && !!cur && d.request === 'inherit';
        const desc = cur
          ? (role === 'default'
              ? (isRedundantFallback ? `same as primary route; clear it so sub-agents follow future primary changes` : `fallback: ${curText}`)
              : `route: ${curText}`)
          : (role === 'default'
              ? 'unset; unconfigured sub-agents inherit the main primary route'
              : (fallback ? `inherits fallback: ${roleRequestFor(fallback.provider, fallback.model)}` : 'inherits the main primary route'));
        return (
          <Row key={role} title={SUBAGENT_ROLE_LABELS[role]} desc={desc}>
            <ChoiceControl value={d.request} options={options as ChoiceOption[]} onChange={setD} />
            <button className="btn" onClick={() => {
              const { provider, model } = assignmentForRequest(d.request);
              api.onAction('a-setrole', 'action:set-agent-model', { role, provider, model });
              setRoleDraft((r) => { const n = { ...r }; delete n[role]; return n; });
              refreshSnapshot();
            }}>{d.request === 'inherit' ? 'Clear' : 'Save'}</button>
          </Row>
        );
      })}
      </div>
      ) : null}
    </div>
  );
}
