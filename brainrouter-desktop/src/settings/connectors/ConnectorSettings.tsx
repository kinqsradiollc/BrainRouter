import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConnectorDefinitionBundle, ConnectorRecord } from '@kinqs/brainrouter-types';
import { Icon } from '../../icons.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import { Row, ChoiceControl } from '../shared/controls.js';
import {
  connectorConfigString,
  connectorConfigList,
  CHECKPOINT_RUNTIME_SOURCES,
  type ConfigSnapshot,
  type GithubOauthState,
} from '../shared/types.js';

/** Friendly "5 minutes ago" for the connector card (no dev timestamps). */
function relTime(iso?: string): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString();
}
const CRED_LABEL: Record<string, string> = { oauth: 'OAuth account', dynamic: 'GitHub CLI', static: 'access token', none: '' };
const SERVER_OAUTH_SOURCES = new Set(['gitlab', 'slack', 'google-drive', 'gmail', 'notion', 'linear']);
// Every OAuth-backed source can hold more than one account (work + personal + …).
const MULTI_ACCOUNT_SOURCES = new Set(['github', ...SERVER_OAUTH_SOURCES]);
/** One external account for a source — the server keeps the sealed credential;
 * this is only the label, connected state, and discovered account identity. */
type ConnectorAccountEntry = {
  id: string;
  label: string;
  connected: boolean;
  status: string;
  account: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  authMode?: string;
};
type AccountConnectorSnapshot = {
  source: ConnectorRecord['source'];
  connected: boolean;
  connector: { id: string; name: string; status: string; enabled: boolean; config: Record<string, unknown>; lastRunAt: string | null; lastError: string | null } | null;
  account?: string | null;
  error?: string;
};

export function ConnectorSettings({ connectors, onAction, refreshSnapshot }: {
  connectors: NonNullable<ConfigSnapshot['connectors']>;
  onAction: (id: string, name: string, args?: Record<string, unknown>) => void;
  refreshSnapshot: () => void;
}): React.ReactElement {
  const github = connectors.catalog.find((entry) => entry.source === 'github');
  const firstGithub = connectors.items.find((item) => item.source === 'github');
  const [selectedSource, setSelectedSource] = useState(firstGithub?.source ?? 'github');
  const selectedEntry = connectors.catalog.find((entry) => entry.source === selectedSource) ?? github ?? connectors.catalog[0];
  const [name, setName] = useState(firstGithub?.name ?? 'GitHub connector');
  const [owner, setOwner] = useState(firstGithub ? connectorConfigString(firstGithub, 'owner') : '');
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
  const [genericOauth, setGenericOauth] = useState<{ signedIn: boolean; connected: boolean; busy: boolean; error?: string }>({ signedIn: false, connected: false, busy: false });
  const [definitionJson, setDefinitionJson] = useState('');
  const [oauthState, setOauthState] = useState<GithubOauthState>({ status: 'idle' });
  const [githubAccount, setGithubAccount] = useState<{ signedIn: boolean; connected: boolean; login?: string; error?: string }>({ signedIn: false, connected: false });
  const [accountConnectors, setAccountConnectors] = useState<AccountConnectorSnapshot[]>([]);
  const [accountConnectorError, setAccountConnectorError] = useState('');
  const [detectedGithubRepo, setDetectedGithubRepo] = useState<string | null>(null);
  // Public install page for the BrainRouter GitHub App — lets the user grant the App
  // access to more repos. Constant regardless of connection status, so it lives in its
  // own state rather than the oauth-status union.
  const [githubInstallUrl, setGithubInstallUrl] = useState('');
  // Connector config moved out of the inline panel into a modal (matching the
  // Models provider dialog): a catalog card / "Configure" opens this editor.
  const [editorOpen, setEditorOpen] = useState(false);
  // The connector form can be tall; always open the
  // dialog scrolled to its title rather than wherever a re-render left it.
  const editorRef = useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (editorOpen) editorRef.current?.scrollTo({ top: 0 }); }, [editorOpen, selectedSource]);

  const refreshAccountConnectors = React.useCallback(async (): Promise<void> => {
    try {
      const result = await bridgeQuery<{ signedIn?: boolean; connectors?: AccountConnectorSnapshot[]; error?: string }>('account-connectors-status');
      setAccountConnectors(Array.isArray(result.connectors) ? result.connectors.filter((item) => item.connector || item.connected) : []);
      setAccountConnectorError(result.error ?? '');
    } catch (error) {
      setAccountConnectors([]);
      setAccountConnectorError(error instanceof Error ? error.message : 'Unable to load account connectors.');
    }
  }, []);
  React.useEffect(() => { void refreshAccountConnectors(); }, [refreshAccountConnectors]);

  // Multi-account: every account connected for the source open in the editor.
  const [sourceAccounts, setSourceAccounts] = useState<ConnectorAccountEntry[]>([]);
  const [newAccountLabel, setNewAccountLabel] = useState('');
  const [addAccountBusy, setAddAccountBusy] = useState(false);
  const [addAccountError, setAddAccountError] = useState('');
  const refreshSourceAccounts = React.useCallback(async (source: string): Promise<void> => {
    if (!MULTI_ACCOUNT_SOURCES.has(source)) { setSourceAccounts([]); return; }
    try {
      const res = await bridgeQuery<{ accounts?: ConnectorAccountEntry[] }>('connector-accounts', { source });
      setSourceAccounts(Array.isArray(res.accounts) ? res.accounts : []);
    } catch { setSourceAccounts([]); }
  }, []);
  React.useEffect(() => {
    if (!editorOpen || !selectedEntry) { return; }
    setNewAccountLabel('');
    setAddAccountError('');
    void refreshSourceAccounts(selectedEntry.source);
  }, [editorOpen, selectedEntry?.source, refreshSourceAccounts]);

  React.useEffect(() => {
    if (!firstGithub) return;
    setName(firstGithub.name);
    setOwner(connectorConfigString(firstGithub, 'owner'));
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
    void bridgeQuery<{ signedIn?: boolean; connected?: boolean; login?: string; installUrl?: string; error?: string }>('github-connect-status')
      .then((res) => {
        setGithubAccount({ signedIn: !!res.signedIn, connected: !!res.connected, login: res.login, error: res.error });
        setOauthState({ status: 'idle', hasToken: !!res.connected, storageMode: 'BrainRouter account' });
        setGithubInstallUrl(res.installUrl ?? '');
      })
      .catch((error) => {
        setGithubAccount({ signedIn: false, connected: false, error: error instanceof Error ? error.message : 'Unable to read GitHub account status.' });
        setOauthState({ status: 'idle' });
      });
    void bridgeQuery<{ githubRepo?: string }>('track-git-context')
      .then((res) => setDetectedGithubRepo(res.githubRepo ?? null))
      .catch(() => setDetectedGithubRepo(null));
  }, [firstGithub?.id, firstGithub?.credential.mode, firstGithub?.updatedAt]);

  React.useEffect(() => {
    if (!selectedEntry || selectedEntry.source === 'github') return;
    setGenericName(`${selectedEntry.title} connector`);
    setGenericCredentialMode(SERVER_OAUTH_SOURCES.has(selectedEntry.source) ? 'oauth' : (selectedEntry.credentialModes[0] ?? 'none'));
    setGenericCredentialRef('');
    setGenericConfig(Object.fromEntries(selectedEntry.configFields.map((field) => [
      field.key,
      field.type === 'boolean' ? Boolean(field.defaultValue) : field.defaultValue == null ? '' : String(field.defaultValue),
    ])));
  }, [selectedEntry?.source]);

  const refreshGenericOauth = React.useCallback(async (): Promise<void> => {
    if (!selectedEntry || !SERVER_OAUTH_SOURCES.has(selectedEntry.source)) return;
    try {
      const res = await bridgeQuery<{ signedIn?: boolean; connected?: boolean; error?: string; connector?: { name?: string; config?: Record<string, unknown> } | null }>('connector-oauth-status', { source: selectedEntry.source });
      setGenericOauth({ signedIn: !!res.signedIn, connected: !!res.connected, busy: false, error: res.error });
      if (res.connector) {
        if (typeof res.connector.name === 'string' && res.connector.name.trim()) setGenericName(res.connector.name);
        if (res.connector.config && typeof res.connector.config === 'object') {
          setGenericConfig((current) => ({ ...current, ...res.connector!.config as Record<string, string | boolean> }));
        }
        setGenericCredentialMode('oauth');
      }
    } catch (e) { setGenericOauth({ signedIn: true, connected: false, busy: false, error: e instanceof Error ? e.message : String(e) }); }
  }, [selectedEntry?.source]);
  React.useEffect(() => { void refreshGenericOauth(); }, [refreshGenericOauth]);

  const saveGithubConnector = (): void => {
    const poll = Number(pollMinutes);
    const config = {
      owner: owner.trim(),
      repositories: [] as string[],
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
  const canSave = Boolean(github && (includeIssues || includePrs || includeFiles));

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

  // Prefer the backend OAuth App configured in Dashboard. If this deployment has
  // no web app, fall back to the backend's bundled GitHub App device flow. Neither
  // path sends a client secret or provider token to this machine.
  const startGithubOauth = async (): Promise<void> => {
    setOauthState({ status: 'starting' });
    try {
      const browser = await bridgeQuery<{ ok?: boolean; url?: string; error?: string }>('github-connect-start');
      if (browser.ok && browser.url) {
        setOauthState({ status: 'pending', flow: 'browser', intervalSec: 2, expiresAtMs: Date.now() + 10 * 60_000 });
        await bridgeQuery('action:open-external', { url: browser.url });
        return;
      }
      const res = await bridgeQuery<{ ok: boolean; userCode?: string; verificationUri?: string; interval?: number; error?: string }>('github-device-start');
      if (!res.ok || !res.userCode) {
        // The browser path failing just means no web OAuth App is configured — the
        // device flow is the real mechanism here, so surface ITS error (or a
        // sign-in hint), never the misleading "OAuth isn't configured" browser message.
        setOauthState({ status: 'error', error: res.error || 'Sign in to your BrainRouter account (Settings → Account) to connect GitHub.' });
        return;
      }
      const uri = res.verificationUri || 'https://github.com/login/device';
      setOauthState({ status: 'pending', flow: 'device', userCode: res.userCode, verificationUri: uri, intervalSec: Number(res.interval) > 0 ? Number(res.interval) : 5, expiresAtMs: Date.now() + 15 * 60_000 });
      await bridgeQuery('action:open-external', { url: uri });
    } catch (e) {
      setOauthState({ status: 'error', error: e instanceof Error ? e.message : 'Could not start the GitHub connection.' });
    }
  };

  const cancelGithubOauth = async (): Promise<void> => {
    if (oauthState.status === 'pending' && oauthState.flow === 'device') {
      await bridgeQuery('github-device-cancel').catch(() => undefined);
    }
    setOauthState({ status: 'idle' });
  };

  const disconnectGithubOauth = async (): Promise<void> => {
    await bridgeQuery('action:github-disconnect').catch(() => undefined);
    markGithubOauthCredential(false);
    setGithubAccount((current) => ({ ...current, connected: false, login: undefined }));
    setOauthState({ status: 'idle', hasToken: false });
  };

  React.useEffect(() => {
    if (oauthState.status !== 'pending') return;
    const delay = Math.max(1, oauthState.intervalSec) * 1000;
    const timer = window.setTimeout(() => {
      if (oauthState.flow === 'browser') {
        void bridgeQuery<{ connected?: boolean; login?: string }>('github-connect-status').then((res) => {
          if (res.connected) { markGithubOauthCredential(true); setGithubAccount({ signedIn: true, connected: true, login: res.login }); setOauthState({ status: 'authorized', storageMode: 'BrainRouter account' }); setTimeout(refreshSnapshot, 120); void refreshSourceAccounts('github'); return; }
          if (Date.now() >= oauthState.expiresAtMs) { setOauthState({ status: 'error', error: 'Authorization was not completed — click Connect to try again.' }); return; }
          setOauthState((current) => current.status === 'pending' ? { ...current } : current);
        }).catch((err) => setOauthState({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      void bridgeQuery<{ status?: string; login?: string }>('github-device-poll').then((res) => {
        // Re-trigger the effect (new object) so polling continues until authorized.
        if (res.status === 'pending') { setOauthState((cur) => (cur.status === 'pending' ? { ...cur } : cur)); return; }
        if (res.status === 'connected') { markGithubOauthCredential(true); setGithubAccount({ signedIn: true, connected: true, login: res.login }); setOauthState({ status: 'authorized', storageMode: 'BrainRouter account' }); setTimeout(refreshSnapshot, 120); void refreshSourceAccounts('github'); return; }
        setOauthState({ status: 'error', error: 'That code expired — click Connect to try again.' });
      }).catch((err) => setOauthState({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [oauthState]);

  const saveGenericConnector = async (): Promise<boolean> => {
    if (!selectedEntry || selectedEntry.source === 'github') return false;
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
    if (genericCredentialMode === 'oauth' && SERVER_OAUTH_SOURCES.has(selectedEntry.source)) {
      const result = await bridgeQuery<{ ok?: boolean; error?: string }>('action:connector-oauth-save', { source: selectedEntry.source, name: genericName.trim() || `${selectedEntry.title} connector`, config });
      if (!result.ok) { setGenericOauth((s) => ({ ...s, error: result.error || 'Could not save connector settings.' })); return false; }
      setTimeout(refreshSnapshot, 150);
      setTimeout(() => void refreshAccountConnectors(), 150);
      return true;
    }
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
    return true;
  };
  const startGenericOauth = async (): Promise<void> => {
    if (!selectedEntry) return;
    setGenericOauth((s) => ({ ...s, busy: true, error: undefined }));
    const res = await bridgeQuery<{ ok?: boolean; url?: string; error?: string }>('connector-oauth-start', { source: selectedEntry.source }).catch((e): { ok?: boolean; url?: string; error?: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (!res.ok || !res.url) { setGenericOauth((s) => ({ ...s, busy: false, error: res.error || 'Could not start OAuth.' })); return; }
    await bridgeQuery('action:open-external', { url: res.url });
    setGenericOauth((s) => ({ ...s, busy: false, error: 'Complete authorization in the browser, then click Refresh.' }));
  };
  const disconnectGenericOauth = async (): Promise<void> => {
    if (!selectedEntry) return;
    await bridgeQuery('action:connector-oauth-disconnect', { source: selectedEntry.source });
    await refreshGenericOauth();
    await refreshAccountConnectors();
  };
  const disconnectAccountConnector = async (source: string): Promise<void> => {
    await bridgeQuery('action:connector-oauth-disconnect', { source });
    await refreshAccountConnectors();
    if (selectedEntry?.source === source) await refreshGenericOauth();
  };

  // Multi-account: create a new empty connector for this source, then kick off
  // its own auth flow (GitHub device code, or the generic OAuth browser redirect)
  // bound to that connector id — so work + personal stay separate credentials.
  const addAnotherAccount = async (): Promise<void> => {
    if (!selectedEntry) return;
    const source = selectedEntry.source;
    setAddAccountBusy(true);
    setAddAccountError('');
    try {
      const created = await bridgeQuery<{ ok?: boolean; connector?: { id?: string }; error?: string }>('connector-account-add', { source, label: newAccountLabel.trim() || undefined });
      const connectorId = created.connector?.id;
      if (!created.ok || !connectorId) { setAddAccountError(created.error || 'Could not create the account.'); return; }
      setNewAccountLabel('');
      if (source === 'github') {
        const res = await bridgeQuery<{ ok: boolean; userCode?: string; verificationUri?: string; interval?: number; error?: string }>('github-device-start', { connectorId });
        if (!res.ok || !res.userCode) { setAddAccountError(res.error || 'Could not start the GitHub connection.'); await refreshSourceAccounts(source); return; }
        const uri = res.verificationUri || 'https://github.com/login/device';
        setSelectedSource('github');
        setCredentialMode('oauth');
        setOauthState({ status: 'pending', flow: 'device', userCode: res.userCode, verificationUri: uri, intervalSec: Number(res.interval) > 0 ? Number(res.interval) : 5, expiresAtMs: Date.now() + 15 * 60_000 });
        await bridgeQuery('action:open-external', { url: uri });
      } else {
        const res = await bridgeQuery<{ ok?: boolean; url?: string; error?: string }>('connector-oauth-start', { source, connectorId }).catch((e): { ok?: boolean; url?: string; error?: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        if (!res.ok || !res.url) { setAddAccountError(res.error || 'Could not start OAuth.'); await refreshSourceAccounts(source); return; }
        await bridgeQuery('action:open-external', { url: res.url });
        setAddAccountError('Complete authorization in the browser, then click Refresh.');
      }
      await refreshSourceAccounts(source);
    } catch (e) {
      setAddAccountError(e instanceof Error ? e.message : 'Could not add the account.');
    } finally {
      setAddAccountBusy(false);
    }
  };
  const removeSourceAccount = async (id: string): Promise<void> => {
    await bridgeQuery('action:connector-account-delete', { id });
    if (selectedEntry) await refreshSourceAccounts(selectedEntry.source);
    await refreshAccountConnectors();
    await refreshGenericOauth();
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
      <div className="set-desc" style={{ marginBottom: 10 }}>Workspace data connectors for indexed sources, permissions, and recall. Track sync uses your account connection and active workspace remote automatically. MCP tool servers live in <b>MCP Servers</b>.</div>

      <div className="connector-shell">
        <div className="connector-catalog">
          {connectors.catalog.map((entry) => {
            const configured = connectors.items.filter((item) => item.source === entry.source).length
              + accountConnectors.filter((item) => item.source === entry.source).length
              + (entry.source === 'github' && githubAccount.connected && !connectors.items.some((item) => item.source === 'github') ? 1 : 0);
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
      {accountConnectorError ? <div className="set-desc" role="alert" style={{ color: 'var(--warn)', marginBottom: 8 }}>{accountConnectorError}</div> : null}
      {connectors.items.length === 0 && accountConnectors.length === 0 && !githubAccount.connected ? <div className="empty">No connectors configured yet.</div> : null}
      {connectors.items.length || accountConnectors.length || githubAccount.connected ? (
        <div className="provider-gallery connector-configured-grid">
          {githubAccount.connected && !connectors.items.some((connector) => connector.source === 'github') ? (
            <div className="provider-card saved">
              <span className="pc-name">GitHub account <span className="pc-tag ok">Connected</span></span>
              <span className="pc-host">OAuth via BrainRouter{githubAccount.login ? ` · ${githubAccount.login}` : ''}</span>
              <span className="pc-wire">Credential sealed server-side{detectedGithubRepo ? ` · detected ${detectedGithubRepo}` : ''}</span>
              <span className="pc-actions">
                <button className="btn" onClick={() => { setSelectedSource('github'); setEditorOpen(true); }}>Configure source</button>
                <button className="btn danger" onClick={() => void disconnectGithubOauth()}>Disconnect</button>
              </span>
            </div>
          ) : null}
          {accountConnectors.map((item) => {
            const entry = connectors.catalog.find((candidate) => candidate.source === item.source);
            const connector = item.connector;
            const status = item.connected && connector?.enabled ? 'Connected' : item.connected ? 'Paused' : 'Needs attention';
            return (
              <div key={`account-${item.source}-${connector?.id ?? 'connection'}`} className="provider-card saved">
                <span className="pc-name">
                  {connector?.name || `${entry?.title ?? item.source} account`}
                  <span className={`pc-tag ${item.connected ? 'ok' : 'danger'}`}>{status}</span>
                </span>
                <span className="pc-host">{entry?.title ?? item.source} · OAuth via BrainRouter account</span>
                <span className="pc-wire">Credential sealed server-side · schedule {connector?.enabled ? 'on' : 'paused'}</span>
                <span className="pc-wire">Last synced {relTime(connector?.lastRunAt ?? undefined)}</span>
                {(item.error || connector?.lastError) ? <span className="pc-host" style={{ color: 'var(--warn)' }}>Last sync didn’t finish — {item.error || connector?.lastError}</span> : null}
                <span className="pc-actions">
                  <button className="btn" onClick={() => { setSelectedSource(item.source); setEditorOpen(true); }}>Configure</button>
                  {item.connected ? <button className="btn danger" onClick={() => void disconnectAccountConnector(item.source)}>Disconnect</button> : null}
                </span>
              </div>
            );
          })}
          {connectors.items.map((connector) => {
            const accountOauthUnavailable = connector.source === 'github'
              && connector.credential.mode === 'oauth'
              && !githubAccount.connected;
            const displayStatus = accountOauthUnavailable ? 'error' : connector.status;
            return (
            <div key={connector.id} className="provider-card saved">
              <span className="pc-name">
                {connector.name}
                <span className={`pc-tag ${displayStatus === 'active' ? 'ok' : displayStatus === 'error' ? 'danger' : 'default'}`}>
                  {displayStatus === 'active' ? 'Connected' : displayStatus === 'paused' ? 'Paused' : displayStatus === 'error' ? 'Needs attention' : displayStatus}
                </span>
              </span>
              <span className="pc-host">
                {connector.source === 'github' ? 'GitHub' : connector.source}
                {connector.credential.mode && CRED_LABEL[connector.credential.mode] ? ` · via ${CRED_LABEL[connector.credential.mode]}` : ''}
              </span>
              {(() => {
                const rs = connectorConfigList(connector, 'repositories');
                const owner = connectorConfigString(connector, 'owner');
                return <span className="pc-wire">{rs.length ? `${rs.length} repositor${rs.length === 1 ? 'y' : 'ies'} synced` : owner ? `All repos under ${owner}` : 'All repos the app can access'}</span>;
              })()}
              <span className="pc-wire">
                Last synced {relTime(connector.lastSuccessAt)}
                {(connectors.documentCounts?.[connector.id] ?? 0) > 0 ? ` · ${(connectors.documentCounts?.[connector.id] ?? 0).toLocaleString()} items in memory` : ''}
              </span>
              {typeof connector.config.pollMinutes === 'number' && connector.config.pollMinutes > 0 && connector.status !== 'paused'
                ? <span className="pc-wire" style={{ opacity: 0.6 }}>Auto-syncs every {connector.config.pollMinutes} min</span> : null}
              {accountOauthUnavailable ? (
                <span className="pc-host" role="alert" style={{ color: 'var(--warn)' }}>{githubAccount.error || 'GitHub authorization needs to be reconnected.'}</span>
              ) : (!!connector.lastError || connector.status === 'error') ? (
                <span className="pc-host" style={{ color: 'var(--warn)' }}>Last sync didn’t finish{connector.lastError ? ` — ${connector.lastError}` : ''}</span>
              ) : null}
              <span className="pc-actions">
                {CHECKPOINT_RUNTIME_SOURCES.has(connector.source) ? <button className="btn primary" onClick={() => { onAction('a-connector-run', 'action:connector-run', { id: connector.id }); setTimeout(refreshSnapshot, 1200); }}>Sync now</button> : null}
                <button className="btn" onClick={() => { setSelectedSource(connector.source); setEditorOpen(true); }}>Configure</button>
                <button className="btn" onClick={() => {
                  onAction('a-connector-update', 'action:connector-update', { id: connector.id, patch: { status: connector.status === 'paused' ? 'active' : 'paused' } });
                  setTimeout(refreshSnapshot, 120);
                }}>{connector.status === 'paused' ? 'Resume' : 'Pause'}</button>
                <button className="btn danger" onClick={() => { if (window.confirm(`Remove the ${connector.name} connector?`)) { onAction('a-connector-delete', 'action:connector-delete', { id: connector.id }); setTimeout(refreshSnapshot, 120); } }}>Remove</button>
              </span>
            </div>
          );})}
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
            {MULTI_ACCOUNT_SOURCES.has(selectedEntry.source) ? (
        <>
          <div className="set-h2" style={{ marginTop: 2 }}>Accounts</div>
          <div className="set-desc" style={{ marginBottom: 8 }}>Connect more than one {selectedEntry.title} account — e.g. work and personal. Each keeps its own sealed credential on the BrainRouter backend.</div>
          {sourceAccounts.length ? (
            <div className="provider-gallery" style={{ marginBottom: 10 }}>
              {sourceAccounts.map((acct) => (
                <div key={acct.id} className="provider-card saved">
                  <span className="pc-name">{acct.label}<span className={`pc-tag ${acct.connected ? 'ok' : 'default'}`}>{acct.connected ? 'Connected' : 'Awaiting authorization'}</span></span>
                  <span className="pc-host">{acct.account ? `@${acct.account}` : `${selectedEntry.title} · not yet authorized`}{acct.authMode ? ` · ${acct.authMode}` : ''}</span>
                  <span className="pc-wire">Credential sealed server-side · schedule {acct.enabled ? 'on' : 'paused'} · last synced {relTime(acct.lastRunAt ?? undefined)}</span>
                  {acct.lastError ? <span className="pc-host" style={{ color: 'var(--warn)' }}>Last sync didn’t finish — {acct.lastError}</span> : null}
                  <span className="pc-actions"><button className="btn danger" onClick={() => void removeSourceAccount(acct.id)}>Remove</button></span>
                </div>
              ))}
            </div>
          ) : <div className="set-desc" style={{ marginBottom: 10 }}>No {selectedEntry.title} accounts connected yet — use the connection below, or add a labelled one here.</div>}
          <Row title="Add another account" desc="Label it (e.g. Work, Personal), then authorize the new account in your browser.">
            <div style={{ display: 'grid', gap: 8, minWidth: 300 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="ctl" value={newAccountLabel} onChange={(e) => setNewAccountLabel(e.target.value)} placeholder="Work / Personal" />
                <button type="button" className="btn" disabled={addAccountBusy} onClick={() => void addAnotherAccount()}>{addAccountBusy ? 'Starting…' : 'Add & connect'}</button>
              </div>
              {addAccountError ? <span className="pc-host" style={{ color: 'var(--warn)' }}>{addAccountError}</span> : null}
            </div>
          </Row>
        </>
            ) : null}
            {selectedEntry.source === 'github' ? (
        <>
          <div className="set-h2" style={{ marginTop: 2 }}>GitHub source</div>
          <div className="set-desc" style={{ marginBottom: 8 }}>Choose what this source indexes for knowledge. Track uses your BrainRouter OAuth connection and the current workspace remote automatically.</div>
          {!github ? <div className="empty">GitHub is not available in the connector catalog.</div> : null}
          <Row title="Name" desc="Local display name for this connector instance.">
            <input className="ctl" value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub connector" />
          </Row>
          <Row title="Repositories" desc="Auto-detected over OAuth — BrainRouter syncs every repository your GitHub app can access. No owner or repo to set.">
            {githubInstallUrl ? (
              <button type="button" onClick={() => void bridgeQuery('action:open-external', { url: githubInstallUrl })}
                style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent, #6ea8fe)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline', justifySelf: 'start' }}>
                Manage on GitHub ↗
              </button>
            ) : <span className="set-desc">Connect GitHub above; repositories are detected automatically.</span>}
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
                    <span>{oauthState.flow === 'device' ? <>Code <b className="mono">{oauthState.userCode}</b> · </> : <>Complete authorization in your browser · </>}expires {new Date(oauthState.expiresAtMs).toLocaleTimeString()}</span>
                  </div>
                ) : oauthState.status === 'authorized' ? (
                  <div className="gh-int-status ok"><span className="gh-int-dot" />Connected{oauthState.scope ? ` · ${oauthState.scope}` : ''}</div>
                ) : oauthState.status === 'error' ? (
                  <div className="pc-host" style={{ color: 'var(--warn)' }}>{oauthState.error}</div>
                ) : null}
                {oauthState.status === 'pending' && oauthState.flow === 'device' ? <span className="set-desc mono">{oauthState.verificationUri}</span> : null}
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
              options={Array.from(new Set([...selectedEntry.credentialModes, ...(SERVER_OAUTH_SOURCES.has(selectedEntry.source) ? ['oauth'] : [])])).map((mode) => ({ value: mode, label: mode === 'none' ? 'None' : mode === 'static' ? 'Token reference' : mode === 'oauth' ? 'OAuth account' : 'Dynamic', detail: mode === 'oauth' ? 'server-sealed token' : undefined }))}
              onChange={setGenericCredentialMode}
            />
          </Row>
          {genericCredentialMode === 'oauth' && SERVER_OAUTH_SOURCES.has(selectedEntry.source) ? (
            <Row title="OAuth account" desc="The token is sealed on the BrainRouter backend and shared with the dashboard sync runner; it is never stored on this machine.">
              <div style={{ display: 'grid', gap: 8, minWidth: 300 }}>
                <div className={`gh-int-status ${genericOauth.connected ? 'ok' : ''}`}><span className="gh-int-dot" />{genericOauth.connected ? 'Connected through BrainRouter' : genericOauth.signedIn ? 'Not connected' : 'Sign in under Account first'}</div>
                {genericOauth.error ? <div className="pc-host" style={{ color: genericOauth.connected ? 'var(--text-muted)' : 'var(--warn)' }}>{genericOauth.error}</div> : null}
                <span className="pc-actions"><button type="button" className="btn" disabled={genericOauth.busy} onClick={() => void startGenericOauth()}>{genericOauth.busy ? 'Starting…' : genericOauth.connected ? 'Reconnect' : 'Connect'}</button><button type="button" className="btn" onClick={() => void refreshGenericOauth()}>Refresh</button>{genericOauth.connected ? <button type="button" className="btn danger" onClick={() => void disconnectGenericOauth()}>Disconnect</button> : null}</span>
              </div>
            </Row>
          ) : genericCredentialMode !== 'none' ? (
            <Row title="Credential reference" desc="Environment variable, keychain label, or future OAuth account id.">
              <input className="ctl mono" value={genericCredentialRef} onChange={(e) => setGenericCredentialRef(e.target.value)} placeholder={selectedEntry.credentialFields[0]?.key?.toUpperCase() ?? 'TOKEN_REF'} spellCheck={false} />
            </Row>
          ) : null}
          <div className="set-actions">
            <button className="btn primary" disabled={genericCredentialMode === 'oauth' && !genericOauth.connected} onClick={() => { void saveGenericConnector().then((saved) => { if (saved) setEditorOpen(false); }); }}>{genericCredentialMode === 'oauth' ? `Save ${selectedEntry.title} sync` : `Add ${selectedEntry.title} connector`}</button>
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
