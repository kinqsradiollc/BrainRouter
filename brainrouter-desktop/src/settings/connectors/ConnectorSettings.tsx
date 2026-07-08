import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConnectorDefinitionBundle, ConnectorRecord } from '@kinqs/brainrouter-types';
import { Icon } from '../../icons.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import { Row, ChoiceControl } from '../shared/controls.js';
import { GithubIntegration } from '../github/GithubIntegration.js';
import { GithubRepoPicker } from '../github/GithubRepoPicker.js';
import {
  connectorConfigString,
  connectorConfigList,
  splitConnectorRepos,
  CHECKPOINT_RUNTIME_SOURCES,
  type ConfigSnapshot,
  type GithubIntegrationSnapshot,
  type GithubSaveArgs,
  type GithubOauthState,
} from '../shared/types.js';

export function ConnectorSettings({ connectors, githubIntegration, githubOauthClientId, onGithubSave, onAction, refreshSnapshot }: {
  connectors: NonNullable<ConfigSnapshot['connectors']>;
  githubIntegration: GithubIntegrationSnapshot;
  githubOauthClientId: string;
  onGithubSave: (args: GithubSaveArgs) => void;
  onAction: (id: string, name: string, args?: Record<string, unknown>) => void;
  refreshSnapshot: () => void;
}): React.ReactElement {
  const github = connectors.catalog.find((entry) => entry.source === 'github');
  const firstGithub = connectors.items.find((item) => item.source === 'github');
  const [selectedSource, setSelectedSource] = useState(firstGithub?.source ?? 'github');
  const selectedEntry = connectors.catalog.find((entry) => entry.source === selectedSource) ?? github ?? connectors.catalog[0];
  const [name, setName] = useState(firstGithub?.name ?? 'GitHub connector');
  const [owner, setOwner] = useState(firstGithub ? connectorConfigString(firstGithub, 'owner') : '');
  const [repos, setRepos] = useState(firstGithub ? connectorConfigList(firstGithub, 'repositories').join('\n') : '');
  const [includeIssues, setIncludeIssues] = useState(firstGithub ? firstGithub.config.includeIssues !== false : true);
  const [includePrs, setIncludePrs] = useState(firstGithub ? firstGithub.config.includePullRequests !== false : true);
  const [includeFiles, setIncludeFiles] = useState(Boolean(firstGithub?.config.includeFiles));
  const [pollMinutes, setPollMinutes] = useState(firstGithub && typeof firstGithub.config.pollMinutes === 'number' ? String(firstGithub.config.pollMinutes) : '');
  const [baseUrl, setBaseUrl] = useState(firstGithub ? connectorConfigString(firstGithub, 'baseUrl') : '');
  const [credentialMode, setCredentialMode] = useState(firstGithub?.credential.mode ?? 'dynamic');
  const [credentialRef, setCredentialRef] = useState(firstGithub?.credential.ref ?? 'gh');
  const [genericName, setGenericName] = useState('');
  const [genericCredentialMode, setGenericCredentialMode] = useState('none');
  const [genericCredentialRef, setGenericCredentialRef] = useState('');
  const [genericConfig, setGenericConfig] = useState<Record<string, string | boolean>>({});
  const [definitionJson, setDefinitionJson] = useState('');
  const [oauthState, setOauthState] = useState<GithubOauthState>({ status: 'idle' });
  // Connector config moved out of the inline panel into a modal (matching the
  // Models provider dialog): a catalog card / "Configure" opens this editor.
  const [editorOpen, setEditorOpen] = useState(false);
  // The connector form is tall (GitHub config + Track sync); always open the
  // dialog scrolled to its title rather than wherever a re-render left it.
  const editorRef = useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (editorOpen) editorRef.current?.scrollTo({ top: 0 }); }, [editorOpen, selectedSource]);

  React.useEffect(() => {
    if (!firstGithub) return;
    setName(firstGithub.name);
    setOwner(connectorConfigString(firstGithub, 'owner'));
    setRepos(connectorConfigList(firstGithub, 'repositories').join('\n'));
    setIncludeIssues(firstGithub.config.includeIssues !== false);
    setIncludePrs(firstGithub.config.includePullRequests !== false);
    setIncludeFiles(Boolean(firstGithub.config.includeFiles));
    setPollMinutes(typeof firstGithub.config.pollMinutes === 'number' ? String(firstGithub.config.pollMinutes) : '');
    setBaseUrl(connectorConfigString(firstGithub, 'baseUrl'));
    setCredentialMode(firstGithub.credential.mode);
    setCredentialRef(firstGithub.credential.ref ?? (firstGithub.credential.mode === 'dynamic' ? 'gh' : ''));
  }, [firstGithub?.id, firstGithub?.updatedAt]);

  React.useEffect(() => {
    // Server-mediated OAuth: the GitHub token lives in your BrainRouter account,
    // not on this machine. Reflect whether it's connected (requires being signed in).
    void bridgeQuery<{ signedIn?: boolean; connected?: boolean }>('github-connect-status')
      .then((res) => setOauthState({ status: 'idle', hasToken: !!res.connected, storageMode: 'BrainRouter account' }))
      .catch(() => setOauthState({ status: 'idle' }));
  }, [firstGithub?.id, firstGithub?.credential.mode, firstGithub?.updatedAt]);

  React.useEffect(() => {
    if (!selectedEntry || selectedEntry.source === 'github') return;
    setGenericName(`${selectedEntry.title} connector`);
    setGenericCredentialMode(selectedEntry.credentialModes[0] ?? 'none');
    setGenericCredentialRef('');
    setGenericConfig(Object.fromEntries(selectedEntry.configFields.map((field) => [
      field.key,
      field.type === 'boolean' ? Boolean(field.defaultValue) : field.defaultValue == null ? '' : String(field.defaultValue),
    ])));
  }, [selectedEntry?.source]);

  const selectedGithubRepos = splitConnectorRepos(repos);
  const saveGithubConnector = (): void => {
    const poll = Number(pollMinutes);
    const ownerHint = owner.trim() || selectedGithubRepos[0]?.split('/')[0] || '';
    const config = {
      owner: ownerHint,
      repositories: selectedGithubRepos,
      includeIssues,
      includePullRequests: includePrs,
      includeFiles,
      pollMinutes: pollMinutes.trim() && Number.isFinite(poll) && poll > 0 ? Math.max(1, Math.floor(poll)) : null,
      baseUrl: baseUrl.trim() || null,
    };
    const credential = {
      mode: credentialMode,
      ref: credentialMode === 'oauth' ? 'github-oauth' : credentialRef.trim() || (credentialMode === 'dynamic' ? 'gh' : undefined),
      label: credentialMode === 'dynamic' ? 'GitHub CLI' : credentialMode === 'oauth' ? 'GitHub OAuth' : undefined,
      hasSecret: credentialMode === 'static' || (credentialMode === 'oauth' && (oauthState.status === 'authorized' || (oauthState.status === 'idle' && oauthState.hasToken === true))),
    };
    if (firstGithub) {
      onAction('a-connector-update', 'action:connector-update', {
        id: firstGithub.id,
        patch: { name: name.trim() || 'GitHub connector', config, credential, flows: github?.flows ?? firstGithub.flows },
      });
    } else {
      onAction('a-connector-create', 'action:connector-create', {
        source: 'github',
        name: name.trim() || 'GitHub connector',
        config,
        credential,
        flows: github?.flows ?? ['load', 'checkpoint', 'slim', 'permission-sync'],
      });
    }
    setTimeout(refreshSnapshot, 120);
  };
  const canSave = Boolean(github && (owner.trim() || selectedGithubRepos.length) && (includeIssues || includePrs || includeFiles));

  const markGithubOauthCredential = (hasSecret: boolean): void => {
    if (!firstGithub) return;
    onAction('a-connector-update', 'action:connector-update', {
      id: firstGithub.id,
      patch: { credential: { mode: 'oauth', ref: 'github-oauth', label: 'GitHub OAuth', hasSecret } },
    });
    setCredentialMode('oauth');
    setCredentialRef('github-oauth');
    setTimeout(refreshSnapshot, 120);
  };

  // Connect GitHub through BrainRouter's server-mediated broker (device flow). No
  // client id/secret on this machine; the token is stored in your account. Requires
  // being signed in (Settings → Account).
  const startGithubOauth = async (): Promise<void> => {
    setOauthState({ status: 'starting' });
    try {
      const res = await bridgeQuery<{ ok: boolean; userCode?: string; verificationUri?: string; interval?: number; error?: string }>('github-device-start');
      if (!res.ok || !res.userCode) {
        setOauthState({ status: 'error', error: res.error || 'Sign in to your BrainRouter account (Settings → Account) to connect GitHub.' });
        return;
      }
      const uri = res.verificationUri || 'https://github.com/login/device';
      setOauthState({ status: 'pending', userCode: res.userCode, verificationUri: uri, intervalSec: Number(res.interval) > 0 ? Number(res.interval) : 5, expiresAtMs: Date.now() + 15 * 60_000 });
      await bridgeQuery('action:open-external', { url: uri });
    } catch (e) {
      setOauthState({ status: 'error', error: e instanceof Error ? e.message : 'Could not start the GitHub connection.' });
    }
  };

  const cancelGithubOauth = async (): Promise<void> => {
    setOauthState({ status: 'idle' });
  };

  const disconnectGithubOauth = async (): Promise<void> => {
    await bridgeQuery('action:github-disconnect').catch(() => undefined);
    markGithubOauthCredential(false);
    setOauthState({ status: 'idle', hasToken: false });
  };

  React.useEffect(() => {
    if (oauthState.status !== 'pending') return;
    const delay = Math.max(1, oauthState.intervalSec) * 1000;
    const timer = window.setTimeout(() => {
      void bridgeQuery<{ status?: string; login?: string }>('github-device-poll').then((res) => {
        // Re-trigger the effect (new object) so polling continues until authorized.
        if (res.status === 'pending') { setOauthState((cur) => (cur.status === 'pending' ? { ...cur } : cur)); return; }
        if (res.status === 'connected') { markGithubOauthCredential(true); setOauthState({ status: 'authorized', storageMode: 'BrainRouter account' }); setTimeout(refreshSnapshot, 120); return; }
        setOauthState({ status: 'error', error: 'That code expired — click Connect to try again.' });
      }).catch((err) => setOauthState({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [oauthState]);

  const saveGenericConnector = (): void => {
    if (!selectedEntry || selectedEntry.source === 'github') return;
    const config = Object.fromEntries(selectedEntry.configFields.map((field) => {
      const raw = genericConfig[field.key];
      if (field.type === 'boolean') return [field.key, raw === true];
      if (field.type === 'number') {
        const n = Number(raw);
        return [field.key, Number.isFinite(n) && n > 0 ? n : null];
      }
      if (field.type === 'string-list') {
        const text = typeof raw === 'string' ? raw : '';
        return [field.key, text.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)];
      }
      return [field.key, typeof raw === 'string' ? raw.trim() || null : null];
    }));
    onAction('a-connector-create', 'action:connector-create', {
      source: selectedEntry.source,
      name: genericName.trim() || `${selectedEntry.title} connector`,
      config,
      credential: {
        mode: genericCredentialMode,
        ref: genericCredentialRef.trim() || undefined,
        hasSecret: genericCredentialMode === 'static',
      },
      flows: selectedEntry.flows,
    });
    setTimeout(refreshSnapshot, 150);
  };
  const exportDefinitions = (): void => {
    const bundle: ConnectorDefinitionBundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      connectors: connectors.items.map((connector) => ({
        source: connector.source,
        name: connector.name,
        description: connector.description,
        config: { ...connector.config },
        credential: { ...connector.credential },
        flows: [...connector.flows],
      })),
    };
    setDefinitionJson(JSON.stringify(bundle, null, 2));
  };
  const importDefinitions = (): void => {
    if (!definitionJson.trim()) return;
    onAction('a-connector-import-definitions', 'action:connector-import-definitions', { json: definitionJson });
    setTimeout(refreshSnapshot, 200);
  };

  return (
    <>
      <div className="set-h">Connectors</div>
      <div className="set-desc" style={{ marginBottom: 10 }}>Workspace data connectors for indexed sources, Track sync, permissions, and recall. MCP tool servers live in <b>MCP Servers</b>.</div>

      <div className="connector-shell">
        <div className="connector-catalog">
          {connectors.catalog.map((entry) => {
            const configured = connectors.items.filter((item) => item.source === entry.source).length;
            const ready = CHECKPOINT_RUNTIME_SOURCES.has(entry.source);
            return (
              <button
                key={entry.source}
                type="button"
                disabled={!ready}
                title={ready ? undefined : `${entry.title} connector — coming soon`}
                className={`connector-source-card${entry.source === selectedSource ? ' active' : ''}${ready ? '' : ' is-soon'}`}
                onClick={ready ? () => { setSelectedSource(entry.source); setEditorOpen(true); } : undefined}
              >
                <span className="connector-source-top">
                  <span className="connector-source-title">{entry.title}</span>
                  <span className={`connector-source-badge${ready ? ' ready' : ' soon'}`}>{ready ? 'runtime' : 'Coming soon'}</span>
                </span>
                <span className="connector-source-desc">{entry.description}</span>
                <span className="connector-source-meta">{entry.flows.join(' · ')}{configured ? ` · ${configured} configured` : ''}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="set-h2">Configured</div>
      {connectors.items.length === 0 ? <div className="empty">No connectors configured yet.</div> : null}
      {connectors.items.length ? (
        <div className="provider-gallery connector-configured-grid">
          {connectors.items.map((connector) => (
            <div key={connector.id} className="provider-card saved">
              <span className="pc-name">{connector.name}<span className={`pc-tag ${connector.status === 'active' ? 'ok' : connector.status === 'error' ? 'danger' : 'default'}`}>{connector.status}</span></span>
              <span className="pc-host">{connector.source} · {connector.flows.join(', ')}</span>
              <span className="pc-wire">
                {connector.lastSuccessAt ? `last success ${new Date(connector.lastSuccessAt).toLocaleString()}` : connector.lastRunAt ? `last run ${new Date(connector.lastRunAt).toLocaleString()}` : 'not run yet'}
              </span>
              <span className="pc-wire">{(connectors.documentCounts?.[connector.id] ?? 0).toLocaleString()} documents</span>
              <span className="pc-wire">{(connectors.permissionCounts?.[connector.id] ?? 0).toLocaleString()} permissions</span>
              {typeof connector.config.pollMinutes === 'number' && connector.config.pollMinutes > 0 ? <span className="pc-wire">auto every {connector.config.pollMinutes}m</span> : null}
              {(() => {
                const latest = connectors.runPreviews?.[connector.id]?.[0];
                return latest ? (
                  <span className="pc-wire">
                    latest {latest.flow}: {latest.status}{latest.completedAt ? ` · ${new Date(latest.completedAt).toLocaleString()}` : ''}
                  </span>
                ) : null;
              })()}
              {(connectors.documentPreviews?.[connector.id] ?? []).slice(0, 3).map((doc) => (
                <span key={doc.id} className="pc-wire">
                  {doc.kind} · {doc.repository ? `${doc.repository} · ` : ''}{doc.title}
                </span>
              ))}
              {connector.lastError ? <span className="pc-host" style={{ color: 'var(--warn)' }}>{connector.lastError}</span> : null}
              <span className="pc-actions">
                <button className="btn" onClick={() => { setSelectedSource(connector.source); setEditorOpen(true); }}>Configure</button>
                <button className="btn" onClick={() => {
                  onAction('a-connector-update', 'action:connector-update', { id: connector.id, patch: { status: connector.status === 'paused' ? 'active' : 'paused' } });
                  setTimeout(refreshSnapshot, 120);
                }}>{connector.status === 'paused' ? 'Resume' : 'Pause'}</button>
                {connector.source === 'github' ? <button className="btn" onClick={() => { onAction('a-connector-validate', 'action:connector-validate', { id: connector.id }); setTimeout(refreshSnapshot, 700); }}>Validate</button> : null}
                {CHECKPOINT_RUNTIME_SOURCES.has(connector.source) ? <button className="btn" onClick={() => { onAction('a-connector-run', 'action:connector-run', { id: connector.id }); setTimeout(refreshSnapshot, 1200); }}>Run</button> : null}
                <button className="btn" disabled={(connectors.documentCounts?.[connector.id] ?? 0) === 0} title="Send stored connector documents to the active BrainRouter memory server for recall" onClick={() => { onAction('a-connector-index-memory', 'action:connector-index-memory', { id: connector.id }); setTimeout(refreshSnapshot, 700); }}>Index memory</button>
                {connector.source === 'github' ? <button className="btn" onClick={() => { onAction('a-connector-sync-permissions', 'action:connector-sync-permissions', { id: connector.id }); setTimeout(refreshSnapshot, 1200); }}>Sync permissions</button> : null}
                <button className="btn danger" onClick={() => { onAction('a-connector-delete', 'action:connector-delete', { id: connector.id }); setTimeout(refreshSnapshot, 120); }}>Remove</button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="set-h2">Import / export</div>
      <Row title="Connector definitions" desc="Portable connector setup JSON. Runtime ids, runs, checkpoints, documents, permissions, and secret values are not included.">
        <div style={{ display: 'grid', gap: 8, minWidth: 320 }}>
          <textarea className="ctl mono" rows={5} value={definitionJson} onChange={(e) => setDefinitionJson(e.target.value)} placeholder="Export definitions here or paste a connector bundle to import." spellCheck={false} />
          <span className="pc-actions">
            <button className="btn" disabled={connectors.items.length === 0} onClick={exportDefinitions}>Export definitions</button>
            <button className="btn" disabled={!definitionJson.trim()} onClick={importDefinitions}>Import definitions</button>
          </span>
        </div>
      </Row>

      {github ? (
        <>
          <div className="set-h2">GitHub Track sync</div>
          <div className="set-desc" style={{ marginBottom: 8 }}>Track issue import/export uses the same GitHub area. Connector-backed repositories are listed here, while write tokens remain local to this machine.</div>
          <GithubIntegration gh={githubIntegration} onSave={onGithubSave} />
        </>
      ) : null}

      {editorOpen && selectedEntry ? createPortal((
        // Portal to <body>: the Settings modal carries a transient `transform`
        // (the popIn animation) which would make this fixed overlay resolve
        // against — and get clipped by — the settings-modal box (height 660px,
        // overflow:hidden), cutting a tall connector form off at top and bottom.
        // Rendering at the document root keeps it anchored to the real viewport.
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setEditorOpen(false); }}>
          <div className="dialog" style={{ width: 560, maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="dialog-title" style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 'none' }}>
              <Icon name="branch" size={22} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span>{selectedEntry.source === 'github' && firstGithub ? `Configure ${selectedEntry.title}` : `Add ${selectedEntry.title} connector`}</span>
                <span className="set-desc" style={{ margin: 0, fontWeight: 400 }}>{selectedEntry.description}</span>
              </span>
            </div>
            <div ref={editorRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {selectedEntry.source === 'github' ? (
        <>
          <div className="set-h2" style={{ marginTop: 2 }}>GitHub source</div>
          <div className="set-desc" style={{ marginBottom: 8 }}>Configure a GitHub identity and the repositories it can index for memory and Track sync.</div>
          {!github ? <div className="empty">GitHub is not available in the connector catalog.</div> : null}
          <Row title="Name" desc="Local display name for this connector instance.">
            <input className="ctl" value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub connector" />
          </Row>
          <Row title="Owner / organization" desc="Optional hint. Used when no repositories are selected.">
            <input className="ctl mono" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="owner-or-org" spellCheck={false} autoCapitalize="off" />
          </Row>
          <Row title="Repositories" desc="Tick repositories from the connected account. Empty means every accessible repo under the owner hint.">
            <GithubRepoPicker connector={firstGithub} value={selectedGithubRepos} onChange={(next) => {
              setRepos(next.join('\n'));
              if (!owner.trim() && next[0]?.includes('/')) setOwner(next[0].split('/')[0]);
            }} />
          </Row>
          <Row title="Content" desc="Choose what the connector ingests for memory and recall.">
            <div className="connector-toggles">
              <label><input type="checkbox" checked={includeIssues} onChange={(e) => setIncludeIssues(e.target.checked)} /> Issues</label>
              <label><input type="checkbox" checked={includePrs} onChange={(e) => setIncludePrs(e.target.checked)} /> Pull requests</label>
              <label><input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} /> Files</label>
            </div>
          </Row>
          <Row title="Auto run" desc="Optional polling cadence in minutes. Blank disables background connector runs.">
            <input className="ctl mono" type="number" min={1} step={1} value={pollMinutes} onChange={(e) => setPollMinutes(e.target.value)} placeholder="disabled" />
          </Row>
          <Row title="Credential provider" desc="OAuth connects through your BrainRouter account (recommended — no token on this machine). GitHub CLI uses gh auth; Token reads an environment token.">
            <ChoiceControl
              value={credentialMode}
              options={[
                { value: 'dynamic', label: 'GitHub CLI', detail: 'uses gh auth' },
                { value: 'static', label: 'Token reference', detail: 'env/config/keychain ref' },
                { value: 'oauth', label: 'OAuth account', detail: 'device flow' },
              ]}
              onChange={(v) => {
                if (v === 'none' || v === 'static' || v === 'dynamic' || v === 'oauth') setCredentialMode(v);
              }}
            />
          </Row>
          {credentialMode === 'static' ? (
            <Row title="Credential reference" desc="Environment variable name for static tokens.">
              <input className="ctl mono" value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)} placeholder="GITHUB_TOKEN" spellCheck={false} />
            </Row>
          ) : null}
          {credentialMode === 'oauth' ? (
            <Row title="OAuth account" desc={oauthState.status === 'idle' && oauthState.hasToken ? 'Connected through your BrainRouter account.' : 'Connect GitHub through BrainRouter — no token is stored on this machine. Requires being signed in (Account).'}>
              <div style={{ display: 'grid', gap: 8, minWidth: 300 }}>
                {oauthState.status === 'pending' ? (
                  <div className="gh-int-status ok">
                    <span className="gh-int-dot" />
                    <span>Code <b className="mono">{oauthState.userCode}</b> · expires {new Date(oauthState.expiresAtMs).toLocaleTimeString()}</span>
                  </div>
                ) : oauthState.status === 'authorized' ? (
                  <div className="gh-int-status ok"><span className="gh-int-dot" />Connected{oauthState.scope ? ` · ${oauthState.scope}` : ''}</div>
                ) : oauthState.status === 'error' ? (
                  <div className="pc-host" style={{ color: 'var(--warn)' }}>{oauthState.error}</div>
                ) : null}
                {oauthState.status === 'pending' ? <span className="set-desc mono">{oauthState.verificationUri}</span> : null}
                <span className="pc-actions">
                  {oauthState.status === 'pending'
                    ? <button type="button" className="btn" onClick={() => void cancelGithubOauth()}>Cancel</button>
                    : <button type="button" className="btn" disabled={oauthState.status === 'starting'} onClick={() => void startGithubOauth()}>{oauthState.status === 'starting' ? 'Starting...' : (oauthState.status === 'idle' && oauthState.hasToken ? 'Reconnect' : 'Connect')}</button>}
                  {oauthState.status === 'idle' && oauthState.hasToken ? <button type="button" className="btn danger" onClick={() => void disconnectGithubOauth()}>Disconnect</button> : null}
                </span>
              </div>
            </Row>
          ) : null}
          <Row title="GitHub Enterprise URL" desc="Optional API base URL for GitHub Enterprise.">
            <input className="ctl mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://github.example.com/api/v3" spellCheck={false} />
          </Row>
          <div className="set-actions">
            <button className="btn primary" disabled={!canSave} onClick={() => { saveGithubConnector(); setEditorOpen(false); }}>{firstGithub ? 'Update GitHub connector' : 'Add GitHub connector'}</button>
          </div>
        </>
            ) : (
        <>
          <div className="set-h2" style={{ marginTop: 2 }}>{selectedEntry.title}</div>
          <div className="set-desc" style={{ marginBottom: 8 }}>{selectedEntry.description}</div>
          <Row title="Name" desc="Local display name for this connector instance.">
            <input className="ctl" value={genericName} onChange={(e) => setGenericName(e.target.value)} placeholder={`${selectedEntry.title} connector`} />
          </Row>
          {selectedEntry.configFields.map((field) => (
            <Row key={field.key} title={field.label} desc={field.description}>
              {field.type === 'boolean' ? (
                <label className="connector-switch"><input type="checkbox" checked={genericConfig[field.key] === true} onChange={(e) => setGenericConfig((c) => ({ ...c, [field.key]: e.target.checked }))} /> Enabled</label>
              ) : field.type === 'string-list' ? (
                <textarea className="ctl mono" rows={3} value={String(genericConfig[field.key] ?? '')} onChange={(e) => setGenericConfig((c) => ({ ...c, [field.key]: e.target.value }))} spellCheck={false} />
              ) : (
                <input className="ctl mono" type={field.type === 'number' ? 'number' : 'text'} value={String(genericConfig[field.key] ?? '')} onChange={(e) => setGenericConfig((c) => ({ ...c, [field.key]: e.target.value }))} spellCheck={false} />
              )}
            </Row>
          ))}
          <Row title="Credential provider" desc="Credential handling is source-specific. Runtime execution is enabled as connector runners are added.">
            <ChoiceControl
              value={genericCredentialMode}
              options={selectedEntry.credentialModes.map((mode) => ({ value: mode, label: mode === 'none' ? 'None' : mode === 'static' ? 'Token reference' : mode === 'oauth' ? 'OAuth account' : 'Dynamic', detail: mode === 'oauth' ? 'Coming soon' : undefined, disabled: mode === 'oauth' }))}
              onChange={setGenericCredentialMode}
            />
          </Row>
          {genericCredentialMode !== 'none' ? (
            <Row title="Credential reference" desc="Environment variable, keychain label, or future OAuth account id.">
              <input className="ctl mono" value={genericCredentialRef} onChange={(e) => setGenericCredentialRef(e.target.value)} placeholder={selectedEntry.credentialFields[0]?.key?.toUpperCase() ?? 'TOKEN_REF'} spellCheck={false} />
            </Row>
          ) : null}
          <div className="set-actions">
            <button className="btn primary" onClick={() => { saveGenericConnector(); setEditorOpen(false); }}>Add {selectedEntry.title} connector</button>
          </div>
        </>
            )}
            </div>
            <div className="set-actions" style={{ marginTop: 0, paddingTop: 12, flex: 'none' }}>
              <button className="btn" onClick={() => setEditorOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      ), document.body) : null}
    </>
  );
}
