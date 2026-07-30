// ADR-017 D5 — the desktop PR Reviews panel. Pulls the PRs our bot has reviewed
// (via the `reviews` host query → GET /api/admin/reviews/jobs) so a flagged PR shows
// up right in the app, and clicking one opens it on GitHub. Two lenses: 🛡️ security
// (gates the merge) + 🔎 code review (advisory). Per-repo + policy config lives in the
// dashboard; this is the "what did the bot just flag, and jump to it" surface.
import { useCallback, useEffect, useState } from 'react';
import type {
  ReviewAssuranceDetailView,
  ReviewSummaryView,
} from '@kinqs/brainrouter-agent-protocol';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import { changeRequestUrl, normalizeReviewListResponse } from './reviewPresentation.js';
import { ReviewAssuranceDetail } from './ReviewAssuranceDetail.js';

type ReviewRow = ReviewSummaryView;
type LoadState = 'loading' | 'signed-out' | 'ready' | 'error';
type DetailState = 'idle' | 'loading' | 'ready' | 'error';

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
  const [canRun, setCanRun] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<ReviewAssuranceDetailView | null>(null);
  const [detailState, setDetailState] = useState<DetailState>('idle');
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    setError('');
    try {
      const res = normalizeReviewListResponse<ReviewRow>(await bridgeQuery('reviews'));
      setCanRun(res.canRun);
      if (!res.signedIn) { setReviews([]); setState('signed-out'); return; }
      setReviews(res.reviews);
      if (res.error) { setError(res.error); setState('error'); } else setState('ready');
    } catch (e) { setCanRun(false); setError(e instanceof Error ? e.message : 'failed to load'); setState('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const closeDetail = (): void => {
    setSelectedReviewId('');
    setSelectedDetail(null);
    setDetailState('idle');
    setDetailError('');
  };

  const loadDetail = async (review: ReviewRow, force = false): Promise<void> => {
    if (!force && selectedReviewId === review.id) {
      closeDetail();
      return;
    }
    setSelectedReviewId(review.id);
    setSelectedDetail(null);
    setDetailError('');
    setDetailState('loading');
    try {
      const result = await bridgeQuery<ReviewAssuranceDetailView>(
        'reviews-detail',
        { jobId: review.id },
      );
      if (result.review.id !== review.id) throw new Error('Review detail did not match the selected job.');
      setSelectedDetail(result);
      setDetailState('ready');
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : 'Could not load assurance detail.');
      setDetailState('error');
    }
  };

  const openPr = async (r: ReviewRow): Promise<void> => {
    if (!r.repo || !r.prNumber) return;
    const url = changeRequestUrl(r.repo, r.prNumber, r.forge);
    if (!url) return;
    try {
      const result = await bridgeQuery<{ ok?: boolean; error?: string }>('action:open-external', { url });
      if (result.ok === false) setError(result.error ?? 'Could not open the pull request.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open the pull request.');
    }
  };

  // Re-run THIS row's lens straight from the desktop. The backend re-gates on the
  // account's reviews:run capability — the button is only a trigger.
  const rerun = async (r: ReviewRow, ev: React.MouseEvent): Promise<void> => {
    ev.stopPropagation(); // don't also open the PR
    if (!canRun || !r.repo || !r.prNumber) return;
    setRunning(r.id); setError('');
    try {
      const res = await bridgeQuery<{ ok: boolean; error?: string }>('reviews-run', { repo: r.repo, prNumber: r.prNumber, lens: r.lens, forge: r.forge });
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
        Pull requests and merge requests the bot has reviewed — 🛡️ <b>security</b> (gates the merge) and 🔎 <b>code review</b> (advisory suggestions). Click a row to open it on its forge, or hit <b>Re-run</b> to run that lens again here. Choose repositories and policies in Dashboard → Reviews.
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
      {state === 'ready' && error && (
        <div className="set-desc" role="alert" style={{ color: 'var(--danger, #e66)', marginBottom: 8 }}>{error}</div>
      )}
      {state === 'ready' && reviews.length === 0 && (
        <div className="set-desc">No reviews yet — open or push a PR on an auto-reviewed repo, and it'll appear here.</div>
      )}
      {state === 'ready' && reviews.map((r) => {
        const clickable = !!(r.repo && r.prNumber);
        const badgeColor = r.status !== 'done' ? 'var(--text-muted, #999)' : (r.blocking && r.lens === 'security') ? 'var(--danger, #e66)' : 'var(--ok, #6c9)';
        const summary = (
          <>
            <span aria-hidden style={{ fontSize: 15 }}>{r.lens === 'security' ? '🛡️' : r.lens === 'pentest' ? '🧪' : '🔎'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.repo ?? '—'}{r.prNumber ? ` #${r.prNumber}` : ''}
              </div>
              <div className="set-desc" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {detail(r)} · {relTime(r.updatedAt)}
              </div>
            </div>
          </>
        );
        return (
          <div key={r.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px', borderBottom: '1px solid var(--border-dim, rgba(255,255,255,0.06))' }}>
              {clickable ? (
                <button type="button" onClick={() => void openPr(r)} title="Open change request" aria-label={`Open ${r.repo} change request ${r.prNumber}`}
                  style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: 0, textAlign: 'left', color: 'inherit', background: 'transparent', border: 0, cursor: 'pointer' }}>
                  {summary}
                </button>
              ) : (
                <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>{summary}</div>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void loadDetail(r)}
                aria-expanded={selectedReviewId === r.id}
                style={{ fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }}
              >
                {selectedReviewId === r.id ? 'Hide detail' : 'Assurance'}
              </button>
              {clickable && canRun && (
                <button type="button" className="btn btn-ghost" onClick={(e) => void rerun(r, e)} disabled={running === r.id}
                  title={`Re-run the ${r.lens} review on ${r.repo} #${r.prNumber}`}
                  style={{ fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                  {running === r.id ? '…' : 'Re-run'}
                </button>
              )}
              <span style={{ fontSize: 11, color: badgeColor, whiteSpace: 'nowrap' }}>{r.status}</span>
            </div>
            {selectedReviewId === r.id && detailState === 'loading' && (
              <div className="set-desc" style={{ padding: '10px 2px' }}>Loading durable assurance…</div>
            )}
            {selectedReviewId === r.id && detailState === 'error' && (
              <div className="set-desc" role="alert" style={{ padding: '10px 2px', color: 'var(--danger, #e66)' }}>
                Could not load assurance: {detailError}{' '}
                <button type="button" className="btn btn-ghost" onClick={() => void loadDetail(r, true)}>Retry</button>
              </div>
            )}
            {selectedReviewId === r.id && detailState === 'ready' && selectedDetail && (
              <ReviewAssuranceDetail detail={selectedDetail} onClose={closeDetail} />
            )}
          </div>
        );
      })}
    </>
  );
}
