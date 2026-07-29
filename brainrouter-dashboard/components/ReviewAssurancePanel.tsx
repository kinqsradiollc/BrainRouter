"use client";

/**
 * Human-reviewable durable assurance details for a repository review.
 *
 * The panel keeps revision authority, coverage gaps, stage receipts, evidence,
 * and independent verifier dispositions visible beside the agent trace.
 */
import type { ReviewAssuranceDto } from "@kinqs/brainrouter-types";

import { SeverityBadge, StatusBadge } from "./Analytics";
import {
  buildReviewAssurancePresentation,
  type AssuranceTone,
} from "../app/reviews/assurancePresentation";
import styles from "./reviewAssurancePanel.module.css";

function statusTone(tone: AssuranceTone): "neutral" | "ok" | "warn" | "danger" | "info" {
  return tone;
}

export function ReviewAssurancePanel({
  assurance,
}: {
  assurance: ReviewAssuranceDto | null;
}) {
  if (!assurance) {
    return (
      <section className={styles.panel} aria-label="Review assurance">
        <div className={styles.empty}>
          <strong>No durable assurance record</strong>
          <span>This review predates evidence-aware assurance or did not start an assurance run.</span>
        </div>
      </section>
    );
  }

  const view = buildReviewAssurancePresentation(assurance);
  return (
    <section className={styles.panel} aria-label="Review assurance">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Durable assurance</span>
          <h3>{view.program}</h3>
        </div>
        <StatusBadge tone={statusTone(view.statusTone)}>{view.status}</StatusBadge>
      </header>
      <p className={styles.notice}>{view.authorityNotice}</p>
      <dl className={styles.summary}>
        <div><dt>Revision</dt><dd title={view.revision}>{view.revision.slice(0, 12)}</dd></div>
        <div>
          <dt>Coverage</dt>
          <dd><StatusBadge tone={statusTone(view.coverage.tone)}>{view.coverage.status}</StatusBadge></dd>
        </div>
        <div><dt>Eligible files</dt><dd>{view.coverage.files}</dd></div>
        <div><dt>Changed files</dt><dd>{view.coverage.changedFiles}</dd></div>
      </dl>
      {view.coverage.limitations.length > 0 && (
        <div className={styles.limitations}>
          <strong>Coverage limitations</strong>
          <ul>{view.coverage.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      )}
      <details className={styles.details}>
        <summary>Stage receipts <span>{view.stages.length}</span></summary>
        <ol className={styles.stages}>
          {view.stages.map((stage) => (
            <li key={stage.id}>
              <div><strong>{stage.name}</strong><span>{stage.detail}</span></div>
              <StatusBadge tone={statusTone(stage.tone)}>{stage.status}</StatusBadge>
            </li>
          ))}
        </ol>
      </details>
      <div className={styles.findings}>
        <div className={styles.sectionHeading}>
          <strong>Assurance findings</strong>
          <span>{view.findings.length}</span>
        </div>
        {view.findings.length === 0 ? (
          <p className={styles.noFindings}>No durable findings were recorded for this run.</p>
        ) : view.findings.map((finding) => (
          <article key={finding.id}>
            <div className={styles.findingHeading}>
              <SeverityBadge severity={finding.severity} />
              <strong>{finding.title}</strong>
              <StatusBadge tone={statusTone(finding.tone)}>{finding.state}</StatusBadge>
            </div>
            <div className={styles.meta}>{finding.location} · confidence {finding.confidence}</div>
            <p>{finding.mechanism}</p>
            {finding.verifier && <div className={styles.verifier}><strong>Verifier</strong>{finding.verifier}</div>}
            {finding.evidence.length > 0 && (
              <details className={styles.evidence}>
                <summary>Evidence <span>{finding.evidence.length}</span></summary>
                <ul>{finding.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
              </details>
            )}
            {finding.limitations.length > 0 && (
              <div className={styles.findingLimitations}>
                {finding.limitations.map((item) => <span key={item}>{item}</span>)}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
