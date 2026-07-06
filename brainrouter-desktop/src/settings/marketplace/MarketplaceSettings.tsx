import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../icons.js';
import { Row } from '../shared/controls.js';
import {
  CATEGORIES,
  describeProvides,
  type MarketplaceState,
  type RegistrySearchHit,
} from './types.js';

/**
 * PLUGIN-MARKETPLACE P4-desktop — the Marketplace panel.
 *
 * Reuses the connectors catalog UI language (source cards + configured grid +
 * portaled dialog). Two tabs:
 *   - Browse    — search the hosted registry, filter by category/tag, sort by
 *                 stars / lastUpdated; each card shows a "provides" badge line and
 *                 an Install action that opens the consent dialog first.
 *   - Installed — the on-disk plugins with enable/disable toggles, update badges,
 *                 and remove.
 * All fs/git work happens in the host (pluginBridge); this component only fires
 * `onAction(...)` queries and renders the state slice threaded from App.
 */
export function MarketplaceSettings({ market, onAction, refreshInstalled, refreshSearch }: {
  market: MarketplaceState;
  onAction: (id: string, name: string, args?: Record<string, unknown>) => void;
  refreshInstalled: () => void;
  refreshSearch: (args: { query: string; category?: string; tag?: string }) => void;
}): React.ReactElement {
  const [tab, setTab] = useState<'browse' | 'installed'>('browse');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<'stars' | 'updated'>('stars');
  const [manualSource, setManualSource] = useState('');
  // Local "searching" so the spinner shows on fire and clears when hits arrive —
  // the host is fire-and-forget; results land in the market slice asynchronously.
  const [searching, setSearching] = useState(false);
  React.useEffect(() => { setSearching(false); }, [market.hits, market.error]);
  // Populate on first open: load the installed list, and browse the registry so
  // the default Browse tab isn't blank.
  React.useEffect(() => {
    refreshInstalled();
    if (!market.hits) { setSearching(true); refreshSearch({ query: '' }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSearch = (): void => { setSearching(true); refreshSearch({ query: query.trim(), category: category || undefined, tag: tag.trim() || undefined }); };

  // Browse hits are ranked server-side by relevance then stars; a secondary
  // client sort lets the user flip to "recently updated" without a re-fetch.
  const hits = useMemo<RegistrySearchHit[]>(() => {
    const list = market.hits ?? [];
    if (sort === 'stars') return list;
    return [...list].sort((a, b) => (b.entry.lastUpdated ?? '').localeCompare(a.entry.lastUpdated ?? ''));
  }, [market.hits, sort]);

  const consent = market.consent;
  const confirmConsent = (): void => {
    if (!consent) return;
    if (consent.action === 'install') {
      onAction('a-plugin-install', 'action:plugin-install', { name: consent.plugin, scope: consent.scope });
    } else {
      onAction('a-plugin-enable', 'action:plugin-enable', { name: consent.plugin, enabled: true });
    }
    // The consent dialog also records shell/MCP approval when the user ticks it
    // in the dialog (handled by the checkbox handlers below via a-plugin-consent-set).
    onAction('a-plugin-consent-close', 'plugin-consent-close');
    setTimeout(refreshInstalled, 400);
  };
  const cancelConsent = (): void => onAction('a-plugin-consent-close', 'plugin-consent-close');

  const askConsent = (plugin: string, action: 'install' | 'enable', scope: 'user' | 'workspace' = 'user'): void => {
    onAction('a-plugin-consent', 'plugin-consent', { name: plugin, action, scope });
  };

  return (
    <>
      <div className="set-h">Marketplace</div>
      <div className="set-desc" style={{ marginBottom: 10 }}>
        Discover and install plugins — bundles of skills, agents, commands, hooks, MCP servers, connectors, and workflows.
        Executable capabilities (shell hooks, MCP servers) stay disabled until you approve them.
      </div>

      <div className="models-subtabs" style={{ marginBottom: 12 }}>
        <button type="button" className={`models-subtab${tab === 'browse' ? ' active' : ''}`} onClick={() => { setTab('browse'); if (!market.hits) runSearch(); }}>Browse</button>
        <button type="button" className={`models-subtab${tab === 'installed' ? ' active' : ''}`} onClick={() => { setTab('installed'); refreshInstalled(); }}>Installed{market.installed?.length ? ` (${market.installed.length})` : ''}</button>
      </div>

      {tab === 'browse' ? (
        <>
          <Row title="Search" desc="Search the hosted plugin registry by name, tag, or description.">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 320 }}>
              <input
                className="ctl"
                value={query}
                placeholder="e.g. devkit, review, jira"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              />
              <button className="btn" onClick={runSearch}>Search</button>
            </div>
          </Row>
          <Row title="Filter & sort" desc="Narrow by category or tag; sort by popularity or freshness.">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select className="ctl" value={category} onChange={(e) => { setCategory(e.target.value); setTimeout(runSearch, 0); }}>
                <option value="">All categories</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input className="ctl mono" style={{ maxWidth: 160 }} value={tag} placeholder="tag" spellCheck={false} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }} />
              <select className="ctl" value={sort} onChange={(e) => setSort(e.target.value as 'stars' | 'updated')}>
                <option value="stars">Sort: Stars</option>
                <option value="updated">Sort: Recently updated</option>
              </select>
            </div>
          </Row>

          {market.error ? <div className="pc-host" style={{ color: 'var(--warn)', margin: '6px 0' }}>{market.error}</div> : null}
          {searching ? <div className="empty">Searching the registry…</div> : null}
          {!searching && market.hits && hits.length === 0 && !market.error ? <div className="empty">No plugins in the registry yet. Point at a different index under <b>Scope &amp; sources → Registry URL</b> below, or publish one with <code>brainrouter plugin publish</code>.</div> : null}

          {hits.length ? (
            <div className="provider-gallery connector-configured-grid">
              {hits.map((hit) => {
                const e = hit.entry;
                const installed = market.installed?.find((p) => p.name.toLowerCase() === e.name.toLowerCase() || p.name.toLowerCase() === e.id.toLowerCase());
                return (
                  <div key={e.id} className="provider-card saved">
                    <span className="pc-name">
                      {e.name}
                      {e.version ? <span className="pc-tag default">v{e.version}</span> : null}
                      {installed ? <span className="pc-tag ok">installed</span> : null}
                    </span>
                    <span className="pc-host">{e.author ? `${e.author} · ` : ''}{e.category ?? 'plugin'} · ★ {e.stars}{e.lastUpdated ? ` · ${e.lastUpdated}` : ''}</span>
                    {e.description ? <span className="pc-wire">{e.description}</span> : null}
                    <span className="pc-wire">provides: {describeProvides(e.provides)}</span>
                    {e.tags.length ? <span className="pc-wire">{e.tags.map((t) => `#${t}`).join(' ')}</span> : null}
                    <span className="pc-actions">
                      {installed ? (
                        <button className="btn" disabled>Installed</button>
                      ) : (
                        <button className="btn primary" onClick={() => askConsent(e.id, 'install')}>Install</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="set-h2">Install from source</div>
          <Row title="Local path or git URL" desc="Install a plugin directly from a folder or a git repository (git+https://…#tag).">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 320 }}>
              <input className="ctl mono" value={manualSource} placeholder="/path/to/plugin or git+https://github.com/u/r.git#v1" spellCheck={false} onChange={(e) => setManualSource(e.target.value)} />
              <button className="btn" disabled={!manualSource.trim()} onClick={() => { onAction('a-plugin-install', 'action:plugin-install', { source: manualSource.trim(), scope: 'user' }); setManualSource(''); setTimeout(refreshInstalled, 400); }}>Install</button>
            </div>
          </Row>
        </>
      ) : (
        <>
          {market.installed === null ? <div className="empty">Loading installed plugins…</div> : null}
          {market.installed && market.installed.length === 0 ? <div className="empty">No plugins installed yet. Browse the registry to install one.</div> : null}
          {market.installed && market.installed.length ? (
            <div className="provider-gallery connector-configured-grid">
              {market.installed.map((p) => (
                <div key={`${p.scope}:${p.name}`} className="provider-card saved">
                  <span className="pc-name">
                    {p.name}
                    {p.version ? <span className="pc-tag default">v{p.version}</span> : null}
                    <span className={`pc-tag ${p.enabled ? 'ok' : 'default'}`}>{p.enabled ? 'enabled' : 'disabled'}</span>
                    {p.readOnly ? <span className="pc-tag default">read-only</span> : null}
                    {p.updateAvailable ? <span className="pc-tag danger">update → v{p.updateAvailable}</span> : null}
                  </span>
                  <span className="pc-host">{p.author ? `${p.author} · ` : ''}{p.scope} scope{p.category ? ` · ${p.category}` : ''}</span>
                  {p.description ? <span className="pc-wire">{p.description}</span> : null}
                  <span className="pc-wire">provides: {describeProvides(p.provides)}</span>
                  {p.requiresConsent ? (
                    <span className="pc-wire" style={{ color: p.shellApproved && p.mcpApproved ? undefined : 'var(--warn)' }}>
                      executable capabilities — shell {p.shellApproved ? '✓' : '✗'} · MCP {p.mcpApproved ? '✓' : '✗'}
                    </span>
                  ) : null}
                  <span className="pc-actions">
                    <button className="btn" disabled={p.readOnly} onClick={() => {
                      if (!p.enabled) { askConsent(p.name, 'enable', p.scope === 'workspace' ? 'workspace' : 'user'); return; }
                      onAction('a-plugin-enable', 'action:plugin-enable', { name: p.name, enabled: false });
                      setTimeout(refreshInstalled, 250);
                    }}>{p.enabled ? 'Disable' : 'Enable'}</button>
                    {p.requiresConsent && !p.shellApproved ? (
                      <button className="btn" disabled={p.readOnly} onClick={() => { onAction('a-plugin-consent-set', 'action:plugin-consent-set', { name: p.name, shell: true }); setTimeout(refreshInstalled, 250); }}>Trust shell</button>
                    ) : null}
                    {p.requiresConsent && !p.mcpApproved ? (
                      <button className="btn" disabled={p.readOnly} onClick={() => { onAction('a-plugin-consent-set', 'action:plugin-consent-set', { name: p.name, mcp: true }); setTimeout(refreshInstalled, 250); }}>Trust MCP</button>
                    ) : null}
                    {p.updateAvailable ? (
                      <button className="btn primary" disabled={p.readOnly} onClick={() => { onAction('a-plugin-install', 'action:plugin-install', { name: p.name, scope: p.scope === 'workspace' ? 'workspace' : 'user', force: true }); setTimeout(refreshInstalled, 500); }}>Update</button>
                    ) : null}
                    <button className="btn danger" disabled={p.readOnly} onClick={() => { onAction('a-plugin-remove', 'action:plugin-remove', { name: p.name, scope: p.scope === 'workspace' ? 'workspace' : 'user' }); setTimeout(refreshInstalled, 250); }}>Remove</button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {consent ? createPortal((
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) cancelConsent(); }}>
          <div className="dialog" style={{ width: 520, maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="dialog-title" style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 'none' }}>
              <Icon name="plug" size={22} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span>{consent.action === 'install' ? 'Install' : 'Enable'} {consent.summary.name}{consent.summary.version ? ` v${consent.summary.version}` : ''}</span>
                <span className="set-desc" style={{ margin: 0, fontWeight: 400 }}>Review what this plugin contributes before {consent.action === 'install' ? 'installing' : 'enabling'} it.</span>
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 2px' }}>
              <div className="set-desc" style={{ marginBottom: 10 }}>{consent.summary.disclosure}</div>
              <div className="pc-wire" style={{ marginBottom: 8 }}>Provides: {describeProvides(consent.summary.provides)}</div>
              {consent.summary.compatibilityWarnings.map((w, i) => (
                <div key={i} className="pc-host" style={{ color: 'var(--warn)', marginBottom: 4 }}>⚠ {w}</div>
              ))}
              {consent.summary.hookCommands.length ? (
                <>
                  <div className="set-h2" style={{ marginTop: 8 }}>Shell hooks</div>
                  {consent.summary.hookCommands.map((h, i) => (
                    <div key={i} className="pc-wire mono" style={{ color: 'var(--warn)' }}>{h.label}: {h.command}</div>
                  ))}
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <input type="checkbox" defaultChecked={consent.summary.shellApproved} onChange={(e) => onAction('a-plugin-consent-set', 'action:plugin-consent-set', { name: consent.plugin, shell: e.target.checked })} />
                    Approve running these shell commands
                  </label>
                </>
              ) : null}
              {consent.summary.mcpCommands.length ? (
                <>
                  <div className="set-h2" style={{ marginTop: 8 }}>MCP servers</div>
                  {consent.summary.mcpCommands.map((m, i) => (
                    <div key={i} className="pc-wire mono" style={{ color: 'var(--warn)' }}>{m.label}: {m.command}</div>
                  ))}
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <input type="checkbox" defaultChecked={consent.summary.mcpApproved} onChange={(e) => onAction('a-plugin-consent-set', 'action:plugin-consent-set', { name: consent.plugin, mcp: e.target.checked })} />
                    Approve launching these MCP servers
                  </label>
                </>
              ) : null}
              {!consent.summary.requiresConsent ? (
                <div className="pc-wire" style={{ color: 'var(--ok, inherit)' }}>No executable (shell / MCP) capabilities — safe to enable.</div>
              ) : null}
            </div>
            <div className="set-actions" style={{ marginTop: 0, paddingTop: 12, flex: 'none' }}>
              <button className="btn primary" onClick={confirmConsent}>{consent.action === 'install' ? 'Install' : 'Enable'}</button>
              <button className="btn" onClick={cancelConsent}>Cancel</button>
            </div>
          </div>
        </div>
      ), document.body) : null}
    </>
  );
}
