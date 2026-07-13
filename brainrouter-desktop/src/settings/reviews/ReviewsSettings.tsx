// ADR-017 D5 — the desktop PR Reviews panel. Pulls the PRs our bot has reviewed
// (via the `reviews` host query → GET /api/admin/reviews/jobs) so a flagged PR shows
// up right in the app, and clicking one opens it on GitHub. Two lenses: 🛡️ security
// (gates the merge) + 🔎 code review (advisory). Per-repo + policy config lives in the
// dashboard; this is the "what did the bot just flag, and jump to it" surface.
import { useCallback, useEffect, useState } from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface ReviewRow {
  id: string;
  lens: 'security' | 'code';
  status: string;
  repo: string | null;
  prNumber: number | null;
  findings: number | null;
  blocking: number | null;
  skipped: string | null;
  error: string | null;
  updatedAt: string;
  createdAt: string;
}
type LoadState = 'loading' | 'signed-out' | 'ready' | 'error';

function relTime(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

export function ReviewsSettings(): React.ReactElement {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [running, setRunning] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await bridgeQuery<{ signedIn: boolean; reviews: ReviewRow[]; error?: string }>('reviews');
      if (!res.signedIn) { setState('signed-out'); return; }
      setReviews(Array.isArray(res.reviews) ? res.reviews : []);
      if (res.error) { setError(res.error); setState('error'); } else setState('ready');
    } catch (e) { setError(e instanceof Error ? e.message : 'failed to load'); setState('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const openPr = (r: ReviewRow): void => {
    if (!r.repo || !r.prNumber) return;
    void bridgeQuery('action:open-external', { what: `https://github.com/${r.repo}/pull/${r.prNumber}` });
  };

  // Re-run THIS row's lens straight from the desktop. The backend re-gates on the
  // account's reviews:run capability — the button is only a trigger.
  const rerun = async (r: ReviewRow, ev: React.MouseEvent): Promise<void> => {
    ev.stopPropagation(); // don't also open the PR
    if (!r.repo || !r.prNumber) return;
    setRunning(r.id); setError('');
    try {
      const res = await bridgeQuery<{ ok: boolean; error?: string }>('reviews-run', { repo: r.repo, prNumber: r.prNumber, lens: r.lens });
      if (!res.ok) setError(res.error ?? 'run failed');
      else setTimeout(() => void load(), 1500); // let the queued job surface
    } catch (e) { setError(e instanceof Error ? e.message : 'run failed'); }
    finally { setRunning(''); }
  };

  const detail = (r: ReviewRow): string =>
    r.error ? `error: ${r.error}`
      : r.skipped ? `skipped: ${r.skipped}`
        : r.findings !== null ? `${r.findings} finding${r.findings === 1 ? '' : 's'}${r.blocking ? ` · ${r.blocking} blocking` : ''}`
          : r.status;

  return (
    <>
      <div className="set-h">PR Reviews</div>
      <div className="set-desc" style={{ marginBottom: 10 }}>
        Pull requests the bot has reviewed — 🛡️ <b>security</b> (gates the merge) and 🔎 <b>code review</b> (advisory suggestions). Click a row to open the PR on GitHub, or hit <b>Re-run</b> to run that lens again right here. You can also comment <code>/security-review</code> / <code>/code-review</code> on the PR. Choose repos and policies in Dashboard → Reviews.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="set-desc">{state === 'ready' ? `${reviews.length} recent review${reviews.length === 1 ? '' : 's'}` : ''}</span>
        <button className="btn btn-ghost" onClick={() => void load()} disabled={state === 'loading'}>Refresh</button>
      </div>

      {state === 'loading' && <div className="set-desc">Loading…</div>}
      {state === 'signed-out' && <div className="set-desc">Sign in under <b>Settings → Account</b> to see your org's reviews.</div>}
      {state === 'error' && (
        <div className="set-desc" style={{ color: 'var(--danger, #e66)' }}>
          {error === 'Owner/admin only' ? 'Only org owners/admins can view reviews.' : `Couldn't load reviews: ${error}`}
        </div>
      )}
      {state === 'ready' && reviews.length === 0 && (
        <div className="set-desc">No reviews yet — open or push a PR on an auto-reviewed repo, and it'll appear here.</div>
      )}
      {state === 'ready' && reviews.map((r) => {
        const clickable = !!(r.repo && r.prNumber);
        const badgeColor = r.status !== 'done' ? 'var(--text-muted, #999)' : (r.blocking && r.lens === 'security') ? 'var(--danger, #e66)' : 'var(--ok, #6c9)';
        return (
          <div key={r.id} onClick={() => openPr(r)} title={clickable ? 'Open PR on GitHub' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px', borderBottom: '1px solid var(--border-dim, rgba(255,255,255,0.06))', cursor: clickable ? 'pointer' : 'default' }}>
            <span style={{ fontSize: 15 }}>{r.lens === 'security' ? '🛡️' : '🔎'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.repo ?? '—'}{r.prNumber ? ` #${r.prNumber}` : ''}
              </div>
              <div className="set-desc" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {detail(r)} · {relTime(r.updatedAt)}
              </div>
            </div>
            {clickable && (
              <button className="btn btn-ghost" onClick={(e) => void rerun(r, e)} disabled={running === r.id}
                title={`Re-run the ${r.lens === 'security' ? 'security' : 'code'} review on ${r.repo} #${r.prNumber}`}
                style={{ fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                {running === r.id ? '…' : 'Re-run'}
              </button>
            )}
            <span style={{ fontSize: 11, color: badgeColor, whiteSpace: 'nowrap' }}>{r.status}</span>
          </div>
        );
      })}
    </>
  );
}
