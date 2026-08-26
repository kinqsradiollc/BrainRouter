/**
 * ADR-015 P3 (UI surface) — "Repositories": link the current workspace to memory
 * by its REPO identity and index its files.
 *
 * The repoTag (a hash of the normalized git remote, from `git-info`) scopes memory
 * by repo rather than folder path, so what you capture and index survives a
 * moved/renamed folder or a second clone (ADR-015 D4). "Index this repo into
 * memory" walks the git-aware file list, reads the local checkout, and routes it
 * through the host `action:index-repo` → `memory_ingest_repo` (opt-in, idempotent).
 */
import React, { useEffect, useState } from 'react';
import { Row } from '../shared/controls.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface GitInfo { repo?: string | null; remoteUrl?: string | null; repoTag?: string | null; gitRoot?: string | null }
interface IndexResult {
  ok: boolean; repoTag?: string; filesRead?: number;
  ingested?: number; skipped?: number; chunks?: number; truncated?: boolean; error?: string;
}

export function RepositoriesSettings(): React.ReactElement {
  const [git, setGit] = useState<GitInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IndexResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    bridgeQuery<GitInfo>('git-info').then((g) => { if (alive) setGit(g); }).catch(() => { if (alive) setGit({}); });
    return () => { alive = false; };
  }, []);

  const runIndex = async (): Promise<void> => {
    setBusy(true); setError(''); setResult(null);
    try {
      // The walk reads up to 3000 files off disk, so allow well past the default.
      const res = await bridgeQuery<IndexResult>('action:index-repo', {}, 180_000);
      if (res.ok) setResult(res); else setError(res.error ?? 'Indexing failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasRepo = !!(git && git.repoTag);
  return (
    <div className="repos-int">
      <div className="set-desc" style={{ marginBottom: 12 }}>
        Link this workspace's repository to memory by its <b>identity</b> rather than its folder
        path. The repo tag is derived from the git remote, so what you capture and index stays
        scoped to the repo even after you move, rename, or re-clone it.
      </div>

      <Row title="Repository" desc="Detected from this workspace's git origin remote.">
        {git === null ? (
          <span className="set-desc">Checking…</span>
        ) : hasRepo ? (
          <div style={{ textAlign: 'right' }}>
            <div className="mono">{git.repo || git.remoteUrl}</div>
            <div className="set-desc mono" style={{ opacity: 0.7 }}>repoTag {git.repoTag}</div>
          </div>
        ) : (
          <span className="set-desc" style={{ maxWidth: 320 }}>
            No git origin remote, so this workspace has no repo identity. Add one with{' '}
            <code>git remote add origin …</code>.
          </span>
        )}
      </Row>

      <Row
        title="Index into memory"
        desc="Walk this repo's tracked files (respects .gitignore), read them from the local checkout, and index them scoped by repoTag. Opt-in and idempotent — re-indexing only adds what changed."
      >
        <button className="btn primary" disabled={!hasRepo || busy} onClick={runIndex}>
          {busy ? 'Indexing…' : 'Index this repo into memory'}
        </button>
      </Row>

      {result ? (
        <div className="set-desc" style={{ marginTop: 10, color: 'var(--ok, var(--accent))' }}>
          Indexed <b>{result.ingested ?? 0}</b> file(s) into <b>{result.chunks ?? 0}</b> chunk(s)
          {typeof result.skipped === 'number' && result.skipped > 0 ? <>, skipped {result.skipped}</> : null}
          {result.truncated ? ' (file cap reached)' : ''}. Read {result.filesRead ?? 0} from the checkout.
        </div>
      ) : null}
      {error ? (
        <div className="set-desc" style={{ marginTop: 10, color: 'var(--warn)' }}>{error}</div>
      ) : null}
    </div>
  );
}
