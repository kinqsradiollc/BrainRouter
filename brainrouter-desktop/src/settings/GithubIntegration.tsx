/** GitHub Track sync — repo + a write-only token (never read
 * back; the host only reports whether one is set). Saves to config.json
 * cli.track.* via action:set-track-github, replacing any need for a .env. */
import React, { useState } from 'react';
import { Row } from './controls.js';
import type { GithubIntegrationSnapshot, GithubSaveArgs } from './types.js';

export function GithubIntegration({ gh, onSave }: { gh: GithubIntegrationSnapshot; onSave: (args: GithubSaveArgs) => void }): React.ReactElement {
  const repos = gh.repos?.length ? gh.repos : (gh.repo ? [{ repo: gh.repo, hasToken: gh.hasToken, tokenSource: gh.tokenSource, active: true }] : []);
  const active = repos.find((r) => r.active) ?? repos[0];
  const [repo, setRepo] = useState(active?.repo ?? gh.repo ?? '');
  const [token, setToken] = useState('');
  const [caBundle, setCaBundle] = useState(gh.caBundle ?? '');
  React.useEffect(() => { setRepo(active?.repo ?? gh.repo ?? ''); }, [active?.repo, gh.repo]);
  React.useEffect(() => { setCaBundle(gh.caBundle ?? ''); }, [gh.caBundle]);
  const selected = repos.find((r) => r.repo === repo.trim());
  const repoChanged = repo.trim() !== (active?.repo ?? gh.repo ?? '');
  const dirty = repo.trim() !== '' && (repoChanged || token.trim() !== '');
  const caDirty = caBundle.trim() !== (gh.caBundle ?? '');
  const connected = repos.some((r) => r.active && r.hasToken);
  return (
    <div className="gh-int">
      <div className={`gh-int-status${connected ? ' ok' : ''}`}>
        <span className="gh-int-dot" />
        {connected ? <>Track sync uses <b className="mono">{active?.repo}</b>{active?.tokenSource === 'env' ? ' · token via environment' : ''}</>
          : repos.length ? <>Repository set — add or select a token-enabled repo</> : <>Not configured</>}
      </div>
      {repos.length ? (
        <div className="gh-repo-list">
          {repos.map((r) => (
            <div key={r.repo} className={`gh-repo-row${r.active ? ' active' : ''}`}>
              <span className={`gh-int-dot${r.hasToken ? ' on' : ''}`} />
              <span className="gh-repo-name mono">{r.repo}</span>
              {r.active ? <span className="gh-repo-pill active">active</span> : null}
              <span className={`gh-repo-pill${r.hasToken ? ' ok' : ''}`}>{r.hasToken ? `token via ${r.tokenSource}` : 'no token'}</span>
              <button className="gh-row-btn" onClick={() => { setRepo(r.repo); setToken(''); }}>Edit</button>
              {!r.active ? <button className="gh-row-btn" onClick={() => onSave({ repo: r.repo, makeActive: true })}>Use</button> : null}
              {r.hasToken ? <button className="gh-row-btn danger" onClick={() => onSave({ repo: r.repo, clearToken: true })}>Remove token</button> : null}
              <button className="gh-row-btn danger" onClick={() => onSave({ removeRepo: r.repo })}>Remove</button>
            </div>
          ))}
        </div>
      ) : null}
      <Row title="Repository" desc="owner/name — add another GitHub repo or update the selected repo used by Track issue sync.">
        <input className="ctl mono" style={{ minWidth: 220 }} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" spellCheck={false} autoCapitalize="off" />
      </Row>
      <Row title="Access token" desc={<>A fine-grained personal access token with <b>Issues</b> read/write. Stored only in your local <code>config.json</code>; sent to GitHub and nowhere else, and never displayed again.</>}>
        <div className="gh-token-row">
          <input className="ctl mono" style={{ minWidth: 220 }} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false}
            placeholder={selected?.hasToken ? '•••••••••••• (set)' : 'github_pat_… / ghp_…'} />
          {selected?.hasToken ? <button className="gh-token-clear" onClick={() => onSave({ repo: selected.repo, clearToken: true })}>Remove</button> : null}
        </div>
      </Row>
      <Row title="GitHub CLI CA bundle" desc={<>Optional trusted certificate bundle path for corporate TLS interception. Passed to <code>gh</code> as <code>SSL_CERT_FILE</code>.</>}>
        <div className="gh-token-row">
          <input className="ctl mono" style={{ minWidth: 260 }} value={caBundle} onChange={(e) => setCaBundle(e.target.value)} placeholder="/path/to/corp-ca.pem" spellCheck={false} />
          <button className="gh-token-clear" disabled={!caDirty} onClick={() => onSave({ caBundle: caBundle.trim() || null })}>Save</button>
        </div>
      </Row>
      <div className="gh-int-actions">
        <button className="gh-int-save" disabled={!dirty} onClick={() => { onSave({ repo: repo.trim(), token: token.trim() || undefined, makeActive: true }); setToken(''); }}>Save as active</button>
      </div>
    </div>
  );
}
