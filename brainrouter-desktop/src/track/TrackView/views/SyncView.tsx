/**
 * Track view — External sync (GitHub Issues) panel: git context, repo config,
 * export/import/two-way actions, and result rendering. Split out of
 * TrackView.tsx byte-for-byte; no behavior change.
 */
import React, { useState } from 'react';
import { Icon } from '../../../icons.js';
import { isTrackSyncAuthFailure, resolveTrackSyncAvailability } from '../../../lib/track/syncAvailability.js';
import type { SyncConfig, SyncResult, GitTrackContext, TrackOps } from '../shared/types.js';

type SyncBusy = 'import' | 'export' | 'sync' | 'gh-import' | 'scan' | 'refresh-git' | null;

export function SyncView({ sync, git, ops }: { sync: { config: SyncConfig | null; result: SyncResult | null }; git: GitTrackContext | null; ops: TrackOps }): React.ReactElement {
  const [busy, setBusy] = useState<SyncBusy>(null);
  const cfg = sync.config;
  const result = sync.result;
  const availability = resolveTrackSyncAvailability(cfg);
  const { configured } = availability;
  const gitLabel = git?.githubRepo ?? git?.root;
  const repos = cfg?.repos?.length ? cfg.repos : (cfg?.repo ? [{ repo: cfg.repo, hasToken: cfg.hasToken, tokenSource: cfg.tokenSource, active: true }] : []);

  // Clear the busy spinner whenever a fresh result lands.
  React.useEffect(() => { setBusy(null); }, [result, git]);

  const run = (direction: 'import' | 'export' | 'sync', dryRun: boolean): void => {
    if (!configured) return;
    setBusy(direction);
    ops.sync(direction, dryRun);
  };
  const runAction = (kind: Exclude<SyncBusy, null>, fn: () => void): void => {
    setBusy(kind);
    fn();
    window.setTimeout(() => setBusy((cur) => (cur === kind ? null : cur)), 15_000);
  };
  const iconFor = (kind: Exclude<SyncBusy, null>, icon: string): React.ReactNode => busy === kind ? <span className="spinner sm" /> : <Icon name={icon} size={12} />;
  const rows = result ? (result.exported ?? result.imported ?? []) : [];
  const authFailure = isTrackSyncAuthFailure(result?.errors);

  return (
    <div className="track-sync">
      <div className="track-section-head">
        External sync <span className="track-col-count">GitHub Issues</span>
        <button className={`track-member-pull${busy === 'gh-import' ? ' is-busy' : ''}`} disabled={!!busy} title="Import open GitHub issues through the GitHub CLI auth store" onClick={() => runAction('gh-import', ops.importGhIssues)}>{iconFor('gh-import', 'arrow-down')} {busy === 'gh-import' ? 'Importing' : 'Import via gh'}</button>
        <button className={`track-member-pull${busy === 'scan' ? ' is-busy' : ''}`} disabled={!!busy} title="Scan recent commit messages for BR-123 references — link each commit to its work item and advance todo → in-progress" onClick={() => runAction('scan', ops.scanCommits)}>{iconFor('scan', 'commit')} {busy === 'scan' ? 'Scanning' : 'Scan commits'}</button>
      </div>
      <p className="track-auto-intro">Two-way sync between this project and a GitHub repository's issues. Work items export as issues (type/priority become labels, done → closed); issues import back as work items. Re-runs update in place — no duplicates. <b>Scan commits</b> links commits to items by their <code className="mono">BR-123</code> reference, so the board advances even when the agent forgets to link.</p>

      <div className="track-sync-config">
        <div className="track-sync-conn">
          <span className={`track-sync-dot${git?.hasGit ? ' on' : ''}`} />
          {git?.hasGit ? (
            <>
              <span className="track-sync-repo mono">{gitLabel}</span>
              <span className="track-sync-token ok">{git.currentBranch || 'detached'}</span>
            </>
          ) : <span className="track-sync-unset">{git?.error ?? 'No local Git repository detected'}</span>}
          <button className={`track-member-pull${busy === 'refresh-git' ? ' is-busy' : ''}`} disabled={!!busy} title="Refresh local Git context" onClick={() => runAction('refresh-git', ops.refreshGit)}>{iconFor('refresh-git', 'refresh')} {busy === 'refresh-git' ? 'Refreshing' : 'Refresh Git'}</button>
        </div>
      </div>

      <div className="track-sync-config">
        <div className="track-sync-conn">
          <span className={`track-sync-dot${configured ? ' on' : ''}`} />
          {availability.repo ? (
            <>
              <span className="track-sync-repo mono">{availability.repo}</span>
              <span className={`track-sync-token${configured ? ' ok' : ''}`}>
                {availability.accountManaged
                  ? `${availability.source} · OAuth credential sealed in your account`
                  : configured
                    ? `active · token via ${availability.source}`
                    : 'detected · connect GitHub to sync'}
              </span>
            </>
          ) : <span className="track-sync-unset">No repository configured</span>}
        </div>
        {repos.length ? (
          <div className="track-sync-repos">
            {repos.map((r) => (
              <div key={r.repo} className={`track-sync-repo-row${r.active ? ' active' : ''}`}>
                <span className={`track-sync-dot${r.hasToken || (availability.accountManaged && r.repo === availability.repo) ? ' on' : ''}`} />
                <span className="track-sync-repo mono">{r.repo}</span>
                {r.label ? <span className="track-sync-token">{r.source === 'connector' ? `connector · ${r.label}` : r.label}</span> : null}
                {r.active ? <span className="track-sync-token ok">active</span> : null}
                <span className={`track-sync-token${r.hasToken || (availability.accountManaged && r.repo === availability.repo) ? ' ok' : ''}`}>
                  {availability.accountManaged && r.repo === availability.repo
                    ? 'OAuth via account'
                    : r.hasToken ? `token via ${r.tokenSource}` : 'no local credential'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {!configured ? (
          <p className="track-sync-help">
            {cfg?.account?.signedIn
              ? <>Connect GitHub in <b>Settings → Connections → Connectors</b>. This workspace's GitHub remote is detected automatically.</>
              : <>Sign in and connect GitHub in <b>Settings → Connections → Connectors</b>, or configure a local GitHub credential.</>}
            {cfg?.account?.error ? <><br />Account status: {cfg.account.error}</> : null}
          </p>
        ) : null}
        {authFailure ? (
          <p className="track-sync-help track-sync-auth-error" role="alert">
            GitHub authorization is no longer valid. Reconnect GitHub in <b>Settings → Connections → Connectors</b>, then run the dry-run again. No sync changes were applied.
          </p>
        ) : null}
      </div>

      <div className="track-sync-actions">
        <div className="track-sync-act">
          <div className="track-sync-act-head"><Icon name="arrow-up" size={13} /> Export → GitHub</div>
          <div className="track-sync-act-sub">Push work items to issues</div>
          <div className="track-sync-btns">
            <button className="track-sync-dry" disabled={!configured || !!busy} onClick={() => run('export', true)}>Dry-run</button>
            <button className={`track-sync-go${busy === 'export' ? ' is-busy' : ''}`} disabled={!configured || !!busy} onClick={() => run('export', false)}>{busy === 'export' ? <span className="spinner sm" /> : null}{busy === 'export' ? 'Exporting' : 'Export'}</button>
          </div>
        </div>
        <div className="track-sync-act">
          <div className="track-sync-act-head"><Icon name="arrow-down" size={13} /> Import ← GitHub</div>
          <div className="track-sync-act-sub">Pull issues into the board</div>
          <div className="track-sync-btns">
            <button className="track-sync-dry" disabled={!configured || !!busy} onClick={() => run('import', true)}>Dry-run</button>
            <button className={`track-sync-go${busy === 'import' ? ' is-busy' : ''}`} disabled={!configured || !!busy} onClick={() => run('import', false)}>{busy === 'import' ? <span className="spinner sm" /> : null}{busy === 'import' ? 'Importing' : 'Import'}</button>
          </div>
        </div>
        <div className="track-sync-act track-sync-act-wide">
          <div className="track-sync-act-head"><Icon name="refresh" size={13} /> Sync ⇅ Both ways</div>
          <div className="track-sync-act-sub">Reconcile both sides — pushes local edits up, pulls GitHub edits down, and flags anything changed on both without overwriting either.</div>
          <div className="track-sync-btns">
            <button className="track-sync-dry" disabled={!configured || !!busy} onClick={() => run('sync', true)}>Dry-run</button>
            <button className={`track-sync-go${busy === 'sync' ? ' is-busy' : ''}`} disabled={!configured || !!busy} onClick={() => run('sync', false)}>{busy === 'sync' ? <span className="spinner sm" /> : null}{busy === 'sync' ? 'Syncing' : 'Sync both'}</button>
          </div>
        </div>
      </div>

      {result ? (
        <div className="track-sync-result">
          {result.direction === 'sync' ? (
            <>
              <div className="track-sync-result-head">
                {result.dryRun ? <span className="track-sync-badge dry">Dry-run</span> : <span className="track-sync-badge live">Applied</span>}
                Two-way sync — {result.pushed ?? 0} pushed, {result.pulled ?? 0} pulled, {(result.created?.remote ?? 0)} new issues, {(result.created?.local ?? 0)} new items
              </div>
              {result.conflicts?.length ? (
                <div className="track-sync-rows">
                  <div className="track-sync-conflict-label">{result.conflicts.length} conflict{result.conflicts.length === 1 ? '' : 's'} — changed on both sides; kept local, left GitHub. Reconcile the field, then sync again.</div>
                  {result.conflicts.map((c, i) => (
                    <div key={i} className="track-sync-row">
                      <span className="track-sync-act-tag conflict">conflict</span>
                      <span className="mono tl-key">{c.key}</span>
                      <span className="tl-title">{c.field}</span>
                    </div>
                  ))}
                </div>
              ) : result.errors.length ? (
                <div className="track-sync-conflict-label">Sync completed with errors — review the details below and retry after resolving them.</div>
              ) : <div className="track-col-empty">In sync — nothing to reconcile.</div>}
            </>
          ) : (
            <>
              <div className="track-sync-result-head">
                {result.dryRun ? <span className="track-sync-badge dry">Dry-run</span> : <span className="track-sync-badge live">Applied</span>}
                {result.direction === 'export' ? 'Export' : 'Import'} — {rows.filter((r) => r.action === 'create').length} new, {rows.filter((r) => r.action === 'update').length} updated
              </div>
              <div className="track-sync-rows">
                {rows.map((r, i) => (
                  <div key={i} className="track-sync-row">
                    <span className={`track-sync-act-tag ${r.action}`}>{r.action === 'create' ? '+ new' : '~ upd'}</span>
                    <span className="mono tl-key">{r.key ?? (r.issueNumber ? `#${r.issueNumber}` : '—')}</span>
                    <span className="tl-title">{r.title}</span>
                  </div>
                ))}
                {rows.length === 0 ? <div className="track-col-empty">Nothing to sync.</div> : null}
              </div>
            </>
          )}
          {result.errors.length ? (
            <div className="track-sync-errors">{result.errors.map((e, i) => <div key={i}>{e}</div>)}</div>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}
