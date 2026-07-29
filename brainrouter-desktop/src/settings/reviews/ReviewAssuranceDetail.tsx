import type { ReviewAssuranceDetailView } from '@kinqs/brainrouter-agent-protocol';
import { buildDesktopAssurancePresentation } from './assurancePresentation.js';
import styles from './ReviewAssuranceDetail.module.css';

export interface ReviewAssuranceDetailProps {
  detail: ReviewAssuranceDetailView;
  onClose: () => void;
}

export function ReviewAssuranceDetail({
  detail,
  onClose,
}: ReviewAssuranceDetailProps): React.ReactElement {
  const view = buildDesktopAssurancePresentation(detail);
  return (
    <section className={styles.panel} aria-label={`Assurance detail for ${detail.review.id}`}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Durable assurance</div>
          <div className={styles.title}>{detail.review.repo ?? 'Repository unavailable'}{detail.review.prNumber ? ` #${detail.review.prNumber}` : ''}</div>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      </header>

      {!view.available ? (
        <div className="set-desc">No durable assurance run is recorded for this review.</div>
      ) : (
        <>
          <div className={styles.summaryGrid}>
            <div><span>Run</span><strong>{view.runId}</strong></div>
            <div><span>Program</span><strong>{view.program}</strong></div>
            <div><span>Status</span><strong>{view.status}</strong></div>
            <div><span>Revision</span><strong className={styles.mono}>{view.revision}</strong></div>
            <div><span>Coverage</span><strong>{view.coverage?.status}</strong></div>
            <div><span>Source</span><strong>{view.source?.status}</strong></div>
          </div>

          {view.staleReason && <div className={styles.notice}>Stale: {view.staleReason}</div>}
          {view.supersededBy && <div className={styles.notice}>Superseded by {view.supersededBy}</div>}

          <div className={styles.section}>
            <h4>Coverage</h4>
            <div className="set-desc">{view.coverage?.files} · {view.coverage?.changedFiles} · {view.source?.indexed}</div>
            {view.coverage?.limitations.map((limitation) => (
              <div key={`${limitation.component}-${limitation.summary}`} className={styles.limitation}>
                <strong>{limitation.state}</strong> · {limitation.component} — {limitation.summary}
              </div>
            ))}
          </div>

          <div className={styles.section}>
            <h4>Stage receipts</h4>
            <div className={styles.receipts}>
              {view.stages.map((stage) => (
                <div key={stage.id}>
                  <span>{stage.name}</span>
                  <strong>{stage.status}</strong>
                  <small>attempt {stage.attempt}{stage.errorCode ? ` · ${stage.errorCode}` : ''}</small>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.section}>
            <h4>Findings ({view.findings.length})</h4>
            {view.findings.length === 0 && <div className="set-desc">No durable findings recorded.</div>}
            {view.findings.map((finding) => (
              <article key={finding.id} className={styles.finding}>
                <div className={styles.findingTitle}>
                  <span>{finding.severity}</span>
                  <strong>{finding.title}</strong>
                  <span>{finding.state}</span>
                </div>
                <div className={`${styles.mono} ${styles.location}`}>{finding.location} · confidence {finding.confidence}</div>
                <p>{finding.mechanism}</p>
                {finding.evidence.map((evidence) => (
                  <div key={evidence.id} className={styles.evidence}>
                    Evidence · {evidence.kind} · {evidence.summary}
                  </div>
                ))}
                {finding.verifier ? (
                  <div className={styles.verifier}>
                    Verifier {finding.verifier.id} · <strong>{finding.verifier.state}</strong> — {finding.verifier.rationale}
                  </div>
                ) : (
                  <div className={styles.verifier}>No verifier disposition recorded.</div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
