/** GitHub Track sync — status + repo list. OAuth (via your BrainRouter account) is the
 * default path: Track proxies GitHub through the sealed server-side token and
 * auto-detects the repo from the workspace's git remote — no token on this machine.
 * A personal access token stays available under "Advanced" for repos the app can't
 * reach / GitHub Enterprise. Saves to config.json via action:set-track-github. */
import React, { useState } from 'react';
import { Row } from '../shared/controls.js';
import type { GithubIntegrationSnapshot, GithubSaveArgs } from '../shared/types.js';

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
  return (
    <div className="gh-int">
      <div className="gh-int-status ok">
        <span className="gh-int-dot" />
        Track syncs GitHub issues for this workspace. When your GitHub account is connected (below) it goes through that — no token on this machine — and auto-detects the repo from your git remote. It uses {active?.repo ? <b className="mono">{active.repo}</b> : 'the detected repo'} and every repo your app can access.
      </div>
      {repos.length ? (
        <div className="gh-repo-list">
          {repos.map((r) => (
            <div key={r.repo} className={`gh-repo-row${r.active ? ' active' : ''}`}>
              <span className={`gh-int-dot${r.hasToken ? ' on' : ''}`} />
              <span className="gh-repo-name mono">{r.repo}</span>
              {r.active ? <span className="gh-repo-pill active">active</span> : null}
              {!r.active ? <button className="gh-row-btn" onClick={() => onSave({ repo: r.repo, makeActive: true })}>Use</button> : null}
              <button className="gh-row-btn danger" onClick={() => onSave({ removeRepo: r.repo })}>Remove</button>
            </div>
          ))}
        </div>
      ) : null}
      <details className="gh-int-advanced" style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', opacity: 0.75, fontSize: 13 }}>Advanced — personal access token / GitHub Enterprise</summary>
        <div style={{ marginTop: 8 }}>
          <Row title="Repository" desc="owner/name — pin Track to a specific repo instead of the auto-detected one.">
            <input className="ctl mono" style={{ minWidth: 220 }} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" spellCheck={false} autoCapitalize="off" />
          </Row>
          <Row title="Access token" desc={<>Optional fallback — a fine-grained PAT with <b>Issues</b> read/write, for repos your GitHub app can't reach. Stored only in your local <code>config.json</code>; sent to GitHub and nowhere else, and never displayed again.</>}>
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
      </details>
    </div>
  );
}
