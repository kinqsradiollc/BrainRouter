import React, { useState } from 'react';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import type { GithubOrgRow, GithubRepoRow, GithubOrgsResult, GithubReposResult } from '../shared/types.js';

export function GithubRepoPicker({ connector, value, onChange }: {
  connector: ConnectorRecord | undefined;
  value: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const selected = new Set(value);
  const [open, setOpen] = useState(false);
  const [viewerLogin, setViewerLogin] = useState('');
  const [orgs, setOrgs] = useState<GithubOrgRow[]>([]);
  const [orgError, setOrgError] = useState('');
  const [loadingOrgs, setLoadingOrgs] = useState(false);
  const [activeOrg, setActiveOrg] = useState('');
  const [repoPages, setRepoPages] = useState<Record<string, { repos: GithubRepoRow[]; nextPage: number | null; error?: string; loading?: boolean }>>({});
  const [repoSearch, setRepoSearch] = useState('');
  const [includePrivate, setIncludePrivate] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeForks, setIncludeForks] = useState(false);

  const connectorId = connector?.id ?? '';
  const loadOrgs = React.useCallback(async () => {
    if (!connectorId) return;
    setLoadingOrgs(true);
    setOrgError('');
    try {
      const result = await bridgeQuery<GithubOrgsResult>('github-connector-orgs', { connectorId });
      const viewer = result.viewer?.login ?? '';
      const rows = [...(viewer ? [{ login: viewer, description: 'Personal repositories' }] : []), ...(result.orgs ?? [])]
        .filter((row, index, arr) => row.login && arr.findIndex((candidate) => candidate.login === row.login) === index);
      setViewerLogin(viewer);
      setOrgs(rows);
      setActiveOrg((cur) => cur || rows[0]?.login || '');
      setOrgError((result.errors ?? []).join('\n'));
    } catch (err) {
      setOrgError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOrgs(false);
    }
  }, [connectorId]);

  const loadRepos = React.useCallback(async (org: string, page?: number) => {
    if (!connectorId || !org) return;
    const nextPage = page ?? repoPages[org]?.nextPage ?? 1;
    setRepoPages((cur) => ({ ...cur, [org]: { repos: cur[org]?.repos ?? [], nextPage: cur[org]?.nextPage ?? nextPage, loading: true } }));
    try {
      const result = await bridgeQuery<GithubReposResult>('github-connector-repos', { connectorId, org, viewerLogin, page: nextPage });
      setRepoPages((cur) => {
        const prior = cur[org]?.repos ?? [];
        const merged = [...prior];
        for (const repo of result.repos ?? []) {
          if (!merged.some((existing) => existing.nameWithOwner === repo.nameWithOwner)) merged.push(repo);
        }
        return { ...cur, [org]: { repos: merged, nextPage: result.nextPage ?? null, error: (result.errors ?? []).join('\n'), loading: false } };
      });
    } catch (err) {
      setRepoPages((cur) => ({ ...cur, [org]: { repos: cur[org]?.repos ?? [], nextPage: cur[org]?.nextPage ?? null, error: err instanceof Error ? err.message : String(err), loading: false } }));
    }
  }, [connectorId, repoPages, viewerLogin]);

  React.useEffect(() => {
    if (!open || !connectorId || orgs.length) return;
    void loadOrgs();
  }, [open, connectorId, orgs.length, loadOrgs]);

  React.useEffect(() => {
    if (!open || !activeOrg || repoPages[activeOrg]) return;
    void loadRepos(activeOrg, 1);
  }, [open, activeOrg, repoPages, loadRepos]);

  const toggle = (repo: string): void => {
    const next = new Set(selected);
    if (next.has(repo)) next.delete(repo);
    else next.add(repo);
    onChange([...next].sort());
  };

  const current = activeOrg ? repoPages[activeOrg] : undefined;
  const q = repoSearch.trim().toLowerCase();
  const filtered = (current?.repos ?? []).filter((repo) => {
    if (!includePrivate && repo.isPrivate) return false;
    if (!includeArchived && repo.isArchived) return false;
    if (!includeForks && repo.isFork) return false;
    if (!q) return true;
    return `${repo.nameWithOwner} ${repo.description ?? ''}`.toLowerCase().includes(q);
  });

  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 320 }}>
      <div className="gh-repo-list">
        {value.length === 0 ? <div className="empty">No repositories selected.</div> : value.map((repo) => (
          <div key={repo} className="gh-repo-row active">
            <span className="gh-repo-name mono">{repo}</span>
            <button type="button" className="gh-row-btn danger" onClick={() => toggle(repo)}>Remove</button>
          </div>
        ))}
      </div>
      {!connector ? <div className="set-desc">Save this GitHub connector before choosing repositories.</div> : null}
      {connector ? <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>{open ? 'Hide repo picker' : 'Choose repos'}</button> : null}
      {open && connector ? (
        <div className="gh-repo-list">
          <div className="gh-token-row">
            <input className="ctl" value={repoSearch} onChange={(e) => setRepoSearch(e.target.value)} placeholder="Search repositories" />
            <button type="button" className="gh-token-clear" disabled={loadingOrgs} onClick={() => { setOrgs([]); setRepoPages({}); void loadOrgs(); }}>Refresh</button>
          </div>
          <div className="connector-toggles">
            <label><input type="checkbox" checked={includePrivate} onChange={(e) => setIncludePrivate(e.target.checked)} /> Private</label>
            <label><input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> Archived</label>
            <label><input type="checkbox" checked={includeForks} onChange={(e) => setIncludeForks(e.target.checked)} /> Forks</label>
          </div>
          {orgError ? <div className="pc-host" style={{ color: 'var(--warn)' }}>{orgError}</div> : null}
          <div className="choice-menu" style={{ position: 'static', display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 'none', boxShadow: 'none', border: '1px solid var(--border)' }}>
            {orgs.map((org) => (
              <button key={org.login} type="button" className={`choice-option${activeOrg === org.login ? ' selected' : ''}`} onClick={() => setActiveOrg(org.login)}>
                <span>{org.login}</span>
              </button>
            ))}
            {loadingOrgs ? <span className="set-desc" style={{ padding: '6px 8px' }}>Loading...</span> : null}
          </div>
          {current?.error ? <div className="pc-host" style={{ color: 'var(--warn)' }}>{current.error}</div> : null}
          {filtered.map((repo) => (
            <label key={repo.nameWithOwner} className="gh-repo-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.has(repo.nameWithOwner)} onChange={() => toggle(repo.nameWithOwner)} />
              <span className="gh-repo-name mono">{repo.nameWithOwner}</span>
              {repo.isPrivate ? <span className="gh-repo-pill">private</span> : null}
              {repo.isArchived ? <span className="gh-repo-pill">archived</span> : null}
              {repo.isFork ? <span className="gh-repo-pill">fork</span> : null}
            </label>
          ))}
          {current?.loading ? <div className="set-desc">Loading repositories...</div> : null}
          {current?.nextPage ? <button type="button" className="btn" disabled={current.loading} onClick={() => void loadRepos(activeOrg, current.nextPage ?? 1)}>Load more</button> : null}
        </div>
      ) : null}
    </div>
  );
}
